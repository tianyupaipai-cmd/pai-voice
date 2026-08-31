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
