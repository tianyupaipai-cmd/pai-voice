# Claude CLI / tmux 接入

PaiVoice 不控制 Claude 的官方客户端 UI；它与**你自己运行的 Claude CLI tmux 会话**协作。实时核心把转录交给 tmux Adapter，Adapter 将此轮的 `turn_id` 和 `pai-voice-reply` 回传命令一同粘贴进终端。

## 1. 启动 Adapter

```bash
cd packages/adapters/tmux
npm install
export PAIVOICE_TMUX_SESSION=your-claude-session
export PAIVOICE_ADAPTER_TOKEN=generate-a-local-secret
npm link
npm start
```

将 realtime core 的 `PAIVOICE_ADAPTER_URL` 设为 `http://127.0.0.1:8791`，并设置相同的 `PAIVOICE_ADAPTER_TOKEN`。

## 2. 给 Claude 项目加入通话规则

将以下内容放入该项目自己的 `CLAUDE.md`。不要把真实 token 写进去；让终端环境变量提供它。

```md
## PaiVoice call turns

When a prompt begins with `[PaiVoice call turn: <id>]`, respond naturally and
briefly to the caller. When the response is ready, call exactly once:

`pai-voice-reply --turn-id <id> --text "your final spoken reply"`

Do not include the callback protocol in the spoken reply.
```

## 3. 最小权限

只给 `pai-voice-reply` 这一条本地命令添加允许规则；不要为通话而开启全局自动执行或跳过权限。首次通话应人工确认一次，再决定是否为此命令建立项目级允许规则。

## 4. 验证

先在 tmux 内确认 Claude 能执行 `pai-voice-reply --help`。从 PaiVoice 发一条文本测试：终端会收到带 turn id 的提示，Claude 回复后调用回传命令，网页应先收到文字，再按 TTS 配置播放声音。
