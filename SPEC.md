# SPEC: xgw

`xgw` 是 TheClaw 系统的通信网关，负责将外部 peer（通过各种 IM 渠道）的消息路由到内部 agent，并将 agent 的回复投递回对应渠道。

## 决策记录

1. **实现策略**：以 OpenClaw gateway 为参考实现（策略 4），逐子模块迁移重写。只取真正需要的部分（协议抽象、channel 插件模型、WebSocket/HTTP 服务框架），丢弃 OpenClaw 特有的 device pairing、APNs relay、node registry、Canvas、wizard 等。代码风格和工具链与 TheClaw 其他 repo 对齐（TypeScript + ESM + commander + tsup）。
2. **不支持 node 机制**：不实现 OpenClaw 的 `role: node`（iOS/Android/macOS app 作为设备节点）。将来若有自己的 node 机制，另行设计，不兼容 OpenClaw 协议。
3. **gateway 只处理跨系统通信**：系统内部通信（agent 之间、agent 与 thread 之间）不经过 gateway。gateway 的职责边界是：外部 peer → gateway → agent inbox（一个特殊 thread）。
4. **消息投递到 agent inbox**：gateway 将入站消息写入目标 agent 的 inbox thread（通过 `thread push`），由 agent 自行从 inbox 路由到具体 thread。gateway 不做语义路由。
5. **出站消息由 outbound consumer 触发**：agent 将回复写入 thread，由注册在该 thread 上的 outbound consumer 触发 `agent deliver`，调用 xgw 的出站接口投递回渠道。出站逻辑属于 agent repo，xgw 只提供出站 CLI 接口（`xgw send`）。
6. **Channel 插件化**：每种 IM 渠道（Telegram、Slack、Discord 等）实现为独立的 channel plugin，通过统一接口注册。核心 gateway 不内置任何具体渠道逻辑。
7. **身份与路由配置**：peer identity、channel identity 到 agent 的路由规则，存储在 xgw 的配置文件中（YAML/JSON），不依赖数据库。
8. **Daemon 模式**：xgw 以 daemon 形式常驻运行，监听各渠道入站消息。通过 `notifier` 管理 daemon 生命周期（与其他 TheClaw 工具一致）。

## 1. 定位 (Role)

```
peer → channel → xgw → agent.inbox (thread) → agent
agent → thread → outbound consumer → agent deliver → xgw send → channel → peer
```

**xgw 的职责**：
- **身份确认**：验证 peer identity、channel identity、session identity。
- **渠道统一**：将不同渠道的消息格式归一化为统一的内部 Message 结构。
- **入站路由**：根据 (peer, channel) 映射到目标 agent，将消息写入 agent inbox（`thread push`）。
- **出站投递**：提供 `xgw send` CLI 接口，供 `agent deliver` 调用，将消息投递回指定渠道。

**xgw 不负责**：
- 语义路由（thread 选择由 agent 决定）。
- 系统内部 agent 间通信。
- Agent 生命周期管理。

## 2. 技术栈与项目结构

遵循 TheClaw 其他 repo 约定：

- **TypeScript + ESM** (Node 22+)
- **构建**: tsup (ESM, shebang banner)
- **测试**: vitest
- **CLI 解析**: commander
- **HTTP/WebSocket**: Node 内置 `http` + `ws`
- **配置**: YAML（`js-yaml`）

```
xgw/
├── src/
│   ├── index.ts              # 入口，CLI 解析与分发
│   ├── commands/
│   │   ├── start.ts          # xgw start --config <path>（启动 daemon）
│   │   ├── stop.ts           # xgw stop
│   │   ├── status.ts         # xgw status [--json]
│   │   └── send.ts           # xgw send --channel <id> --peer <id> --message <text>（出站接口）
│   ├── gateway/
│   │   ├── server.ts         # HTTP + WebSocket 服务器
│   │   ├── router.ts         # (peer, channel) → agent 路由
│   │   ├── normalizer.ts     # 渠道消息 → 内部 Message 归一化
│   │   └── send.ts           # xgw send 出站投递实现
│   ├── channels/
│   │   ├── types.ts          # Channel plugin 接口定义
│   │   ├── registry.ts       # Channel plugin 注册与加载
│   │   ├── telegram/
│   │   ├── slack/
│   │   └── discord/
│   ├── inbox.ts              # 调用 thread push 写入 agent inbox
│   ├── config.ts             # 配置文件加载与校验
│   ├── logger.ts             # 运行日志
│   └── types.ts              # 共享类型定义
├── vitest/
├── package.json
├── tsconfig.json
├── tsup.config.ts
├── vitest.config.ts
├── SPEC.md
└── USAGE.md
```

## 3. 配置文件规范

默认路径：`~/.config/xgw/config.yaml`（可通过 `--config` 覆盖，或 `XGW_CONFIG` 环境变量）。

```yaml
# xgw 配置示例
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
  # agent inbox thread 路径
  admin:
    inbox: /home/user/.theclaw/agents/admin/inbox
```

## 4. 内部 Message 结构

所有渠道消息归一化后的统一格式：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | 消息唯一 ID（由 xgw 生成，UUID） |
| `channel_id` | string | 渠道 ID（对应配置中的 `channels[].id`） |
| `peer_id` | string | 发送方在该渠道的唯一标识 |
| `peer_name` | string \| null | 发送方显示名称 |
| `session_id` | string | 会话 ID（单聊为 peer_id，群聊为群组 ID） |
| `text` | string | 消息文本内容 |
| `attachments` | Attachment[] | 附件列表（图片、文件等） |
| `reply_to` | string \| null | 回复的原始消息 ID |
| `created_at` | string | ISO 8601 时间戳 |
| `raw` | object | 原始渠道消息（供调试，不写入 thread） |

## 5. Channel Plugin 接口

每个 channel plugin 实现以下接口：

```typescript
interface ChannelPlugin {
  readonly type: string;           // 渠道类型标识，如 "telegram"
  
  // 启动监听（入站）
  start(config: ChannelConfig, onMessage: (msg: Message) => Promise<void>): Promise<void>;
  
  // 停止监听
  stop(): Promise<void>;
  
  // 发送消息（出站）
  send(params: {
    peer_id: string;
    session_id: string;
    text: string;
    reply_to?: string;
  }): Promise<void>;
  
  // 健康检查
  health(): Promise<{ ok: boolean; detail?: string }>;
}
```

## 6. CLI 子命令规范

### `xgw start`

启动 gateway daemon。

```bash
xgw start [--config <path>] [--foreground]
```

- 默认以后台 daemon 方式运行（通过 `notifier` 调度）。
- `--foreground`：前台运行，日志同时输出到 stdout 和日志文件，适合调试。
- 配置文件不存在或校验失败时报错退出（退出码 1）。

### `xgw stop`

停止正在运行的 gateway daemon。

```bash
xgw stop [--config <path>]
```

### `xgw status`

查看 gateway 运行状态。

```bash
xgw status [--config <path>] [--json]
```

输出：运行状态、各 channel 健康状态、消息统计。

### `xgw send`（出站接口）

将消息投递到指定渠道的指定 peer。供 `agent deliver` 调用。

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

### `xgw config check`

校验配置文件语法和连通性。

```bash
xgw config check [--config <path>]
```

## 7. 入站消息处理流程

```
渠道 webhook/polling
  → ChannelPlugin.onMessage(raw)
  → normalizer: raw → Message
  → router: (channel_id, peer_id) → agent_id
  → inbox.push(agent_id, message)
      → thread push --thread <inbox_path>
                    --source xgw
                    --type message
                    --content <JSON(message)>
  → 记录日志
```

路由找不到匹配 agent 时：记录警告日志，丢弃消息（不报错）。

## 8. 出站消息处理流程

Agent 的 outbound consumer 触发 `agent deliver`，后者调用：

```bash
xgw send --channel <channel_id> --peer <peer_id> --session <session_id> --message <text>
```

xgw 将消息通过对应 ChannelPlugin 投递到渠道。

## 9. 数据目录与日志

```
~/.local/share/xgw/
├── logs/
│   ├── xgw.log                    # 当前运行日志
│   └── xgw-<YYYYMMDD-HHmmss>.log  # 轮换后的历史日志
└── xgw.pid                        # daemon PID 文件
```

日志超过 10000 行时自动轮换（与 notifier 一致）。

**日志行格式**：
```
[2026-03-18T10:30:00.123Z] [INFO] channel telegram-main started
[2026-03-18T10:30:01.456Z] [INFO] inbound: channel=telegram-main peer=123456 → agent=admin msg_id=uuid
[2026-03-18T10:30:01.500Z] [INFO] inbox push: agent=admin thread=/home/user/.theclaw/agents/admin/inbox event_id=42
[2026-03-18T10:30:02.000Z] [INFO] outbound: channel=telegram-main peer=123456 session=123456
[2026-03-18T10:30:02.100Z] [WARN] routing miss: channel=slack-work peer=U99999 (no matching rule)
```

## 10. 退出码

| 退出码 | 含义 |
|--------|------|
| `0` | 成功 |
| `1` | 一般逻辑错误（配置错误、渠道发送失败等） |
| `2` | 参数/语法错误（缺少必需参数等） |

## 11. 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `XGW_CONFIG` | 配置文件路径 | `~/.config/xgw/config.yaml` |
| `XGW_HOME` | 数据目录根路径 | `~/.local/share/xgw` |
