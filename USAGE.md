# USAGE: xgw

## 安装

```bash
npm run build && npm link
```

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `XGW_HOME` | 运行时数据目录（PID 文件、日志） | `~/.local/share/xgw` |
| `XGW_CONFIG` | 配置文件路径 | `~/.config/xgw/config.yaml` |

`--config <path>` 优先级最高，其次 `XGW_CONFIG` 环境变量，最后默认路径。

---

## 配置文件

默认路径：`~/.config/xgw/config.yaml`

```yaml
gateway:
  host: 127.0.0.1
  port: 28211

# xar IPC 连接配置（v2 模式）
xar:
  port: 28213                   # TCP 端口
  reconnect_interval_ms: 3000   # 断线重连间隔

# 插件注册表：type → npm 包名
# 内置 tui 插件无需注册
plugins:
  telegram: "@theclawlab/xgw-plugin-telegram"
  feishu: "@theclawlab/xgw-plugin-feishu"

channels:
  - id: tui-main
    type: tui
    port: 28212
    paired: true
    pair_mode: ws

  - id: tg-main
    type: telegram
    token: "BOT_TOKEN"
    paired: true
    pair_mode: webhook

agents:
  admin:
    inbox: ~/.theclaw/agents/admin/inbox

routing:
  - channel: tui-main
    peer: "*"
    agent: admin
  - channel: tg-main
    peer: "*"
    agent: admin
```

### 字段说明

- `gateway.host` / `gateway.port`：HTTP gateway 监听地址
- `xar`：xar daemon IPC 连接配置（v2 模式，省略则不连接 xar）
- `plugins`：channel 插件注册表，key 为 type 名，value 为 npm 包名
- `channels`：channel 实例列表，每个 channel 需有唯一 `id` 和 `type`
- `agents`：注册的 agent，key 为 agent id，`inbox` 为 thread 目录路径
- `routing`：路由规则，`channel` + `peer` → `agent`；`peer` 可用 `*` 匹配所有

---

## 插件管理

xgw 通过插件支持不同的 channel 类型。TUI 插件内置，其他类型需要安装并注册。

### 安装插件

```bash
# 1. 全局安装 npm 包
npm install -g @theclawlab/xgw-plugin-telegram

# 2. 注册到 xgw（写入 config.yaml 的 plugins 节）
xgw plugin add telegram @theclawlab/xgw-plugin-telegram
```

### plugin add

```bash
xgw plugin add <type> <package>
```

将 `type → package` 写入 config.yaml 的 `plugins` 节。

### plugin remove

```bash
xgw plugin remove <type>
```

### plugin list

```bash
xgw plugin list [--json]
```

### channel 级别覆盖

在 channel 配置里指定 `plugin` 字段可覆盖全局注册（适合测试 beta 版本）：

```yaml
channels:
  - id: tg-test
    type: telegram
    plugin: "@theclawlab/xgw-plugin-telegram-beta"
```

### 插件查找顺序

1. channel 配置里的 `plugin` 字段（npm 包名）
2. config.yaml 顶层 `plugins.<type>`（全局注册）
3. xgw 内置 `plugins/<type>/`（开发 fallback，仅 tui）

---

## Daemon 管理

### start

后台启动 daemon：

```bash
xgw start
```

前台运行（日志输出到 stdout，适合调试）：

```bash
xgw start --foreground
```

指定配置文件：

```bash
xgw start --config /path/to/config.yaml
```

同一时间只允许一个实例运行。后台模式下日志写入 `$XGW_HOME/logs/xgw.log`。

### stop

```bash
xgw stop
```

### reload

热重载配置（向运行中的 daemon 发送 SIGUSR1）：

```bash
xgw reload
```

daemon 未运行时静默成功。

### status

```bash
xgw status
xgw status --json
```

---

## Channel 管理

### channel add

```bash
xgw channel add --id <id> --type <type> [--set key=value ...]
```

`--set` 可传入任意额外字段，例如 `--set token=abc123`。

### channel remove / list / pair / health

```bash
xgw channel remove --id <id>
xgw channel list [--json]
xgw channel pair --id <id>
xgw channel health [--id <id>] [--json]
```

---

## Agent 管理

```bash
xgw agent add --id <agent-id> --inbox <thread-path>
xgw agent remove --id <agent-id>
xgw agent list [--json]
```

---

## 路由管理

```bash
xgw route add --channel <id> --peer <peer-id> --agent <agent-id>
xgw route remove --channel <id> --peer <peer-id>
xgw route list [--json]
```

`--peer "*"` 匹配该 channel 的所有 peer。

---

## 发送消息（诊断工具）

`xgw send` 在 v2 中是诊断工具，正常消息路径由 xar 通过 IPC 直接 push 到 xgw。

```bash
xgw send --channel <id> --peer <peer-id> --session <session-id> --message "hello"
echo "hello" | xgw send --channel tui-main --peer alice --session alice
```

---

## 配置校验

```bash
xgw config check [--config <path>]
```

---

## 退出码

| 退出码 | 含义 |
|--------|------|
| `0` | 成功 |
| `1` | 运行时错误（daemon 未运行、channel 不存在等） |
| `2` | 参数/用法错误（缺少必填参数、未知命令） |
