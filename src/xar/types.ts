// IPC types for xgw ↔ xar WebSocket communication

export interface XarConfig {
  /** Unix socket path, default: ~/.theclaw/xar.sock */
  socket: string;
  /** TCP fallback port, default: 18792 */
  port: number;
  /** Initial reconnect interval in ms, default: 3000 */
  reconnect_interval_ms: number;
}

export interface ReplyContext {
  channel_type: string;
  channel_id: string;
  session_type: string;
  session_id: string;
  peer_id: string;
  /** Optional: used by channels that have a connection ID (e.g. TUI) */
  ipc_conn_id?: string;
}

export interface InboundMessage {
  /** Format: "external:<type>:<channel_id>:<session_type>:<session_id>:<peer_id>" */
  source: string;
  /** Message text content */
  content: string;
  reply_context: ReplyContext;
}

export type XarOutboundEvent =
  | { type: 'stream_start';    reply_context: ReplyContext; session_id: string }
  | { type: 'stream_token';    session_id: string; token: string }
  | { type: 'stream_thinking'; session_id: string; delta: string }
  | { type: 'stream_end';      session_id: string }
  | { type: 'stream_error';    session_id: string; error: string };

/** Internal buffer unit used by XarClient when disconnected */
export interface InboundEnvelope {
  agentId: string;
  message: InboundMessage;
  enqueuedAt: number; // Date.now()
}

/** Internal session state tracked by Dispatcher */
export interface SessionState {
  channelId: string;
  channelType: string;
  peerId: string;
  sessionId: string;
  /** Accumulated tokens for non-TUI channels */
  tokenBuffer: string[];
}
