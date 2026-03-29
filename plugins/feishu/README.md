# xgw-plugin-feishu

飞书（Feishu / Lark）渠道插件，为 [xgw](../../README.md) 网关提供飞书 IM Bot 接入能力。

通过飞书 WebSocket 长连接接收消息，无需公网 IP，部署简单。

## 功能

- WebSocket 长连接接收飞书消息（SDK 内置自动重连）
- 支持单聊（p2p）和群聊（group）
- 群聊可配置是否需要 @bot 才触发
- 收到消息立即添加 👀 reaction，表示已收到
- 真正的流式响应：通过飞书 CardKit API 创建 streaming card，实时更新内容
- 进度状态（thinking / tool_call 等）在同一张卡片内更新，无需额外消息
- 凭证验证（`pair`）：自动获取 bot open_id

## 安装

```bash
npm install @theclawlab/xgw-plugin-feishu
```

## 飞书应用配置

使用**企业自建应用**，需要以下凭证：

| 凭证 | 说明 |
|------|------|
| `appId` | 应用 ID（`cli_xxxx`） |
| `appSecret` | 应用密钥 |

所需权限：

- `im:message` — 获取与发送消息
- `im:message:send_as_bot` — 以机器人身份发送消息

在飞书开发者后台开启 **WebSocket 模式**（事件订阅 → 长连接），订阅 `im.message.receive_v1` 事件。

## xgw 配置

在 `config.yaml` 的 `channels` 中添加：

```yaml
channels:
  - id: feishu-main
    type: feishu
    paired: true
    pair_mode: ws
    appId: "cli_xxxx"
    appSecret: "xxxx"
    domain: feishu          # feishu（默认）或 lark（国际版）
    requireMention: true    # 群聊是否需要 @bot，默认 true
    streamingThrottleMs: 100  # streaming card 更新节流，默认 100ms
```

### 配置字段

| 字段 | 类型 | 必需 | 默认值 | 说明 |
|------|------|:----:|--------|------|
| `appId` | string | ✅ | — | 飞书应用 ID |
| `appSecret` | string | ✅ | — | 飞书应用密钥 |
| `domain` | `'feishu'` \| `'lark'` \| URL | — | `'feishu'` | API 域名 |
| `requireMention` | boolean | — | `true` | 群聊是否需要 @bot |
| `streamingThrottleMs` | number | — | `100` | Streaming card 更新节流间隔（ms） |

## 消息行为

**收到消息时：** 立即在原消息上添加 👀 reaction，表示已收到（best-effort，失败不影响处理）。

**Streaming 流程：**
1. 收到第一个 `progress` 或 `stream: 'chunk'` 时，通过 CardKit API 创建 streaming card 并发送 interactive 消息
2. 后续 chunk 通过 `PUT /cardkit/v1/cards/:id/elements/content/content` 实时更新卡片内容（节流）
3. `stream: 'end'` 时写入最终文本，然后 `PATCH /cardkit/v1/cards/:id/settings` 关闭 streaming mode

**进度状态映射：**

| progress | 显示文本 |
|----------|---------|
| `thinking` | 🤔 思考中... |
| `tool_call` | 🔧 调用工具... |
| `tool_result` | 📋 处理结果... |
| `compact_start` | 🗜️ 压缩上下文... |
| `compact_end` | ✅ 上下文已压缩 |

**session_id 策略：**
- 单聊（p2p）：`session_id = sender open_id`
- 群聊（group）：`session_id = chat_id`

**消息类型支持：**

| 飞书消息类型 | 处理方式 |
|-------------|---------|
| `text` | 直接提取文本 |
| `post` | 递归提取文本节点拼接 |
| `image` | `[image]` 占位符 |
| `file` | `[file: name]` 占位符 |
| 其他 | `[unsupported: type]` 占位符 |

**Streaming：** 使用飞书 CardKit API 实现真正的流式更新，每个 session 维护一个 streaming card，chunk 实时写入，`stream: 'end'` 时关闭 streaming mode。

## 开发

```bash
npm install
npm run build       # 构建
npm run test        # 单次测试
npm run dev         # watch 模式构建
```

## 与 OpenClaw Feishu Extension 的差异

本插件是面向 xgw 的最小化实现，不包含 OpenClaw 的 pairing 流程、Rich Card、多账号、附件处理等功能。详见 [SPEC.md](./SPEC.md)。

## License

MIT
