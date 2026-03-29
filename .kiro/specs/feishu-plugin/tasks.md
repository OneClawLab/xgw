# Implementation Plan: xgw-plugin-feishu

## Overview

按照 SPEC 中的实施顺序，逐步实现飞书渠道插件的各个模块。每个模块实现后紧跟对应的测试任务，确保增量验证。项目结构遵循 TUI plugin 模式，作为独立 npm 包。

## Tasks

- [ ] 1. 项目脚手架和类型定义
  - [ ] 1.1 创建 `xgw/plugins/feishu/package.json`、`tsconfig.json`、`tsup.config.ts`、`vitest.config.ts`
    - 参考 TUI plugin 的配置结构
    - 添加 `@larksuiteoapi/node-sdk` 依赖
    - 添加 `fast-check` 和 `vitest` 开发依赖
    - _Requirements: 9.1_
  - [ ] 1.2 在 `src/index.ts` 中定义本地 xgw 类型副本（Message、SendParams、HealthResult、PairResult、ChannelConfig、Attachment）和 FeishuMessageEvent 类型
    - 与 TUI plugin 保持一致的类型定义模式
    - 添加 FeishuPluginConfig 接口
    - _Requirements: 9.1, 9.2, 9.3, 9.4_

- [ ] 2. 实现消息内容解析模块 (`src/event-handler.ts`)
  - [ ] 2.1 实现 `parseMessageContent` 函数
    - 处理 text、post、image、file、unsupported 类型
    - 实现 `parsePostContent` 递归提取 post 富文本中的文本节点
    - JSON 解析失败返回空字符串
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_
  - [ ]* 2.2 编写消息解析属性测试 (`vitest/pbt/message-parsing.pbt.test.ts`)
    - **Property 1: Text content round-trip**
    - **Property 2: Post content text extraction**
    - **Property 3: Placeholder format for non-text types**
    - **Property 4: Malformed JSON safety**
    - **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6**
  - [ ] 2.3 实现 `checkBotMentioned` 和 `stripBotMention` 函数
    - 检测 mentions 数组中是否包含 bot 的 open_id
    - 从文本中移除 bot 的 mention key 占位符
    - _Requirements: 4.1, 4.2, 4.4, 4.5_
  - [ ]* 2.4 编写 @bot 检测属性测试 (`vitest/pbt/bot-mention.pbt.test.ts`)
    - **Property 5: Bot mention detection correctness**
    - **Property 6: Bot mention stripping**
    - **Validates: Requirements 4.1, 4.2, 4.4, 4.5**
  - [ ] 2.5 实现 `toMessage` 函数
    - 将 FeishuMessageEvent 转换为 xgw Message
    - 实现 session_id 策略（p2p → sender open_id, group → chat_id）
    - 调用 parseMessageContent 和 stripBotMention
    - _Requirements: 2.2, 5.1, 5.2_
  - [ ]* 2.6 编写 session 路由属性测试 (`vitest/pbt/session-routing.pbt.test.ts`)
    - **Property 7: Session ID routing**
    - **Validates: Requirements 5.1, 5.2**

- [ ] 3. Checkpoint — 确保消息解析模块测试通过
  - 运行 `vitest run`，确保所有测试通过，有问题请询问用户。

- [ ] 4. 实现飞书 SDK 封装 (`src/client.ts`)
  - [ ] 4.1 实现 `createClient`、`createWSClient`、`createDispatcher`、`validateCredentials` 函数
    - createClient: 创建 Lark.Client，支持 feishu/lark/自定义 domain
    - createWSClient: 创建 Lark.WSClient
    - createDispatcher: 创建 EventDispatcher（WebSocket 模式无需 encryptKey/verificationToken）
    - validateCredentials: 通过获取 tenant_access_token 验证凭证
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 2.1_

- [ ] 5. 实现 Streaming 缓冲模块 (`src/streaming.ts`)
  - [ ] 5.1 实现 `StreamingBuffer` 类
    - handleChunk: 首次发送占位消息，后续累积并按 coalesceMs 合并编辑
    - handleEnd: 最终编辑并清理 session
    - clear: 清理所有 session 和定时器
    - 编辑失败时 fallback 到发送新消息
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_
  - [ ]* 5.2 编写 streaming buffer 属性测试 (`vitest/pbt/streaming.pbt.test.ts`)
    - **Property 8: Streaming buffer accumulation**
    - **Validates: Requirements 7.2**
  - [ ]* 5.3 编写 streaming buffer 单元测试 (`vitest/unit/streaming.test.ts`)
    - 测试首次 chunk 发送占位消息
    - 测试 end 清理 session
    - 测试编辑失败 fallback
    - 测试 coalesceMs 默认值
    - _Requirements: 7.1, 7.3, 7.4, 7.5_

- [ ] 6. Checkpoint — 确保 streaming 模块测试通过
  - 运行 `vitest run`，确保所有测试通过，有问题请询问用户。

- [ ] 7. 实现 FeishuPlugin 主类 (`src/index.ts`)
  - [ ] 7.1 实现 FeishuPlugin 类，组装 client、event-handler、streaming 模块
    - pair(): 调用 validateCredentials，返回 PairResult
    - start(): 创建 EventDispatcher + WSClient，注册事件处理，过滤 bot 消息，检查 requireMention
    - stop(): 断开 WSClient，清理 streamingBuffer
    - send(): 非 streaming 直接发送，streaming 委托给 StreamingBuffer，progress 通过消息编辑
    - health(): 检查 WSClient 连接状态
    - _Requirements: 1.1, 1.2, 2.1, 2.2, 2.3, 2.4, 4.3, 6.1, 6.2, 8.1, 8.2, 9.1, 9.2, 9.3, 9.4_
  - [ ]* 7.2 编写 FeishuPlugin 单元测试 (`vitest/unit/feishu-plugin.test.ts`)
    - 测试 pair 成功/失败场景（mock SDK）
    - 测试 health 状态返回
    - 测试 config 解析和默认值
    - 测试 bot 消息过滤
    - 测试 requireMention 过滤
    - _Requirements: 1.1, 1.2, 2.3, 4.3, 8.1, 8.2, 9.2, 9.3, 9.4_

- [ ] 8. 最终 Checkpoint — 确保所有测试通过
  - 运行 `vitest run`，确保所有测试通过
  - 运行 `npx tsc --noEmit` 确保类型检查通过
  - 运行 `tsup` 确保构建成功
  - 有问题请询问用户。

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- 每个属性测试标注对应的设计文档 Property 编号
- 插件作为独立包，不依赖 xgw 核心代码
- 飞书 SDK 调用在单元测试中需要 mock
