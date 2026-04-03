export interface Attachment {
  type: string;
  url: string;
  name?: string;
  size?: number;
}

export type ConversationType = 'dm' | 'group' | 'channel';

export interface Message {
  id: string;
  channel_id: string;
  peer_id: string;
  peer_name: string | null;
  conversation_type: ConversationType;
  conversation_id: string;
  text: string;
  attachments: Attachment[];
  reply_to: string | null;
  /** ISO 8601 timestamp */
  created_at: string;
  raw: object;
  /** Whether the bot was explicitly mentioned (@ or reply-to-bot).
   *  Set by channel plugins for group conversations.
   *  undefined or true → treat as 'message' (triggers LLM).
   *  false → treat as 'record' (context only, no LLM trigger). */
  mentioned?: boolean;
}

export interface SendParams {
  peer_id: string;
  conversation_id: string;
  text: string;
  reply_to?: string;
  /** If set, plugin should send a streaming frame instead of a regular message */
  stream?: 'chunk' | 'end';
  /** Progress event kind — sent as a separate frame to the TUI client */
  progress?: 'thinking' | 'tool_call' | 'tool_result' | 'ctx_usage' | 'compact_start' | 'compact_end';
}

export interface HealthResult {
  ok: boolean;
  detail?: string;
}

export interface PairResult {
  success: boolean;
  pair_mode: 'webhook' | 'polling' | 'ws';
  pair_info: Record<string, string>;
  error?: string;
}

export interface SendResult {
  success: boolean;
  channel_id: string;
  peer_id: string;
  error?: string;
}

export interface GatewayStats {
  uptime: number;
  messagesIn: number;
  messagesOut: number;
  channelStats: Record<string, { status: string; messagesIn: number; messagesOut: number }>;
}
