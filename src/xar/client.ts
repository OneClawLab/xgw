import WebSocket from 'ws';
import type { Logger } from '../repo-utils/logger.js';
import type { XarConfig, InboundMessage, XarOutboundEvent, InboundEnvelope } from './types.js';

const BUFFER_CAPACITY = 100;
const MAX_RECONNECT_INTERVAL_MS = 60_000;

type ConnectionState = 'disconnected' | 'connecting' | 'connected';

export class XarClient {
  private readonly config: XarConfig;
  private readonly logger: Logger;

  private state: ConnectionState = 'disconnected';
  private ws: WebSocket | null = null;
  private buffer: InboundEnvelope[] = [];
  private outboundHandler: ((event: XarOutboundEvent) => void) | null = null;

  /** Whether close() has been called — stops reconnect loop */
  private closed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private currentReconnectInterval: number;

  constructor(config: XarConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
    this.currentReconnectInterval = config.reconnect_interval_ms;
  }

  /** Establish connection, starting the auto-reconnect loop. */
  async connect(): Promise<void> {
    if (this.closed) return;
    this.closed = false;
    await this._attemptConnect();
  }

  /** Send an inbound message to xar. Buffers when disconnected. */
  async sendInbound(agentId: string, message: InboundMessage): Promise<void> {
    const envelope: InboundEnvelope = { agentId, message, enqueuedAt: Date.now() };

    if (this.state === 'connected' && this.ws) {
      this._sendEnvelope(envelope);
    } else {
      this._enqueue(envelope);
    }
  }

  /** Register a handler for outbound events from xar. */
  onOutbound(handler: (event: XarOutboundEvent) => void): void {
    this.outboundHandler = handler;
  }

  /** Close the connection and stop reconnecting. */
  close(): void {
    this.closed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      // Remove listeners before closing to avoid triggering reconnect
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
    this.state = 'disconnected';
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private async _attemptConnect(): Promise<void> {
    if (this.closed) return;
    this.state = 'connecting';

    // On Windows, Unix domain sockets are unreliable — go straight to TCP
    if (process.platform === 'win32') {
      const tcpUrl = `ws://127.0.0.1:${this.config.port}`;
      const connected = await this._tryConnect(tcpUrl);
      if (!connected) this._scheduleReconnect();
      return;
    }

    // Try Unix socket first, then TCP fallback
    const connected = await this._tryConnect(`ws+unix://${this.config.socket}`);
    if (!connected) {
      const tcpUrl = `ws://127.0.0.1:${this.config.port}`;
      this.logger.warn(`XarClient: Unix socket failed, falling back to TCP ${tcpUrl}`);
      const tcpConnected = await this._tryConnect(tcpUrl);
      if (!tcpConnected) {
        this._scheduleReconnect();
      }
    }
  }

  private _tryConnect(url: string): Promise<boolean> {
    return new Promise((resolve) => {
      if (this.closed) {
        resolve(false);
        return;
      }

      let settled = false;
      const ws = new WebSocket(url);

      const onOpen = () => {
        if (settled) return;
        settled = true;
        this.ws = ws;
        this.state = 'connected';
        this.currentReconnectInterval = this.config.reconnect_interval_ms; // reset backoff
        this.logger.info(`XarClient: connected to ${url}`);
        this._flushBuffer();
        resolve(true);
      };

      const onError = (err: Error) => {
        if (settled) return;
        settled = true;
        ws.removeAllListeners();
        ws.terminate();
        this.logger.debug(`XarClient: connection error for ${url}: ${err.message}`);
        resolve(false);
      };

      ws.once('open', onOpen);
      ws.once('error', onError);

      ws.on('message', (data) => {
        this._handleMessage(data);
      });

      ws.on('close', () => {
        if (this.ws === ws) {
          this.ws = null;
          this.state = 'disconnected';
          this.logger.warn('XarClient: connection closed, scheduling reconnect');
          this._scheduleReconnect();
        }
      });

      ws.on('error', (err) => {
        // Post-connection errors (after open)
        if (this.ws === ws) {
          this.logger.error(`XarClient: WebSocket error: ${err.message}`);
        }
      });
    });
  }

  private _handleMessage(data: WebSocket.RawData): void {
    let raw: string;
    if (typeof data === 'string') {
      raw = data;
    } else if (Buffer.isBuffer(data)) {
      raw = data.toString('utf8');
    } else {
      raw = Buffer.concat(data as Buffer[]).toString('utf8');
    }

    let event: XarOutboundEvent;
    try {
      event = JSON.parse(raw) as XarOutboundEvent;
    } catch {
      this.logger.error(`XarClient: received invalid JSON: ${raw.slice(0, 200)}`);
      return;
    }

    if (this.outboundHandler) {
      this.outboundHandler(event);
    }
  }

  private _enqueue(envelope: InboundEnvelope): void {
    if (this.buffer.length >= BUFFER_CAPACITY) {
      this.buffer.shift(); // drop oldest
      this.logger.warn('XarClient: buffer full, dropped oldest message (1 discarded)');
    }
    this.buffer.push(envelope);
  }

  private _sendEnvelope(envelope: InboundEnvelope): void {
    if (!this.ws || this.state !== 'connected') {
      this._enqueue(envelope);
      return;
    }
    const payload = JSON.stringify({
      type: 'inbound_message',
      agent_id: envelope.agentId,
      ...envelope.message,
    });
    this.ws.send(payload);
  }

  private _flushBuffer(): void {
    const toSend = this.buffer.splice(0); // take all, FIFO
    for (const envelope of toSend) {
      this._sendEnvelope(envelope);
    }
  }

  private _scheduleReconnect(): void {
    if (this.closed) return;
    this.state = 'disconnected';

    const delay = this.currentReconnectInterval;
    // Exponential backoff, capped at MAX_RECONNECT_INTERVAL_MS
    this.currentReconnectInterval = Math.min(
      this.currentReconnectInterval * 2,
      MAX_RECONNECT_INTERVAL_MS,
    );

    this.logger.debug(`XarClient: reconnecting in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this._attemptConnect();
    }, delay);
  }
}
