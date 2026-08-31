#!/usr/bin/env python3
"""PaiVoice realtime core.

This is the model-neutral part of a call: PCM16 audio comes from the web
client, the selected ASR transcribes it, an Adapter returns text, and the
selected TTS turns reply sentences into audio.  It deliberately contains no
personal prompt, memory, voice ID, server address, or provider credential.
"""

from __future__ import annotations

import asyncio
import base64
import io
import json
import os
import time
import uuid
import wave
from dataclasses import dataclass, field

import aiohttp
import numpy as np
from websockets.asyncio.server import serve

SAMPLE_RATE = 16_000
HOST = os.getenv("PAIVOICE_HOST", "127.0.0.1")
PORT = int(os.getenv("PAIVOICE_PORT", "8780"))
TOKEN = os.getenv("PAIVOICE_TOKEN", "")
ASR_PROVIDER = os.getenv("PAIVOICE_ASR_PROVIDER", "mock")
TTS_PROVIDER = os.getenv("PAIVOICE_TTS_PROVIDER", "mock")
ASR_KEY = os.getenv("PAIVOICE_ASR_API_KEY") or os.getenv("GROQ_API_KEY", "")
TTS_KEY = os.getenv("PAIVOICE_TTS_API_KEY") or os.getenv("ELEVENLABS_API_KEY", "")
GROQ_MODEL = os.getenv("PAIVOICE_GROQ_ASR_MODEL", "whisper-large-v3-turbo")
ELEVEN_VOICE = os.getenv("PAIVOICE_ELEVEN_VOICE_ID", "")
ADAPTER_URL = os.getenv("PAIVOICE_ADAPTER_URL", "")
ADAPTER_TOKEN = os.getenv("PAIVOICE_ADAPTER_TOKEN", "")
MAX_TURN_SECONDS = int(os.getenv("PAIVOICE_MAX_TURN_SECONDS", "60"))


def wav(pcm: bytes) -> bytes:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(SAMPLE_RATE)
        out.writeframes(pcm)
    return buffer.getvalue()


async def transcribe(http: aiohttp.ClientSession, pcm: bytes) -> str:
    """Return text only. Provider errors are intentionally safe to show."""
    if ASR_PROVIDER == "mock":
        return ""
    if ASR_PROVIDER != "groq" or not ASR_KEY:
        raise RuntimeError("ASR provider is not configured")
    form = aiohttp.FormData()
    form.add_field("file", wav(pcm), filename="turn.wav", content_type="audio/wav")
    form.add_field("model", GROQ_MODEL)
    form.add_field("language", "zh")
    headers = {"Authorization": f"Bearer {ASR_KEY}"}
    async with http.post("https://api.groq.com/openai/v1/audio/transcriptions", data=form, headers=headers) as response:
        if response.status != 200:
            raise RuntimeError(f"ASR request failed ({response.status})")
        return str((await response.json()).get("text", "")).strip()


async def request_reply(http: aiohttp.ClientSession, turn: dict) -> str:
    """Call any PaiVoice Adapter HTTP endpoint.

    It receives {call_session_id, turn_id, transcript} and returns
    {reply: string}.  A production adapter may queue terminal output before
    returning; this core does not need to know which model sits behind it.
    """
    if not ADAPTER_URL:
        return f"我听见了：{turn['transcript']}" if turn["transcript"] else "我没有听清楚。"
    headers = {"content-type": "application/json"}
    if ADAPTER_TOKEN:
        headers["authorization"] = f"Bearer {ADAPTER_TOKEN}"
    async with http.post(ADAPTER_URL.rstrip("/") + "/turn", json=turn, headers=headers,
                         timeout=aiohttp.ClientTimeout(total=120)) as response:
        if response.status != 200:
            raise RuntimeError(f"Adapter request failed ({response.status})")
        result = await response.json()
    return str(result.get("reply", "")).strip()


async def synthesize(http: aiohttp.ClientSession, text: str) -> bytes | None:
    """ElevenLabs is optional. Without a TTS provider, the client still gets text."""
    if TTS_PROVIDER == "mock" or not text:
        return None
    if TTS_PROVIDER != "elevenlabs" or not TTS_KEY or not ELEVEN_VOICE:
        raise RuntimeError("TTS provider is not configured")
    headers = {"xi-api-key": TTS_KEY, "accept": "audio/mpeg", "content-type": "application/json"}
    body = {"text": text, "model_id": "eleven_multilingual_v2"}
    url = f"https://api.elevenlabs.io/v1/text-to-speech/{ELEVEN_VOICE}/stream"
    async with http.post(url, headers=headers, json=body) as response:
        if response.status != 200:
            raise RuntimeError(f"TTS request failed ({response.status})")
        return await response.read()


@dataclass
class Call:
    id: str = field(default_factory=lambda: uuid.uuid4().hex)
    audio: bytearray = field(default_factory=bytearray)
    active: bool = False
    generation: int = 0

    def begin_turn(self) -> None:
        self.active = True
        self.audio.clear()

    def end_turn(self) -> bytes:
        self.active = False
        max_bytes = SAMPLE_RATE * 2 * MAX_TURN_SECONDS
        return bytes(self.audio[-max_bytes:])


async def send(ws, message: dict) -> None:
    await ws.send(json.dumps(message, ensure_ascii=False))


async def answer_turn(ws, call: Call, http: aiohttp.ClientSession, pcm: bytes, supplied_text: str = "") -> None:
    if not pcm and not supplied_text:
        await send(ws, {"type": "nothing_heard"})
        return
    turn_id = uuid.uuid4().hex
    try:
        transcript = supplied_text or await transcribe(http, pcm)
        if not transcript:
            await send(ws, {"type": "nothing_heard"})
            return
        await send(ws, {"type": "transcript", "call_session_id": call.id, "turn_id": turn_id, "text": transcript})
        reply = await request_reply(http, {"call_session_id": call.id, "turn_id": turn_id, "transcript": transcript})
        if not reply:
            return
        call.generation += 1
        generation = call.generation
        await send(ws, {"type": "reply_text", "generation_id": generation, "turn_id": turn_id, "text": reply})
        audio = await synthesize(http, reply)
        if audio and generation == call.generation:
            await send(ws, {"type": "audio", "generation_id": generation, "data": base64.b64encode(audio).decode("ascii")})
            await send(ws, {"type": "audio_sentence_end", "generation_id": generation})
        await send(ws, {"type": "generation_end", "generation_id": generation})
    except Exception as error:  # do not serialize credentials or provider bodies
        await send(ws, {"type": "error", "error": str(error)})


async def session(ws) -> None:
    call = Call()
    async with aiohttp.ClientSession() as http:
        async for raw in ws:
            if isinstance(raw, bytes):
                if call.active:
                    call.audio.extend(raw)
                continue
            try:
                event = json.loads(raw)
            except json.JSONDecodeError:
                continue
            kind = event.get("type")
            if kind == "start":
                if TOKEN and event.get("token") != TOKEN:
                    await send(ws, {"type": "error", "error": "Unauthorized"})
                    return
                await send(ws, {"type": "state", "call_session_id": call.id, "mode": "listening"})
            elif kind == "speech_start":
                call.begin_turn()
            elif kind == "speech_end":
                pcm = call.end_turn()
                await send(ws, {"type": "state", "mode": "thinking"})
                await answer_turn(ws, call, http, pcm)
                await send(ws, {"type": "state", "mode": "listening"})
            elif kind == "text":
                await send(ws, {"type": "state", "mode": "thinking"})
                await answer_turn(ws, call, http, b"", str(event.get("text", "")))
                await send(ws, {"type": "state", "mode": "listening"})
            elif kind == "interrupt":
                call.generation += 1
                await send(ws, {"type": "interrupted"})
            elif kind == "hangup":
                return


async def main() -> None:
    async with serve(session, HOST, PORT, max_size=None):
        print(f"PaiVoice listening on ws://{HOST}:{PORT}")
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
