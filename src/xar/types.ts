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

export interface CtxUsage {
  total_tokens: number;
  budget_tokens: number;
  pct: number;
}

export interface CompactStartInfo {
  reason: 'threshold' | 'interval';
}

export interface CompactEndInfo {
  before_tokens: number;
  after_tokens: number;
}

export type XarOutboundEvent =
  | { type: 'stream_start';         reply_context: ReplyContext; session_id: string }
  | { type: 'stream_token';         session_id: string; token: string }
  | { type: 'stream_thinking';      session_id: string; delta: string }
  | { type: 'stream_tool_call';     session_id: string; tool_call: unknown }
  | { type: 'stream_tool_result';   session_id: string; tool_result: unknown }
  | { type: 'stream_end';           session_id: string }
  | { type: 'stream_error';         session_id: string; error: string }
  | { type: 'stream_ctx_usage';     reply_context: ReplyContext; session_id: string; ctx_usage: CtxUsage }
  | { type: 'stream_compact_start'; reply_context: ReplyContext; session_id: string; compact_start: CompactStartInfo }
  | { type: 'stream_compact_end';   reply_context: ReplyContext; session_id: string; compact_end: CompactEndInfo };

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
  /** Whether the plugin supports streaming (chunk-by-chunk) delivery */
  streaming: boolean;
  /** Accumulated tokens (non-TUI: full message; TUI/streaming: pending batch) */
  tokenBuffer: string[];
  /** TUI only: pending flush timer handle */
  flushTimer: ReturnType<typeof setTimeout> | null;
  /** Timeout handle for stream_end watchdog */
  watchdogTimer: ReturnType<typeof setTimeout> | null;
  /** Pending progress sends (tool_result etc.) that must complete before stream_end */
  pendingProgress?: Promise<void>;
}
