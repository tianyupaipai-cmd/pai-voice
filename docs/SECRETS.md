# 密钥、转录与发声服务

PaiVoice 的代码可以公开，**供应商密钥与用户语音数据不可以**。本文件是部署要求，不是把真实凭据填进仓库的地方。

## 推荐的职责划分

```text
浏览器 / PWA
  └─ 只连接自己的 PaiVoice 网关，不知道任何供应商 Key

PaiVoice 网关（服务器）
  ├─ ASR Key：用于转录服务
  ├─ TTS Key：用于发声服务
  └─ 模型 / Realtime Key：用于模型服务
```

浏览器只能获得自己的会话凭证，或由网关代为建立连接；**不要**把 `OPENAI_API_KEY`、转录服务 Key、TTS Key 写进前端代码、PWA 配置、构建产物或移动端包。

## 环境变量建议

将真实值放在服务器部署环境的 `.env`、systemd `EnvironmentFile`、Docker/云平台 Secret 中；仓库仅保留 `.env.example` 的空变量名。

```dotenv
PAIVOICE_ASR_PROVIDER=groq
PAIVOICE_TTS_PROVIDER=elevenlabs
PAIVOICE_ASR_API_KEY=replace-in-server-secret-store
PAIVOICE_TTS_API_KEY=replace-in-server-secret-store
```

- ASR、TTS、推理服务使用独立 Key；泄露或停用时可单独轮换。
- 能限制额度、项目、来源或权限的 Key，一律开启限制。
- 服务器上的 `.env` 只允许运行账户读取（例如 `chmod 600`）。
- 日志只记录供应商名称、请求耗时与错误类别；不得记录 Authorization 头、完整转录、原始音频或合成音频地址。
- 一旦 Key 出现在截图、终端记录、提交历史或聊天记录中，应立即在供应商后台撤销并生成新 Key，而不是只改仓库文件。

## OpenAI Realtime 的接入建议

OpenAI Realtime 可通过 WebRTC、WebSocket 或 SIP 提供实时音频能力。推荐由 PaiVoice 服务器创建或代理会话：浏览器只与 PaiVoice 会话交互，服务器使用长期 OpenAI Key。这样仍可保留 PaiVoice 的通话状态、记忆桥接、额度控制与隐私策略。

如果后续采用直接 WebRTC，仍不要把长期 OpenAI API Key 发到浏览器；应由自己的服务器完成受控的会话建立，并把用户身份、通话时长与额度校验放在此前。

## 录音与转录保留策略

默认建议：原始音频不落盘；实时转录只用于当前通话；如需诊断，采用显式开关、最短保留期与可删除的独立目录。不要将真实录音、转录、声纹/语音 ID、日记或记忆文件提交到 Git。

## 发布前检查

```text
□ .env、录音、转录、日志、私有记忆均未被 Git 跟踪
□ 前端产物中没有供应商 Key
□ 示例配置没有真实地址、账号或 token
□ 服务端已设置独立 Key 与额度上限
□ 真实语音数据有明确的保留/删除策略
```
