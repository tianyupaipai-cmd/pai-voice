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

from vision import DIFF_THRESHOLD, Eyes
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


EYE_FILE = os.getenv("PAIVOICE_EYE_FILE", "/tmp/paivoice-eye-latest.jpg")   # 对方摄像头最新一帧；关摄像头/挂断时删

# 陪伴模式：对方在工作学习时挂着摄像头，核心不再逐帧描述，只在离开/回来/小动作/太久没动静时给适配器一条 companion 事件
COMP_ABSENT_SECS = int(os.getenv("PAIVOICE_COMPANION_ABSENT_SECONDS", "120"))      # 走开多久算离开
COMP_NUDGE_COOLDOWN = int(os.getenv("PAIVOICE_COMPANION_NUDGE_SECONDS", "120"))    # 离开/回来/小动作共用的冷却
COMP_STILL_SECS = int(os.getenv("PAIVOICE_COMPANION_STILL_SECONDS", "1800"))       # 多久没动静提醒一次（喝水/站起来轮流）
COMP_ASSESS_MIN = int(os.getenv("PAIVOICE_COMPANION_ASSESS_MIN_SECONDS", "60"))    # 模型最少隔多久问一次
COMP_ASSESS_MAX = int(os.getenv("PAIVOICE_COMPANION_ASSESS_MAX_SECONDS", "300"))   # 没动静也保底问一次
COMP_DIFF_MULT = float(os.getenv("PAIVOICE_COMPANION_DIFF_MULT", "2"))            # 像素差门槛倍数

# 屏幕共享：前端约 2 秒一帧（画面或字幕变了才发），核心攒着，每 SCREEN_STORY_SECS 秒把这几帧按顺序一起交给模型串一次
SCREEN_STORY_SECS = float(os.getenv("PAIVOICE_SCREEN_STORY_SECONDS", "10"))
SCREEN_STORY_FRAMES = int(os.getenv("PAIVOICE_SCREEN_STORY_FRAMES", "5"))


def save_eye_file(jpeg: bytes) -> None:
    try:
        with open(EYE_FILE + ".tmp", "wb") as f:
            f.write(jpeg)
        os.replace(EYE_FILE + ".tmp", EYE_FILE)
    except OSError:
        pass


def remove_eye_file() -> None:
    for path in (EYE_FILE, EYE_FILE + ".tmp"):
        try:
            os.unlink(path)
        except OSError:
            pass


async def notify_adapter(http: aiohttp.ClientSession, event: dict) -> None:
    """可选：把摄像头开关 / 画面描述这类不是"一轮话"的事件 POST 到适配器的 /event。适配器没实现就当没这回事。"""
    if not ADAPTER_URL:
        return
    headers = {"content-type": "application/json"}
    if ADAPTER_TOKEN:
        headers["authorization"] = f"Bearer {ADAPTER_TOKEN}"
    try:
        async with http.post(ADAPTER_URL.rstrip("/") + "/event", json=event, headers=headers,
                             timeout=aiohttp.ClientTimeout(total=10)) as response:
            await response.read()
    except Exception:  # noqa: BLE001
        pass


@dataclass
class Call:
    id: str = field(default_factory=lambda: uuid.uuid4().hex)
    audio: bytearray = field(default_factory=bytearray)
    active: bool = False
    generation: int = 0
    video: bool = False                       # 对方开着摄像头（通话中可随时开关，和语音并行）
    video_mode: str = "live"                  # live 画面变就描述 / companion 陪伴：只在离开、回来、小动作、太久没动静时开口
                                              # / screen 屏幕共享：每几秒把几帧串成一段（看剧、打游戏）
    eyes: Eyes = field(default_factory=Eyes)
    comp: dict = field(default_factory=dict)
    screen_buf: list = field(default_factory=list)   # 屏幕共享：上次串完之后攒的 (时间, jpeg)
    screen_story_at: float = 0.0
    camera_mode: str = "live"                 # 切到屏幕共享前摄像头用的模式，关屏幕共享后回到它

    def companion_reset(self) -> None:
        self.comp = {"present": None, "absent_since": 0.0, "left_reported": False,
                     "last_nudge": 0.0, "last_assess": 0.0, "still_since": time.time(), "reminders": 0}

    def begin_turn(self) -> None:
        self.active = True
        self.audio.clear()

    def end_turn(self) -> bytes:
        self.active = False
        max_bytes = SAMPLE_RATE * 2 * MAX_TURN_SECONDS
        return bytes(self.audio[-max_bytes:])


SCREEN_INTRO = ("对方共享了屏幕，可能在看剧、玩游戏或看网页，想和你一起看。大约每 {secs} 秒来一条 screen 事件："
                "把这几秒的几帧串起来说了什么、发生了什么。想接话就自然地接一句，不用每条都回，也别逐条复述画面")


async def screen_frame(ws, call: Call, http: aiohttp.ClientSession, jpeg: bytes) -> None:
    """屏幕共享：先攒帧（模型在串上一段时来的帧也留着），到点、模型空闲时把这段挑几帧一起交出去。"""
    now = time.time()
    call.screen_buf = [*call.screen_buf[-29:], (now, jpeg)]
    if not call.eyes.enabled or call.eyes.busy or now - call.screen_story_at < SCREEN_STORY_SECS:
        return
    buf, call.screen_buf = call.screen_buf, []
    if len(buf) > SCREEN_STORY_FRAMES:            # 多了就均匀挑，首尾都留
        step = (len(buf) - 1) / (SCREEN_STORY_FRAMES - 1)
        buf = [buf[round(i * step)] for i in range(SCREEN_STORY_FRAMES)]
    call.screen_story_at = now
    desc = await call.eyes.story(http, [j for _, j in buf], buf[-1][0] - buf[0][0])
    if desc and call.video and call.video_mode == "screen":
        await send(ws, {"type": "observation", "content": desc})
        await notify_adapter(http, {"type": "screen", "call_session_id": call.id, "text": desc, "frame": EYE_FILE})


def companion_intro(mode: str) -> str:
    if mode == "screen":
        return SCREEN_INTRO.format(secs=round(SCREEN_STORY_SECS))
    if mode != "companion":
        return "对方把摄像头切回实时模式：画面有变化会来 saw 事件"
    return (f"对方开的是陪伴模式：在工作或学习，别主动评论画面。只有离开座位 {COMP_ABSENT_SECS // 60} 分钟、回来了、"
            f"有值得搭话的小动作，或 {COMP_STILL_SECS // 60} 分钟没动静时才会来 companion 事件")


async def companion_frame(ws, call: Call, http: aiohttp.ClientSession, jpeg: bytes) -> None:
    """陪伴模式的状态机：每帧算一次，需要时才问模型；开口只走 nudge()。"""
    c = call.comp
    now = time.time()

    async def nudge(kind: str, text: str) -> None:
        c["last_nudge"] = now
        c["still_since"] = now
        await notify_adapter(http, {"type": "companion", "kind": kind, "call_session_id": call.id, "text": text, "frame": EYE_FILE})

    moved = call.eyes.changed(jpeg, threshold=DIFF_THRESHOLD * COMP_DIFF_MULT)
    since = now - c["last_assess"]
    want = (since >= COMP_ASSESS_MAX
            or (moved and since >= COMP_ASSESS_MIN)
            or (c["present"] is False and since >= COMP_ASSESS_MIN)   # 人不在时盯紧点，好确认离开/回来
            or c["present"] is None)
    if want and call.eyes.enabled and not call.eyes.busy:
        c["last_assess"] = now
        d = await call.eyes.assess(http, jpeg)
        if not d or not call.video or call.video_mode != "companion":
            return
        was = c["present"]
        c["present"] = d["present"]
        if not d["present"]:
            if not c["absent_since"]:
                c["absent_since"] = now
            elif not c["left_reported"] and now - c["absent_since"] >= COMP_ABSENT_SECS:
                c["left_reported"] = True
                mins = int((now - c["absent_since"]) // 60)
                await nudge("left", f"对方离开座位 {mins} 分钟了，画面里没人")
            return
        if was is False and c["left_reported"]:
            c["absent_since"] = 0.0; c["left_reported"] = False
            await nudge("back", f"对方回来了{('，' + d['activity']) if d['activity'] else ''}")
            return
        c["absent_since"] = 0.0; c["left_reported"] = False
        if d["notable"] and now - c["last_nudge"] >= COMP_NUDGE_COOLDOWN:
            await nudge("gesture", f"对方{d['notable']}{('，现在' + d['activity']) if d['activity'] else ''}")
            return
    if c["present"] and now - c["still_since"] >= COMP_STILL_SECS and now - c["last_nudge"] >= COMP_NUDGE_COOLDOWN:
        c["reminders"] += 1
        tip = "喝口水" if c["reminders"] % 2 else "站起来活动一下"
        await nudge("still", f"对方已经 {COMP_STILL_SECS // 60} 分钟没什么动静了，一直在座位上；提醒{tip}")


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
        turn = {"call_session_id": call.id, "turn_id": turn_id, "transcript": transcript}
        if call.video and call.eyes.last_observation:
            turn["observation"] = call.eyes.last_observation      # 最近一次看到的画面，随这轮一起给回复端
        reply = await request_reply(http, turn)
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
            elif kind == "video":
                on = bool(event.get("on"))
                source = "screen" if event.get("source") == "screen" else "camera"
                if on and source == "screen" and call.video_mode != "screen":     # 开屏幕共享：记下摄像头原来的模式
                    call.camera_mode, call.video_mode = call.video_mode, "screen"
                    call.screen_buf, call.screen_story_at = [], 0.0
                elif not on and call.video_mode == "screen":                     # 关屏幕共享：回到摄像头原来的模式
                    call.video_mode = call.camera_mode
                if on != call.video or source == "screen":
                    call.video = on
                    call.companion_reset()
                    if not on:
                        remove_eye_file()
                    await send(ws, {"type": "video", "on": on, "source": source, "eyes": call.eyes.enabled, "mode": call.video_mode})
                    await notify_adapter(http, {"type": "camera", "call_session_id": call.id, "on": on, "source": source,
                                                "mode": call.video_mode, "frame": EYE_FILE if on else None,
                                                **({"text": companion_intro(call.video_mode)} if on and call.video_mode in ("companion", "screen") else {})})
            elif kind == "video_mode":
                mode = "companion" if event.get("mode") == "companion" else "live"
                if call.video_mode == "screen":           # 屏幕共享中切的是摄像头模式：记下，关了屏幕共享再用
                    call.camera_mode = mode
                    await send(ws, {"type": "video_mode", "mode": "screen", "camera_mode": mode})
                elif mode != call.video_mode:
                    call.video_mode = mode
                    call.companion_reset()
                    await send(ws, {"type": "video_mode", "mode": mode})
                    if call.video:
                        await notify_adapter(http, {"type": "camera", "call_session_id": call.id, "on": True, "mode": mode,
                                                    "frame": EYE_FILE, "text": companion_intro(mode)})
            elif kind == "frame":
                if not call.video:
                    continue
                try:
                    jpeg = base64.b64decode(event.get("data", ""))
                except Exception:  # noqa: BLE001
                    continue
                save_eye_file(jpeg)                                # 原画面永远留最新一帧给回复端自己看
                if call.video_mode == "screen":
                    await screen_frame(ws, call, http, jpeg)
                elif call.video_mode == "companion":
                    await companion_frame(ws, call, http, jpeg)
                elif call.eyes.should_describe(jpeg):
                    desc = await call.eyes.describe(http, jpeg)
                    if desc and call.video:
                        await send(ws, {"type": "observation", "content": desc})
                        await notify_adapter(http, {"type": "saw", "call_session_id": call.id, "text": desc, "frame": EYE_FILE})
            elif kind == "hangup":
                remove_eye_file()
                return


async def main() -> None:
    async with serve(session, HOST, PORT, max_size=None):
        print(f"PaiVoice listening on ws://{HOST}:{PORT}")
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
