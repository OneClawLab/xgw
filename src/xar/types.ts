// IPC types for xgw ↔ xar WebSocket communication

export interface XarConfig {
  /** Unix socket path, default: ~/.theclaw/xar.sock */
  socket: string;
  /** TCP fallback port, default: 18792 */
  port: number;
  /** Initial reconnect interval in ms, default: 3000 */
  reconnect_interval_ms: number;
}

/**
 * Inbound message sent from xgw → xar.
 * Only source + content; no reply_context (outbound info derived from source).
 */
export interface InboundMessage {
  /** Format: "external:<channel_type>:<instance>:<conversation_type>:<conversation_id>:<peer_id>" */
  source: string;
  /** Message text content */
  content: string;
}

/**
 * Outbound target address, carried only in stream_start.
 */
export interface OutboundTarget {
  channel_id: string;
  peer_id: string;
  conversation_id: string;
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

/**
 * Outbound events from xar → xgw.
 * stream_start carries target + stream_id; all other events use stream_id only.
 */
export type XarOutboundEvent =
  | { type: 'stream_start';         target: OutboundTarget; stream_id: string }
  | { type: 'stream_token';         stream_id: string; token: string }
  | { type: 'stream_thinking';      stream_id: string; delta: string }
  | { type: 'stream_tool_call';     stream_id: string; tool_call: unknown }
  | { type: 'stream_tool_result';   stream_id: string; tool_result: unknown }
  | { type: 'stream_end';           stream_id: string }
  | { type: 'stream_error';         stream_id: string; error: string }
  | { type: 'stream_ctx_usage';     stream_id: string; ctx_usage: CtxUsage }
  | { type: 'stream_compact_start'; stream_id: string; compact_start: CompactStartInfo }
  | { type: 'stream_compact_end';   stream_id: string; compact_end: CompactEndInfo };

/** Internal buffer unit used by XarClient when disconnected */
export interface InboundEnvelope {
  agentId: string;
  message: InboundMessage;
  enqueuedAt: number; // Date.now()
}

/**
 * Internal stream state tracked by Dispatcher.
 * Keyed by stream_id.
 */
export interface StreamState {
  channelId: string;       // e.g. "telegram:main", parse prefix for channel type
  peerId: string;
  conversationId: string;
  /** Whether the plugin supports streaming (chunk-by-chunk) delivery */
  streaming: boolean;
  /** Accumulated tokens */
  tokenBuffer: string[];
  /** TUI only: pending flush timer handle */
  flushTimer: ReturnType<typeof setTimeout> | null;
  /** Timeout handle for stream_end watchdog */
  watchdogTimer: ReturnType<typeof setTimeout> | null;
  /** Pending progress sends (tool_result etc.) that must complete before stream_end */
  pendingProgress?: Promise<void>;
}
