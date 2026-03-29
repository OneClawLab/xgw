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

export interface ChannelConfig {
  id: string;
  type: string;
  paired?: boolean;
  pair_mode?: 'webhook' | 'polling' | 'ws';
  pair_info?: Record<string, string>;
  paired_at?: string;
  [key: string]: unknown;
}

// ── Noop logger (default — silent) ──

interface TuiLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

const noopLogger: TuiLogger = {
  info() {},
  warn() {},
  error() {},
};

// ── TuiPlugin ──

export class TuiPlugin {
  readonly type = 'tui';

  private wss: WebSocketServer | null = null;
  private channelId = '';
  private onMessage: ((msg: Message) => Promise<void>) | null = null;
  /** Map peer_id → WebSocket connection */
  private peers = new Map<string, WebSocket>();
  private log: TuiLogger = noopLogger;

  setLogger(logger: TuiLogger): void {
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
    const port =
      typeof config['port'] === 'number' ? config['port'] : 18791;

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
          ws.send(
            JSON.stringify({
              type: 'error',
              code: 'bad_json',
              message: 'Invalid JSON',
            }),
          );
          ws.close();
          return;
        }

        const frameType = frame['type'];
        this.log.info(`frame type=${String(frameType)} peer=${peerId ?? 'unknown'} handshake=${handshakeComplete}`);

        // ── Handshake ──
        if (!handshakeComplete) {
          if (frameType !== 'hello') {
            ws.send(
              JSON.stringify({
                type: 'error',
                code: 'bad_hello',
                message: 'Expected hello frame',
              }),
            );
            ws.close();
            return;
          }

          const helloChannelId = frame['channel_id'];
          const helloPeerId = frame['peer_id'];

          if (
            typeof helloChannelId !== 'string' ||
            typeof helloPeerId !== 'string'
          ) {
            ws.send(
              JSON.stringify({
                type: 'error',
                code: 'bad_hello',
                message: 'Missing channel_id or peer_id',
              }),
            );
            ws.close();
            return;
          }

          if (helloChannelId !== this.channelId) {
            this.log.warn(`channel mismatch: got=${helloChannelId} expected=${this.channelId}`);
            ws.send(
              JSON.stringify({
                type: 'error',
                code: 'bad_hello',
                message: `Unknown channel_id: ${helloChannelId}`,
              }),
            );
            ws.close();
            return;
          }

          peerId = helloPeerId;
          handshakeComplete = true;
          this.peers.set(peerId, ws);
          this.log.info(`handshake ok: channel=${this.channelId} peer=${peerId}`);
          ws.send(
            JSON.stringify({
              type: 'hello_ack',
              channel_id: this.channelId,
              peer_id: peerId,
            }),
          );
          return;
        }

        // ── Post-handshake frames ──
        if (frameType === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
          return;
        }

        if (
          frameType === 'message' &&
          typeof frame['text'] === 'string' &&
          peerId
        ) {
          this.log.info(`inbound message: peer=${peerId} text=${String(frame['text']).slice(0, 80)}`);
          const msg: Message = {
            id: randomUUID(),
            channel_id: this.channelId,
            peer_id: peerId,
            peer_name: peerId,
            session_id: peerId,
            text: frame['text'],
            attachments: [],
            reply_to: null,
            created_at: new Date().toISOString(),
            raw: frame as object,
          };
          void this.onMessage?.(msg);
        }
      });

      ws.on('close', () => {
        this.log.info(`peer disconnected: peer=${peerId ?? 'unknown'}`);
        if (peerId) {
          this.peers.delete(peerId);
        }
      });

      ws.on('error', (err) => {
        this.log.error(`ws error: peer=${peerId ?? 'unknown'} err=${err.message}`);
        if (peerId) {
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
      for (const ws of this.peers.values()) {
        ws.close();
      }
      this.peers.clear();
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
    const ws = this.peers.get(params.peer_id);
    if (!ws) {
      throw new Error(`Peer ${params.peer_id} not connected`);
    }
    if (params.progress !== undefined) {
      ws.send(JSON.stringify({ type: 'progress', kind: params.progress, text: params.text }));
    } else if (params.stream === 'chunk') {
      ws.send(JSON.stringify({ type: 'stream_chunk', text: params.text }));
    } else if (params.stream === 'end') {
      ws.send(JSON.stringify({ type: 'stream_end' }));
    } else {
      ws.send(JSON.stringify({ type: 'message', text: params.text }));
    }
  }

  async health(): Promise<HealthResult> {
    return {
      ok: this.wss !== null,
      detail: this.wss
        ? `${this.peers.size} peer(s) connected`
        : 'not started',
    };
  }
}
