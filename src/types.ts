export interface Attachment {
  type: string;
  url: string;
  name?: string;
  size?: number;
}

export interface Message {
  id: string;
  channel_id: string;
  peer_id: string;
  peer_name: string | null;
  session_id: string;
  text: string;
  attachments: Attachment[];
  reply_to: string | null;
  /** ISO 8601 timestamp */
  created_at: string;
  raw: object;
}

export interface SendParams {
  peer_id: string;
  session_id: string;
  text: string;
  reply_to?: string;
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
