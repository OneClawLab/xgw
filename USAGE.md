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
  host: "0.0.0.0"
  port: 8080

channels:
  - id: telegram
    type: tui          # 目前支持 tui；其他类型通过插件扩展
    paired: false

agents:
  my-agent:
    inbox: /home/user/.theclaw/agents/my-agent/inbox

routing:
  - channel: telegram
    peer: "*"
    agent: my-agent
```

### 字段说明

- `gateway.host` / `gateway.port`：HTTP gateway 监听地址
- `channels`：channel 实例列表，每个 channel 需有唯一 `id` 和 `type`
- `agents`：注册的 agent，key 为 agent id，`inbox` 为 thread 目录路径
- `routing`：路由规则，`channel` + `peer` → `agent`；`peer` 可用 `*` 匹配所有

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

停止 daemon（发送 SIGTERM，等待最多 5 秒）：

```bash
xgw stop
```

### reload

热重载配置（向运行中的 daemon 发送 SIGUSR1）：

```bash
xgw reload
```

daemon 未运行时静默成功，配置变更将在下次启动时生效。

### status

查看 daemon 状态：

```bash
xgw status
xgw status --json
```

JSON 输出示例：

```json
{
  "running": true,
  "pid": 12345,
  "channels": [
    { "id": "telegram", "type": "tui", "paired": true }
  ]
}
```

---

## Channel 管理

### channel add

```bash
xgw channel add --id <id> --type <type> [--set key=value ...]
```

`--set` 可传入任意额外字段，例如 `--set token=abc123`。

### channel remove

```bash
xgw channel remove --id <id>
```

### channel list

```bash
xgw channel list [--json]
```

### channel pair

对 channel 进行配对（验证凭证、完成 webhook/polling 注册）：

```bash
xgw channel pair --id <id>
```

### channel health

检查 channel 健康状态：

```bash
xgw channel health [--id <id>] [--json]
```

---

## Agent 管理

### agent add

注册一个 agent 的 inbox：

```bash
xgw agent add --id <agent-id> --inbox <thread-path>
```

### agent remove

```bash
xgw agent remove --id <agent-id>
```

### agent list

```bash
xgw agent list [--json]
```

---

## 路由管理

### route add

添加或更新路由规则（channel + peer → agent）：

```bash
xgw route add --channel <id> --peer <peer-id> --agent <agent-id>
```

`--peer` 可用 `*` 匹配该 channel 的所有 peer。

### route remove

```bash
xgw route remove --channel <id> --peer <peer-id>
```

### route list

```bash
xgw route list [--json]
```

---

## 发送消息

通过指定 channel 向 peer 发送消息：

```bash
xgw send --channel <id> --peer <peer-id> --session <session-id> --message "hello"
```

从 stdin 读取消息内容：

```bash
echo "hello" | xgw send --channel telegram --peer user42 --session s1
```

回复指定消息：

```bash
xgw send --channel telegram --peer user42 --session s1 \
  --message "got it" --reply-to <message-id>
```

---

## 配置校验

```bash
xgw config check [--config <path>]
```

校验通过输出 `Config OK: <path>`，失败时打印所有错误并以退出码 1 退出。

---

## 退出码

| 退出码 | 含义 |
|--------|------|
| `0` | 成功 |
| `1` | 运行时错误（daemon 未运行、channel 不存在等） |
| `2` | 参数/用法错误（缺少必填参数、未知命令） |

---

## 帮助

```bash
xgw --help
xgw start --help
xgw channel --help
xgw --version
```
