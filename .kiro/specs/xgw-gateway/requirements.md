# Requirements Document

## Introduction

xgw is a communication gateway daemon and CLI for TheClaw. It routes messages from external peers (via IM channels) to internal agents' inbox threads, and delivers agent replies back to the corresponding channels. It runs as a daemon with CLI management commands, supports a channel plugin system for extensibility, and includes a TUI plugin/client for terminal-based chat.

## Glossary

- **Gateway**: The xgw daemon process that listens for inbound messages from channels and provides outbound delivery.
- **Channel**: An IM communication endpoint (e.g., Telegram, Slack, TUI) implemented as a plugin.
- **Channel_Plugin**: A module implementing the `ChannelPlugin` interface that handles inbound/outbound message conversion for a specific channel type.
- **Peer**: An external user communicating through a channel.
- **Agent**: An internal TheClaw agent that receives messages in its inbox thread.
- **Inbox**: An agent's inbox thread where inbound messages are written via `thread push`.
- **Router**: The component that maps (channel_id, peer_id) to a target agent_id using configured routing rules.
- **Message**: The unified internal message structure that all channel messages are normalized into.
- **Config**: The YAML configuration file containing gateway settings, channel definitions, routing rules, and agent registrations.
- **Daemon**: The long-running xgw process that listens for inbound messages and serves outbound delivery.
- **Notifier**: The TheClaw daemon lifecycle manager used to start/stop xgw.
- **TUI_Plugin**: The built-in channel plugin that accepts local WebSocket connections from xgw-tui clients.
- **XGW_TUI**: The terminal chat client that connects to the TUI_Plugin via WebSocket.
- **Pair**: The process of validating channel credentials and configuring channel-side message delivery.

## Requirements

### Requirement 1: Configuration Loading and Validation

**User Story:** As a system operator, I want xgw to load and validate its configuration from a YAML file, so that I can reliably configure the gateway's behavior.

#### Acceptance Criteria

1. WHEN xgw starts, THE Config_Loader SHALL load configuration from the path specified by `--config` flag, `XGW_CONFIG` environment variable, or the default path `~/.config/xgw/config.yaml` (in that precedence order).
2. WHEN a configuration file is loaded, THE Config_Loader SHALL validate that all required fields (`gateway.host`, `gateway.port`, `channels`, `routing`, `agents`) are present and correctly typed.
3. IF the configuration file does not exist or fails validation, THEN THE Config_Loader SHALL exit with code 1 and print a descriptive error to stderr.
4. WHEN `xgw config check` is executed, THE Config_Loader SHALL validate the configuration file and report any syntax or structural errors.
5. WHEN a CLI management command modifies the configuration (route/channel/agent add/remove), THE Config_Loader SHALL write the updated configuration back to the YAML file atomically.

### Requirement 2: Gateway Daemon Lifecycle

**User Story:** As a system operator, I want to start, stop, and monitor the xgw daemon, so that I can manage the gateway's runtime.

#### Acceptance Criteria

1. WHEN `xgw start` is executed, THE Gateway SHALL start the daemon process, load configuration, initialize all paired channels, and begin listening for inbound messages.
2. WHEN `xgw start --foreground` is executed, THE Gateway SHALL run in the foreground with logs output to both stdout and the log file.
3. WHEN `xgw stop` is executed, THE Gateway SHALL gracefully stop all channel plugins and terminate the daemon process.
4. WHEN `xgw status` is executed, THE Gateway SHALL report the daemon's running state, each channel's health status, and message statistics.
5. WHEN `xgw status --json` is executed, THE Gateway SHALL output the status information as structured JSON to stdout.
6. WHEN `xgw reload` is executed while the daemon is running, THE Gateway SHALL reload the configuration file and rebuild channel and routing state.
7. WHEN `xgw reload` is executed while the daemon is not running, THE Gateway SHALL exit with code 0 silently (changes take effect on next start).
8. THE Gateway SHALL write its PID to `~/.local/share/xgw/xgw.pid` on startup and remove it on shutdown.

### Requirement 3: Channel Plugin System

**User Story:** As a developer, I want a plugin-based channel system, so that new IM channels can be added without modifying the gateway core.

#### Acceptance Criteria

1. THE Channel_Registry SHALL load channel plugins based on the `type` field in each channel configuration entry.
2. WHEN a channel plugin is loaded, THE Channel_Registry SHALL verify that it implements the `ChannelPlugin` interface (`pair`, `start`, `stop`, `send`, `health` methods).
3. WHEN the daemon starts, THE Channel_Registry SHALL call `start()` only on channels that have `paired: true` in their configuration.
4. WHEN the daemon stops, THE Channel_Registry SHALL call `stop()` on all running channel plugins.
5. IF a channel plugin's `start()` call fails, THEN THE Channel_Registry SHALL log the error and continue starting other channels.

### Requirement 4: Channel Instance Management

**User Story:** As a system operator, I want to add, remove, pair, and inspect channel instances, so that I can manage which IM channels the gateway connects to.

#### Acceptance Criteria

1. WHEN `xgw channel add --id <id> --type <type>` is executed, THE Channel_Manager SHALL add a new channel entry to the configuration file.
2. IF a channel with the same id already exists, THEN THE Channel_Manager SHALL exit with code 1 and print an error suggesting to remove first.
3. WHEN `xgw channel pair --id <id>` is executed, THE Channel_Manager SHALL invoke the channel plugin's `pair()` method and write the pair result (`paired`, `pair_mode`, `pair_info`, `paired_at`) to the configuration.
4. WHEN `xgw channel remove --id <id>` is executed, THE Channel_Manager SHALL remove the channel entry and clean up or report routing rules referencing that channel.
5. WHEN `xgw channel list` is executed, THE Channel_Manager SHALL display all configured channels with their id, type, and paired status.
6. WHEN `xgw channel health --id <id>` is executed while the daemon is running, THE Channel_Manager SHALL invoke the channel plugin's `health()` method and report the result.
7. IF `xgw channel health` is executed while the daemon is not running, THEN THE Channel_Manager SHALL exit with code 1 with an error message.

### Requirement 5: Inbound Message Routing

**User Story:** As a system operator, I want inbound messages to be routed to the correct agent's inbox, so that each agent receives messages intended for it.

#### Acceptance Criteria

1. WHEN an inbound message arrives, THE Router SHALL look up the routing rules to find a matching `(channel_id, peer_id)` → `agent_id` mapping.
2. WHEN multiple routing rules match, THE Router SHALL use the most specific rule (exact peer match takes priority over wildcard `peer: "*"`).
3. WHEN a matching agent is found, THE Inbox SHALL write the normalized message to the agent's inbox thread via `thread push`.
4. IF no routing rule matches the inbound message, THEN THE Router SHALL log a warning and discard the message without error.
5. THE Router SHALL evaluate routing rules in priority order: exact `(channel, peer)` matches first, then wildcard `(channel, *)` matches.

### Requirement 6: Outbound Message Delivery

**User Story:** As an agent system, I want to deliver reply messages back to peers through their original channels, so that conversations are bidirectional.

#### Acceptance Criteria

1. WHEN `xgw send --channel <id> --peer <id> --session <id> --message <text>` is executed, THE Send_Handler SHALL deliver the message through the specified channel plugin's `send()` method.
2. WHEN `--message` is omitted, THE Send_Handler SHALL read the message text from stdin.
3. WHEN the message is delivered successfully, THE Send_Handler SHALL exit with code 0.
4. IF the specified channel does not exist or the send fails, THEN THE Send_Handler SHALL exit with code 1 and print an error to stderr.
5. WHEN `--json` flag is provided, THE Send_Handler SHALL output the send result as structured JSON to stdout.

### Requirement 7: Route Management

**User Story:** As a system operator, I want to manage routing rules dynamically, so that I can control which agent handles messages from which peer/channel combination.

#### Acceptance Criteria

1. WHEN `xgw route add --channel <id> --peer <id> --agent <id>` is executed, THE Route_Manager SHALL insert the rule before any wildcard fallback rules in the configuration.
2. WHEN a route with the same channel and peer already exists, THE Route_Manager SHALL update the agent target of the existing rule.
3. WHEN `xgw route remove --channel <id> --peer <id>` is executed, THE Route_Manager SHALL remove the matching rule from the configuration.
4. IF the route to be removed does not exist, THEN THE Route_Manager SHALL exit with code 1.
5. WHEN `xgw route list` is executed, THE Route_Manager SHALL display all routing rules sorted by match priority.
6. WHEN a route is added or removed, THE Route_Manager SHALL write the updated configuration and trigger a daemon reload.

### Requirement 8: Agent Inbox Registration

**User Story:** As a system operator, I want to register agent inbox paths, so that the gateway knows where to deliver inbound messages for each agent.

#### Acceptance Criteria

1. WHEN `xgw agent add --id <id> --inbox <path>` is executed, THE Agent_Manager SHALL register the agent's inbox path in the configuration.
2. WHEN an agent with the same id already exists, THE Agent_Manager SHALL update the inbox path.
3. WHEN `xgw agent remove --id <id>` is executed, THE Agent_Manager SHALL remove the agent registration.
4. IF routing rules reference the agent being removed, THEN THE Agent_Manager SHALL exit with code 1 and report the conflicting routes.
5. WHEN `xgw agent list` is executed, THE Agent_Manager SHALL display all registered agents and their inbox paths.
6. WHEN an agent is added or removed, THE Agent_Manager SHALL write the updated configuration and trigger a daemon reload.

### Requirement 9: Message Normalization

**User Story:** As a developer, I want all channel messages normalized into a unified internal structure, so that the gateway core processes messages uniformly regardless of source channel.

#### Acceptance Criteria

1. THE Channel_Plugin SHALL normalize each inbound raw channel message into the internal Message structure containing: `id`, `channel_id`, `peer_id`, `peer_name`, `session_id`, `text`, `attachments`, `reply_to`, `created_at`, and `raw`.
2. THE Gateway SHALL generate a UUID for each inbound message's `id` field.
3. THE Channel_Plugin SHALL convert outbound send parameters (`peer_id`, `session_id`, `text`, `reply_to`) into the channel-specific API call format.
4. THE Message structure SHALL use ISO 8601 format for the `created_at` timestamp.

### Requirement 10: TUI Plugin

**User Story:** As a developer, I want a built-in TUI channel plugin, so that I can test the gateway locally using a terminal client without external IM dependencies.

#### Acceptance Criteria

1. WHEN the TUI_Plugin starts, THE TUI_Plugin SHALL listen on a local WebSocket port (default 18791, configurable via channel config `port` field).
2. WHEN a client connects and sends a valid `hello` message, THE TUI_Plugin SHALL respond with a `hello_ack` message and register the connection with the declared `peer_id`.
3. IF a client sends an invalid `hello` message, THEN THE TUI_Plugin SHALL respond with an `error` message (code `bad_hello`) and close the connection.
4. WHEN a client sends a `message` frame, THE TUI_Plugin SHALL normalize it into the internal Message structure and invoke the `onMessage` callback.
5. WHEN `send()` is called on the TUI_Plugin, THE TUI_Plugin SHALL deliver the message to the WebSocket connection matching the target `peer_id`.
6. WHEN a client sends a `ping` frame, THE TUI_Plugin SHALL respond with a `pong` frame.
7. THE TUI_Plugin SHALL set `pair_mode` to `ws` and `paired` to `true` by default (no credentials required).

### Requirement 11: XGW-TUI Client

**User Story:** As a user, I want a terminal chat client, so that I can interact with agents through the gateway from my terminal.

#### Acceptance Criteria

1. WHEN `xgw-tui --channel <id> --peer <id>` is executed, THE XGW_TUI SHALL connect to the TUI_Plugin via WebSocket and complete the hello handshake.
2. WHEN the user types a line and presses Enter, THE XGW_TUI SHALL send a `message` frame to the TUI_Plugin.
3. WHEN the TUI_Plugin pushes a `message` frame, THE XGW_TUI SHALL display it with an `agent> ` prefix.
4. WHEN the user inputs `/quit` or presses Ctrl+C, THE XGW_TUI SHALL close the WebSocket connection and exit.
5. IF the WebSocket connection drops, THEN THE XGW_TUI SHALL attempt reconnection up to 3 times with exponential backoff, then exit with code 1 if all attempts fail.
6. THE XGW_TUI SHALL send a `ping` frame every 30 seconds to maintain the connection.
7. THE XGW_TUI SHALL display the connection status on startup in the format `[<channel>/<peer>] Connected.`.

### Requirement 12: Logging

**User Story:** As a system operator, I want structured runtime logs, so that I can monitor and debug the gateway's operation.

#### Acceptance Criteria

1. THE Logger SHALL write log entries in the format `[<ISO8601 timestamp>] [<LEVEL>] <message>` to the log file at `~/.local/share/xgw/logs/xgw.log`.
2. WHEN the log file exceeds 10000 lines, THE Logger SHALL rotate it to `xgw-<YYYYMMDD-HHmmss>.log` and start a new log file.
3. WHEN running in foreground mode, THE Logger SHALL output log entries to both stdout and the log file.
4. THE Logger SHALL log inbound message events with channel, peer, agent, and message id fields.
5. THE Logger SHALL log outbound delivery events with channel, peer, and session fields.
6. THE Logger SHALL log routing misses as warnings with channel and peer fields.

### Requirement 13: Error Handling and Exit Codes

**User Story:** As a system operator, I want consistent error reporting and exit codes, so that I can script and automate gateway management.

#### Acceptance Criteria

1. THE CLI SHALL exit with code 0 on success.
2. THE CLI SHALL exit with code 1 on logic errors (config errors, channel send failures, missing resources).
3. THE CLI SHALL exit with code 2 on usage/argument errors (missing required arguments, invalid flags).
4. WHEN an error occurs, THE CLI SHALL print the error to stderr in the format `Error: <what went wrong> - <how to fix>`.
5. THE CLI SHALL output command result data to stdout and progress/debug/warning messages to stderr.

### Requirement 14: Configuration Serialization

**User Story:** As a system operator, I want the configuration to be reliably persisted as YAML, so that manual edits and CLI-driven changes are both supported.

#### Acceptance Criteria

1. THE Config_Serializer SHALL parse YAML configuration files into typed Config objects.
2. THE Config_Serializer SHALL serialize Config objects back into valid YAML files.
3. FOR ALL valid Config objects, parsing then serializing then parsing SHALL produce an equivalent Config object (round-trip property).
4. THE Config_Serializer SHALL preserve comments in the YAML file when performing CLI-driven mutations.
