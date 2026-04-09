import { WebSocketServer, type WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';

// ── Types (local copies for plugin independence) ──

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
  conversation_type: 'dm' | 'group' | 'channel';
  conversation_id: string;
  text: string;
  attachments: Attachment[];
  reply_to: string | null;
  created_at: string;
  raw: object;
  mentioned?: boolean;
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

// ── Logger ──

interface WebuiLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

const noopLogger: WebuiLogger = {
  info() {},
  warn() {},
  error() {},
};

// ── Peer state ──

interface PeerState {
  ws: WebSocket;
  /** Set of conversation_ids this peer has opened */
  conversations: Set<string>;
}

// ── WebuiPlugin ──

/**
 * WebUI channel plugin — multi-session WebSocket protocol for WebClaw desktop client.
 *
 * Key differences from TUI plugin:
 * - Supports multiple concurrent conversations per peer (explicit conversation_id)
 * - open_conversation / close_conversation lifecycle frames
 * - All outbound frames carry conversation_id for client-side routing
 * - hello_ack includes available agents list
 */
export class WebuiPlugin {
  readonly type = 'webui';
  readonly streaming = true;

  private wss: WebSocketServer | null = null;
  private channelId = '';
  private onMessage: ((msg: Message) => Promise<void>) | null = null;
  /** peer_id → PeerState */
  private peers = new Map<string, PeerState>();
  /** conversation_id → peer_id (for routing inbound send() calls) */
  private convToPeer = new Map<string, string>();
  private log: WebuiLogger = noopLogger;

  setLogger(logger: WebuiLogger): void {
    this.log = logger;
  }

  async pair(_config: ChannelConfig): Promise<PairResult> {
    return {
      success: true,
      pair_mode: 'ws',
      pair_info: {},
    };
  }

  async start(
    config: ChannelConfig,
    onMessage: (msg: Message) => Promise<void>,
  ): Promise<void> {
    this.channelId = config.id;
    this.onMessage = onMessage;
    const port = typeof config['port'] === 'number' ? config['port'] : 28211;

    this.wss = new WebSocketServer({ port, host: '127.0.0.1' });

    this.wss.on('connection', (ws) => {
      let peerId: string | null = null;
      let handshakeComplete = false;

      this.log.info(`new ws connection on channel=${this.channelId}`);

      ws.on('message', (data) => {
        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(String(data)) as Record<string, unknown>;
        } catch {
          this.log.warn(`bad JSON from peer=${peerId ?? 'unknown'}`);
          ws.send(JSON.stringify({ type: 'error', code: 'bad_json', message: 'Invalid JSON' }));
          ws.close();
          return;
        }

        const frameType = frame['type'];
        this.log.info(`frame type=${String(frameType)} peer=${peerId ?? 'unknown'}`);

        // ── Handshake ──
        if (!handshakeComplete) {
          if (frameType !== 'hello') {
            ws.send(JSON.stringify({ type: 'error', code: 'bad_hello', message: 'Expected hello frame' }));
            ws.close();
            return;
          }

          const helloChannelId = frame['channel_id'];
          const helloPeerId = frame['peer_id'];

          if (typeof helloChannelId !== 'string' || typeof helloPeerId !== 'string') {
            ws.send(JSON.stringify({ type: 'error', code: 'bad_hello', message: 'Missing channel_id or peer_id' }));
            ws.close();
            return;
          }

          if (helloChannelId !== this.channelId) {
            ws.send(JSON.stringify({ type: 'error', code: 'bad_hello', message: `Unknown channel_id: ${helloChannelId}` }));
            ws.close();
            return;
          }

          peerId = helloPeerId;
          handshakeComplete = true;
          this.peers.set(peerId, { ws, conversations: new Set() });
          this.log.info(`handshake ok: channel=${this.channelId} peer=${peerId}`);

          // hello_ack — agents list can be extended later via config
          const agents: string[] = (config['agents'] as string[] | undefined) ?? [];
          ws.send(JSON.stringify({ type: 'hello_ack', channel_id: this.channelId, peer_id: peerId, agents }));
          return;
        }

        // ── Post-handshake frames ──
        if (!peerId) return;

        if (frameType === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
          return;
        }

        if (frameType === 'open_conversation') {
          const convId = frame['conversation_id'];
          const agentId = frame['agent_id'];
          if (typeof convId !== 'string') {
            ws.send(JSON.stringify({ type: 'error', code: 'bad_frame', message: 'Missing conversation_id', conversation_id: convId }));
            return;
          }
          const peer = this.peers.get(peerId)!;
          peer.conversations.add(convId);
          this.convToPeer.set(convId, peerId);
          this.log.info(`open_conversation: peer=${peerId} conv=${convId} agent=${String(agentId ?? '')}`);
          return;
        }

        if (frameType === 'close_conversation') {
          const convId = frame['conversation_id'];
          if (typeof convId === 'string') {
            const peer = this.peers.get(peerId);
            peer?.conversations.delete(convId);
            this.convToPeer.delete(convId);
            this.log.info(`close_conversation: peer=${peerId} conv=${convId}`);
          }
          return;
        }

        if (frameType === 'message') {
          const convId = frame['conversation_id'];
          const text = frame['text'];
          if (typeof convId !== 'string' || typeof text !== 'string') {
            ws.send(JSON.stringify({ type: 'error', code: 'bad_frame', message: 'Missing conversation_id or text' }));
            return;
          }
          this.log.info(`inbound message: peer=${peerId} conv=${convId} text=${text.slice(0, 80)}`);
          const msg: Message = {
            id: randomUUID(),
            channel_id: this.channelId,
            peer_id: peerId,
            peer_name: peerId,
            conversation_type: 'dm',
            conversation_id: convId,
            text,
            attachments: [],
            reply_to: null,
            created_at: new Date().toISOString(),
            raw: frame as object,
          };
          void this.onMessage?.(msg);
          return;
        }

        this.log.warn(`unknown frame type=${String(frameType)} peer=${peerId}`);
      });

      ws.on('close', () => {
        this.log.info(`peer disconnected: peer=${peerId ?? 'unknown'}`);
        if (peerId) {
          const peer = this.peers.get(peerId);
          if (peer) {
            for (const convId of peer.conversations) {
              this.convToPeer.delete(convId);
            }
          }
          this.peers.delete(peerId);
        }
      });

      ws.on('error', (err) => {
        this.log.error(`ws error: peer=${peerId ?? 'unknown'} err=${err.message}`);
        if (peerId) {
          const peer = this.peers.get(peerId);
          if (peer) {
            for (const convId of peer.conversations) {
              this.convToPeer.delete(convId);
            }
          }
          this.peers.delete(peerId);
        }
      });
    });

    await new Promise<void>((resolve) => {
      this.wss!.on('listening', resolve);
    });
  }

  async stop(): Promise<void> {
    if (this.wss) {
      for (const { ws } of this.peers.values()) {
        ws.close();
      }
      this.peers.clear();
      this.convToPeer.clear();
      await new Promise<void>((resolve, reject) => {
        this.wss!.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      this.wss = null;
    }
  }

  async send(params: SendParams): Promise<void> {
    // Route by conversation_id → peer_id
    const peerId = this.convToPeer.get(params.conversation_id) ?? params.peer_id;
    const peer = this.peers.get(peerId);
    if (!peer) {
      throw new Error(`Peer ${peerId} not connected (conversation: ${params.conversation_id})`);
    }
    const { ws } = peer;
    const convId = params.conversation_id;

    if (params.progress !== undefined) {
      ws.send(JSON.stringify({ type: 'progress', conversation_id: convId, kind: params.progress, text: params.text }));
    } else if (params.stream === 'chunk') {
      ws.send(JSON.stringify({ type: 'stream_chunk', conversation_id: convId, text: params.text }));
    } else if (params.stream === 'end') {
      ws.send(JSON.stringify({ type: 'stream_end', conversation_id: convId }));
    } else {
      ws.send(JSON.stringify({ type: 'message', conversation_id: convId, text: params.text }));
    }
  }

  async health(): Promise<HealthResult> {
    return {
      ok: this.wss !== null,
      detail: this.wss
        ? `${this.peers.size} peer(s), ${this.convToPeer.size} conversation(s)`
        : 'not started',
    };
  }
}
