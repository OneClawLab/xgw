import type { Message, SendParams, HealthResult, PairResult } from '../types.js';

export interface ChannelConfig {
  id: string;
  type: string;
  paired?: boolean;
  pair_mode?: 'webhook' | 'polling' | 'ws';
  pair_info?: Record<string, string>;
  paired_at?: string;
  [key: string]: unknown;
}

export interface ChannelPlugin {
  readonly type: string;
  pair(config: ChannelConfig): Promise<PairResult>;
  start(config: ChannelConfig, onMessage: (msg: Message) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
  send(params: SendParams): Promise<void>;
  health(): Promise<HealthResult>;
}
