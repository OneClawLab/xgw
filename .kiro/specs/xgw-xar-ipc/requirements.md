# 需求文档

## 简介

本功能将 xgw（通信网关 daemon）从 v1 的 CLI 子进程调用模式升级为 v2 的直接 IPC（WebSocket）通信模式。xgw 将通过持久 WebSocket 连接与 xar（agent runtime daemon）进行双向通信，取代原有的 CLI 调用链路，实现更低延迟的消息传递和实时流式输出。

## 词汇表

- **xgw**：通信网关 daemon，负责外部渠道与 AI agent 之间的消息桥接
- **xar**：agent runtime daemon，负责运行 AI agent 并处理消息
- **IPC**：进程间通信，本文中特指基于 Unix socket 或 TCP 的 WebSocket 连接
- **XarClient**：xgw 中维护到 xar 持久连接的客户端模块
- **Dispatcher**：xgw 中将 xar 出站事件路由到对应 channel plugin 的分发器
- **InboundMessage**：从外部渠道发往 xar 的入站消息
- **XarOutboundEvent**：xar 主动推送给 xgw 的出站事件（流式 token 等）
- **ReplyContext**：消息回复所需的上下文信息，包含渠道、会话、对端标识
- **Channel Plugin**：xgw 中对接具体外部渠道（TUI、Telegram 等）的插件
- **GatewayServer**：xgw 的核心网关服务，协调各 channel plugin 与 xar 之间的消息流转
- **Unix socket**：Unix 域套接字，用于本机进程间通信
- **stream_token**：xar 推送的流式输出 token 事件
- **stream_end**：xar 推送的流式输出结束事件
- **stream_error**：xar 推送的流式输出错误事件
- **重连退避**：连接断开后按指数增长的间隔重试连接的策略

## 需求

### 需求 1：XarClient 持久连接管理

**用户故事：** 作为 xgw 系统，我希望维护一条到 xar 的持久 IPC 连接，以便能够实时双向传递消息。

#### 验收标准

1. WHEN xgw 启动时，THE XarClient SHALL 优先尝试通过配置的 Unix socket 路径建立 WebSocket 连接
2. IF Unix socket 连接失败，THEN THE XarClient SHALL 回退到通过配置的 TCP 地址（127.0.0.1:<port>）建立连接
3. WHEN xar 连接断开时，THE XarClient SHALL 按指数退避策略自动重连，直到连接恢复
4. WHILE XarClient 处于重连状态时，THE XarClient SHALL 将入站消息缓冲至最多 100 条
5. WHEN 缓冲区已满且有新消息到达时，THE XarClient SHALL 丢弃最旧的消息并记录 warn 日志
6. THE XarClient SHALL 在连接恢复后将缓冲区中的消息按顺序发送给 xar
7. WHEN xar 永久不可用时，THE XarClient SHALL 持续重连而不阻塞 xgw 的其他功能

### 需求 2：入站消息发送

**用户故事：** 作为 xgw 系统，我希望将来自外部渠道的消息通过 IPC 发送给 xar，以便 agent 能够处理这些消息。

#### 验收标准

1. WHEN 外部渠道收到用户消息时，THE GatewayServer SHALL 调用 XarClient.sendInbound() 将消息发送给 xar，而非调用 CLI 子进程
2. THE XarClient SHALL 将 InboundMessage 序列化为 JSON 格式通过 WebSocket 发送
3. THE InboundMessage SHALL 包含 source 字段，格式为 "external:<type>:<channel_id>:<session_type>:<session_id>:<peer_id>"
4. THE InboundMessage SHALL 包含 content 字段（消息文本内容）和 reply_context 字段（回复上下文）
5. THE ReplyContext SHALL 包含 channel_type、channel_id、session_type、session_id、peer_id 字段
6. WHERE ipc_conn_id 可用时，THE ReplyContext SHALL 包含 ipc_conn_id 字段

### 需求 3：出站事件接收与分发

**用户故事：** 作为 xgw 系统，我希望接收 xar 主动推送的流式输出事件并将其路由到正确的 channel plugin，以便用户能够实时看到 agent 的回复。

#### 验收标准

1. WHEN xar 推送 stream_token 事件时，THE Dispatcher SHALL 将 token 内容通过对应 channel plugin 的 send 方法发送给用户
2. WHEN xar 推送 stream_end 事件时，THE Dispatcher SHALL 不执行额外操作（token 已逐条发送）
3. WHEN xar 推送 stream_error 事件时，THE Dispatcher SHALL 记录错误日志
4. WHEN xar 推送 stream_start 事件时，THE Dispatcher SHALL 初始化对应会话的流式状态
5. THE Dispatcher SHALL 根据 XarOutboundEvent 中的 reply_context 定位到正确的 channel plugin 实例
6. WHEN 对应 channel plugin 不存在时，THE Dispatcher SHALL 记录 warn 日志并丢弃该事件

### 需求 4：TUI 渠道流式输出

**用户故事：** 作为 TUI 用户，我希望能够实时看到 agent 的流式输出，以便获得更好的交互体验。

#### 验收标准

1. WHEN TUI channel plugin 收到 stream_token 事件时，THE Dispatcher SHALL 立即将每个 token 推送给 TUI plugin（实时流式）
2. WHEN 非 TUI channel plugin 收到 stream_token 事件时，THE Dispatcher SHALL 累积所有 token，在 stream_end 时一次性发送完整回复

### 需求 5：配置扩展

**用户故事：** 作为系统管理员，我希望能够在 config.yaml 中配置 xar 的连接参数，以便灵活部署。

#### 验收标准

1. THE Config SHALL 支持 xar 配置节，包含 socket（Unix socket 路径）、port（TCP 端口）、reconnect_interval_ms（重连间隔毫秒数）字段
2. WHEN xar.socket 未配置时，THE Config SHALL 使用默认值 ~/.theclaw/xar.sock
3. WHEN xar.port 未配置时，THE Config SHALL 使用默认值 18792
4. WHEN xar.reconnect_interval_ms 未配置时，THE Config SHALL 使用默认值 3000
5. THE Config Parser SHALL 将 config.yaml 中的 xar 节解析为类型安全的配置对象
6. WHEN config.yaml 中 xar 节格式错误时，THE Config Parser SHALL 返回描述性错误信息

### 需求 6：GatewayServer 集成

**用户故事：** 作为 xgw 系统，我希望 GatewayServer 能够使用 XarClient 处理消息，以便完成 v1 到 v2 的迁移。

#### 验收标准

1. THE GatewayServer SHALL 在构造时接收 XarClient 实例作为依赖
2. WHEN GatewayServer.start() 被调用时，THE GatewayServer SHALL 连接 XarClient 并注册出站事件处理器
3. WHEN GatewayServer 处理入站消息时，THE GatewayServer SHALL 调用 XarClient.sendInbound() 而非 InboxWriter
4. THE InboxWriter SHALL 仅保留用于 xgw send CLI 命令的诊断/测试用途

### 需求 7：降级与容错

**用户故事：** 作为系统运维人员，我希望 xgw 在 xar 不可用时仍能正常运行，以便保证系统的基本可用性。

#### 验收标准

1. WHEN xar 不可用时，THE XarClient SHALL 持续尝试重连而不导致 xgw 进程退出
2. WHEN xar 不可用时，THE GatewayServer SHALL 继续接受来自外部渠道的连接
3. WHEN 缓冲区溢出时，THE XarClient SHALL 记录 warn 级别日志，包含被丢弃的消息数量
4. THE XarClient SHALL 在重连成功后记录 info 级别日志
