# Implementation Plan: xgw-gateway

## Overview

Incremental implementation of the xgw communication gateway. Each task builds on previous ones, starting with core types and config, then routing and channel infrastructure, then CLI commands, then TUI plugin/client. Testing is integrated alongside implementation using vitest + fast-check.

## Tasks

- [ ] 1. Project setup and shared types
  - [ ] 1.1 Initialize package.json, tsconfig.json, tsup.config.ts, vitest.config.ts with TypeScript ESM, commander, ws, js-yaml, fast-check dependencies
    - _Requirements: 2.1 (tech stack)_
  - [ ] 1.2 Create `src/types.ts` with shared type definitions: `Message`, `Attachment`, `SendParams`, `HealthResult`, `PairResult`, `GatewayStats`
    - _Requirements: 9.1, 9.4_
  - [ ] 1.3 Create `src/channels/types.ts` with `ChannelPlugin`, `ChannelConfig` interfaces
    - _Requirements: 3.1, 3.2_
  - [ ] 1.4 Create `src/config.ts` with `Config`, `GatewayConfig`, `RoutingRule`, `AgentConfig` types, and functions: `resolveConfigPath`, `loadConfig`, `validateConfig`, `saveConfig`
    - _Requirements: 1.1, 1.2, 1.3, 1.5, 14.1, 14.2_
  - [ ]* 1.5 Write property tests for config module
    - **Property 1: Config path resolution precedence**
    - **Validates: Requirements 1.1**
    - **Property 2: Config validation rejects invalid configs**
    - **Validates: Requirements 1.2**
    - **Property 4: Config YAML round-trip**
    - **Validates: Requirements 14.3**
    - **Property 5: Config comment preservation**
    - **Validates: Requirements 14.4**

- [ ] 2. Logger
  - [ ] 2.1 Create `src/logger.ts` with `Logger` class: `info`, `warn`, `error` methods, foreground mode toggle, log rotation at 10000 lines
    - _Requirements: 12.1, 12.2, 12.3_
  - [ ]* 2.2 Write property tests for logger
    - **Property 25: Log entry format**
    - **Validates: Requirements 12.1**
    - **Property 26: Log event fields**
    - **Validates: Requirements 12.4, 12.5, 12.6**

- [ ] 3. Router
  - [ ] 3.1 Create `src/gateway/router.ts` with `Router` class: `resolve(channelId, peerId)` returning agent_id or null, `reload(rules)` to update routing table
    - Resolution: exact (channel, peer) match > wildcard (channel, *) match > null
    - _Requirements: 5.1, 5.2, 5.4, 5.5_
  - [ ]* 3.2 Write property tests for router
    - **Property 8: Router resolves to most specific match**
    - **Validates: Requirements 5.1, 5.2, 5.5**
    - **Property 9: Router returns null for unmatched messages**
    - **Validates: Requirements 5.4**

- [ ] 4. Checkpoint - Core modules
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 5. Config mutation operations (route, channel, agent managers)
  - [ ] 5.1 Create `src/commands/route.ts` with route add/remove/list logic: insert before wildcards, update duplicates, remove by (channel, peer)
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6_
  - [ ]* 5.2 Write property tests for route manager
    - **Property 10: Route add inserts before wildcards**
    - **Validates: Requirements 7.1**
    - **Property 11: Route add updates existing duplicate**
    - **Validates: Requirements 7.2**
    - **Property 12: Route remove deletes the matching rule**
    - **Validates: Requirements 7.3**
    - **Property 13: Route list is sorted by match priority**
    - **Validates: Requirements 7.5**
  - [ ] 5.3 Create `src/commands/agent-mgmt.ts` with agent add/remove/list logic: register inbox path, update existing, block removal if referenced by routes
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6_
  - [ ]* 5.4 Write property tests for agent manager
    - **Property 14: Agent add/update registers inbox correctly**
    - **Validates: Requirements 8.1, 8.2**
    - **Property 15: Agent remove deletes registration**
    - **Validates: Requirements 8.3**
  - [ ] 5.5 Create `src/commands/channel-mgmt.ts` with channel add/remove/list/health/pair logic: add new entry, block duplicate id, remove and clean up routes, pair via plugin
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7_
  - [ ]* 5.6 Write property tests for channel manager
    - **Property 16: Channel add creates new entry**
    - **Validates: Requirements 4.1**
    - **Property 17: Channel remove cleans up config**
    - **Validates: Requirements 4.4**
  - [ ]* 5.7 Write property test for config mutation round-trip
    - **Property 3: Config mutation round-trip**
    - **Validates: Requirements 1.5, 14.3**

- [ ] 6. Checkpoint - Config mutation
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 7. Channel registry and inbox writer
  - [ ] 7.1 Create `src/channels/registry.ts` with `ChannelRegistry` class: register plugin types, load plugins from config, startAll (only paired), stopAll, getPlugin, healthCheck
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_
  - [ ]* 7.2 Write property tests for channel registry
    - **Property 6: Channel registry starts only paired channels**
    - **Validates: Requirements 3.3**
    - **Property 7: Channel registry stops all running plugins**
    - **Validates: Requirements 3.4**
  - [ ] 7.3 Create `src/inbox.ts` with `InboxWriter`: invoke `thread push` to write normalized message to agent inbox thread, format source address as `external:<type>:<channel_id>:<session_type>:<session_id>:<peer_id>`
    - _Requirements: 5.3_

- [ ] 8. Gateway server and send handler
  - [ ] 8.1 Create `src/gateway/server.ts` with `GatewayServer`: HTTP + WebSocket server, webhook endpoints for channel plugins, message processing pipeline (plugin → router → inbox), stats tracking
    - _Requirements: 2.1, 5.1, 5.3_
  - [ ] 8.2 Create `src/gateway/send.ts` with `SendHandler`: look up channel plugin from registry, call plugin.send(), return SendResult
    - _Requirements: 6.1, 6.3, 6.4_
  - [ ]* 8.3 Write property test for send handler
    - **Property 22: Send handler dispatches to correct plugin**
    - **Validates: Requirements 6.1**

- [ ] 9. CLI entry point and commands
  - [ ] 9.1 Create `src/index.ts` with commander program: register all subcommands (start, stop, status, send, reload, config check, route, channel, agent)
    - _Requirements: 13.1, 13.2, 13.3, 13.5_
  - [ ] 9.2 Create `src/commands/start.ts`: load config, init channel registry, start gateway server, write PID file, handle --foreground flag, daemon mode via notifier
    - _Requirements: 2.1, 2.2, 2.8_
  - [ ] 9.3 Create `src/commands/stop.ts`: read PID file, send signal to stop daemon, clean up PID file
    - _Requirements: 2.3_
  - [ ] 9.4 Create `src/commands/status.ts`: check daemon running state, query channel health, format output (human-readable or --json)
    - _Requirements: 2.4, 2.5_
  - [ ] 9.5 Create `src/commands/send.ts`: parse args, read message from --message or stdin, call SendHandler, format output (human-readable or --json)
    - _Requirements: 6.1, 6.2, 6.5_
  - [ ] 9.6 Create `src/commands/reload.ts`: send SIGUSR1 to daemon, exit 0 if daemon not running
    - _Requirements: 2.6, 2.7_
  - [ ] 9.7 Create `src/commands/config-check.ts`: load and validate config, report errors
    - _Requirements: 1.4_
  - [ ]* 9.8 Write property test for error message format
    - **Property 27: Error message format**
    - **Validates: Requirements 13.4**

- [ ] 10. Checkpoint - Core gateway
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 11. TUI Plugin
  - [ ] 11.1 Initialize `plugins/tui/` project: package.json, tsconfig.json, tsup.config.ts
    - _Requirements: 10.1_
  - [ ] 11.2 Create `plugins/tui/src/index.ts` with `TuiPlugin` implementing `ChannelPlugin`: WebSocket server, hello/hello_ack handshake, message normalization, send to peer by peer_id, ping/pong, pair() returns success with pair_mode=ws
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 9.1, 9.2, 9.3, 9.4_
  - [ ]* 11.3 Write property tests for TUI plugin
    - **Property 18: TUI Plugin message normalization**
    - **Validates: Requirements 9.1, 9.2, 9.4, 10.4**
    - **Property 19: TUI Plugin hello handshake**
    - **Validates: Requirements 10.2**
    - **Property 20: TUI Plugin invalid hello rejection**
    - **Validates: Requirements 10.3**
    - **Property 21: TUI Plugin send routes to correct peer**
    - **Validates: Requirements 10.5**

- [ ] 12. XGW-TUI Client
  - [ ] 12.1 Initialize `clients/tui/` project: package.json, tsconfig.json, tsup.config.ts
    - _Requirements: 11.1_
  - [ ] 12.2 Create `clients/tui/src/index.ts` with xgw-tui CLI: commander parsing (--channel, --peer, --host, --port), WebSocket connection, hello handshake, readline loop, message display with `agent> ` prefix, /quit handling, ping every 30s, reconnection with exponential backoff (1s, 2s, 4s, max 3 attempts)
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.7_
  - [ ]* 12.3 Write property tests for xgw-tui client
    - **Property 23: XGW-TUI agent message formatting**
    - **Validates: Requirements 11.3**
    - **Property 24: XGW-TUI reconnection backoff**
    - **Validates: Requirements 11.5**
    - **Property 28: XGW-TUI connection status format**
    - **Validates: Requirements 11.7**

- [ ] 13. Final checkpoint
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Property tests use fast-check with minimum 100 iterations
- Shell command utilities (os-utils.ts) are copied from the pai repo — no separate tests needed in xgw
- Checkpoints ensure incremental validation
