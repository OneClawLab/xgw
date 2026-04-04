# xgw

Communication gateway daemon for TheClaw. Routes inbound messages from external channels (TUI, Telegram, etc.) to xar agent runtime via IPC, and delivers streaming replies back to peers.

## How it works

- Configure channels, agents, routing rules, and plugins in a YAML config file.
- Start the daemon with `xgw start` — it connects to the xar daemon via IPC and starts listening on each channel.
- Inbound messages are forwarded to xar over IPC; xar processes them and streams replies back through xgw to the channel.
- Routing rules map `channel + peer → agent`; `peer: "*"` catches all peers on a channel.

## Install

```bash
npm run build && npm link
```

## Quick start

```bash
# 1. Create config
mkdir -p ~/.config/xgw
cat > ~/.config/xgw/config.yaml << 'EOF'
gateway:
  host: 127.0.0.1
  port: 28211

xar:
  port: 28213

channels:
  - id: tui-main
    type: tui
    port: 28212
    paired: true
    pair_mode: ws

routing:
  - channel: tui-main
    peer: "*"
    agent: admin

agents:
  admin:
    inbox: ~/.theclaw/agents/admin/inbox
EOF

# 2. Validate config
xgw config check

# 3. Start daemon (after xar daemon is running)
xgw start --foreground
```

## Commands

| Command | Description |
|---------|-------------|
| `xgw start` | Start the gateway daemon |
| `xgw stop` | Stop the daemon |
| `xgw reload` | Hot-reload config (SIGUSR1) |
| `xgw status` | Show daemon status |
| `xgw plugin add <type> <pkg>` | Register a channel plugin |
| `xgw plugin remove <type>` | Unregister a plugin |
| `xgw plugin list` | List registered plugins |
| `xgw channel add` | Add a channel |
| `xgw channel remove` | Remove a channel |
| `xgw channel list` | List channels |
| `xgw channel pair` | Pair/authenticate a channel |
| `xgw channel health` | Check channel health |
| `xgw agent add` | Register an agent inbox |
| `xgw agent remove` | Unregister an agent |
| `xgw agent list` | List registered agents |
| `xgw route add` | Add a routing rule |
| `xgw route remove` | Remove a routing rule |
| `xgw route list` | List routing rules |
| `xgw send` | Send a message to a peer (diagnostics) |
| `xgw config check` | Validate the config file |

## Installing channel plugins

The TUI plugin is built-in. For other channels:

```bash
npm install -g @theclawlab/xgw-plugin-telegram
xgw plugin add telegram @theclawlab/xgw-plugin-telegram
```

## Data directory

Config: `~/.config/xgw/config.yaml` — override with `XGW_CONFIG` or `--config`.  
Runtime: `~/.local/share/xgw/` — override with `XGW_HOME`.

## Documentation

- [USAGE.md](./USAGE.md) — full CLI reference and config format
