# xgw-plugin-feishu

飞书（Feishu / Lark）渠道插件，为 [xgw](../../README.md) 网关提供飞书 IM Bot 接入能力。

通过飞书 WebSocket 长连接接收消息，无需公网 IP，部署简单。

## 功能

- WebSocket 长连接接收飞书消息（SDK 内置自动重连）
- 支持单聊（p2p）和群聊（group）
- 群聊可配置是否需要 @bot 才触发
- Streaming 支持：中间 chunk 丢弃，`stream: 'end'` 时发送完整回复
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
    streamingCoalesceMs: 500
```

### 配置字段

| 字段 | 类型 | 必需 | 默认值 | 说明 |
|------|------|:----:|--------|------|
| `appId` | string | ✅ | — | 飞书应用 ID |
| `appSecret` | string | ✅ | — | 飞书应用密钥 |
| `domain` | `'feishu'` \| `'lark'` \| URL | — | `'feishu'` | API 域名 |
| `requireMention` | boolean | — | `true` | 群聊是否需要 @bot |
| `streamingCoalesceMs` | number | — | `500` | Streaming 合并间隔（ms，当前版本未使用） |

## 消息行为

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

**Streaming：** 当前实现丢弃中间 `chunk`，在 `stream: 'end'` 时发送完整文本（飞书文本消息不支持编辑）。

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
