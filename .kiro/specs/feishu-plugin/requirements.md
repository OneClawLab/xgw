# Requirements Document

## Introduction

xgw 飞书（Feishu/Lark）IM Bot 渠道插件，实现 `ChannelPlugin` 接口，使 xgw 网关能够通过 WebSocket 长连接接收和发送飞书 IM 消息。插件作为独立 npm 包发布，仅依赖飞书官方 SDK `@larksuiteoapi/node-sdk`。

## Glossary

- **ChannelPlugin**: xgw 定义的渠道插件接口，包含 `pair`、`start`、`stop`、`send`、`health` 五个方法
- **ChannelConfig**: xgw 渠道配置对象，包含 `id`、`type`、`paired` 等字段及自定义扩展字段
- **Message**: xgw 标准化消息格式，包含 `id`、`channel_id`、`peer_id`、`session_id`、`text` 等字段
- **SendParams**: xgw 发送消息参数，包含 `peer_id`、`session_id`、`text`、`stream`、`progress` 等字段
- **WSClient**: 飞书 SDK 提供的 WebSocket 客户端，内置自动重连
- **EventDispatcher**: 飞书 SDK 提供的事件分发器，用于注册和处理飞书事件
- **Client**: 飞书 SDK 提供的 REST API 客户端，用于发送/编辑消息
- **FeishuMessageEvent**: 飞书 `im.message.receive_v1` 事件的数据结构
- **StreamingBuffer**: 内部缓冲区，用于累积 streaming token 并合并编辑请求
- **BotOpenId**: 飞书机器人的 open_id，用于 @bot 检测和自身消息过滤
- **CoalesceInterval**: Streaming 编辑合并间隔，默认 500ms

## Requirements

### Requirement 1: 配对验证

**User Story:** As a gateway operator, I want to verify Feishu app credentials before starting the channel, so that I can detect configuration errors early.

#### Acceptance Criteria

1. WHEN `pair()` is called with valid `appId` and `appSecret`, THE FeishuPlugin SHALL return a PairResult with `success: true`, `pair_mode: 'ws'`, and `pair_info` containing `botOpenId`
2. WHEN `pair()` is called with invalid or missing credentials, THE FeishuPlugin SHALL return a PairResult with `success: false` and a descriptive `error` message
3. THE FeishuPlugin SHALL obtain a `tenant_access_token` from the Feishu API to validate credentials
4. WHEN the `domain` config field is set to `'lark'`, THE FeishuPlugin SHALL use the Lark international API domain for credential validation

### Requirement 2: WebSocket 连接与事件监听

**User Story:** As a gateway operator, I want the plugin to establish a WebSocket connection to Feishu and listen for messages, so that users can interact with the bot.

#### Acceptance Criteria

1. WHEN `start()` is called, THE FeishuPlugin SHALL create an EventDispatcher, register the `im.message.receive_v1` handler, and start a WSClient connection
2. WHEN a `im.message.receive_v1` event is received, THE FeishuPlugin SHALL parse the event into an xgw Message and invoke the `onMessage` callback
3. WHEN the event sender is a bot (`sender_type === 'bot'`), THE FeishuPlugin SHALL ignore the event and not invoke `onMessage`
4. WHEN `stop()` is called, THE FeishuPlugin SHALL disconnect the WSClient and clear all internal state including streaming buffers

### Requirement 3: 消息内容解析

**User Story:** As a developer, I want incoming Feishu messages to be parsed into plain text, so that the agent can process them uniformly.

#### Acceptance Criteria

1. WHEN the message type is `text`, THE Parser SHALL extract the `text` field from the JSON content string
2. WHEN the message type is `post`, THE Parser SHALL recursively extract all text nodes from the rich text JSON and concatenate them into plain text
3. WHEN the message type is `image`, THE Parser SHALL return the placeholder string `[image]`
4. WHEN the message type is `file`, THE Parser SHALL return a placeholder string in the format `[file: <filename>]`
5. WHEN the message type is unsupported, THE Parser SHALL return a placeholder string in the format `[unsupported: <type>]`
6. IF the content JSON string is malformed, THEN THE Parser SHALL return an empty string rather than throwing an error

### Requirement 4: @Bot 检测与 Mention 剥离

**User Story:** As a gateway operator, I want the plugin to detect @bot mentions in group chats and strip mention tags from message text, so that the agent receives clean input.

#### Acceptance Criteria

1. WHEN a group message contains a mention matching the bot's `open_id`, THE Detector SHALL return `true` for bot-mentioned check
2. WHEN a group message does not contain a mention matching the bot's `open_id`, THE Detector SHALL return `false` for bot-mentioned check
3. WHEN `requireMention` is `true` and the message is in a group chat without @bot, THE FeishuPlugin SHALL ignore the message
4. WHEN the bot is mentioned in the message text, THE FeishuPlugin SHALL strip the bot's @mention tag from the text before constructing the Message
5. WHEN `botOpenId` is not available, THE Detector SHALL return `false` regardless of mentions present

### Requirement 5: Session ID 策略

**User Story:** As a gateway operator, I want consistent session routing, so that conversations are properly isolated per user (DM) or per group.

#### Acceptance Criteria

1. WHEN the chat type is `p2p`, THE FeishuPlugin SHALL set `session_id` to the sender's `open_id`
2. WHEN the chat type is `group`, THE FeishuPlugin SHALL set `session_id` to the `chat_id`

### Requirement 6: 消息发送（非 Streaming）

**User Story:** As a gateway operator, I want the plugin to send messages to Feishu users, so that agent responses reach the user.

#### Acceptance Criteria

1. WHEN `send()` is called without a `stream` parameter, THE FeishuPlugin SHALL send a complete text message via the Feishu API to the target session
2. WHEN `send()` is called with a `progress` parameter, THE FeishuPlugin SHALL send a status message (e.g. "🤔 思考中...") via message edit on the same message

### Requirement 7: Streaming 发送

**User Story:** As a gateway operator, I want streaming responses to appear progressively in Feishu, so that users see real-time output.

#### Acceptance Criteria

1. WHEN the first `stream: 'chunk'` is received for a session, THE StreamingBuffer SHALL send an initial placeholder message and record its `message_id`
2. WHEN subsequent `stream: 'chunk'` messages arrive, THE StreamingBuffer SHALL accumulate the text and edit the message at the configured coalesce interval
3. WHEN `stream: 'end'` is received, THE StreamingBuffer SHALL perform a final edit with the complete text and clear the buffer for that session
4. THE StreamingBuffer SHALL default to a 500ms coalesce interval, configurable via `streamingCoalesceMs`
5. IF a streaming edit API call fails, THEN THE StreamingBuffer SHALL log the error and attempt to send a new message as fallback

### Requirement 8: 健康检查

**User Story:** As a gateway operator, I want to check the plugin's connection health, so that I can monitor the system status.

#### Acceptance Criteria

1. WHEN `health()` is called and the WSClient is connected, THE FeishuPlugin SHALL return `{ ok: true }` with a descriptive detail
2. WHEN `health()` is called and the WSClient is not connected or not started, THE FeishuPlugin SHALL return `{ ok: false }` with a descriptive detail

### Requirement 9: 配置解析

**User Story:** As a gateway operator, I want to configure the plugin via xgw config, so that I can customize its behavior.

#### Acceptance Criteria

1. THE FeishuPlugin SHALL read `appId` and `appSecret` from the ChannelConfig
2. THE FeishuPlugin SHALL support an optional `domain` field with values `'feishu'` (default), `'lark'`, or a custom URL string
3. THE FeishuPlugin SHALL support an optional `requireMention` boolean field, defaulting to `true`
4. THE FeishuPlugin SHALL support an optional `streamingCoalesceMs` number field, defaulting to `500`
