# tmux Adapter

运行在与目标终端相同的机器上。它只把已转录文本粘贴进你指定的 tmux 会话，并等待你自己的 CLI hook 将回复 POST 回来。

```bash
export PAIVOICE_TMUX_SESSION=my-agent
export PAIVOICE_ADAPTER_TOKEN=replace-with-a-local-secret
npm start
```

将 realtime core 的 `PAIVOICE_ADAPTER_URL` 设为 `http://127.0.0.1:8791`。你的终端完成一轮后，调用：

```bash
curl -X POST http://127.0.0.1:8791/reply \
  -H "Authorization: Bearer $PAIVOICE_ADAPTER_TOKEN" \
  -H "content-type: application/json" \
  -d '{"turn_id":"<turn id>","reply":"<reply text>"}'
```

不要将 token、终端历史或私有提示词提交进仓库。
