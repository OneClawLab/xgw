# 实现计划：xgw-xar-ipc

## 概述

将 xgw 从 v1 CLI 子进程调用模式升级为 v2 直接 IPC（WebSocket）通信模式。按以下顺序实现：类型定义 → XarClient → Dispatcher → Config 扩展 → GatewayServer 集成 → startCommand 集成。

## 任务

- [ ] 1. 定义 IPC 相关类型
  - 在 `src/xar/types.ts` 中定义 `XarConfig`、`InboundMessage`、`ReplyContext`、`XarOutboundEvent`、`InboundEnvelope`、`SessionState` 接口
  - 在 `src/config.ts` 的 `Config` 接口中新增可选字段 `xar?: XarConfig`
  - _需求：2.3、2.4、2.5、5.1_

- [ ] 2. 实现 XarClient
  - [ ] 2.1 实现 `src/xar/client.ts` 中的 `XarClient` 类
    - 构造函数接收 `XarConfig` 和 `Logger`
    - `connect()` 方法：优先尝试 Unix socket，失败后回退 TCP
    - `sendInbound()` 方法：连接时直接发送，断连时入队缓冲区（上限 100，溢出丢弃最旧并记录 warn）
    - `onOutbound()` 方法：注册出站事件处理器
    - `close()` 方法：关闭连接，停止重连
    - 自动重连：指数退避，初始间隔来自配置，上限 60000ms，重连成功后记录 info 并刷新缓冲区（FIFO）
    - _需求：1.1、1.2、1.3、1.4、1.5、1.6、1.7、7.1、7.3、7.4_

  - [ ]* 2.2 为 XarClient 编写单元测试（`vitest/unit/xar-client.test.ts`）
    - 测试 Unix socket 优先连接、TCP fallback
    - 测试缓冲区溢出时丢弃最旧消息
    - 测试重连成功后按 FIFO 顺序刷新缓冲区
    - 测试 close() 停止重连
    - _需求：1.1、1.2、1.5、1.6_

  - [ ]* 2.3 为 XarClient 编写属性测试（`vitest/pbt/xar-client.pbt.test.ts`）
    - **属性 1：缓冲区溢出后保留最新消息**
    - **验证：需求 1.4、1.5**
    - **属性 2：缓冲区恢复后 FIFO 顺序发送**
    - **验证：需求 1.6**
    - **属性 3：InboundMessage source 字段格式正确性**
    - **验证：需求 2.3**
    - **属性 4：InboundMessage JSON 序列化往返一致性**
    - **验证：需求 2.2、2.4、2.5**

- [ ] 3. 检查点 — 确保所有测试通过
  - 确保所有测试通过，如有问题请告知。

- [ ] 4. 实现 Dispatcher
  - [ ] 4.1 实现 `src/xar/dispatcher.ts` 中的 `Dispatcher` 类
    - 构造函数接收 `ChannelRegistry` 和 `Logger`
    - `handle(event)` 方法：
      - `stream_start`：初始化 `SessionState`，记录 channel_id、channel_type、peer_id
      - `stream_token`：TUI 渠道立即调用 `plugin.send`；非 TUI 渠道累积到 `tokenBuffer`
      - `stream_end`：非 TUI 渠道调用 `plugin.send`（完整拼接文本），清理 session 状态
      - `stream_error`：记录 error 日志，清理 session 状态
      - `stream_thinking`：忽略（不影响输出）
      - channel plugin 不存在时：记录 warn 日志，丢弃事件
    - _需求：3.1、3.2、3.3、3.4、3.5、3.6、4.1、4.2_

  - [ ]* 4.2 为 Dispatcher 编写单元测试（`vitest/unit/dispatcher.test.ts`）
    - 测试 stream_start 初始化 session 状态
    - 测试 TUI 渠道 stream_end 时不额外调用 plugin.send
    - 测试 stream_error 记录日志
    - 测试 plugin 不存在时记录 warn 并不抛出异常
    - _需求：3.2、3.3、3.4、3.6_

  - [ ]* 4.3 为 Dispatcher 编写属性测试（`vitest/pbt/dispatcher.pbt.test.ts`）
    - **属性 5：stream_token 路由到正确 plugin**
    - **验证：需求 3.1、3.5**
    - **属性 6：TUI 渠道每个 token 立即发送**
    - **验证：需求 4.1**
    - **属性 7：非 TUI 渠道 token 累积后完整发送**
    - **验证：需求 4.2**

- [ ] 5. 扩展 Config 解析
  - [ ] 5.1 在 `src/config.ts` 中实现 `parseXarConfig()` 函数
    - 从原始配置对象中提取 xar 节
    - 填充默认值：socket `~/.theclaw/xar.sock`，port `18792`，reconnect_interval_ms `3000`
    - 格式错误时返回描述性错误信息
    - 在 `validateConfig()` 中新增 xar 节的可选校验逻辑
    - _需求：5.1、5.2、5.3、5.4、5.5、5.6_

  - [ ]* 5.2 为 Config 扩展编写单元测试（`vitest/unit/config.test.ts`，新增用例）
    - 测试 xar 节完整配置解析
    - 测试 xar 节格式错误时返回描述性错误
    - _需求：5.5、5.6_

  - [ ]* 5.3 为 Config 编写属性测试（`vitest/pbt/config.pbt.test.ts`）
    - **属性 8：XarConfig 默认值正确性**
    - **验证：需求 5.2、5.3、5.4**
    - **属性 9：XarConfig YAML 解析往返一致性**
    - **验证：需求 5.1、5.5**

- [ ] 6. 集成 GatewayServer
  - [ ] 6.1 修改 `src/gateway/server.ts`
    - 构造函数新增可选参数 `xarClient?: XarClient`
    - `start()` 中：若 xarClient 存在，调用 `xarClient.connect()` 并注册 `onOutbound` 处理器（转发给 Dispatcher）
    - `handleInbound()` 中：若 xarClient 存在，调用 `xarClient.sendInbound()` 替代 `InboxWriter.push()`；否则回退到 InboxWriter（保持向后兼容）
    - `stop()` 中：调用 `xarClient.close()`
    - _需求：6.1、6.2、6.3、6.4_

  - [ ]* 6.2 为 GatewayServer 集成编写单元测试（`vitest/unit/gateway-server.test.ts`，新增用例）
    - 测试 start() 时 XarClient.connect() 和 onOutbound() 被调用
    - 测试入站消息时 XarClient.sendInbound() 被调用而非 InboxWriter
    - 测试 xarClient 不存在时回退到 InboxWriter
    - _需求：6.2、6.3_

- [ ] 7. 集成 startCommand
  - 修改 `src/commands/start.ts`
  - 从 config 中读取 xar 配置节，调用 `parseXarConfig()` 获取 `XarConfig`
  - 构造 `XarClient` 实例（传入 XarConfig 和 logger）
  - 构造 `Dispatcher` 实例（传入 ChannelRegistry 和 logger）
  - 将 XarClient 传入 `GatewayServer` 构造函数
  - _需求：6.1、6.2_

- [ ] 8. 最终检查点 — 确保所有测试通过
  - 确保所有测试通过，如有问题请告知。

## 备注

- 标有 `*` 的子任务为可选任务，可跳过以优先完成核心功能
- 每个属性测试使用 `fast-check`，最少运行 100 次迭代
- 每个属性测试注释格式：`// Feature: xgw-xar-ipc, Property N: <属性名>`
- WebSocket 连接在单元测试中使用 mock，不依赖真实 xar 进程
- 所有本地 import 必须带 `.js` 后缀（ESM + NodeNext 要求）
