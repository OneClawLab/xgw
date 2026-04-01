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
  conversation_id: string;
  text: string;
  attachments: Attachment[];
  reply_to: string | null;
  created_at: string;
  raw: object;
}

export interface SendParams {
  peer_id: string;
  conversation_id: string;
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
  domain: 'feishu' | 'lark' | string;
  requireMention: boolean;
  streamingThrottleMs: number;
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
import { FeishuStreamingCard } from './streaming.js';

/** Infer receive_id_type from the id prefix: oc_ → chat_id, otherwise open_id */
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
    streamingThrottleMs:
      typeof config['streamingThrottleMs'] === 'number' ? config['streamingThrottleMs'] : 100,
  };
}

/**
 * Add a reaction emoji to a message. Errors are swallowed — reactions are
 * best-effort and should never block message processing.
 */
async function addReaction(
  client: Lark.Client,
  messageId: string,
  emojiType: string,
): Promise<void> {
  try {
    await client.im.messageReaction.create({
      path: { message_id: messageId },
      data: { reaction_type: { emoji_type: emojiType } },
    });
  } catch (err) {
    console.error('[FeishuPlugin] addReaction failed:', err);
  }
}

export class FeishuPlugin {
  readonly type = 'feishu';
  readonly streaming = true;

  private client: Lark.Client | null = null;
  private wsClient: Lark.WSClient | null = null;
  private channelId = '';
  private botOpenId: string | undefined = undefined;
  private pluginConfig: FeishuPluginConfig | null = null;
  private wsConnected = false;

  // One streaming card session per conversation_id
  private streamingSessions = new Map<string, FeishuStreamingCard>();

  async pair(config: ChannelConfig): Promise<PairResult> {
    try {
      const pluginConfig = parseConfig(config);
      const client = createClient(pluginConfig);
      const { botOpenId } = await validateCredentials(client);
      return { success: true, pair_mode: 'ws', pair_info: { botOpenId } };
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
    this.pluginConfig = pluginConfig;
    this.channelId = config.id;

    const client = createClient(pluginConfig);
    this.client = client;

    const { botOpenId } = await validateCredentials(client);
    this.botOpenId = botOpenId;

    const dispatcher = createDispatcher();
    dispatcher.register({
      'im.message.receive_v1': async (data) => {
        const event = data as unknown as FeishuMessageEvent;

        // Ignore bot's own messages
        if (event.sender.sender_type === 'bot') return;

        // Group: ignore if @bot not present when requireMention is true
        if (
          pluginConfig.requireMention &&
          event.message.chat_type === 'group' &&
          !checkBotMentioned(event, this.botOpenId)
        ) {
          return;
        }

        // Acknowledge receipt with a reaction immediately (best-effort)
        // "THUMBSUP" is a verified valid Feishu emoji type
        void addReaction(client, event.message.message_id, 'THUMBSUP');

        const msg = toMessage(this.channelId, event, this.botOpenId);
        await onMessage(msg);
      },
      // Register no-op handlers to suppress SDK warnings for unhandled event types
      'im.message.reaction.created_v1': async () => {},
      'im.message.message_read_v1': async () => {},
    });

    const wsClient = createWSClient(pluginConfig, dispatcher);
    this.wsClient = wsClient;
    wsClient.start({ eventDispatcher: dispatcher });
    this.wsConnected = true;
  }

  async stop(): Promise<void> {
    if (this.wsClient !== null) {
      try { this.wsClient.close(); } catch { /* ignore */ }
      this.wsClient = null;
    }
    this.wsConnected = false;

    // Close any open streaming sessions
    for (const session of this.streamingSessions.values()) {
      try { await session.close(); } catch { /* ignore */ }
    }
    this.streamingSessions.clear();

    this.client = null;
    this.pluginConfig = null;
    this.botOpenId = undefined;
    this.channelId = '';
  }

  async send(params: SendParams): Promise<void> {
    if (this.client === null || this.pluginConfig === null) {
      throw new Error('FeishuPlugin: not started');
    }

    // conversation_id from xar may be prefixed as "<channel_id>:<peer_id>"
    const receiveId = params.conversation_id.includes(':')
      ? params.conversation_id.slice(params.conversation_id.indexOf(':') + 1)
      : params.conversation_id;

    const sessionKey = params.conversation_id;

    // ── Progress event ──────────────────────────────────────────────────────
    if (params.progress !== undefined) {
      const progressText = this._progressText(params.progress, params.text);
      let card = this.streamingSessions.get(sessionKey);
      if (!card || !card.isActive()) {
        card = this._createCard();
        this.streamingSessions.set(sessionKey, card);
        // Don't await start — it's queued, and appendProgress queues after it
        void card.start(receiveId, receiveIdType(receiveId), params.reply_to);
      }
      await card.appendProgress(progressText);
      return;
    }

    // ── Streaming chunk ─────────────────────────────────────────────────────
    if (params.stream === 'chunk') {
      let card = this.streamingSessions.get(sessionKey);
      if (!card || !card.isActive()) {
        card = this._createCard();
        this.streamingSessions.set(sessionKey, card);
        void card.start(receiveId, receiveIdType(receiveId), params.reply_to);
      }
      await card.update(params.text);
      return;
    }

    // ── Streaming end ───────────────────────────────────────────────────────
    if (params.stream === 'end') {
      let card = this.streamingSessions.get(sessionKey);
      if (!card || !card.isActive()) {
        card = this._createCard();
        this.streamingSessions.set(sessionKey, card);
        void card.start(receiveId, receiveIdType(receiveId), params.reply_to);
      }
      await card.close(params.text);
      this.streamingSessions.delete(sessionKey);
      return;
    }

    // ── Plain message ───────────────────────────────────────────────────────
    // Close any stale streaming session first
    const stale = this.streamingSessions.get(sessionKey);
    if (stale?.isActive()) {
      await stale.close();
      this.streamingSessions.delete(sessionKey);
    }
    await this._sendText(receiveId, params.text, params.reply_to);
  }

  async health(): Promise<HealthResult> {
    if (this.wsConnected) return { ok: true, detail: 'WSClient connected' };
    return { ok: false, detail: 'WSClient not connected' };
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private _createCard(): FeishuStreamingCard {
    const cfg = this.pluginConfig!;
    return new FeishuStreamingCard(
      this.client!,
      cfg.appId,
      cfg.appSecret,
      cfg.domain,
      { throttleMs: cfg.streamingThrottleMs },
    );
  }

  private async _sendText(
    receiveId: string,
    text: string,
    replyToMessageId?: string,
  ): Promise<void> {
    if (replyToMessageId) {
      await this.client!.im.message.reply({
        path: { message_id: replyToMessageId },
        data: { msg_type: 'text', content: JSON.stringify({ text }) },
      });
    } else {
      await this.client!.im.message.create({
        params: { receive_id_type: receiveIdType(receiveId) },
        data: { receive_id: receiveId, msg_type: 'text', content: JSON.stringify({ text }) },
      });
    }
  }

  private _progressText(progress: SendParams['progress'], rawText: string): string {
    switch (progress) {
      case 'thinking':      return `🤔 ${rawText || '思考中...'}`;
      case 'tool_call':     return this._formatToolCall(rawText);
      case 'tool_result':   return this._formatToolResult(rawText);
      case 'ctx_usage':     return this._formatCtxUsage(rawText);
      case 'compact_start': return '🗜️ 压缩上下文...';
      case 'compact_end':   return this._formatCompactEnd(rawText);
      default:              return `⏳ ${rawText || '处理中...'}`;
    }
  }

  private _formatToolCall(rawText: string): string {
    try {
      const obj = JSON.parse(rawText) as Record<string, unknown>;
      const args = (typeof obj['arguments'] === 'object' && obj['arguments'] !== null)
        ? obj['arguments'] as Record<string, unknown>
        : obj; // fallback: treat obj itself as args
      const comment = typeof args['comment'] === 'string' ? args['comment'].trim() : '';
      const command = typeof args['command'] === 'string' ? args['command'].trim() : '';
      const cwd = typeof args['cwd'] === 'string' ? args['cwd'].trim() : '';
      const timeout = args['timeout_seconds'] !== undefined ? String(args['timeout_seconds']) : '';

      const lines: string[] = [];
      lines.push(`🔧 ${comment || '执行命令'}`);
      if (command) {
        const cmdTruncated = command.length > 120 ? `${command.slice(0, 120)}…` : command;
        lines.push(`cmd: ${cmdTruncated}`);
      }
      const meta: string[] = [];
      if (cwd) meta.push(`cwd: ${cwd}`);
      if (timeout) meta.push(`timeout: ${timeout}s`);
      if (meta.length > 0) lines.push(meta.join('  '));
      return lines.join('\n');
    } catch {
      return `🔧 ${rawText.slice(0, 100)}`;
    }
  }

  private _formatToolResult(rawText: string): string {
    try {
      const obj = JSON.parse(rawText) as Record<string, unknown>;
      const exitCode = obj['exitCode'] ?? obj['exit_code'];
      const stdout = typeof obj['stdout'] === 'string' ? obj['stdout'].trim() : '';
      const stderr = typeof obj['stderr'] === 'string' ? obj['stderr'].trim() : '';
      const isSuccess = exitCode === 0 || exitCode === undefined;
      const icon = isSuccess ? '✅' : '❌';
      const content = [stdout, stderr].filter(s => s).join(' | ');
      if (!content) return `${icon} (无输出)`;
      const truncated = content.length > 200 ? `${content.slice(0, 200)}…` : content;
      return `${icon} ${truncated.replace(/\n+/g, ' ↵ ')}`;
    } catch {
      const truncated = rawText.length > 100 ? `${rawText.slice(0, 100)}…` : rawText;
      return `📋 ${truncated}`;
    }
  }

  private _formatCtxUsage(rawText: string): string {
    try {
      const obj = JSON.parse(rawText) as Record<string, unknown>;
      const pct = typeof obj['pct'] === 'number' ? obj['pct'] : 0;
      const total = typeof obj['total_tokens'] === 'number' ? obj['total_tokens'] : 0;
      const budget = typeof obj['budget_tokens'] === 'number' ? obj['budget_tokens'] : 0;
      return `📊 上下文: ${pct}% (${total}/${budget} tokens)`;
    } catch {
      return `📊 上下文使用情况`;
    }
  }

  private _formatCompactEnd(rawText: string): string {
    try {
      const obj = JSON.parse(rawText) as Record<string, unknown>;
      const before = typeof obj['before_tokens'] === 'number' ? obj['before_tokens'] : 0;
      const after = typeof obj['after_tokens'] === 'number' ? obj['after_tokens'] : 0;
      return `✅ 上下文已压缩 (${before} → ${after} tokens)`;
    } catch {
      return '✅ 上下文已压缩';
    }
  }
}

export default FeishuPlugin;
