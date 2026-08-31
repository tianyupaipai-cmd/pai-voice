# PaiVoice

**一个可自托管、可替换模型的实时语音通话底座。**

PaiVoice 让 PaiHome/PWA 成为统一的通话界面：负责收音、实时字幕、播放、打断和通话状态；模型、终端和语音服务都通过 Adapter 接入，而不是绑定某一个官方客户端。

> 这不是“把某个官方客户端嵌进网页”。PaiVoice 是自己的前端和实时通话层；Claude、Codex、GPT、终端或本地模型只是可替换的回复端。

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

## GPT / OpenAI 的原生使用建议

如果目标是最低延迟、最自然的双工语音，优先使用 OpenAI Realtime API 作为 `openai-realtime` Adapter：它可通过 WebRTC、WebSocket 或 SIP 处理实时音频输入和输出。PaiVoice 仍负责自己的 UI、通话状态、记忆/工具桥接以及隐私策略。

不要尝试依赖或控制 ChatGPT、Claude 等官方消费级客户端的内部语音界面；这类客户端并不是可稳定桥接的公开接口。应使用 API，或使用用户自己掌控的 CLI/tmux 进程作为 Adapter。

## 调参是产品的一部分

PaiVoice 不存在对所有人都正确的一组数值。以下都必须依据真实通话反复磨合：

- **延迟阈值**：ASR 分段、句子多久开始播报、网络抖动缓冲。
- **转录策略**：静音多长算一句结束、错字纠正、是否把语气信息送给模型。
- **打断策略**：用户轻声附和时不应掐断对方；明确说话时才停止当前播音。
- **回复节奏**：终端模型输出较慢时，需要短确认、流式分句或等待提示。
- **声音个性**：音色、速度、停顿和情绪不应由默认值替代磨合。

建议把这些参数做成每个“人—窗口—设备”可独立保存的配置，而不是全局硬编码。

## 开源边界与隐私

仓库只应包含通用代码、协议、示例配置和模拟数据。**绝不提交** API Key、`.env`、真实通话音频、转录、记忆库、日记、私人提示词、语音 ID 或真实服务器地址。

各 Adapter 的代码可以公开；第三方模型服务、账号权限、模型费用和其各自条款不随本仓库授予。

部署前请先阅读 [密钥与语音隐私](docs/SECRETS.md)：真实 Key 只留在服务器的部署环境中，浏览器和 PWA 永远不持有长期供应商密钥。

## 开始方式（计划）

1. 定义稳定的 `VoiceAdapter` 接口：`onTurn`、`cancel`、`status`。
2. 迁入并整理 `claude-tmux` Adapter。
3. 增加同规格 `codex-tmux` Adapter。
4. 实现 `openai-realtime` Adapter，作为原生全双工选项。
5. 用模拟模型和假音频完成本地开发示例。

## 现已包含的主体代码

- [`packages/web-client/voice-call.js`](packages/web-client/voice-call.js)：无依赖浏览器通话客户端；PCM 捕获、VAD、回声抑制、流式音频队列、温和打断与实时状态事件。
- [`packages/realtime-core/server.py`](packages/realtime-core/server.py)：可运行的 WebSocket 通话核心；供应商可替换的 ASR、Adapter 与 TTS 管线。
- [`packages/adapters/tmux`](packages/adapters/tmux)：把已转录的话安全粘贴给用户自己掌控的 tmux 窗口，并等待其 hook 回传回复的适配器。

最小本地启动：先安装 `packages/realtime-core/requirements.txt`，配置自己的服务器环境变量，再运行 `python packages/realtime-core/server.py`。默认 `mock` 模式不调用任何云服务；接入 Groq、ElevenLabs 或 OpenAI 前，请阅读 [密钥与语音隐私](docs/SECRETS.md)。

## 许可

本项目采用 [GNU AGPL-3.0](LICENSE)。可以使用、修改与商用；若将修改版通过网络向用户提供服务，须向这些用户提供相应源码。第三方模型服务、账号权限、密钥和个人数据不包含在本许可内。
