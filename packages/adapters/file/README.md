# File Adapter（文件 + Monitor 接法）

给「没有办法往终端窗口里打字」的环境用：适配器不碰终端，只把每一句话和每个通话事件写成一行 JSON，追加到收件文件；终端里的 Agent 自己盯着这个文件，看到一句就回。

```bash
export PAIVOICE_INBOX=/tmp/pai-voice-inbox.jsonl
export PAIVOICE_ADAPTER_TOKEN=replace-with-a-local-secret
npm start
```

realtime core 的 `PAIVOICE_ADAPTER_URL` 设为 `http://127.0.0.1:8791`。回复和 tmux 接法完全一样，用 tmux 适配器装的 `pai-voice-reply`：

```bash
pai-voice-reply --turn-id "<turn id>" --text "<reply text>"
```

Agent 那边：开一个后台监视（例如 Claude Code 的 Monitor）跑 `tail -F /tmp/pai-voice-inbox.jsonl`，每来一行 `{"type":"turn",…}` 就回一句；`call_start / call_dropped / call_resumed / call_end / camera / screen` 这些事件也在同一个文件里。

注意：监视是 Agent 自己开的。有的工具会让后台监视过一段时间自动到期，到期没重开，这通电话就没人听了——这是这种接法最大的坑。能往终端里打字的话，优先用 tmux 接法（见 `../tmux/README.md`）。
