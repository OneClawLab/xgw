# xgw-plugin-feishu — 飞书 IM Bot Channel Plugin

飞书（Feishu / Lark）渠道插件，实现 xgw `ChannelPlugin` 接口，使 xgw 网关能够接收和发送飞书 IM 消息。

---

## 1. 概述

### 1.1 目标

将飞书机器人作为 xgw 的一个 channel plugin 接入，支持：

- 通过 WebSocket 长连接接收飞书用户/群组消息（无需公网 IP）
- 将消息标准化为 xgw `Message` 格式，交由 gateway 路由到 agent
- 接收 agent 回复（含 streaming），通过飞书 API 发送给用户
- 健康检查、配对验证

### 1.2 参考实现

- **xgw TUI plugin** (`xgw/plugins/tui/`)：xgw 插件的标准结构和接口实现
- **OpenClaw Feishu extension** (`openclaw/extensions/feishu/`)：飞书 API 集成的成熟实现，包括消息解析、streaming、多账号等

### 1.3 设计原则

1. **最小化**：只实现 xgw `ChannelPlugin` 接口所需的功能，不搬运 OpenClaw 的 pairing、ACP binding、skill tools 等
2. **独立包**：与 TUI plugin 一样，作为独立 npm 包发布，不依赖 xgw 核心代码
3. **WebSocket only**：仅使用飞书 WebSocket 长连接模式，无需公网 IP，部署简单
4. **Streaming 友好**：支持 xgw 的 `stream` 参数，通过飞书消息编辑实现流式输出

## 2. 飞书 Bot 接入基础

### 2.1 飞书应用类型

使用**企业自建应用**（Self-Built App），需要：

| 凭证 | 说明 |
|------|------|
| `appId` | 应用 ID |
| `appSecret` | 应用密钥 |

WebSocket 模式不需要 `encryptKey` 和 `verificationToken`，飞书 SDK 的 `WSClient` 内部处理鉴权。

### 2.2 飞书 API 概览

| 操作 | API | 说明 |
|------|-----|------|
| 发送消息 | `POST /open-apis/im/v1/messages` | 支持 text、post、card、image、file 等 |
| 编辑消息 | `PATCH /open-apis/im/v1/messages/{message_id}` | 用于 streaming 更新 |
| 回复消息 | `POST /open-apis/im/v1/messages/{message_id}/reply` | 引用回复 |

### 2.3 飞书消息事件结构

入站事件 `im.message.receive_v1`：

```typescript
{
  sender: {
    sender_id: { open_id: string; user_id?: string; union_id?: string };
    sender_type: string;       // "user" | "bot" | ...
    tenant_key: string;
  };
  message: {
    message_id: string;
    root_id?: string;          // 话题根消息 ID
    parent_id?: string;        // 被回复消息 ID
    chat_id: string;           // 会话 ID（oc_ 开头为群，ou_ 开头为单聊）
    chat_type: "p2p" | "group";
    message_type: string;      // "text" | "post" | "image" | "file" | ...
    content: string;           // JSON 字符串
    mentions?: Array<{ key: string; id: { open_id: string }; name: string }>;
  };
}
```

### 2.4 所需飞书权限

| 权限 | 说明 |
|------|------|
| `im:message` | 获取与发送单聊、群组消息 |
| `im:message:send_as_bot` | 以机器人身份发送消息 |
| `contact:user.base:readonly` | 获取用户基本信息（可选，用于 sender name 解析） |

## 3. ChannelPlugin 接口实现

### 3.1 接口定义（来自 xgw）

```typescript
interface ChannelPlugin {
  readonly type: string;
  pair(config: ChannelConfig): Promise<PairResult>;
  start(config: ChannelConfig, onMessage: (msg: Message) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
  send(params: SendParams): Promise<void>;
  health(): Promise<HealthResult>;
}
```

### 3.2 `pair(config)` — 配对验证

验证飞书凭证是否有效：

1. 从 `config` 中读取 `appId`、`appSecret`
2. 调用飞书 API 获取 `tenant_access_token`
3. 成功 → `{ success: true, pair_mode: 'ws', pair_info: { botOpenId } }`
4. 失败 → `{ success: false, error: '...' }`

### 3.3 `start(config, onMessage)` — 启动监听

1. 使用 `@larksuiteoapi/node-sdk` 创建 `EventDispatcher`，注册 `im.message.receive_v1` 事件处理器
2. 使用 `WSClient` 建立到飞书的 WebSocket 长连接，传入 `EventDispatcher`
3. 收到事件 → 过滤 bot 自身消息 → 解析为 xgw `Message` → 调用 `onMessage(msg)`

SDK 的 `WSClient` 内置自动重连，无需额外处理断线。

### 3.4 `stop()` — 停止

断开 WSClient 连接，清理内部状态（streaming buffer 等）。

### 3.5 `send(params)` — 发送消息

```typescript
async send(params: SendParams): Promise<void>
```

| `params.stream` | 行为 |
|-----------------|------|
| `undefined` | 调用飞书 API 发送完整消息 |
| `'chunk'` | 累积 token 到内部 buffer；达到阈值（500ms 或 50 tokens）时编辑消息 |
| `'end'` | 用完整内容最终编辑消息，清理 buffer |

**Streaming 实现**：

1. 收到第一个 `stream: 'chunk'` 时，发送一条初始消息（如 "▍"），记录 `message_id`
2. 后续 chunk 累积到 buffer，定时（500ms）调用 `PATCH` 编辑消息
3. 收到 `stream: 'end'` 时，用完整文本做最终编辑

**Progress 事件**：

当 `params.progress` 存在时，发送对应的状态提示（如 "🤔 思考中..."），通过编辑同一条消息实现。

### 3.6 `health()` — 健康检查

检查 WSClient 连接状态，返回 `{ ok: boolean, detail: string }`。

## 4. 消息转换

### 4.1 飞书事件 → xgw Message

```typescript
function toMessage(channelId: string, event: FeishuMessageEvent): Message {
  const content = parseMessageContent(event.message.content, event.message.message_type);
  const senderId = event.sender.sender_id.open_id ?? event.sender.sender_id.user_id ?? '';

  return {
    id: event.message.message_id,
    channel_id: channelId,
    peer_id: senderId,
    peer_name: null,                    // 可选：通过 API 解析
    session_id: event.message.chat_id,  // 群聊用 chat_id，单聊用 sender open_id
    text: content,
    attachments: [],                    // v1 暂不处理附件
    reply_to: event.message.parent_id ?? null,
    created_at: new Date().toISOString(),
    raw: event,
  };
}
```

**session_id 策略**：
- 单聊（p2p）：`session_id = sender open_id`（每个用户一个会话）
- 群聊（group）：`session_id = chat_id`（每个群一个会话）

### 4.2 消息内容解析

飞书 `message.content` 是 JSON 字符串，需要按 `message_type` 解析：

| message_type | content 格式 | 提取方式 |
|-------------|-------------|---------|
| `text` | `{"text": "hello"}` | 直接取 `text` 字段 |
| `post` | 富文本 JSON | 递归提取文本节点，拼接为纯文本 |
| `image` | `{"image_key": "..."}` | 返回 `[image]` 占位符 |
| `file` | `{"file_key": "...", "file_name": "..."}` | 返回 `[file: name]` 占位符 |
| 其他 | — | 返回 `[unsupported: type]` |

### 4.3 @Bot 检测（群聊）

群聊中需要检测消息是否 @了机器人：

```typescript
function checkBotMentioned(event: FeishuMessageEvent, botOpenId?: string): boolean {
  if (!botOpenId || !event.message.mentions) return false;
  return event.message.mentions.some(m => m.id.open_id === botOpenId);
}
```

群聊配置 `requireMention: true` 时，未 @bot 的消息将被忽略。

同时需要从消息文本中剥离 bot 的 @mention tag，避免干扰 agent 处理。

## 5. 配置

### 5.1 xgw config.yaml 中的 channel 配置

```yaml
channels:
  - id: feishu-main
    type: feishu
    paired: true
    pair_mode: ws
    # 飞书应用凭证
    appId: "cli_xxxx"
    appSecret: "xxxx"
    # 飞书域名：feishu（默认）或 lark（国际版）或自定义 URL
    domain: feishu
    # 群聊行为
    requireMention: true
    # Streaming 配置
    streamingCoalesceMs: 500
```

### 5.2 配置字段说明

| 字段 | 类型 | 必需 | 默认值 | 说明 |
|------|------|------|--------|------|
| `appId` | string | ✅ | — | 飞书应用 ID |
| `appSecret` | string | ✅ | — | 飞书应用密钥 |
| `domain` | `'feishu'` \| `'lark'` \| URL | — | `'feishu'` | 飞书 API 域名 |
| `requireMention` | boolean | — | `true` | 群聊是否需要 @bot |
| `streamingCoalesceMs` | number | — | `500` | Streaming 编辑合并间隔（ms） |

## 6. 项目结构

```
xgw/plugins/feishu/
├── src/
│   ├── index.ts              # FeishuPlugin 类（实现 ChannelPlugin）
│   ├── client.ts             # 飞书 SDK Client/WSClient 创建封装
│   ├── event-handler.ts      # 事件解析、消息转换、@bot 检测
│   └── streaming.ts          # Streaming buffer 和消息编辑逻辑
├── package.json
├── tsconfig.json
├── tsup.config.ts
├── README.md
└── SPEC.md                   ← 本文档
```

## 7. 依赖

| 包 | 用途 |
|----|------|
| `@larksuiteoapi/node-sdk` | 飞书官方 SDK（Client、WSClient、EventDispatcher） |

SDK 提供：
- `Client`：REST API 调用（发送/编辑消息）
- `WSClient`：WebSocket 长连接（内置自动重连）
- `EventDispatcher`：事件分发
- `AppType`、`Domain`：配置常量

不需要额外的 HTTP 库。

## 8. 消息流

### 8.1 入站（飞书 → xgw → xar）

```
飞书用户发消息
  → 飞书服务器
  → WSClient 收到事件
  → EventDispatcher 分发 im.message.receive_v1
  → event-handler 解析事件
      → 忽略 bot 自身消息（sender_type === 'bot'）
      → 群聊：检查 @bot（requireMention）
      → 剥离 bot @mention tag
      → 解析 content → 纯文本
      → 构造 xgw Message
  → onMessage(msg) 回调
  → GatewayServer → Router → XarClient → xar agent
```

### 8.2 出站（xar → xgw → 飞书）

```
xar streaming tokens
  → Dispatcher → FeishuPlugin.send(params)
  → stream='chunk':
      → 首次：发送初始消息，记录 message_id
      → 后续：累积 token，定时编辑消息
  → stream='end':
      → 最终编辑，清理 buffer
  → 无 stream：
      → 直接发送完整消息
  → 飞书 API → 飞书服务器 → 用户
```

## 9. 错误处理

| 场景 | 处理 |
|------|------|
| 飞书凭证无效 | `pair()` 返回 `success: false`，`start()` 抛出错误 |
| WebSocket 断线 | SDK 内置自动重连 |
| 消息发送失败（API 错误） | 记录日志，`send()` 抛出错误 |
| Streaming 编辑失败 | 记录日志，尝试发送新消息作为 fallback |
| 不支持的消息类型 | 转换为 `[unsupported: type]` 占位符 |

## 10. 实施顺序

1. **`src/client.ts`**：封装飞书 SDK Client/WSClient 创建
2. **`src/event-handler.ts`**：消息事件解析、内容提取、@bot 检测、Message 构造
3. **`src/streaming.ts`**：Streaming buffer、消息编辑合并逻辑
4. **`src/index.ts`**：FeishuPlugin 类，组装以上模块，实现 ChannelPlugin 接口
5. **单元测试**：消息解析、@bot 检测、streaming buffer
6. **集成测试**：配合 xgw gateway 端到端验证

## 11. 与 OpenClaw Feishu Extension 的差异

| 方面 | OpenClaw | xgw-plugin-feishu |
|------|---------|-------------------|
| 接口 | 丰富的 ChannelPlugin（actions、bindings、directory 等） | 最小 ChannelPlugin（5 个方法） |
| 连接模式 | WebSocket + Webhook 双模式 | WebSocket only |
| 多账号 | 支持 | 不支持，单账号 |
| Pairing | 完整的 DM pairing 流程 | 不实现，由 xgw routing 配置控制 |
| Rich Card | Feishu Card Kit、streaming card | 纯文本 + 消息编辑 |
| 工具集成 | Doc、Wiki、Drive、Bitable 等 | 不实现 |
| 群聊策略 | groupPolicy、allowFrom、groupSenderAllowFrom | 仅 requireMention |
| 附件/媒体 | 完整的 media pipeline | 占位符，后续扩展 |

## 12. 后续扩展（不在 v1 范围）

- Webhook 连接模式
- 多账号支持
- Rich Card 消息（Feishu Card Kit）
- 附件/图片/文件上传下载
- 群聊 allowlist 策略
- Reaction 通知
- 话题（Thread）会话隔离
- 消息去重（dedup）
