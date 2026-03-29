import { Command } from 'commander';
import { WebSocket } from 'ws';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import { computeBackoffMs, MAX_RECONNECT_ATTEMPTS } from './helpers.js';

// Re-export helpers for backwards compatibility
export { formatAgentMessage, computeBackoffMs, formatConnectionStatus } from './helpers.js';

// ── TUI Frame types ──

type TuiFrame =
  | { type: 'hello'; channel_id: string; peer_id: string }
  | { type: 'hello_ack'; channel_id: string; peer_id: string }
  | { type: 'error'; code: string; message: string }
  | { type: 'message'; text: string }
  | { type: 'stream_chunk'; text: string }
  | { type: 'stream_end' }
  | { type: 'progress'; kind: 'thinking' | 'tool_call' | 'tool_result' | 'ctx_usage' | 'compact_start' | 'compact_end'; text: string }
  | { type: 'ping' }
  | { type: 'pong' };

// ── Progress rendering (mirrors xar chat) ────────────────────────────────────

const INDENT = '    ';
const LINE_MAX = 120;
const MULTILINE_MAX_LINES = 5;

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + `…(${s.length - maxLen} chars)`;
}

function renderInlineOrBlock(prefix: string, text: string, indent: string): string {
  const lines = text.split('\n').map(l => l.trimEnd()).filter(l => l.length > 0);
  if (lines.length <= 1) {
    const line = lines[0] ?? '';
    const display = line.length > LINE_MAX ? line.slice(0, LINE_MAX) + `…(${line.length - LINE_MAX} chars)` : line;
    return `${prefix} ${display}\n`;
  }
  const shown = lines.slice(0, MULTILINE_MAX_LINES);
  const omitted = lines.length - MULTILINE_MAX_LINES;
  const body = shown.map(l => `${indent}${l.length > LINE_MAX ? l.slice(0, LINE_MAX) + `…(${l.length - LINE_MAX} chars)` : l}`);
  return `${prefix}\n${body.join('\n')}${omitted > 0 ? `\n${indent}…(${omitted} lines)` : ''}\n`;
}

function renderToolCall(data: unknown): void {
  if (typeof data !== 'object' || data === null) {
    process.stderr.write(`  tool_call: ${JSON.stringify(data)}\n`);
    return;
  }
  const d = data as Record<string, unknown>;
  const name = typeof d['name'] === 'string' ? d['name'] : 'unknown';
  if (name !== 'bash_exec') {
    process.stderr.write(`  tool_call: ${name}(${JSON.stringify(d['arguments'] ?? {})})\n`);
    return;
  }
  const args = (typeof d['arguments'] === 'object' && d['arguments'] !== null)
    ? d['arguments'] as Record<string, unknown>
    : {};
  const comment = typeof args['comment'] === 'string' ? args['comment'].trim() : '';
  const command = typeof args['command'] === 'string' ? args['command'].trim() : '';
  const cwd = typeof args['cwd'] === 'string' ? args['cwd'] : '';
  const timeout = args['timeout_seconds'] !== undefined ? String(args['timeout_seconds']) : '';

  process.stderr.write(`  ▶ ${comment || 'bash_exec'}\n`);
  if (command) process.stderr.write(renderInlineOrBlock(`${INDENT}command:`, command, `${INDENT}  `));
  const meta: string[] = [];
  if (cwd) meta.push(`cwd: ${cwd}`);
  if (timeout) meta.push(`timeout: ${timeout}s`);
  if (meta.length > 0) process.stderr.write(`${INDENT}${meta.join('  ')}\n`);
}

function renderToolResult(data: unknown): void {
  if (typeof data !== 'object' || data === null) {
    process.stderr.write(`  ✓ ${truncate(JSON.stringify(data), LINE_MAX)}\n`);
    return;
  }
  const d = data as Record<string, unknown>;
  const exitCode = d['exitCode'] !== undefined ? d['exitCode'] : d['exit_code'];
  const stdout = typeof d['stdout'] === 'string' ? d['stdout'] : '';
  const stderr = typeof d['stderr'] === 'string' ? d['stderr'] : '';
  const errMsg = typeof d['error'] === 'string' ? d['error'] : '';
  const isSuccess = exitCode === 0 || exitCode === undefined;
  const content = errMsg || [stdout, stderr].filter(s => s.trim()).join('\n').trim();
  const prefix = `  ${isSuccess ? '✓' : '✗'}`;
  if (!content) { process.stderr.write(`${prefix} (no output)\n`); return; }
  process.stderr.write(renderInlineOrBlock(prefix, content, INDENT));
}

// ── Core client logic ─────────────────────────────────────────────────────────

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
  let inStream = false;
  let streamHeaderPrinted = false;
  let processing = false;

  function cleanup(): void {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    if (rl) { rl.close(); rl = null; }
  }

  function showPrompt(): void {
    if (rl) { rl.setPrompt('Q: '); rl.prompt(); }
  }

  function connect(): void {
    const url = buildWsUrl(opts.host, opts.port);
    ws = new WebSocket(url);

    ws.on('open', () => {
      ws!.send(JSON.stringify({ type: 'hello', channel_id: opts.channel, peer_id: opts.peer } satisfies TuiFrame));
    });

    ws.on('message', (data) => {
      let frame: TuiFrame;
      try { frame = JSON.parse(String(data)) as TuiFrame; } catch { return; }

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

        case 'progress':
          if (frame.kind === 'thinking') {
            // thinking delta — ignore (same as xar chat)
          } else if (frame.kind === 'tool_call') {
            try { renderToolCall(JSON.parse(frame.text)); } catch { process.stderr.write(`  tool_call: ${frame.text}\n`); }
          } else if (frame.kind === 'tool_result') {
            try { renderToolResult(JSON.parse(frame.text)); } catch { process.stderr.write(`  tool_result: ${frame.text}\n`); }
          } else if (frame.kind === 'ctx_usage') {
            try {
              const u = JSON.parse(frame.text) as { total_tokens: number; budget_tokens: number; pct: number };
              const toK = (n: number): string => `${Math.round(n / 1000)}K`;
              process.stderr.write(`\nctx: ${u.pct}% (${toK(u.total_tokens)}/${toK(u.budget_tokens)})\n`);
            } catch { /* ignore malformed */ }
          } else if (frame.kind === 'compact_start') {
            try {
              const info = JSON.parse(frame.text) as { reason: string };
              process.stderr.write(`compacting session (${info.reason})...\n`);
            } catch { process.stderr.write('compacting session...\n'); }
          } else if (frame.kind === 'compact_end') {
            try {
              const info = JSON.parse(frame.text) as { before_tokens: number; after_tokens: number };
              const toK = (n: number): string => `${Math.round(n / 1000)}K`;
              process.stderr.write(`compact done (${toK(info.before_tokens)} → ${toK(info.after_tokens)})\n`);
            } catch { /* ignore malformed */ }
          }
          break;

        case 'message':
          process.stderr.write('\n');
          process.stdout.write(`\nA:\n${frame.text}\n\n`);
          processing = false;
          showPrompt();
          break;

        case 'stream_chunk':
          if (!streamHeaderPrinted) {
            process.stderr.write('\n');
            process.stdout.write('\nA:\n');
            streamHeaderPrinted = true;
            inStream = true;
          }
          process.stdout.write(frame.text);
          break;

        case 'stream_end':
          if (inStream) { process.stdout.write('\n\n'); inStream = false; }
          streamHeaderPrinted = false;
          processing = false;
          showPrompt();
          break;

        case 'pong':
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

    ws.on('error', () => { /* close fires after */ });
  }

  function onConnected(): void {
    reconnectAttempt = 0;
    process.stdout.write(`Chatting with channel '${opts.channel}' as '${opts.peer}' (Ctrl+C or Ctrl+D to exit)\n\n`);

    pingTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping' } satisfies TuiFrame));
      }
    }, PING_INTERVAL_MS);

    rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: process.stdin.isTTY,
      prompt: 'Q: ',
    });

    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (trimmed === '/quit') {
        intentionalClose = true; ws?.close(); cleanup();
        process.stdout.write('\n'); process.exit(0);
      }
      if (!trimmed || processing) return;
      if (ws && ws.readyState === WebSocket.OPEN) {
        processing = true;
        streamHeaderPrinted = false;
        inStream = false;
        process.stderr.write('\n--- working...\n');
        ws.send(JSON.stringify({ type: 'message', text: trimmed } satisfies TuiFrame));
      }
    });

    rl.on('close', () => {
      intentionalClose = true; ws?.close(); cleanup();
      process.stdout.write('\n'); process.exit(0);
    });

    showPrompt();
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

  process.on('SIGINT', () => {
    intentionalClose = true; ws?.close(); cleanup();
    process.stdout.write('\n'); process.exit(0);
  });

  connect();
}

// ── CLI ───────────────────────────────────────────────────────────────────────

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
    createClient({ channel: opts.channel, peer: opts.peer, host: opts.host, port });
  });

program.parse();
