# xgw

A CLI tool and daemon that acts as a communication gateway between AI agents and external peers — routing inbound messages from channels (e.g. Telegram) to agent inboxes, and delivering outbound replies back to the right peer.

## How it works

- Configure channels (external messaging platforms), agents (inbox paths), and routing rules in a YAML config file.
- Start the daemon with `xgw start` — it listens for inbound messages on each channel and routes them to the matching agent's inbox via `thread push`.
- When an agent replies, `xgw send` delivers the message back to the peer on the correct channel.
- Routing rules map `channel + peer → agent`; `peer: "*"` catches all peers on a channel.

## Install

### From npm

```bash
npm install -g @theclawlab/xgw
```

### From source

```bash
npm run build && npm link
```

## Quick start

```bash
# Start the daemon
xgw start

# Add a channel
xgw channel add --id telegram --type tui

# Register an agent inbox
xgw agent add --id my-agent --inbox ~/.theclaw/agents/my-agent/inbox

# Add a routing rule (all telegram peers → my-agent)
xgw route add --channel telegram --peer "*" --agent my-agent

# Check daemon status
xgw status

# Send a message to a peer
xgw send --channel telegram --peer user42 --session s1 --message "hello"

# Stop the daemon
xgw stop
```

## Commands

| Command | Description |
|---------|-------------|
| `xgw start` | Start the gateway daemon (background by default) |
| `xgw stop` | Stop the daemon |
| `xgw reload` | Hot-reload config (SIGUSR1) |
| `xgw status` | Show daemon status and active channels |
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
| `xgw send` | Send a message to a peer via a channel |
| `xgw config check` | Validate the config file |

## Data directory

Default: `~/.local/share/xgw/` — override with `XGW_HOME`.  
Config file default: `~/.config/xgw/config.yaml` — override with `XGW_CONFIG` or `--config`.

```
$XGW_HOME/
├── logs/    # daemon logs
└── xgw.pid  # daemon lock file
```

## Dependencies

Requires the following tools to be installed and on `PATH`:

- [`thread`](../thread) — event queue CLI (used to push messages into agent inboxes)

## Documentation

- [USAGE.md](./USAGE.md) — full CLI reference, config format, and routing details
