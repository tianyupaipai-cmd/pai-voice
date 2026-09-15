# PaiVoice

**一个可自托管、可替换模型的实时语音通话底座。**

PaiVoice 让 PaiHome/PWA 成为统一的通话界面：负责收音、实时字幕、播放、打断和通话状态；模型、终端和语音服务都通过 Adapter 接入，而不是绑定某一个官方客户端。

> 这不是"把某个官方客户端嵌进网页"。PaiVoice 是自己的前端和实时通话层；Claude、Codex、GPT、终端或本地模型只是可替换的回复端。

## 能接什么

| 层 | 可选实现 |
| --- | --- |
| 前端 | PaiHome、PWA、任意自制 Web 前端 |
| 语音识别（ASR） | 云端 Whisper、Groq、OpenAI，或本地 Whisper/whisper.cpp |
| 推理 / 对话 | Claude CLI/tmux、Codex CLI/tmux、OpenAI API、Ollama、任意 JSONL/HTTP 终端 |
| 语音合成（TTS） | 云端 TTS 或本地 TTS |
| 通信 | WebSocket；可扩展 WebRTC / SIP |

## 架构

```text
PaiHome / PWA
  └─ PaiVoice Core
      ├─ 麦克风与回声处理
      ├─ 实时字幕与状态
      ├─ 语音播放 / 温和打断
      └─ Call Event Protocol
          └─ Voice Adapter
              ├─ claude-tmux
              ├─ codex-tmux
              ├─ openai-realtime
              ├─ generic-terminal
              └─ local-model
```

## 源码申请

源码不再公开托管，改为邮件申请。这是一个陪伴向的项目，我希望它到真正和 AI 一起生活的人手里。

请发邮件到 **654572045@qq.com** 或 **tianyupaipai@gmail.com**，邮件里带上：

1. **申请理由**：你是谁、打算用它做什么。
2. **你和机相处的日常截图 2～3 张**（聊天、通话、一起做的事都可以）。

通过后会把源码发给你。源码遵循 AGPL-3.0（见 LICENSE）。

**商务合作**也走同一个邮箱，标题注明"商务合作"即可。

---

## Source access

The source is no longer hosted publicly. To request it, email **654572045@qq.com** or **tianyupaipai@gmail.com** with (1) a short note on who you are and what you want to build, and (2) two or three screenshots of your day-to-day life with your AI companion. Approved requests receive the source under AGPL-3.0. Business inquiries are welcome at the same address.
