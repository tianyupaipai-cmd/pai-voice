"""PaiVoice · 眼睛（可选）。

视频通话时前端每隔几秒抽一帧 JPEG 发过来；这里只在画面明显变化、且距上次描述够久时，
沿一条可配置的视觉模型链逐家描述（任何 OpenAI 兼容的多模态接口都行），每家单次超时、整轮超时，
超了就丢这一帧不堵下一帧；上一帧还在描述时新帧直接跳过。

配置（全部环境变量，缺 key 的后端自动跳过）：
  PAIVOICE_VISION_BACKENDS=deepseek,qwen        链子顺序；名字随便起，下面按名字找配置
  PAIVOICE_VISION_<NAME>_BASE_URL / _API_KEY / _MODEL / _PROXY(可选)
  PAIVOICE_VISION_TIMEOUT=12   PAIVOICE_VISION_TOTAL_TIMEOUT=25
  PAIVOICE_VISION_DIFF_THRESHOLD=0.06（32×32 灰度平均像素差）  PAIVOICE_VISION_MIN_INTERVAL=8（秒）
  PAIVOICE_VISION_PROMPT  描述提示词（默认见下）
  PAIVOICE_VISION_COMPANION_PROMPT  陪伴模式提示词：只回一行 JSON {present, activity, notable}
  PAIVOICE_VISION_SCREEN_PROMPT / PAIVOICE_VISION_STORY_PROMPT  屏幕共享模式：单帧 / 多帧串剧情的提示词
"""

from __future__ import annotations

import asyncio
import base64
import io
import logging
import os
import re
import time

import aiohttp

log = logging.getLogger("paivoice.vision")

VISION_TIMEOUT = float(os.getenv("PAIVOICE_VISION_TIMEOUT", "12"))
VISION_TOTAL_TIMEOUT = float(os.getenv("PAIVOICE_VISION_TOTAL_TIMEOUT", "25"))
DIFF_THRESHOLD = float(os.getenv("PAIVOICE_VISION_DIFF_THRESHOLD", "0.06"))
MIN_INTERVAL = float(os.getenv("PAIVOICE_VISION_MIN_INTERVAL", "8"))
PROMPT = os.getenv(
    "PAIVOICE_VISION_PROMPT",
    "这是视频通话时从对方摄像头里抽的一帧。用中文、两句话以内描述你看到的：对方在哪、在做什么、表情和状态、有没有值得一提的细节。只描述，不评价，不打招呼，不加前缀。",
)


COMPANION_PROMPT = os.getenv(
    "PAIVOICE_VISION_COMPANION_PROMPT",
    "这是视频通话中从对方摄像头里抽的一帧。对方在工作或学习，你只是安静的观察员。只输出一行 JSON，不要任何别的字："
    '{"present": 画面里有没有人（true/false）, "activity": "在做什么，十个字以内", '
    '"notable": "值得搭话的小动作：伸懒腰、趴桌、揉眼、打哈欠、明显发呆走神、一直玩手机、对镜头笑或摆手之类，十个字以内；正常工作学习就写空字符串"}',
)


SCREEN_PROMPT = os.getenv(
    "PAIVOICE_VISION_SCREEN_PROMPT",
    "这是通话中对方共享的电脑屏幕截图。用中文、三句话以内说清画面现在的状态：是什么界面/游戏/视频、正在发生什么、"
    "屏幕上关键的文字（字幕、选项、对话、数值、提示）。只描述，不评价，不打招呼，不加前缀。",
)

# 屏幕共享时一次只看一帧，字幕半句、剧情接不上：把这几秒里的几帧按顺序一起给模型，串成一两句
STORY_PROMPT = os.getenv(
    "PAIVOICE_VISION_STORY_PROMPT",
    "这是通话中对方共享的电脑屏幕，下面是按时间顺序的 {n} 张截图，前后大约 {secs} 秒。对方多半在看剧或视频，也可能在玩游戏、看网页。"
    "如果是剧或视频：先把这几张里的字幕按先后原样摘出来（重复的只写一次，每句用「」括起来），"
    "再用一两句话把这几秒的剧情串起来：谁、在做什么、什么情绪。"
    "如果是游戏或网页：说清是什么界面、这几秒里发生了什么变化、屏幕上关键的文字（选项、对话、数值、提示）。"
    "只描述，不评价，不打招呼，不加前缀，总共不超过五句。",
)


def parse_assessment(text: str) -> dict:
    """解模型回的那行 JSON；解不出就当"在、看不清"，不打扰。"""
    import json as _json
    m = re.search(r"\{.*\}", text or "", re.S)
    if m:
        try:
            d = _json.loads(m.group(0))
            return {"present": bool(d.get("present", True)),
                    "activity": str(d.get("activity") or "").strip()[:40],
                    "notable": str(d.get("notable") or "").strip()[:40]}
        except Exception:  # noqa: BLE001
            pass
    return {"present": True, "activity": (text or "").strip()[:40], "notable": ""}


def backend_chain() -> list[dict]:
    chain: list[dict] = []
    for name in [x.strip() for x in os.getenv("PAIVOICE_VISION_BACKENDS", "").split(",") if x.strip()]:
        key = name.upper().replace("-", "_")
        base = os.getenv(f"PAIVOICE_VISION_{key}_BASE_URL", "").rstrip("/")
        api_key = os.getenv(f"PAIVOICE_VISION_{key}_API_KEY", "")
        model = os.getenv(f"PAIVOICE_VISION_{key}_MODEL", "")
        if base and api_key and model:
            chain.append({"name": name, "base": base, "key": api_key, "model": model,
                          "proxy": os.getenv(f"PAIVOICE_VISION_{key}_PROXY", "").strip() or None})
        else:
            log.warning("vision 后端 %s 缺 BASE_URL/API_KEY/MODEL，跳过", name)
    return chain


def _thumb(jpeg: bytes):
    """JPEG → 32×32 灰度（numpy 数组）。没装 PIL/numpy 就返回 None（当作每帧都变了）。"""
    try:
        import numpy as np
        from PIL import Image
        im = Image.open(io.BytesIO(jpeg)).convert("L").resize((32, 32))
        return np.asarray(im, dtype="float32") / 255.0
    except Exception:  # noqa: BLE001
        return None


class Eyes:
    def __init__(self) -> None:
        self.chain = backend_chain()
        self.enabled = bool(self.chain)
        self._last_thumb = None
        self._last_desc_at = 0.0
        self.busy = False
        self.last_observation: str | None = None
        self.last_backend: str | None = None
        log.info("vision 链：%s", " → ".join(b["name"] for b in self.chain) or "off")

    def changed(self, jpeg: bytes, threshold: float = DIFF_THRESHOLD) -> bool:
        t = _thumb(jpeg)
        if t is None:
            return True
        prev, self._last_thumb = self._last_thumb, t
        if prev is None:
            return True
        return float(abs(t - prev).mean()) >= threshold

    def should_describe(self, jpeg: bytes) -> bool:
        if not self.enabled or self.busy:
            return False
        if time.time() - self._last_desc_at < MIN_INTERVAL:
            self.changed(jpeg)            # 间隔内也更新基线，慢慢变化才检测得到
            return False
        return self.changed(jpeg)

    async def describe(self, session: aiohttp.ClientSession, jpeg: bytes) -> str | None:
        """实时模式：两句自由描述。"""
        return await self._run(session, jpeg, PROMPT)

    async def assess(self, session: aiohttp.ClientSession, jpeg: bytes) -> dict | None:
        """陪伴模式：只问在不在、在干什么、有没有值得搭话的小动作。"""
        raw = await self._run(session, jpeg, COMPANION_PROMPT)
        if raw is None:
            return None
        d = parse_assessment(raw)
        self.last_observation = d["activity"] or ("画面里没人" if not d["present"] else None)
        return d

    async def story(self, session: aiohttp.ClientSession, frames: list[bytes], secs: float) -> str | None:
        """屏幕共享：几帧按顺序一起交给模型（要能一次看多张图），串成这几秒发生的事；失败就退回只看最后一帧。"""
        if not frames:
            return None
        if len(frames) > 1:
            desc = await self._run(session, frames, STORY_PROMPT.format(n=len(frames), secs=round(secs)))
            if desc:
                return desc
        return await self._run(session, frames[-1], SCREEN_PROMPT)

    async def _run(self, session: aiohttp.ClientSession, jpeg: bytes | list[bytes], prompt: str) -> str | None:
        self._last_desc_at = time.time()
        if self.busy:
            return None
        self.busy = True
        started = time.time()
        try:
            for backend in self.chain:
                left = VISION_TOTAL_TIMEOUT - (time.time() - started)
                if left <= 1:
                    log.warning("画面描述整轮超过 %.0fs，这帧丢掉", VISION_TOTAL_TIMEOUT)
                    return None
                try:
                    desc = await asyncio.wait_for(self._describe(session, jpeg, backend, prompt), timeout=min(VISION_TIMEOUT, left))
                except asyncio.TimeoutError:
                    log.warning("画面描述 %s 超过 %.0fs，换下一家", backend["name"], VISION_TIMEOUT)
                    continue
                except Exception as e:  # noqa: BLE001
                    log.warning("画面描述 %s 失败：%s，换下一家", backend["name"], e)
                    continue
                desc = (desc or "").strip()
                if desc:
                    self.last_observation = desc
                    self.last_backend = backend["name"]
                    return desc
            return None
        finally:
            self.busy = False

    async def _describe(self, session: aiohttp.ClientSession, jpeg: bytes | list[bytes], backend: dict, prompt: str = PROMPT) -> str:
        frames = jpeg if isinstance(jpeg, list) else [jpeg]
        body = {
            "model": backend["model"],
            "max_tokens": 600,
            "messages": [{"role": "user", "content": [
                {"type": "text", "text": prompt},
                *({"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + base64.b64encode(f).decode()}} for f in frames),
            ]}],
        }
        async with session.post(f"{backend['base']}/chat/completions", json=body,
                                headers={"authorization": f"Bearer {backend['key']}"},
                                proxy=backend.get("proxy"),
                                timeout=aiohttp.ClientTimeout(total=VISION_TIMEOUT + 2)) as r:
            data = await r.json(content_type=None)
            if r.status != 200:
                raise RuntimeError(str(data)[:200])
            return data["choices"][0]["message"]["content"]
