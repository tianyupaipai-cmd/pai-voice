# tmux Adapter

运行在与目标终端相同的机器上。它只把已转录文本粘贴进你指定的 tmux 会话，并等待终端 Agent 用 `pai-voice-reply` 回传回复。

```bash
export PAIVOICE_TMUX_SESSION=my-agent
export PAIVOICE_ADAPTER_TOKEN=replace-with-a-local-secret
npm link
npm start
```

将 realtime core 的 `PAIVOICE_ADAPTER_URL` 设为 `http://127.0.0.1:8791`。安装这个包后会提供 `pai-voice-reply`；终端 Agent 完成一轮后调用：

```bash
pai-voice-reply --turn-id "<turn id>" --text "<reply text>"
```

不要将 token、终端历史或私有提示词提交进仓库。

通话事件：realtime core 会把接通（`call_start`）、断线（`call_dropped`）、接回（`call_resumed`）、挂断（`call_end`）、摄像头开关、屏幕描述等 POST 到 `/event`，这个适配器把每一个都贴成一行 `[PaiVoice …]` 进终端，Agent 不会漏掉通话状态。对方连着说几句时，几轮可以同时在等回复，各自用 `--turn-id` 回就行。

没办法往终端里打字的环境，改用 [`../file`](../file) 的文件 + Monitor 接法。
