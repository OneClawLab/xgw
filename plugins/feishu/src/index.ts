// Local copies of xgw types — keeps this package independent (same pattern as TUI plugin)

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
  created_at: string;
  raw: object;
}

export interface SendParams {
  peer_id: string;
  session_id: string;
  text: string;
  reply_to?: string;
  stream?: 'chunk' | 'end';
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

export interface ChannelConfig {
  id: string;
  type: string;
  paired?: boolean;
  pair_mode?: 'webhook' | 'polling' | 'ws';
  pair_info?: Record<string, string>;
  paired_at?: string;
  [key: string]: unknown;
}

// Feishu-specific config extracted from ChannelConfig
export interface FeishuPluginConfig {
  appId: string;
  appSecret: string;
  domain: 'feishu' | 'lark' | string; // default 'feishu'
  requireMention: boolean;             // default true
  streamingCoalesceMs: number;         // default 500
}

// Local type for Feishu im.message.receive_v1 events
export interface FeishuMessageEvent {
  sender: {
    sender_id: {
      open_id?: string;
      user_id?: string;
      union_id?: string;
    };
    sender_type?: string;
    tenant_key?: string;
  };
  message: {
    message_id: string;
    root_id?: string;
    parent_id?: string;
    chat_id: string;
    chat_type: 'p2p' | 'group';
    message_type: string;
    content: string;
    mentions?: Array<{
      key: string;
      id: { open_id?: string };
      name: string;
    }>;
  };
}

import * as Lark from '@larksuiteoapi/node-sdk';
import {
  createClient,
  createDispatcher,
  createWSClient,
  validateCredentials,
} from './client.js';
import { checkBotMentioned, toMessage } from './event-handler.js';
import { StreamingBuffer } from './streaming.js';

/** Infer receive_id_type from the id prefix: ou_ → open_id, oc_ → chat_id */
function receiveIdType(id: string): 'open_id' | 'chat_id' {
  return id.startsWith('oc_') ? 'chat_id' : 'open_id';
}

function parseConfig(config: ChannelConfig): FeishuPluginConfig {
  return {
    appId: typeof config['appId'] === 'string' ? config['appId'] : '',
    appSecret: typeof config['appSecret'] === 'string' ? config['appSecret'] : '',
    domain: typeof config['domain'] === 'string' ? config['domain'] : 'feishu',
    requireMention:
      typeof config['requireMention'] === 'boolean' ? config['requireMention'] : true,
    streamingCoalesceMs:
      typeof config['streamingCoalesceMs'] === 'number' ? config['streamingCoalesceMs'] : 500,
  };
}

export class FeishuPlugin {
  readonly type = 'feishu';
  readonly streaming = true;

  private client: Lark.Client | null = null;
  private wsClient: Lark.WSClient | null = null;
  private streamingBuffer: StreamingBuffer | null = null;
  private channelId = '';
  private botOpenId: string | undefined = undefined;
  private config: FeishuPluginConfig | null = null;
  private wsConnected = false;

  async pair(config: ChannelConfig): Promise<PairResult> {
    try {
      const pluginConfig = parseConfig(config);
      const client = createClient(pluginConfig);
      const { botOpenId } = await validateCredentials(client);
      return {
        success: true,
        pair_mode: 'ws',
        pair_info: { botOpenId },
      };
    } catch (err) {
      return {
        success: false,
        pair_mode: 'ws',
        pair_info: {},
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async start(
    config: ChannelConfig,
    onMessage: (msg: Message) => Promise<void>,
  ): Promise<void> {
    const pluginConfig = parseConfig(config);
    this.config = pluginConfig;
    this.channelId = config.id;

    const client = createClient(pluginConfig);
    this.client = client;

    // Validate credentials and get botOpenId
    const { botOpenId } = await validateCredentials(client);
    this.botOpenId = botOpenId;

    // Create dispatcher and register event handler
    const dispatcher = createDispatcher();
    dispatcher.register({
      'im.message.receive_v1': async (data) => {
        const event = data as unknown as FeishuMessageEvent;

        // Req 2.3: ignore bot messages
        if (event.sender.sender_type === 'bot') return;

        // Req 4.3: ignore group messages without @bot when requireMention is true
        if (
          pluginConfig.requireMention &&
          event.message.chat_type === 'group' &&
          !checkBotMentioned(event, this.botOpenId)
        ) {
          return;
        }

        const msg = toMessage(this.channelId, event, this.botOpenId);
        await onMessage(msg);
      },
    });

    // Start WSClient
    const wsClient = createWSClient(pluginConfig, dispatcher);
    this.wsClient = wsClient;
    wsClient.start({ eventDispatcher: dispatcher });
    this.wsConnected = true;
  }

  async stop(): Promise<void> {
    if (this.wsClient !== null) {
      try {
        this.wsClient.close();
      } catch {
        // ignore errors during close
      }
      this.wsClient = null;
    }
    this.wsConnected = false;

    if (this.streamingBuffer !== null) {
      this.streamingBuffer.clear();
      this.streamingBuffer = null;
    }

    this.client = null;
    this.config = null;
    this.botOpenId = undefined;
    this.channelId = '';
  }

  async send(params: SendParams): Promise<void> {
    if (this.client === null) {
      throw new Error('FeishuPlugin: not started');
    }

    // session_id from xar is prefixed as "<channel_id>:<peer_id>", extract the peer part
    const receiveId = params.session_id.includes(':')
      ? params.session_id.slice(params.session_id.indexOf(':') + 1)
      : params.session_id;

    // Streaming: feishu does not support message editing for text messages,
    // so we ignore intermediate chunks and send the final text on stream end.
    if (params.stream === 'chunk') {
      return; // discard intermediate chunks
    }

    if (params.stream === 'end') {
      // Send the complete accumulated text as a plain message
      await this.client.im.v1.message.create({
        params: { receive_id_type: receiveIdType(receiveId) },
        data: {
          receive_id: receiveId,
          msg_type: 'text',
          content: JSON.stringify({ text: params.text }),
        },
      });
      return;
    }

    // Progress: send a status message
    if (params.progress !== undefined) {
      const statusText =
        params.progress === 'thinking' ? '🤔 思考中...' : params.text;
      await this.client.im.v1.message.create({
        params: { receive_id_type: receiveIdType(receiveId) },
        data: {
          receive_id: receiveId,
          msg_type: 'text',
          content: JSON.stringify({ text: statusText }),
        },
      });
      return;
    }

    // Plain text message
    await this.client.im.v1.message.create({
      params: { receive_id_type: receiveIdType(receiveId) },
      data: {
        receive_id: receiveId,
        msg_type: 'text',
        content: JSON.stringify({ text: params.text }),
      },
    });
  }

  async health(): Promise<HealthResult> {
    if (this.wsConnected) {
      return { ok: true, detail: 'WSClient connected' };
    }
    return { ok: false, detail: 'WSClient not connected' };
  }
}

export default FeishuPlugin;
