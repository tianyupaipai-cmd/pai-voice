# VoiceAdapter v1（草案）

每个适配器只处理“把一次已转录的话交给回复端，并把回复安全地交回 PaiVoice”。它不拥有麦克风，不保存原始语音，也不决定页面视觉。

```ts
interface VoiceAdapter {
  onTurn(turn: {
    callSessionId: string;
    turnId: string;
    transcript: string;
    prosody?: Record<string, unknown>;
  }): AsyncIterable<{ type: 'text' | 'done' | 'error'; text?: string }>;
  cancel(turnId: string): Promise<void>;
  status(): Promise<{ ready: boolean; detail?: string }>;
}
```

## 适配器约束

- `onTurn` 必须可串行排队，避免把两句电话话语同时注入同一终端。
- `cancel` 只停止当前播音或当前轮次；不得删除用户的终端历史。
- 只在真实通话处于 active 状态时接收轮次。
- API Key、终端地址和个人上下文只放在部署环境变量中。
- 终端适配器应使用项目内明确允许的命令，避免扩大自动执行权限。

## 实现优先级

1. `claude-tmux`：用户拥有的 tmux 进程。
2. `codex-tmux`：同样保留审批/权限模式。
3. `openai-realtime`：音频可直接在 API 会话中流转，适合全双工。
4. `generic-terminal`：JSONL、HTTP 回调或 stdin/stdout。
5. `local-model`：Ollama 或自托管推理服务。
