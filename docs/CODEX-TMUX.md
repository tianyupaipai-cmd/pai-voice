# Codex CLI / tmux 接入

PaiVoice 与**用户自己运行的 Codex CLI tmux 会话**协作，而不是操控 Codex 桌面客户端。tmux Adapter 负责把一轮转录贴入窗口；Codex 依照项目规则调用 `pai-voice-reply` 将最终文本交回语音层。

## 1. 启动通用 tmux Adapter

```bash
cd packages/adapters/tmux
npm install
export PAIVOICE_TMUX_SESSION=your-codex-session
export PAIVOICE_ADAPTER_TOKEN=generate-a-local-secret
npm link
npm start
```

同时给 realtime core 设置：

```bash
export PAIVOICE_ADAPTER_URL=http://127.0.0.1:8791
export PAIVOICE_ADAPTER_TOKEN=generate-a-local-secret
```

两个 token 必须相同，但不要写进仓库或 `AGENTS.md`。

## 2. 在目标项目的 `AGENTS.md` 加入规则

```md
## PaiVoice call turns

When a prompt begins with `[PaiVoice call turn: <id>]`, answer the caller in a
brief, natural spoken style. Once the answer is ready, invoke exactly once:

`pai-voice-reply --turn-id <id> --text "your final spoken reply"`

Never expose the turn id, adapter URL, token, or callback command in the reply.
```

## 3. 权限与审批模式

第一次使用时，让 Codex 正常请求执行 `pai-voice-reply` 的批准。确认命令路径和参数无误后，可以只为这一个命令建立项目级规则；不要因为语音桥接而关闭 Codex 的审批模式。

Codex 的公开文档并未在此处承诺一个稳定的“最终回复 Hook”协议，因此本方案用明确、可审计的本地回传命令，而不依赖未文档化的内部事件。

## 4. 验证

在 tmux 中运行 `pai-voice-reply --help`，再从 PaiVoice 发一条文字测试。收到的 Codex 提示会带 `turn_id`；它调用回传命令后，网页将收到文本及可选 TTS 音频。
