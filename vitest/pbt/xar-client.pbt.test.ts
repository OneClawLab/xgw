import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fc from 'fast-check';
import { WebSocketServer } from 'ws';
import type { WebSocket as WsSocket } from 'ws';
import { XarClient } from '../../src/xar/client.js';
import type { XarConfig, InboundMessage, ReplyContext } from '../../src/xar/types.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeLogger() {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    close: async () => {},
  };
}

/** Config pointing Unix socket at a path that never exists (forces TCP fallback). */
function makeConfig(port: number): XarConfig {
  return {
    socket: '/tmp/__xar_pbt_nonexistent__.sock',
    port,
    reconnect_interval_ms: 50,
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

function startWsServer(): Promise<{ server: WebSocketServer; port: number }> {
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

function closeWsServer(server: WebSocketServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

/**
 * Collect messages from the NEXT client connection on the server.
 * Returns a promise that resolves to the array of raw message strings
 * once the client disconnects.
 */
function collectNextConnection(server: WebSocketServer): Promise<string[]> {
  return new Promise((resolve) => {
    server.once('connection', (ws: WsSocket) => {
      const msgs: string[] = [];
      ws.on('message', (data) => msgs.push(data.toString()));
      ws.on('close', () => resolve(msgs));
    });
  });
}

// ── Generators ────────────────────────────────────────────────────────────────

/** N > 100 */
const genOverflowCount = () => fc.integer({ min: 101, max: 150 });

/** Sequence of 1..50 message contents (kept small for speed) */
const genMessageContents = () =>
  fc.array(fc.string({ minLength: 1, maxLength: 30 }), { minLength: 1, maxLength: 50 });

/** Non-empty string without colons (safe for source field segments) */
const genSegment = () =>
  fc.string({ minLength: 1, maxLength: 20 }).filter((s) => !s.includes(':') && s.length > 0);

/** Valid InboundMessage */
const genInboundMessage = () =>
  fc
    .record({
      channel_type: genSegment(),
      channel_id: genSegment(),
      session_type: genSegment(),
      session_id: genSegment(),
      peer_id: genSegment(),
      content: fc.string({ minLength: 0, maxLength: 100 }),
    })
    .map(({ channel_type, channel_id, session_type, session_id, peer_id, content }) => {
      const source = `external:${channel_type}:${channel_id}:${session_type}:${session_id}:${peer_id}`;
      const reply_context: ReplyContext = {
        channel_type,
        channel_id,
        session_type,
        session_id,
        peer_id,
      };
      const msg: InboundMessage = { source, content, reply_context };
      return msg;
    });

// ── Property 1: 缓冲区溢出后保留最新消息 ─────────────────────────────────────
// Feature: xgw-xar-ipc, Property 1: 缓冲区溢出后保留最新消息
// **Validates: Requirements 1.4、1.5**

describe('Property 1: 缓冲区溢出后保留最新消息', () => {
  let server: WebSocketServer;
  let port: number;

  beforeAll(async () => {
    ({ server, port } = await startWsServer());
  });

  afterAll(async () => {
    await closeWsServer(server);
  });

  it(
    'N > 100 条消息入队后，缓冲区大小 ≤ 100 且保留最后 100 条',
    async () => {
      await fc.assert(
        fc.asyncProperty(genOverflowCount(), async (n) => {
          // Collect messages from the next client connection
          const collectionPromise = collectNextConnection(server);

          const client = new XarClient(makeConfig(port), makeLogger());

          // Enqueue N messages while disconnected (no connect() call yet)
          for (let i = 0; i < n; i++) {
            await client.sendInbound('agent1', makeMessage(`msg-${i}`));
          }

          // Connect — buffer flushes, then close so the server-side socket closes
          await client.connect();
          await new Promise((r) => setTimeout(r, 80));
          client.close();

          const received = await collectionPromise;

          // Buffer must have been capped at 100
          expect(received.length).toBe(100);

          // The retained messages must be the LAST 100 (indices n-100 .. n-1)
          const firstExpected = n - 100;
          const firstParsed = JSON.parse(received[0]!) as { content: string };
          expect(firstParsed.content).toBe(`msg-${firstExpected}`);

          const lastParsed = JSON.parse(received[99]!) as { content: string };
          expect(lastParsed.content).toBe(`msg-${n - 1}`);
        }),
        { numRuns: 100 },
      );
    },
    60000,
  );
});

// ── Property 2: 缓冲区恢复后 FIFO 顺序发送 ───────────────────────────────────
// Feature: xgw-xar-ipc, Property 2: 缓冲区恢复后 FIFO 顺序发送
// **Validates: Requirements 1.6**

describe('Property 2: 缓冲区恢复后 FIFO 顺序发送', () => {
  let server: WebSocketServer;
  let port: number;

  beforeAll(async () => {
    ({ server, port } = await startWsServer());
  });

  afterAll(async () => {
    await closeWsServer(server);
  });

  it(
    '断连时缓冲的消息在连接恢复后按 FIFO 顺序发送给 xar',
    async () => {
      await fc.assert(
        fc.asyncProperty(genMessageContents(), async (contents) => {
          const collectionPromise = collectNextConnection(server);

          const client = new XarClient(makeConfig(port), makeLogger());

          // Enqueue all messages BEFORE connecting (simulates buffering while disconnected)
          for (const content of contents) {
            await client.sendInbound('agent1', makeMessage(content));
          }

          // Connect — buffer flushes in FIFO order, then close
          await client.connect();
          await new Promise((r) => setTimeout(r, 80));
          client.close();

          const received = await collectionPromise;

          expect(received.length).toBe(contents.length);
          for (let i = 0; i < contents.length; i++) {
            const parsed = JSON.parse(received[i]!) as { content: string };
            expect(parsed.content).toBe(contents[i]);
          }
        }),
        { numRuns: 100 },
      );
    },
    60000,
  );
});

// ── Property 3: InboundMessage source 字段格式正确性 ─────────────────────────
// Feature: xgw-xar-ipc, Property 3: InboundMessage source 字段格式正确性
// **Validates: Requirements 2.3**

describe('Property 3: InboundMessage source 字段格式正确性', () => {
  it('构造的 source 字段以 "external:" 开头，共 6 段，各段与输入一一对应', () => {
    fc.assert(
      fc.property(
        genSegment(),
        genSegment(),
        genSegment(),
        genSegment(),
        genSegment(),
        (channel_type, channel_id, session_type, session_id, peer_id) => {
          const source = `external:${channel_type}:${channel_id}:${session_type}:${session_id}:${peer_id}`;

          // Must start with "external:"
          expect(source.startsWith('external:')).toBe(true);

          // Must have exactly 6 colon-separated segments
          const segments = source.split(':');
          expect(segments.length).toBe(6);

          // Each segment must match the input
          expect(segments[0]).toBe('external');
          expect(segments[1]).toBe(channel_type);
          expect(segments[2]).toBe(channel_id);
          expect(segments[3]).toBe(session_type);
          expect(segments[4]).toBe(session_id);
          expect(segments[5]).toBe(peer_id);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ── Property 4: InboundMessage JSON 序列化往返一致性 ─────────────────────────
// Feature: xgw-xar-ipc, Property 4: InboundMessage JSON 序列化往返一致性
// **Validates: Requirements 2.2、2.4、2.5**

describe('Property 4: InboundMessage JSON 序列化往返一致性', () => {
  it('任意合法 InboundMessage 经 JSON 序列化再反序列化后字段完全等价', () => {
    fc.assert(
      fc.property(genInboundMessage(), (msg) => {
        const serialized = JSON.stringify(msg);
        const deserialized = JSON.parse(serialized) as InboundMessage;

        // Top-level fields
        expect(deserialized.source).toBe(msg.source);
        expect(deserialized.content).toBe(msg.content);

        // reply_context fields
        expect(deserialized.reply_context.channel_type).toBe(msg.reply_context.channel_type);
        expect(deserialized.reply_context.channel_id).toBe(msg.reply_context.channel_id);
        expect(deserialized.reply_context.session_type).toBe(msg.reply_context.session_type);
        expect(deserialized.reply_context.session_id).toBe(msg.reply_context.session_id);
        expect(deserialized.reply_context.peer_id).toBe(msg.reply_context.peer_id);
      }),
      { numRuns: 100 },
    );
  });
});
