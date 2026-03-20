import { Command } from 'commander';
import { WebSocket } from 'ws';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import { formatAgentMessage, computeBackoffMs, formatConnectionStatus, MAX_RECONNECT_ATTEMPTS } from './helpers.js';

// Re-export helpers for backwards compatibility
export { formatAgentMessage, computeBackoffMs, formatConnectionStatus } from './helpers.js';

// ── TUI Frame types ──

type TuiFrame =
  | { type: 'hello'; channel_id: string; peer_id: string }
  | { type: 'hello_ack'; channel_id: string; peer_id: string }
  | { type: 'error'; code: string; message: string }
  | { type: 'message'; text: string }
  | { type: 'ping' }
  | { type: 'pong' };

// ── Core client logic ──
const PING_INTERVAL_MS = 30_000;

interface ClientOptions {
  channel: string;
  peer: string;
  host: string;
  port: number;
}

function buildWsUrl(host: string, port: number): string {
  return `ws://${host}:${port}`;
}

function createClient(opts: ClientOptions): void {
  let reconnectAttempt = 0;
  let rl: ReadlineInterface | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let ws: WebSocket | null = null;
  let intentionalClose = false;

  function cleanup(): void {
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
    if (rl) {
      rl.close();
      rl = null;
    }
  }

  function connect(): void {
    const url = buildWsUrl(opts.host, opts.port);
    ws = new WebSocket(url);

    ws.on('open', () => {
      const hello: TuiFrame = {
        type: 'hello',
        channel_id: opts.channel,
        peer_id: opts.peer,
      };
      ws!.send(JSON.stringify(hello));
    });

    ws.on('message', (data) => {
      let frame: TuiFrame;
      try {
        frame = JSON.parse(String(data)) as TuiFrame;
      } catch {
        return;
      }

      switch (frame.type) {
        case 'hello_ack':
          onConnected();
          break;
        case 'error':
          process.stderr.write(`Error: ${frame.message}\n`);
          intentionalClose = true;
          ws?.close();
          process.exit(1);
          break;
        case 'message':
          process.stdout.write(formatAgentMessage(frame.text) + '\n');
          break;
        case 'pong':
          // keepalive ack, nothing to do
          break;
        default:
          break;
      }
    });

    ws.on('close', () => {
      cleanup();
      if (intentionalClose) return;
      attemptReconnect();
    });

    ws.on('error', () => {
      // 'close' event will fire after this, reconnect handled there
    });
  }

  function onConnected(): void {
    reconnectAttempt = 0;
    process.stdout.write(formatConnectionStatus(opts.channel, opts.peer) + '\n');

    // Start ping keepalive
    pingTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping' } satisfies TuiFrame));
      }
    }, PING_INTERVAL_MS);

    // Start readline loop
    rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '' });

    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (trimmed === '/quit') {
        intentionalClose = true;
        ws?.close();
        cleanup();
        process.exit(0);
      }
      if (ws && ws.readyState === WebSocket.OPEN && trimmed.length > 0) {
        const msg: TuiFrame = { type: 'message', text: trimmed };
        ws.send(JSON.stringify(msg));
      }
    });

    rl.on('close', () => {
      // Ctrl+C or EOF
      intentionalClose = true;
      ws?.close();
      cleanup();
      process.exit(0);
    });
  }

  function attemptReconnect(): void {
    reconnectAttempt++;
    if (reconnectAttempt > MAX_RECONNECT_ATTEMPTS) {
      process.stderr.write('Error: Failed to reconnect after 3 attempts - Check that the xgw daemon is running\n');
      process.exit(1);
    }
    const delayMs = computeBackoffMs(reconnectAttempt);
    process.stderr.write(`Reconnecting (attempt ${reconnectAttempt}/${MAX_RECONNECT_ATTEMPTS}) in ${delayMs / 1000}s...\n`);
    setTimeout(connect, delayMs);
  }

  // Handle Ctrl+C globally
  process.on('SIGINT', () => {
    intentionalClose = true;
    ws?.close();
    cleanup();
    process.exit(0);
  });

  connect();
}

// ── CLI ──

const program = new Command();

program
  .name('xgw-tui')
  .description('Terminal chat client for xgw TUI plugin')
  .requiredOption('--channel <id>', 'Channel ID to connect to')
  .requiredOption('--peer <id>', 'Peer ID to identify as')
  .option('--host <host>', 'TUI plugin host', '127.0.0.1')
  .option('--port <port>', 'TUI plugin port', '18791')
  .action((opts: { channel: string; peer: string; host: string; port: string }) => {
    const port = parseInt(opts.port, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      process.stderr.write('Error: Invalid value for --port - Expected a number between 1 and 65535\n');
      process.exit(2);
    }
    createClient({
      channel: opts.channel,
      peer: opts.peer,
      host: opts.host,
      port,
    });
  });

program.parse();
