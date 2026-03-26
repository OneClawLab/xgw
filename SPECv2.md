# xgw SPECv2 - Communication Gateway

xgw 是 TheClaw v2 架构的通信网关 daemon，负责外部渠道（Telegram、TUI、Slack 等）与 xar agent runtime 之间的消息桥接。

模块类型：**CLI/Daemon**（见 [CLI-LIB-Module-Spec.md](../TheClaw/CLI-LIB-Module-Spec.md)）

参考文档：[TheClaw SPECv2.md](../TheClaw/SPECv2.md)

---

## v1 → v2 核心变化

v1 的消息路径：
```
入站: channel plugin → thread push(CLI) → notifier dispatch → agent run(CLI)
出站: agent deliver(CLI) → xgw send(CLI) → channel plugin
```

v2 的消息路径：
```
入站: channel plugin → IPC → xar (内存队列)
出站: xar → IPC → channel plugin
```

**变化点**：
- 入站不再调用 `thread push` CLI，改为通过 IPC 发送 `inbound_message` 给 xar
- 出站不再等待 `agent deliver` CLI 调用，改为 xar 主动通过 IPC push streaming tokens
- xgw 持有到 xar 的持久 IPC 连接（WebSocket over Unix socket）
- `xgw send` CLI 降级为诊断/测试工具，不再是 agent 出站的必经路径

**保持不变**：
- Channel plugin 模型（`ChannelPlugin` 接口不变）
- TUI plugin 和 xgw-tui client（协议不变）
- 所有管理 CLI（start/stop/status/reload/route/channel/agent）
- config.yaml 格式（新增 `xar` 配置节）

---

## 设计原则

1. **xgw 只做桥接**：不做语义路由（thread 选择由 xar 决定），不做 agent 生命周期管理。
2. **IPC 连接由 xgw 主动建立**：xgw 启动时连接 xar，断线自动重连。xar 不主动连接 xgw。
3. **Streaming 透传**：xar 通过 IPC push 的 `stream_token` 事件，xgw 直接转发给对应的 channel plugin，不缓冲。
4. **reply_context 透传**：入站消息携带的 `reply_context` 由 xgw 构造，xar 原样透传回来，xgw 用它找到目标 channel 和 peer。
5. **`xgw send` 保留**：作为诊断工具和 fallback，不废弃。

---

## 目录结构

```
xgw/
├── src/
│   ├── index.ts                  # CLI 入口（commander，命令名 xgw）
│   ├── config.ts                 # 配置加载、校验、保存（新增 xar 配置节）
│   ├── types.ts                  # 共享类型（Message、SendParams 等，不变）
│   ├── commands/                 # CLI 子命令（与 v1 基本一致）
│   │   ├── start.ts              # xgw start（新增：启动时建立 xar IPC 连接）
│   │   ├── stop.ts
│   │   ├── status.ts
│   │   ├── send.ts               # xgw send（降级为诊断工具，逻辑不变）
│   │   ├── reload.ts
│   │   ├── route.ts
│   │   ├── channel-mgmt.ts
│   │   ├── agent-mgmt.ts
│   │   └── config-check.ts
│   ├── gateway/
│   │   ├── server.ts             # GatewayServer（新增：持有 XarClient，入站走 IPC）
│   │   ├── router.ts             # (channel_id, peer_id) → agent_id（不变）
│   │   └── send.ts               # xgw send 实现（不变）
│   ├── xar/
│   │   ├── client.ts             # XarClient：持久 IPC 连接，自动重连
│   │   └── dispatcher.ts         # 处理 xar → xgw 的出站事件（stream_token 等）
│   ├── channels/
│   │   ├── types.ts              # ChannelPlugin 接口（不变）
│   │   └── registry.ts           # ChannelRegistry（不变）
│   └── repo-utils/               # 跨 repo 共通工具（从 pai 同步）
├── plugins/
│   └── tui/                      # TUI plugin（不变）
├── clients/
│   └── tui/                      # xgw-tui client（不变）
├── package.json
├── tsconfig.json
├── tsup.config.ts
├── vitest.config.ts
├── SPEC.md                       # v1 spec（保留参考）
├── SPECv2.md                     # 本文档
└── USAGE.md
```

---

## 配置格式

在 v1 config.yaml 基础上新增 `xar` 配置节：

```yaml
gateway:
  host: 127.0.0.1
  port: 18790

# 新增：xar IPC 连接配置
xar:
  socket: ~/.theclaw/xar.sock     # Unix socket 路径（优先）
  port: 18792                     # TCP fallback 端口
  reconnect_interval_ms: 3000     # 断线重连间隔（默认 3000）

channels:
  - id: tui-main
    type: tui
    port: 18791
    paired: true
    pair_mode: ws

routing:
  - channel: tui-main
    peer: "*"
    agent: admin

agents:
  admin:
    inbox: ~/.theclaw/agents/admin/inbox   # v2 中仅用于 xgw send fallback
```

`agents.inbox` 在 v2 中仅供 `xgw send` CLI（诊断工具）使用，正常消息路径不再需要它。

---

## XarClient

`src/xar/client.ts` 负责维护到 xar 的持久 IPC 连接。

```typescript
class XarClient {
  // 连接到 xar（优先 Unix socket，fallback TCP）
  connect(): Promise<void>

  // 发送入站消息给 xar
  sendInbound(agentId: string, message: InboundMessage): Promise<void>

  // 注册出站事件处理器（xar → xgw）
  onOutbound(handler: (event: XarOutboundEvent) => void): void

  // 断线时自动重连（指数退避，最多 reconnect_interval_ms * 2^n）
  // 重连期间入站消息缓冲（最多 100 条），重连成功后重放
}
```

### InboundMessage（xgw → xar）

```typescript
interface InboundMessage {
  source: string          // thread source 地址：external:<type>:<channel_id>:<session_type>:<session_id>:<peer_id>
  content: string         // 消息文本
  reply_context: ReplyContext
}

interface ReplyContext {
  channel_type: string    // channel plugin type，如 'tui'、'telegram'
  channel_id: string      // channel 实例 id，如 'tui-main'
  session_type: string    // 'dm' | 'group' | 'channel'
  session_id: string
  peer_id: string
  ipc_conn_id?: string    // xgw 内部连接 id，用于 streaming 回写定位
}
```

### XarOutboundEvent（xar → xgw）

```typescript
type XarOutboundEvent =
  | { type: 'stream_start';    reply_context: ReplyContext; session_id: string }
  | { type: 'stream_token';    session_id: string; token: string }
  | { type: 'stream_thinking'; session_id: string; delta: string }
  | { type: 'stream_end';      session_id: string }
  | { type: 'stream_error';    session_id: string; error: string }
```

---

## Dispatcher

`src/xar/dispatcher.ts` 处理 xar 推送的出站事件，将 streaming token 转发给对应的 channel plugin。

```
xar IPC → XarClient.onOutbound → Dispatcher
  → 根据 reply_context.channel_id 找到 ChannelPlugin
  → stream_token: plugin.send({ peer_id, session_id, text: token })
  → stream_end: 无需操作（token 已逐个发送）
  → stream_error: 记录日志
```

**Streaming 投递策略**：

| 渠道类型 | 策略 |
|---------|------|
| TUI | 每个 `stream_token` 立即 push 到 WebSocket（实时流式） |
| Telegram | 累积 token，每 500ms 或 token 数 > 50 时 edit message（避免 API rate limit） |
| 其他 | 默认：`stream_end` 时一次性发送完整回复 |

投递策略由各 channel plugin 自行实现（通过 `ChannelPlugin` 接口扩展），Dispatcher 只负责路由。

---

## 入站消息流

```
外部 peer 发消息
  → ChannelPlugin.onMessage(msg: Message)
  → GatewayServer.handleInbound(msg)
      → Router.resolve(channel_id, peer_id) → agent_id
      → 构造 InboundMessage（含 reply_context）
      → XarClient.sendInbound(agent_id, inboundMessage)
          → IPC: { type: 'inbound_message', agent_id, message }
  → xar 收到，push 到 agent 内存队列
```

**reply_context 构造**：

```typescript
const replyContext: ReplyContext = {
  channel_type: channelConfig.type,          // 'tui' | 'telegram' | ...
  channel_id: msg.channel_id,
  session_type: 'dm',                        // TUI 固定 dm；群聊渠道按实际
  session_id: msg.session_id,
  peer_id: msg.peer_id,
  ipc_conn_id: xarClient.connectionId,       // 当前 IPC 连接 id
}
```

---

## 出站消息流

```
xar 处理完消息，开始 LLM streaming
  → IPC: { type: 'stream_start', reply_context, session_id }
  → IPC: { type: 'stream_token', session_id, token: 'Hello' }
  → IPC: { type: 'stream_token', session_id, token: ' world' }
  → IPC: { type: 'stream_end', session_id }

xgw XarClient 收到事件
  → Dispatcher.handle(event)
      → 根据 reply_context.channel_id 找 ChannelPlugin
      → 调用 plugin.streamToken(peer_id, session_id, token)
         （或 plugin.send，取决于 plugin 是否支持 streaming）
```

---

## GatewayServer 改造

v2 的 `GatewayServer` 在 v1 基础上：

1. 构造时接收 `XarClient` 实例
2. `start()` 时启动 `XarClient.connect()`，注册出站事件处理器到 `Dispatcher`
3. `handleInbound()` 改为调用 `XarClient.sendInbound()`，不再调用 `InboxWriter`（`thread push` CLI）
4. `InboxWriter` 保留，仅供 `xgw send` CLI 使用

```typescript
class GatewayServer {
  constructor(logger: Logger, xarClient: XarClient) { ... }

  async start(config: Config, registry: ChannelRegistry): Promise<void> {
    // 1. 连接 xar
    await this.xarClient.connect()
    this.dispatcher = new Dispatcher(registry, this.xarClient)

    // 2. 注册出站事件处理
    this.xarClient.onOutbound(event => this.dispatcher.handle(event))

    // 3. 启动 channel plugins（与 v1 相同）
    await registry.startAll(config.channels, msg => this.handleInbound(msg))

    // 4. 启动 HTTP server（与 v1 相同）
    ...
  }

  private async handleInbound(msg: Message): Promise<void> {
    const agentId = this.router.resolve(msg.channel_id, msg.peer_id)
    if (!agentId) { this.logger.warn(...); return }

    const replyContext = this.buildReplyContext(msg)
    const inboundMessage: InboundMessage = {
      source: `external:${channelType}:${msg.channel_id}:dm:${msg.session_id}:${msg.peer_id}`,
      content: msg.text,
      reply_context: replyContext,
    }

    await this.xarClient.sendInbound(agentId, inboundMessage)
  }
}
```

---

## xar 不可用时的降级行为

| 场景 | 行为 |
|------|------|
| xar 未启动，xgw 启动 | XarClient 持续重连（不阻塞 xgw 启动），入站消息缓冲 |
| xar 运行中断线 | XarClient 自动重连，重连期间入站消息缓冲（最多 100 条） |
| 缓冲满（> 100 条） | 丢弃最旧的消息，记录 warn 日志 |
| xar 持续不可用 | 记录 error 日志，消息丢弃，xgw 继续运行 |

xgw 的可用性不依赖 xar——channel plugin 始终在线，只是消息无法被处理。

---

## CLI 命令

与 v1 完全一致，无新增命令。

```
xgw start [--config <path>] [--foreground]
xgw stop [--config <path>]
xgw status [--config <path>] [--json]
xgw reload [--config <path>]
xgw send --channel <id> --peer <id> --session <id> --message <text>   # 诊断工具
xgw config check [--config <path>]
xgw route add/remove/list
xgw channel add/pair/remove/list/health
xgw agent add/remove/list
```

`xgw send` 在 v2 中仍然通过 channel plugin 直接发送（不经过 xar），用于测试和诊断。

---

## 依赖关系

```
xgw
├── ws          (WebSocket，IPC client + TUI plugin server)
├── js-yaml     (config 解析)
├── commander   (CLI)
└── plugins/tui (内置 TUI plugin，独立 Node project)
```

xgw 不依赖 `pai`、`thread`、`xar`（通过 IPC 通信，不 import）。

---

## 实施顺序

1. **新增 `src/xar/client.ts`**：XarClient，WebSocket IPC 连接，自动重连，入站发送
2. **新增 `src/xar/dispatcher.ts`**：出站事件路由，stream_token → channel plugin
3. **改造 `src/gateway/server.ts`**：接收 XarClient，handleInbound 改走 IPC
4. **改造 `src/commands/start.ts`**：构造 XarClient，传入 GatewayServer
5. **更新 `src/config.ts`**：新增 `xar` 配置节解析和校验
6. **更新 `plugins/tui`**：支持 streaming（逐 token push），可选

TUI plugin 的 streaming 支持（第 6 步）可以后做——`stream_end` 时一次性发送也能工作，只是没有流式体验。

---

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `XGW_CONFIG` | 配置文件路径 | `~/.config/xgw/config.yaml` |
| `XGW_HOME` | 数据目录根路径 | `~/.local/share/xgw` |

---

## 错误码

| Code | 含义 |
|------|------|
| `0` | 成功 |
| `1` | 运行时错误（配置错误、channel 发送失败等） |
| `2` | 参数/用法错误 |
