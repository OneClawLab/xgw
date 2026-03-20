# xgw - communication gateway daemon & CLI command

The communication gateway for TheClaw. Routes messages from external peers (via IM channels) to internal agents, and delivers agent replies back to the corresponding channels. Runs as a daemon with CLI management commands.

## 决策记录

1. **实现策略**：以 OpenClaw gateway 为参考实现（策略 4），逐子模块迁移重写。只取真正需要的部分（协议抽象、channel 插件模型、WebSocket/HTTP 服务框架），丢弃 OpenClaw 特有的 device pairing、APNs relay、node registry、Canvas、wizard 等。代码风格和工具链与 TheClaw 其他 repo 对齐。
2. **不支持 node 机制**：不实现 OpenClaw 的 `role: node`（iOS/Android/macOS app 作为设备节点）。将来若有自己的 node 机制，另行设计，不兼容 OpenClaw 协议。
3. **Gateway 只处理跨系统通信**：系统内部通信（agent 之间、agent 与 thread 之间）不经过 gateway。gateway 的职责边界是：外部 peer → gateway → agent inbox（一个特殊 thread）。
4. **消息投递到 agent inbox**：gateway 将入站消息写入目标 agent 的 inbox thread（通过 `thread push`），由 agent 自行从 inbox 路由到具体 thread。gateway 不做语义路由。
5. **出站消息由 outbound consumer 触发**：agent 将回复写入 thread，由注册在该 thread 上的 outbound consumer 触发 `agent deliver`，调用 xgw 的出站接口投递回渠道。出站逻辑属于 agent repo，xgw 只提供出站 CLI 接口（`xgw send`）。
6. **Channel 插件化**：每种 IM 渠道（Telegram、Slack、Discord 等）实现为独立的 channel plugin，通过统一接口注册。核心 gateway 不内置任何具体渠道逻辑。
7. **身份与路由配置**：peer identity、channel identity 到 agent 的路由规则，存储在 xgw 的配置文件中（YAML/JSON），不依赖数据库。
8. **Daemon 模式**：xgw 以 daemon 形式常驻运行，监听各渠道入站消息。通过 `notifier` 管理 daemon 生命周期（与其他 TheClaw 工具一致）。

## 1. Role

```
peer → channel → xgw → agent.inbox (thread) → agent
agent → thread → outbound consumer → agent deliver → xgw send → channel → peer
```

- **Identity Verification**: Validate peer identity, channel identity, session identity.
- **Channel Normalization**: Normalize messages from different channels into a unified internal Message structure.
- **Inbound Routing**: Map (peer, channel) to target agent, write messages to agent inbox (`thread push`).
- **Outbound Delivery**: Provide `xgw send` CLI interface for `agent deliver` to deliver messages back to channels.

**xgw does NOT handle**:
- Semantic routing (thread selection is decided by agent).
- Internal inter-agent communication.
- Agent lifecycle management.

## 2. Tech Stack & Project Structure

遵循 TheClaw 其他 repo 约定：

- **TypeScript + ESM** (Node 22+)
- **构建**: tsup (ESM, shebang banner)
- **测试**: vitest
- **CLI 解析**: commander
- **HTTP/WebSocket**: Node built-in `http` + `ws`
- **配置**: YAML (`js-yaml`)

```
xgw/
├── src/
│   ├── index.ts              # Entry point, CLI parsing & dispatch
│   ├── commands/
│   │   ├── start.ts          # xgw start --config <path>
│   │   ├── stop.ts           # xgw stop
│   │   ├── status.ts         # xgw status [--json]
│   │   ├── send.ts           # xgw send --channel <id> --peer <id> --message <text>
│   │   ├── reload.ts         # xgw reload
│   │   ├── route.ts          # xgw route add/remove/list
│   │   ├── channel-mgmt.ts   # xgw channel add/remove/list/health
│   │   ├── agent-mgmt.ts     # xgw agent add/remove/list
│   │   └── config-check.ts   # xgw config check
│   ├── gateway/
│   │   ├── server.ts         # HTTP + WebSocket server
│   │   ├── router.ts         # (peer, channel) → agent routing
│   │   └── send.ts           # xgw send outbound delivery implementation
│   ├── channels/
│   │   ├── types.ts          # Channel plugin interface & Message type definitions
│   │   └── registry.ts       # Channel plugin registration & loading
│   ├── inbox.ts              # Invoke thread push to write to agent inbox
│   ├── config.ts             # Config file loading, validation & mutation
│   ├── logger.ts             # Runtime logging
│   └── types.ts              # Shared type definitions
├── plugins/                  # Channel plugins — each is an independent Node project
│   ├── tui/                  # TUI plugin (localhost Terminal UI, 优先级:高)
│   │   ├── src/
│   │   │   └── index.ts      # TuiPlugin implements ChannelPlugin
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── tsup.config.ts
│   └── webchat/               # Webchat plugin (browser GUI, 优先级:低)
│       ├── src/
│       │   └── index.ts      # WebchatPlugin implements ChannelPlugin
│       ├── package.json
│       ├── tsconfig.json
│       └── tsup.config.ts
├── clients/                  # End-user clients — each is an independent Node project
│   ├── tui/                  # xgw-tui: terminal chat client (connects to TUI plugin)
│   │   ├── src/
│   │   │   └── index.ts      # readline-based TUI, connects via WebSocket
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── tsup.config.ts
│   └── webchat/              # Webchat client (browser GUI, 优先级:低)
│       ├── src/
│       └── package.json
├── vitest/
├── package.json
├── tsconfig.json
├── tsup.config.ts
├── vitest.config.ts
├── SPEC.md
└── USAGE.md
```

**依赖边界**：
- `xgw` 核心不依赖任何 plugin 或 client 代码
- `plugins/*` 依赖 xgw 导出的 `ChannelPlugin` 接口和 `Message` 等类型
- `clients/*` 只依赖通信协议（WebSocket JSON 消息格式），不依赖任何 xgw 代码
- 部署时通过 xgw config 将 plugin 配置到 xgw daemon，client 独立运行

## 3. Configuration

Default path: `~/.config/xgw/config.yaml` (override via `--config` or `XGW_CONFIG` env var).

```yaml
# xgw config example
gateway:
  host: 127.0.0.1
  port: 18790

channels:
  - id: telegram-main
    type: telegram
    token: "BOT_TOKEN"

  - id: slack-work
    type: slack
    token: "xoxb-..."
    signing_secret: "..."

routing:
  # (channel_id, peer_id) → agent_id
  # peer_id 为 "*" 时匹配该渠道所有 peer
  - channel: telegram-main
    peer: "*"
    agent: admin

  - channel: slack-work
    peer: "U12345678"
    agent: admin

agents:
  # agent inbox thread paths
  admin:
    inbox: /home/user/.theclaw/agents/admin/inbox
```

## 4. Data Protocol

### 4.1 Internal Message Structure

所有渠道消息归一化后的统一格式：

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique message ID (UUID, generated by xgw) |
| `channel_id` | string | Channel ID (matches `channels[].id` in config) |
| `peer_id` | string | Sender's unique identifier in the channel |
| `peer_name` | string \| null | Sender's display name |
| `session_id` | string | Session ID (peer_id for DM, group ID for group chat) |
| `text` | string | Message text content |
| `attachments` | Attachment[] | Attachment list (images, files, etc.) |
| `reply_to` | string \| null | Original message ID being replied to |
| `created_at` | string | ISO 8601 timestamp |
| `raw` | object | Raw channel message (for debugging, not written to thread) |

### 4.2 Channel Plugin Interface

每个 channel plugin 实现以下接口：

```typescript
interface ChannelPlugin {
  readonly type: string;           // Channel type identifier, e.g. "telegram"

  // Pair: validate credentials and configure channel-side message delivery
  pair(config: ChannelConfig): Promise<PairResult>;

  // Start listening (inbound).
  // The plugin is responsible for normalizing raw channel messages into the
  // internal Message structure before calling onMessage.
  start(config: ChannelConfig, onMessage: (msg: Message) => Promise<void>): Promise<void>;

  // Stop listening
  stop(): Promise<void>;

  // Send message (outbound).
  // The plugin is responsible for converting the structured params into the
  // channel-specific API call format (reverse normalization).
  send(params: {
    peer_id: string;
    session_id: string;
    text: string;
    reply_to?: string;
  }): Promise<void>;

  // Health check
  health(): Promise<{ ok: boolean; detail?: string }>;
}

interface PairResult {
  success: boolean;
  pair_mode: 'webhook' | 'polling' | 'ws';
  pair_info: Record<string, string>;   // 渠道特定信息（bot_username、webhook_url 等）
  error?: string;
}
```

**归一化职责归属**：入站消息的归一化（raw → Message）和出站消息的反归一化（params → channel API call）均由各 Channel Plugin 自行实现，不存在中心化的 normalizer 模块。`Message` 类型定义在 `src/channels/types.ts`，供所有 plugin 引用。

**内置 Channel Plugins**：两个默认 plugin 以独立 Node project 形式存放在 `plugins/` 子目录：
- `plugins/tui/` — TUI plugin，在 xgw daemon 侧监听本地 WebSocket，接受 `xgw-tui` 客户端连接（优先级：高，随 xgw 核心一起实现）
- `plugins/webchat/` — Webchat plugin，浏览器 GUI 对应的服务端 plugin（优先级：低，后续实现）

对应的客户端存放在 `clients/` 子目录：
- `clients/tui/` — `xgw-tui`，readline-based 终端 chat 客户端，通过 WebSocket 连接 TUI plugin
- `clients/webchat/` — Webchat 客户端，浏览器 GUI（优先级：低）

第三方渠道 plugin（飞书、telegram、slack、discord 等）同样可以按此结构添加到 `plugins/` 下。

## 5. CLI Commands

### 5.1 `xgw start`

Start the gateway daemon.

```bash
xgw start [--config <path>] [--foreground]
```

- 默认以后台 daemon 方式运行（通过 `notifier` 调度）。
- `--foreground`：前台运行，日志同时输出到 stdout 和日志文件，适合调试。
- 配置文件不存在或校验失败时报错退出（退出码 1）。

### 5.2 `xgw stop`

Stop the running gateway daemon.

```bash
xgw stop [--config <path>]
```

### 5.3 `xgw status`

Show gateway runtime status.

```bash
xgw status [--config <path>] [--json]
```

Output: 运行状态、各 channel 健康状态、消息统计。

### 5.4 `xgw send` (Outbound Interface)

Deliver a message to a specific peer on a specific channel. Called by `agent deliver`.

```bash
xgw send \
  --channel <channel-id> \
  --peer <peer-id> \
  --session <session-id> \
  --message <text> \
  [--reply-to <message-id>] \
  [--config <path>]
```

- `--message` 可省略，从 stdin 读取。
- 成功时退出码 0，输出发送结果（`--json` 模式下输出 JSON）。
- channel 不存在或发送失败时退出码 1。

### 5.5 `xgw config check`

Validate config file syntax and connectivity.

```bash
xgw config check [--config <path>]
```

### 5.6 `xgw reload`

通知运行中的 daemon 重新加载配置文件。CLI 管理命令（route/channel/agent）修改 config.yaml 后自动触发 reload，通常不需要手动调用。

```bash
xgw reload [--config <path>]
```

- daemon 未运行时静默成功（退出码 0，配置变更会在下次 start 时生效）。
- 实现方式：向 daemon 进程发送 SIGUSR1（daemon 收到后重新加载配置文件并重建 channel/routing 状态）。

### 5.7 `xgw route` — 路由规则管理

动态管理 `(channel, peer) → agent` 路由规则。修改后自动写入 config.yaml 并触发 daemon reload。

#### `xgw route add`

```bash
xgw route add --channel <channel-id> --peer <peer-id> --agent <agent-id> [--config <path>]
```

- 将规则插入到 fallback（`peer=*`）规则之前。
- 若完全相同的规则已存在，更新其 agent 目标。
- 修改 config.yaml 后自动触发 `xgw reload`。

#### `xgw route remove`

```bash
xgw route remove --channel <channel-id> --peer <peer-id> [--config <path>]
```

- 删除匹配的规则。不存在时报错退出（退出码 1）。
- 不允许删除最后一条 fallback 规则（`channel=*, peer=*`）。

#### `xgw route list`

```bash
xgw route list [--json] [--config <path>]
```

- 列出所有路由规则，按匹配优先级排序。

### 5.8 `xgw channel` — 渠道实例管理

动态管理渠道实例配置。

#### `xgw channel add`

```bash
xgw channel add --id <id> --type <type> [--set <key>=<value> ...] [--config <path>]
```

- 添加新渠道实例到 config.yaml，写入基础配置。
- `--set` 用于设置渠道特有参数（credentials、webhook 模式等）。
- 同名 id 已存在时报错退出（退出码 1，提示先 remove 再 add）。
- 此命令只写配置，不启动 channel plugin。需要 `xgw channel pair` 完成配对验证后才能使用。

#### `xgw channel pair`

执行渠道特定的配对/验证流程，确认 credentials 有效并完成渠道侧的接入设置。

```bash
xgw channel pair --id <id> [--config <path>]
```

配对流程由 channel plugin 实现，不同渠道差异较大：

| 渠道类型 | 配对流程 | 所需 credentials（通过 `--set` 提供） |
|---------|---------|--------------------------------------|
| `telegram` | 调用 `getMe` API 验证 bot token → 设置 webhook 或启动 polling | `token` |
| `feishu` | 验证 app_id/app_secret → 获取 tenant_access_token → 注册事件订阅 URL | `app_id`, `app_secret`, `verification_token` |
| `slack` | 验证 bot token → 确认 signing_secret → 注册 Event Subscriptions URL | `token`, `signing_secret` |
| `discord` | 验证 bot token → 连接 Gateway WebSocket | `token` |
| `wechat` | 验证 app_id/app_secret → 配置消息接收 URL → 完成 token 验证 | `app_id`, `app_secret`, `token`, `encoding_aes_key` |
| `tui` | 无需配对（本地直连） | (无) |
| `webchat` | 无需配对（HTTP server 直接启动） | (无) |

**配对流程通用步骤**：

1. 读取 channel 配置中的 credentials
2. 调用渠道 API 验证 credentials 有效性
3. 配置渠道侧的消息接收方式：
   - Webhook 模式：向渠道注册 xgw 的 webhook URL（`https://<xgw_host>:<port>/webhook/<channel_id>`）
   - Polling 模式：记录为 polling，daemon 启动时主动轮询
   - WebSocket 模式：记录为 ws，daemon 启动时主动连接
4. 将配对结果写入 config.yaml（`paired: true`、`pair_mode: webhook|polling|ws`、`paired_at: <timestamp>`）
5. 若 daemon 正在运行，自动触发 `xgw reload` 启动新 channel plugin

**交互式配对**：部分渠道（如 Slack OAuth）需要浏览器交互。`pair` 命令会输出 URL 并等待回调完成，或提示用户手动完成后重新运行 `pair`。

**配对状态**：

```yaml
# config.yaml 中 channel 配对后的状态
channels:
  - id: telegram-main
    type: telegram
    token: "BOT_TOKEN"
    paired: true
    pair_mode: webhook        # webhook | polling | ws
    pair_info:                # 渠道特定的配对信息
      bot_username: "my_bot"
      webhook_url: "https://example.com:18790/webhook/telegram-main"
    paired_at: "2026-03-20T10:00:00Z"
```

未配对的 channel（`paired: false` 或无 `paired` 字段）不会被 daemon 启动。`xgw status` 会标注未配对的 channel。

#### `xgw channel remove`

```bash
xgw channel remove --id <id> [--config <path>]
```

- 删除渠道实例。同时清理引用该 channel 的路由规则（或报错提示先清理路由）。
- 修改后自动触发 `xgw reload`（daemon 会停止对应 channel plugin）。

#### `xgw channel list`

```bash
xgw channel list [--json] [--config <path>]
```

- 列出所有已配置的渠道实例（id、type、健康状态）。

#### `xgw channel health`

```bash
xgw channel health [--id <id>] [--json] [--config <path>]
```

- 对指定渠道（或全部渠道）执行健康检查。
- 需要 daemon 运行中。daemon 未运行时报错退出（退出码 1）。

### 5.9 `xgw agent` — Agent inbox 注册

管理 xgw 已知的 agent inbox 路径。xgw 入站时需要知道目标 agent 的 inbox thread 路径才能 `thread push`。

#### `xgw agent add`

```bash
xgw agent add --id <agent-id> --inbox <path> [--config <path>]
```

- 注册 agent 的 inbox 路径。同名 id 已存在时更新路径。
- 修改后自动触发 `xgw reload`。

#### `xgw agent remove`

```bash
xgw agent remove --id <agent-id> [--config <path>]
```

- 删除 agent 注册。若有路由规则引用该 agent，报错提示先清理路由。

#### `xgw agent list`

```bash
xgw agent list [--json] [--config <path>]
```

- 列出所有已注册的 agent 及其 inbox 路径。

## 6. Message Processing Flows

### 6.1 Inbound Flow

```
Channel webhook/polling
  → ChannelPlugin.start() → onMessage(normalizedMsg)   # plugin 内部完成 raw → Message 归一化
  → router: (channel_id, peer_id) → agent_id
  → inbox.push(agent_id, message)
      → thread push --thread <inbox_path>
                    --source xgw
                    --type message
                    --content <JSON(message)>
  → log
```

路由找不到匹配 agent 时：记录警告日志，丢弃消息（不报错）。

### 6.2 Outbound Flow

Agent 的 outbound consumer 触发 `agent deliver`，后者调用：

```bash
xgw send --channel <channel_id> --peer <peer_id> --session <session_id> --message <text>
```

xgw 将消息通过对应 ChannelPlugin 投递到渠道。出站参数到渠道 API 的转换（反归一化）由 plugin 的 `send()` 实现负责。

## 7. Output Format

### 7.1 stdout / stderr Contract

- `stdout`: Command result data (status info, send result).
- `stderr`: Progress, debug, error, and warning messages.

### 7.2 Human / Machine Readability

- Default output is human-readable.
- `--json` enables structured JSON output (`status`, `send`).

## 8. Error Handling & Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | Logic error (config error, channel send failure, etc.) |
| `2` | Usage/argument error (missing required args, etc.) |

Error output to `stderr`, format `Error: <what went wrong> - <how to fix>`.

## 9. Logging

### 9.1 Data Directory

```
~/.local/share/xgw/
├── logs/
│   ├── xgw.log                    # Current runtime log
│   └── xgw-<YYYYMMDD-HHmmss>.log  # Rotated historical logs
└── xgw.pid                        # Daemon PID file
```

### 9.2 Log Content & Format

**Log line format**:
```
[2026-03-18T10:30:00.123Z] [INFO] channel telegram-main started
[2026-03-18T10:30:01.456Z] [INFO] inbound: channel=telegram-main peer=123456 → agent=admin msg_id=uuid
[2026-03-18T10:30:01.500Z] [INFO] inbox push: agent=admin thread=/home/user/.theclaw/agents/admin/inbox event_id=42
[2026-03-18T10:30:02.000Z] [INFO] outbound: channel=telegram-main peer=123456 session=123456
[2026-03-18T10:30:02.100Z] [WARN] routing miss: channel=slack-work peer=U99999 (no matching rule)
```

### 9.3 Rotation Policy

超过 10000 行时自动轮换（与 notifier 一致）。

## 10. Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `XGW_CONFIG` | Config file path | `~/.config/xgw/config.yaml` |
| `XGW_HOME` | Data directory root path | `~/.local/share/xgw` |

## 11. TUI Plugin & Client

### 11.1 Overview

TUI channel 由两个独立组件构成：

- `plugins/tui/` — **TUI plugin**，运行在 xgw daemon 内，监听本地 WebSocket，管理多个客户端连接，每个连接对应一个 peer
- `clients/tui/` — **`xgw-tui`**，用户运行的终端 chat 客户端，通过 WebSocket 连接到 TUI plugin

```
xgw-tui (client)
  │  WebSocket ws://127.0.0.1:<tui_port>
  ▼
TUI plugin (server, inside xgw daemon)
  │  onMessage(normalizedMsg)
  ▼
xgw gateway → agent inbox
```

### 11.2 Configuration

TUI channel 在 xgw config.yaml 中的配置：

```yaml
channels:
  - id: tui-main
    type: tui
    port: 18791          # TUI plugin 监听的本地 WebSocket 端口（默认 18791）
    paired: true         # tui 无需 pair，初始化时直接设为 true
    pair_mode: ws
```

`pair_mode` 固定为 `ws`（客户端主动连接）。无需 credentials，`xgw channel pair` 对 tui 类型直接成功。

### 11.3 WebSocket Protocol

TUI plugin 与 xgw-tui client 之间使用 JSON 消息帧，每条 WebSocket message 为一个 JSON 对象。

#### 连接握手

客户端连接后立即发送 `hello` 消息，声明自己的身份：

```json
{ "type": "hello", "channel_id": "tui-main", "peer_id": "alice" }
```

plugin 回复确认：

```json
{ "type": "hello_ack", "channel_id": "tui-main", "peer_id": "alice" }
```

握手失败（channel_id 不存在、peer_id 格式非法等）时 plugin 回复：

```json
{ "type": "error", "code": "bad_hello", "message": "..." }
```

并关闭连接。

#### 入站消息（client → plugin）

用户在终端输入后，client 发送：

```json
{ "type": "message", "text": "hello agent" }
```

plugin 收到后归一化为内部 `Message`，调用 `onMessage`，写入 agent inbox。

#### 出站消息（plugin → client）

agent 回复时，xgw 调用 `plugin.send()`，plugin 向对应连接推送：

```json
{ "type": "message", "text": "Hello! How can I help you?" }
```

#### 心跳

client 每 30 秒发送一次 ping，plugin 回复 pong，用于检测连接存活：

```json
{ "type": "ping" }
{ "type": "pong" }
```

#### 消息归一化

TUI plugin 将客户端消息归一化为内部 `Message` 时：

| Message 字段 | 值 |
|---|---|
| `id` | UUID，plugin 生成 |
| `channel_id` | 握手时的 `channel_id` |
| `peer_id` | 握手时的 `peer_id` |
| `peer_name` | 同 `peer_id` |
| `session_id` | 同 `peer_id`（DM 模式，session_type 固定为 `dm`） |
| `text` | 消息文本 |
| `attachments` | `[]` |
| `reply_to` | `null` |
| `created_at` | ISO 8601 时间戳 |
| `raw` | 原始 WebSocket JSON 帧 |

写入 agent inbox 的 source 地址格式：

```
external:tui:<channel_id>:dm:<peer_id>:<peer_id>
```

例：`external:tui:tui-main:dm:alice:alice`

### 11.4 `xgw-tui` CLI

```bash
xgw-tui --channel <channel-id> --peer <peer-id> [--host <host>] [--port <port>]
```

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `--channel` | 目标 channel id（对应 config.yaml 中的 channel） | 必填 |
| `--peer` | 本客户端的 peer 身份标识 | 必填 |
| `--host` | TUI plugin 地址 | `127.0.0.1` |
| `--port` | TUI plugin 端口 | `18791` |

**交互行为**：

- 启动后连接 WebSocket，完成握手，进入 readline 交互循环
- 用户输入一行回车后发送，等待 agent 回复
- agent 回复异步推送，打印到终端（与用户输入区分，前缀 `agent> `）
- 输入 `/quit` 或 Ctrl+C 退出
- 连接断开时自动重连（最多 3 次，指数退避），重连失败后退出（退出码 1）

**输出格式**：

```
[tui-main/alice] Connected.
you> hello
agent> Hello! How can I help you?
you> _
```
