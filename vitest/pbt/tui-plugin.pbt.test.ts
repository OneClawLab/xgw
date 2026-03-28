import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fc from 'fast-check';
import WebSocket from 'ws';
import { TuiPlugin } from '../../plugins/tui/src/index.js';
import type { Message } from '../../plugins/tui/src/index.js';

// ── Helpers ────────────────────────────────────────────────────────

/** Get a random port in the ephemeral range */
function randomPort(): number {
  return 30000 + Math.floor(Math.random() * 20000);
}

/** Connect a WebSocket client and wait for open */
function connectWs(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

/** Send a JSON frame and wait for the next JSON response */
function sendAndReceive(ws: WebSocket, frame: object): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timeout waiting for response')), 5000);
    ws.once('message', (data) => {
      clearTimeout(timeout);
      resolve(JSON.parse(String(data)) as Record<string, unknown>);
    });
    ws.once('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    ws.send(JSON.stringify(frame));
  });
}

/**
 * Send a frame that may cause the server to close the connection.
 * Collects the response message even if the connection is closed right after.
 */
function sendAndReceiveBeforeClose(ws: WebSocket, frame: object): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timeout waiting for response')), 5000);
    ws.once('message', (data) => {
      clearTimeout(timeout);
      resolve(JSON.parse(String(data)) as Record<string, unknown>);
    });
    ws.once('close', () => {
      // If we got here without a message, the server closed before responding
      clearTimeout(timeout);
      // Give a tiny bit of time for the message event to fire first
    });
    ws.send(JSON.stringify(frame));
  });
}

/** Perform hello handshake, return the hello_ack frame */
async function doHandshake(
  ws: WebSocket,
  channelId: string,
  peerId: string,
): Promise<Record<string, unknown>> {
  return sendAndReceive(ws, { type: 'hello', channel_id: channelId, peer_id: peerId });
}

/** Close a WebSocket gracefully */
function closeWs(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      resolve();
      return;
    }
    ws.on('close', () => resolve());
    ws.close();
  });
}

// ── Generators ─────────────────────────────────────────────────────

/** Alphanumeric identifier suitable for peer_id (unique per iteration via counter) */
const genSuffix = () =>
  fc.stringMatching(/^[a-z0-9]{1,8}$/).filter((s) => s.length >= 1);

/** Arbitrary non-empty text for messages */
const genText = () =>
  fc.string({ minLength: 1, maxLength: 200 }).filter((s) => s.trim().length > 0);

// UUID v4 regex
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Property 18: TUI Plugin message normalization ──────────────────
// **Validates: Requirements 9.1, 9.2, 9.4, 10.4**

describe('Property 18: TUI Plugin message normalization', () => {
  const CHANNEL_ID = 'test-norm';
  let plugin: TuiPlugin;
  let port: number;
  let messages: Message[];

  beforeAll(async () => {
    port = randomPort();
    plugin = new TuiPlugin();
    messages = [];
    await plugin.start({ id: CHANNEL_ID, type: 'tui', port }, async (msg) => {
      messages.push(msg);
    });
  });

  afterAll(async () => {
    await plugin.stop();
  });

  it('normalizes any message frame into a correct Message object', async () => {
    let counter = 0;
    await fc.assert(
      fc.asyncProperty(genText(), async (text) => {
        const peerId = `p${counter++}`;
        const ws = await connectWs(port);
        try {
          await doHandshake(ws, CHANNEL_ID, peerId);

          // Clear messages from previous iterations
          const startIdx = messages.length;

          // Send a message frame
          ws.send(JSON.stringify({ type: 'message', text }));

          // Wait for the onMessage callback to fire
          await new Promise((r) => setTimeout(r, 50));

          expect(messages.length).toBeGreaterThan(startIdx);
          const msg = messages[startIdx]!;

          // id is a valid UUID
          expect(msg.id).toMatch(UUID_RE);
          // channel_id and peer_id match handshake values
          expect(msg.channel_id).toBe(CHANNEL_ID);
          expect(msg.peer_id).toBe(peerId);
          // session_id equals peer_id
          expect(msg.session_id).toBe(peerId);
          // text equals the frame text
          expect(msg.text).toBe(text);
          // attachments is empty
          expect(msg.attachments).toEqual([]);
          // created_at is a valid ISO 8601 timestamp
          expect(new Date(msg.created_at).toISOString()).toBe(msg.created_at);
          // raw contains the original frame
          expect(msg.raw).toEqual({ type: 'message', text });
        } finally {
          await closeWs(ws);
        }
      }),
      { numRuns: 20 },
    );
  }, 60_000);
});

// ── Property 19: TUI Plugin hello handshake ────────────────────────
// **Validates: Requirements 10.2**

describe('Property 19: TUI Plugin hello handshake', () => {
  const CHANNEL_ID = 'test-hello';
  let plugin: TuiPlugin;
  let port: number;

  beforeAll(async () => {
    port = randomPort();
    plugin = new TuiPlugin();
    await plugin.start({ id: CHANNEL_ID, type: 'tui', port }, async () => {});
  });

  afterAll(async () => {
    await plugin.stop();
  });

  it('responds with hello_ack containing matching channel_id and peer_id', async () => {
    let counter = 0;
    await fc.assert(
      fc.asyncProperty(genSuffix(), async (suffix) => {
        const peerId = `h${counter++}_${suffix}`;
        const ws = await connectWs(port);
        try {
          const ack = await doHandshake(ws, CHANNEL_ID, peerId);

          expect(ack['type']).toBe('hello_ack');
          expect(ack['channel_id']).toBe(CHANNEL_ID);
          expect(ack['peer_id']).toBe(peerId);
        } finally {
          await closeWs(ws);
        }
      }),
      { numRuns: 20 },
    );
  }, 60_000);
});

// ── Property 20: TUI Plugin invalid hello rejection ────────────────
// **Validates: Requirements 10.3**

describe('Property 20: TUI Plugin invalid hello rejection', () => {
  const CHANNEL_ID = 'test-reject';
  let plugin: TuiPlugin;
  let port: number;

  beforeAll(async () => {
    port = randomPort();
    plugin = new TuiPlugin();
    await plugin.start({ id: CHANNEL_ID, type: 'tui', port }, async () => {});
  });

  afterAll(async () => {
    await plugin.stop();
  });

  it('rejects hello frames missing channel_id, missing peer_id, or with unknown channel_id', async () => {
    // Generator for malformed hello frames — 3 categories
    const genMalformedHello = fc.oneof(
      // Missing channel_id entirely
      genSuffix().map((peerId) => ({
        type: 'hello',
        peer_id: peerId,
      })),
      // Missing peer_id entirely
      fc.constant({
        type: 'hello',
        channel_id: CHANNEL_ID,
      }),
      // Unknown channel_id (different from the real one)
      fc.tuple(genSuffix(), genSuffix())
        .filter(([ch]) => ch !== CHANNEL_ID)
        .map(([ch, peer]) => ({
          type: 'hello',
          channel_id: `wrong_${ch}`,
          peer_id: peer,
        })),
    );

    await fc.assert(
      fc.asyncProperty(genMalformedHello, async (frame) => {
        const ws = await connectWs(port);
        try {
          const resp = await sendAndReceiveBeforeClose(ws, frame);
          expect(resp['type']).toBe('error');
          expect(resp['code']).toBe('bad_hello');
        } finally {
          await closeWs(ws);
        }
      }),
      { numRuns: 20 },
    );
  }, 60_000);
});

// ── Property 21: TUI Plugin send routes to correct peer ────────────
// **Validates: Requirements 10.5**

describe('Property 21: TUI Plugin send routes to correct peer', () => {
  const CHANNEL_ID = 'test-send';
  let plugin: TuiPlugin;
  let port: number;

  beforeAll(async () => {
    port = randomPort();
    plugin = new TuiPlugin();
    await plugin.start({ id: CHANNEL_ID, type: 'tui', port }, async () => {});
  });

  afterAll(async () => {
    await plugin.stop();
  });

  it('send() delivers message only to the target peer_id', async () => {
    let counter = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 5 }),
        genText(),
        async (numPeers, text) => {
          const batch = counter++;
          const peerIds = Array.from({ length: numPeers }, (_, i) => `s${batch}_${i}`);

          // Connect all peers and complete handshake
          const clients: { peerId: string; ws: WebSocket; received: string[] }[] = [];
          for (const peerId of peerIds) {
            const ws = await connectWs(port);
            await doHandshake(ws, CHANNEL_ID, peerId);
            const received: string[] = [];
            ws.on('message', (data) => {
              const frame = JSON.parse(String(data)) as Record<string, unknown>;
              if (frame['type'] === 'message') {
                received.push(frame['text'] as string);
              }
            });
            clients.push({ peerId, ws, received });
          }

          // Pick the first peer as the target
          const targetPeerId = peerIds[0]!;

          // Send a message to the target peer
          await plugin.send({ peer_id: targetPeerId, session_id: targetPeerId, text });

          // Wait for delivery
          await new Promise((r) => setTimeout(r, 50));

          // Only the target peer should have received the message
          for (const client of clients) {
            if (client.peerId === targetPeerId) {
              expect(client.received).toEqual([text]);
            } else {
              expect(client.received).toEqual([]);
            }
          }

          // Cleanup connections for this iteration
          for (const client of clients) {
            await closeWs(client.ws);
          }
        },
      ),
      { numRuns: 20 },
    );
  }, 60_000);
});
