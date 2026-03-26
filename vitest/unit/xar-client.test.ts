import { describe, it, expect, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import type { WebSocket as WsSocket } from 'ws';
import { XarClient } from '../../src/xar/client.js';
import type { XarConfig, InboundMessage } from '../../src/xar/types.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function makeMessage(content: string): InboundMessage {
  return {
    source: 'external:tui:ch1:direct:sess1:peer1',
    content,
    reply_context: {
      channel_type: 'tui',
      channel_id: 'ch1',
      session_type: 'direct',
      session_id: 'sess1',
      peer_id: 'peer1',
    },
  };
}

/** Start a WS server on a random OS-assigned port, return { server, port }. */
async function startWsServer(): Promise<{ server: WebSocketServer; port: number }> {
  return new Promise((resolve, reject) => {
    const server = new WebSocketServer({ port: 0 });
    server.on('listening', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        resolve({ server, port: addr.port });
      } else {
        reject(new Error('unexpected address type'));
      }
    });
    server.on('error', reject);
  });
}

/** Close a WS server and wait for it to finish. */
function closeWsServer(server: WebSocketServer): Promise<void> {
  return new Promise((resolve, reject) => {
    // Close all connected clients first
    for (const client of server.clients) {
      client.terminate();
    }
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

/** Collect all messages received by the server. */
function collectServerMessages(server: WebSocketServer): string[] {
  const msgs: string[] = [];
  server.on('connection', (ws: WsSocket) => {
    ws.on('message', (data) => msgs.push(data.toString()));
  });
  return msgs;
}

/** Wait for the next connection on a server, returning the server-side socket. */
function waitForConnection(server: WebSocketServer): Promise<WsSocket> {
  return new Promise((resolve) => {
    server.once('connection', resolve);
  });
}

/** Config that points Unix socket to a path that will never exist. */
function makeConfig(port: number): XarConfig {
  return {
    socket: '/tmp/__xar_nonexistent_test_socket_xgw__.sock',
    port,
    reconnect_interval_ms: 50, // fast for tests
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('XarClient — Unix socket priority / TCP fallback', () => {
  it('falls back to TCP when Unix socket is unavailable (req 1.1, 1.2)', async () => {
    const { server, port } = await startWsServer();
    const logger = makeLogger();
    const client = new XarClient(makeConfig(port), logger);

    await client.connect();

    // Should have warned about Unix socket failure and fallen back
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Unix socket failed'),
    );
    // Should have logged successful connection to TCP URL
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining(`ws://127.0.0.1:${port}`),
    );

    client.close();
    await closeWsServer(server);
  });

  it('sends a message over TCP after fallback connection (req 1.2)', async () => {
    const { server, port } = await startWsServer();
    const received = collectServerMessages(server);
    const logger = makeLogger();
    const client = new XarClient(makeConfig(port), logger);

    await client.connect();
    await client.sendInbound('agent1', makeMessage('hello'));

    // Give the WS frame time to arrive
    await new Promise((r) => setTimeout(r, 50));

    expect(received).toHaveLength(1);
    const parsed = JSON.parse(received[0]!);
    expect(parsed.type).toBe('inbound_message');
    expect(parsed.content).toBe('hello');

    client.close();
    await closeWsServer(server);
  });
});

describe('XarClient — buffer overflow: drop oldest (req 1.5)', () => {
  it('keeps at most 100 messages, dropping the oldest when over capacity', async () => {
    const logger = makeLogger();
    // Use a port that nothing is listening on so the client stays disconnected
    const client = new XarClient(makeConfig(19999), logger);
    // Don't call connect() — client stays disconnected, all messages go to buffer

    // Enqueue 110 messages
    for (let i = 0; i < 110; i++) {
      await client.sendInbound('agent1', makeMessage(`msg-${i}`));
    }

    // warn should have been called 10 times (once per overflow)
    expect(logger.warn).toHaveBeenCalledTimes(10);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('buffer full'),
    );

    // Now connect a real server and verify only the last 100 messages arrive
    const { server, port } = await startWsServer();
    const received = collectServerMessages(server);

    client.close();

    const logger2 = makeLogger();
    const client2 = new XarClient(makeConfig(port), logger2);

    for (let i = 0; i < 110; i++) {
      await client2.sendInbound('agent1', makeMessage(`msg-${i}`));
    }

    await client2.connect();
    await new Promise((r) => setTimeout(r, 100));

    expect(received).toHaveLength(100);
    // First received should be msg-10 (oldest 10 were dropped)
    const first = JSON.parse(received[0]!);
    expect(first.content).toBe('msg-10');
    // Last received should be msg-109
    const last = JSON.parse(received[99]!);
    expect(last.content).toBe('msg-109');

    client2.close();
    await closeWsServer(server);
  });
});

describe('XarClient — FIFO flush after reconnect (req 1.6)', () => {
  it('sends buffered messages in FIFO order after connection is established', async () => {
    const { server, port } = await startWsServer();
    const received = collectServerMessages(server);
    const logger = makeLogger();
    const client = new XarClient(makeConfig(port), logger);

    // Enqueue 5 messages before connecting
    for (let i = 0; i < 5; i++) {
      await client.sendInbound('agent1', makeMessage(`queued-${i}`));
    }

    // Now connect — should flush buffer in order
    await client.connect();
    await new Promise((r) => setTimeout(r, 100));

    expect(received).toHaveLength(5);
    for (let i = 0; i < 5; i++) {
      const parsed = JSON.parse(received[i]!);
      expect(parsed.content).toBe(`queued-${i}`);
    }

    client.close();
    await closeWsServer(server);
  });

  it('sends buffered messages in FIFO order after server becomes available', async () => {
    const { server, port } = await startWsServer();
    const received: string[] = [];
    server.on('connection', (ws: WsSocket) => {
      ws.on('message', (data) => received.push(data.toString()));
    });

    const logger = makeLogger();
    const client = new XarClient(makeConfig(port), logger);

    // Enqueue 3 messages BEFORE connecting (simulates buffering while disconnected)
    for (let i = 0; i < 3; i++) {
      await client.sendInbound('agent1', makeMessage(`reconnect-${i}`));
    }

    // Now connect — buffer should flush in FIFO order
    await client.connect();
    await new Promise((r) => setTimeout(r, 200));

    expect(received).toHaveLength(3);
    for (let i = 0; i < 3; i++) {
      const parsed = JSON.parse(received[i]!);
      expect(parsed.content).toBe(`reconnect-${i}`);
    }

    client.close();
    await closeWsServer(server);
  });
});

describe('XarClient — close() stops reconnect (req 1.1)', () => {
  it('does not reconnect after close() is called', async () => {
    const logger = makeLogger();
    // Point at a port with nothing listening — will fail and schedule reconnect
    const client = new XarClient(
      { socket: '/tmp/__xar_nonexistent__.sock', port: 19998, reconnect_interval_ms: 50 },
      logger,
    );

    // Start connecting (will fail and schedule reconnect)
    const connectPromise = client.connect();

    // Close immediately
    client.close();
    await connectPromise;

    const warnsBefore = logger.warn.mock.calls.length;

    // Wait longer than reconnect interval — no new reconnect should happen
    await new Promise((r) => setTimeout(r, 200));

    // warn count should not have increased (no reconnect attempts)
    expect(logger.warn.mock.calls.length).toBe(warnsBefore);
  });

  it('close() is idempotent — calling twice does not throw', () => {
    const logger = makeLogger();
    const client = new XarClient(makeConfig(19997), logger);
    expect(() => {
      client.close();
      client.close();
    }).not.toThrow();
  });
});

describe('XarClient — outbound event handler (req 1.1)', () => {
  it('delivers messages from xar to registered onOutbound handler', async () => {
    const { server, port } = await startWsServer();
    const logger = makeLogger();
    const client = new XarClient(makeConfig(port), logger);

    const events: unknown[] = [];
    client.onOutbound((e) => events.push(e));

    // Register connection listener BEFORE connect() to avoid race
    const connPromise = waitForConnection(server);

    await client.connect();
    const serverSocket = await connPromise;

    const event = { type: 'stream_token', session_id: 's1', token: 'hello' };
    serverSocket.send(JSON.stringify(event));

    // Wait for message to propagate
    await new Promise((r) => setTimeout(r, 200));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject(event);

    client.close();
    await closeWsServer(server);
  });

  it('logs error and skips invalid JSON from xar', async () => {
    const { server, port } = await startWsServer();
    const logger = makeLogger();
    const client = new XarClient(makeConfig(port), logger);

    const events: unknown[] = [];
    client.onOutbound((e) => events.push(e));

    // Register connection listener BEFORE connect() to avoid race
    const connPromise = waitForConnection(server);

    await client.connect();
    const serverSocket = await connPromise;

    serverSocket.send('not valid json {{{');
    await new Promise((r) => setTimeout(r, 200));

    expect(events).toHaveLength(0);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('invalid JSON'));

    client.close();
    await closeWsServer(server);
  });
});
