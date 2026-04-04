# xgw - Communication Gateway CLI/Daemon

The communication gateway for TheClaw. Routes messages from external peers (via IM channels) to internal agents, and delivers agent replies back to the corresponding channels. Runs as a daemon with CLI management commands.

xgw 是 TheClaw 架构的通信网关 daemon，负责外部渠道（Telegram、TUI、Slack 等）与 xar agent runtime 之间的消息桥接。

模块类型：**CLI/Daemon**（见 [CLI-LIB-Module-Spec.md](../TheClaw/CLI-LIB-Module-Spec.md)）

---

## 设计原则

1. **实现策略**：以 OpenClaw gateway 为参考实现，逐子模块迁移重写。只取真正需要的部分（协议抽象、channel 插件模型、WebSocket/HTTP 服务框架），丢弃 OpenClaw 特有的 device pairing、APNs relay、node registry 等。
2. **不支持 node 机制**：不实现 OpenClaw 的 `role: node`（iOS/Android/macOS app 作为设备节点）。
3. **Gateway 只处理跨系统通信**：系统内部通信（agent 之间、agent 与 thread 之间）不经过 gateway。
4. **消息通过 IPC 投递到 xar**：gateway 将入站消息通过 IPC 发送给 xar，由 xar 进行 Thread 分配。gateway 不做语义路由（Thread 选择由 xar 决定）。
5. **出站消息由 xar 驱动**：xar 处理完消息后通过 IPC 主动 push streaming tokens 给 xgw，xgw 转发给 channel plugin。
6. **Channel 插件化**：每种 IM 渠道（Telegram、Slack、Discord 等）实现为独立的 channel plugin，通过统一接口注册。
7. **身份与路由配置**：peer identity、channel identity 到 agent 的路由规则，存储在 xgw 的配置文件中（YAML），不依赖数据库。
8. **Daemon 模式**：xgw 以 daemon 形式常驻运行，监听各渠道入站消息。

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
- xgw 持有到 xar 的持久 IPC 连接（WebSocket over TCP loopback）
- `xgw send` CLI 降级为诊断/测试工具，不再是 agent 出站的必经路径

**保持不变**：
- Channel plugin 模型（`ChannelPlugin` 接口不变）
- TUI plugin 和 xgw-tui client（协议不变）
- 所有管理 CLI（start/stop/status/reload/route/channel/agent）
- config.yaml 格式（新增 `xar` 配置节，移除 `agents` 配置节）

## 1. Role

```
peer → channel → xgw → IPC → xar (Thread 分配 → 写入 thread → LLM 调用)
xar (指定 OutboundTarget) → IPC → xgw → channel → peer
```

- **Identity Verification**: Validate peer identity, channel identity.
- **Channel Normalization**: Normalize messages from different channels into unified internal Message structure.
- **Inbound Routing**: Map (peer, channel) to target agent, send messages to xar via IPC.
- **Outbound Delivery**: Receive streaming tokens from xar via IPC, forward to channel plugins.

**xgw does NOT handle**:
- Semantic routing (thread selection decided by xar).
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
│   ├── index.ts                  # CLI 入口（commander，命令名 xgw）
│   ├── config.ts                 # 配置加载、校验、保存（新增 xar 配置节）
│   ├── types.ts                  # 共享类型（Message、SendParams 等）
│   ├── commands/                 # CLI 子命令
│   │   ├── start.ts              # xgw start（新增：启动时建立 xar IPC 连接）
│   │   ├── stop.ts
│   │   ├── status.ts
│   │   ├── send.ts               # xgw send（降级为诊断工具）
│   │   ├── reload.ts
│   │   ├── route.ts
│   │   ├── channel-mgmt.ts
│   │   ├── agent-mgmt.ts
│   │   └── config-check.ts
│   ├── gateway/
│   │   ├── server.ts             # GatewayServer（新增：持有 XarClient，入站走 IPC）
│   │   ├── router.ts             # (channel_id, peer_id) → agent_id
│   │   └── send.ts               # xgw send 实现
│   ├── xar/
│   │   ├── client.ts             # XarClient：持久 IPC 连接，自动重连
│   │   └── dispatcher.ts         # 处理 xar → xgw 的出站事件（stream_token 等）
│   ├── channels/
│   │   ├── types.ts              # ChannelPlugin 接口
│   │   └── registry.ts           # ChannelRegistry
│   └── repo-utils/               # 跨 repo 共通工具（从 pai 同步）
├── plugins/
│   └── tui/                      # TUI plugin
├── clients/
│   └── tui/                      # xgw-tui client
├── vitest/
├── package.json
├── tsconfig.json
├── tsup.config.ts
├── vitest.config.ts
├── SPEC.md                       ← This document
└── USAGE.md
```

## 3. 配置格式

在 v1 config.yaml 基础上新增 `xar` 配置节：

```yaml
gateway:
  host: 127.0.0.1
  port: 28211

# 新增：xar IPC 连接配置
xar:
  port: 28213                     # TCP 端口
  reconnect_interval_ms: 3000     # 断线重连间隔（默认 3000）

channels:
  - id: tui:default
    port: 28212
    paired: true
    pair_mode: ws

routing:
  - channel: tui:default
    peer: "*"
    agent: admin
```

## 4. XarClient

`src/xar/client.ts` 负责维护到 xar 的持久 IPC 连接。

```typescript
class XarClient {
  // 连接到 xar（TCP loopback）
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
  source: string          // 结构化来源地址: external:<channel_id>:<conversation_type>:<conversation_id>:<peer_id>
  content: string         // 消息文本
}
```

### XarOutboundEvent（xar → xgw）

```typescript
type XarOutboundEvent =
  | { type: 'stream_start';         target: OutboundTarget; stream_id: string }
  | { type: 'stream_token';         stream_id: string; token: string }
  | { type: 'stream_thinking';      stream_id: string; delta: string }
  | { type: 'stream_tool_call';     stream_id: string; tool_call: unknown }
  | { type: 'stream_tool_result';   stream_id: string; tool_result: unknown }
  | { type: 'stream_end';           stream_id: string }
  | { type: 'stream_error';         stream_id: string; error: string }
  | { type: 'stream_ctx_usage';     stream_id: string; ctx_usage: CtxUsage }
  | { type: 'stream_compact_start'; stream_id: string; compact_start: CompactStartInfo }
  | { type: 'stream_compact_end';   stream_id: string; compact_end: CompactEndInfo }

interface OutboundTarget {
  channel_id: string      // 格式: <channel_type>:<instance>
  peer_id: string
  conversation_id: string
}
```

`stream_id` 由 xar 生成，格式为 `<channel_id>:<conversation_id>:<seq>`。xgw 用 `stream_id` 关联同一次 streaming 的所有事件，不解释其内部结构。

## 5. Dispatcher

`src/xar/dispatcher.ts` 处理 xar 推送的出站事件，将 streaming token 转发给对应的 channel plugin。

```
xar IPC → XarClient.onOutbound → Dispatcher
  → stream_start: 从 target.channel_id 找到 ChannelPlugin，建立 StreamState
  → stream_token: 通过 stream_id 查找 StreamState，路由到对应 plugin
  → stream_end: 发送完整文本（非 streaming plugin）或结束帧（streaming plugin）
  → stream_error: 记录日志，通知客户端
```

**Streaming 投递策略**：

| 渠道类型 | 策略 |
|---------|------|
| TUI | 累积 token，每 100ms batched flush 到 WebSocket |
| Telegram | 累积 token，每 500ms 或 token 数 > 50 时 edit message（避免 API rate limit） |
| 其他 | 默认：`stream_end` 时一次性发送完整回复 |

投递策略由各 channel plugin 自行实现，Dispatcher 只负责路由。

## 6. 入站消息流

```
外部 peer 发消息
  → ChannelPlugin.onMessage(msg: Message)
  → GatewayServer.handleInbound(msg)
      → Router.resolve(channel_id, peer_id) → agent_id
      → 构造 source 地址: external:<channel_id>:<conversation_type>:<conversation_id>:<peer_id>
      → XarClient.sendInbound(agent_id, { source, content: msg.text })
          → IPC: { type: 'inbound_message', agent_id, message: { source, content } }
  → xar 收到，Thread 分配 → 写入目标 thread
```

## 7. 出站消息流

```
xar 处理完消息，开始 LLM streaming
  → IPC: { type: 'stream_start', target: { channel_id, peer_id, conversation_id }, stream_id: '<channel_id>:<conversation_id>:<seq>' }
  → IPC: { type: 'stream_token', stream_id, token: 'Hello' }
  → IPC: { type: 'stream_token', stream_id, token: ' world' }
  → IPC: { type: 'stream_end', stream_id }

xgw XarClient 收到事件
  → Dispatcher.handle(event)
      → stream_start: 从 target.channel_id 找 ChannelPlugin，建立 StreamState
      → stream_token: 通过 stream_id 查找 StreamState，路由到 plugin
      → stream_end: 发送完整文本或结束帧
```

## 8. GatewayServer 改造

v2 的 `GatewayServer` 在 v1 基础上：

1. 构造时接收 `XarClient` 实例
2. `start()` 时启动 `XarClient.connect()`，注册出站事件处理器到 `Dispatcher`
3. `handleInbound()` 调用 `XarClient.sendInbound()`，构造 source 地址并发送 `{ source, content }`
4. `InboxWriter` 已废弃（inbox 概念移除）

## 9. xar 不可用时的降级行为

| 场景 | 行为 |
|------|------|
| xar 未启动，xgw 启动 | XarClient 持续重连（不阻塞 xgw 启动），入站消息缓冲 |
| xar 运行中断线 | XarClient 自动重连，重连期间入站消息缓冲（最多 100 条） |
| 缓冲满（> 100 条） | 丢弃最旧的消息，记录 warn 日志 |
| xar 持续不可用 | 记录 error 日志，消息丢弃，xgw 继续运行 |

xgw 的可用性不依赖 xar——channel plugin 始终在线，只是消息无法被处理。

## 10. CLI 命令

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

`xgw agent add/remove` 已废弃（agent 生命周期由 xar 管理）。`xgw agent list` 从 routing rules 中提取 agent 列表。

`xgw send` 在 v2 中仍然通过 channel plugin 直接发送（不经过 xar），用于测试和诊断。

## 11. 依赖关系

```
xgw
├── ws          (WebSocket，IPC client + TUI plugin server)
├── js-yaml     (config 解析)
├── commander   (CLI)
└── plugins/tui (内置 TUI plugin，独立 Node project)
```

xgw 不依赖 `pai`、`thread`、`xar`（通过 IPC 通信，不 import）。

## 12. 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `XGW_CONFIG` | 配置文件路径 | `~/.config/xgw/config.yaml` |
| `XGW_HOME` | 数据目录根路径 | `~/.local/share/xgw` |

## 13. 错误码

| Code | 含义 |
|------|------|
| `0` | 成功 |
| `1` | 运行时错误（配置错误、channel 发送失败等） |
| `2` | 参数/用法错误 |

## 14. 实施顺序

1. **新增 `src/xar/client.ts`**：XarClient，WebSocket IPC 连接，自动重连，入站发送
2. **新增 `src/xar/dispatcher.ts`**：出站事件路由，stream_token → channel plugin
3. **改造 `src/gateway/server.ts`**：接收 XarClient，handleInbound 改走 IPC
4. **改造 `src/commands/start.ts`**：构造 XarClient，传入 GatewayServer
5. **更新 `src/config.ts`**：新增 `xar` 配置节解析和校验
6. **更新 `plugins/tui`**：支持 streaming（逐 token push），可选

TUI plugin 的 streaming 支持（第 6 步）可以后做——`stream_end` 时一次性发送也能工作，只是没有流式体验。
