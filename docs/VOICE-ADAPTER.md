# VoiceAdapter v1（草案）

每个适配器只处理“把一次已转录的话交给回复端，并把回复安全地交回 PaiVoice”。它不拥有麦克风，不保存原始语音，也不决定页面视觉。

```ts
interface VoiceAdapter {
  onTurn(turn: {
    callSessionId: string;
    turnId: string;
    transcript: string;
    prosody?: Record<string, unknown>;
    observation?: string;        // 开着摄像头时：最近一次看到的画面描述
  }): AsyncIterable<{ type: 'text' | 'done' | 'error'; text?: string }>;
  cancel(turnId: string): Promise<void>;
  status(): Promise<{ ready: boolean; detail?: string }>;
}
```

## 视频（可选，和语音并行）

前端可以在通话中随时开关摄像头，不断线：

| 方向 | 消息 | 说明 |
| --- | --- | --- |
| 前端 → 核心 | `{"type":"video","on":true|false}` | 开/关摄像头 |
| 前端 → 核心 | `{"type":"frame","data":"<base64 jpeg>","ts":…}` | 实时模式每 5 秒一帧、陪伴模式每 20 秒一帧，480 宽 |
| 前端 → 核心 | `{"type":"video_mode","mode":"live"|"companion"}` | 切实时 / 陪伴模式，不用重开摄像头 |
| 核心 → 前端 | `{"type":"video","on":…,"eyes":…,"mode":…}` | 回执；`eyes` 表示服务端配了视觉模型 |
| 核心 → 前端 | `{"type":"video_mode","mode":…}` | 切模式回执 |
| 核心 → 前端 | `{"type":"observation","content":"…"}` | 视觉模型的描述（前端可以选择不显示） |
| 核心 → 适配器 | `POST /event {"type":"camera","on":…,"mode":…,"frame":…}` / `{"type":"saw","text":…,"frame":…}` | 可选；适配器没实现 `/event` 就忽略 |
| 核心 → 适配器 | `POST /event {"type":"companion","kind":"left"|"back"|"gesture"|"still","text":…,"frame":…}` | 陪伴模式唯一的开口通道，每条都是"想说就一句" |
| 核心 → 适配器 | `onTurn` 的 `turn` 多一个 `observation?: string` | 最近一次看到的画面，随这轮一起给 |

原画面：核心把最新一帧写到 `PAIVOICE_EYE_FILE`（默认 `/tmp/paivoice-eye-latest.jpg`），回复端想亲眼看就读它；关摄像头或挂断时删掉。视觉模型走一条可配置的链（任何 OpenAI 兼容多模态接口），单家 `PAIVOICE_VISION_TIMEOUT`、整轮 `PAIVOICE_VISION_TOTAL_TIMEOUT` 超时就丢这一帧。

### 陪伴模式

对方工作或学习时把摄像头切到 `companion`：前端抽帧降到 20 秒一次；核心不再逐帧描述、不发 `saw`、不发 `observation`，而是维护一个小状态机（在不在 / 在做什么），视觉模型只回一行 JSON `{present, activity, notable}`（`PAIVOICE_VISION_COMPANION_PROMPT` 可换）。只有四种情况给适配器 `companion` 事件：

- `left`：离开座位 `PAIVOICE_COMPANION_ABSENT_SECONDS`（默认 120）秒。
- `back`：回来了。
- `gesture`：值得搭话的小动作（伸懒腰、趴桌、揉眼、发呆、玩手机……）。和 left/back 共用 `PAIVOICE_COMPANION_NUDGE_SECONDS`（默认 120）秒冷却。
- `still`：`PAIVOICE_COMPANION_STILL_SECONDS`（默认 1800）秒没动静，text 里轮流写"提醒喝口水 / 站起来活动一下"。

模型最少 `PAIVOICE_COMPANION_ASSESS_MIN_SECONDS`（60）秒问一次，没动静也每 `PAIVOICE_COMPANION_ASSESS_MAX_SECONDS`（300）秒保底问一次；像素差门槛是实时模式的 `PAIVOICE_COMPANION_DIFF_MULT`（2）倍。适配器的回复端拿到 `companion` 事件后想说一句就说，不想说也行。

网页端：`call.enableVideo(facing)` / `call.disableVideo()` / `call.flipCamera()` / `call.setVideoMode('live'|'companion')`，`on.video(el)` 拿到预览用的 `<video>`（把这个元素本身挂进页面，同一路流不要再开第二个元素，iOS 会让第二个黑屏）。麦克风在挂断、连接断开、接通失败三条路上都会真正释放；静音是真停音轨（iOS 的指示灯只认这个）。

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
