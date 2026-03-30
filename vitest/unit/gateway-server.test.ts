import { describe, it, expect, vi } from 'vitest';
import { GatewayServer } from '../../src/gateway/server.js';
import type { XarClient } from '../../src/xar/client.js';
import type { XarOutboundEvent } from '../../src/xar/types.js';
import type { Config } from '../../src/config.js';
import type { ChannelRegistry } from '../../src/channels/registry.js';

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

function makeXarClient(): XarClient {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    sendInbound: vi.fn().mockResolvedValue(undefined),
    onOutbound: vi.fn(),
    close: vi.fn(),
  } as unknown as XarClient;
}

function makeRegistry(): ChannelRegistry {
  return {
    startAll: vi.fn().mockResolvedValue(undefined),
    stopAll: vi.fn().mockResolvedValue(undefined),
    getPlugin: vi.fn().mockReturnValue(undefined),
  } as unknown as ChannelRegistry;
}

function makeConfig(): Config {
  return {
    gateway: { host: '127.0.0.1', port: 0 },
    channels: [{ id: 'ch1', type: 'tui', paired: true }],
    routing: [{ channel: 'ch1', peer: '*', agent: 'agent1' }],
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GatewayServer — start() with XarClient (req 6.2)', () => {
  it('calls XarClient.connect() when xarClient is provided', async () => {
    const logger = makeLogger();
    const xarClient = makeXarClient();
    const registry = makeRegistry();
    const server = new GatewayServer(logger, xarClient);

    await server.start(makeConfig(), registry);
    await server.stop();

    expect(xarClient.connect).toHaveBeenCalledOnce();
  });

  it('calls XarClient.onOutbound() to register the dispatcher handler', async () => {
    const logger = makeLogger();
    const xarClient = makeXarClient();
    const registry = makeRegistry();
    const server = new GatewayServer(logger, xarClient);

    await server.start(makeConfig(), registry);
    await server.stop();

    expect(xarClient.onOutbound).toHaveBeenCalledOnce();
    expect(xarClient.onOutbound).toHaveBeenCalledWith(expect.any(Function));
  });

  it('registers onOutbound before calling connect()', async () => {
    const logger = makeLogger();
    const callOrder: string[] = [];
    const xarClient = makeXarClient();
    (xarClient.onOutbound as ReturnType<typeof vi.fn>).mockImplementation(() => {
      callOrder.push('onOutbound');
    });
    (xarClient.connect as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callOrder.push('connect');
    });

    const registry = makeRegistry();
    const server = new GatewayServer(logger, xarClient);

    await server.start(makeConfig(), registry);
    await server.stop();

    expect(callOrder).toEqual(['onOutbound', 'connect']);
  });

  it('the registered onOutbound handler forwards events (does not throw)', async () => {
    const logger = makeLogger();
    const xarClient = makeXarClient();
    const registry = makeRegistry();
    const server = new GatewayServer(logger, xarClient);

    await server.start(makeConfig(), registry);
    await server.stop();

    // Retrieve the registered handler
    const handler = (xarClient.onOutbound as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
      | ((event: XarOutboundEvent) => void)
      | undefined;
    expect(handler).toBeDefined();

    // Calling it with a valid event should not throw
    expect(() =>
      handler!({ type: 'stream_token', stream_id: 's1', token: 'hello' }),
    ).not.toThrow();
  });
});

describe('GatewayServer — inbound message routing with XarClient (req 6.3)', () => {
  it('calls XarClient.sendInbound() when xarClient is provided', async () => {
    const logger = makeLogger();
    const xarClient = makeXarClient();

    let capturedOnMessage: ((msg: unknown) => Promise<void>) | undefined;
    const registry = makeRegistry();
    (registry.startAll as ReturnType<typeof vi.fn>).mockImplementation(
      async (_channels: unknown, onMessage: (msg: unknown) => Promise<void>) => {
        capturedOnMessage = onMessage;
      },
    );

    const server = new GatewayServer(logger, xarClient);
    await server.start(makeConfig(), registry);

    // Simulate an inbound message from a channel plugin
    await capturedOnMessage!({
      id: 'msg1',
      channel_id: 'ch1',
      peer_id: 'peer1',
      peer_name: null,
      conversation_id: 'conv1',
      text: 'hello xar',
      attachments: [],
      reply_to: null,
      created_at: '2026-01-01T00:00:00.000Z',
      raw: {},
    });

    expect(xarClient.sendInbound).toHaveBeenCalledOnce();
    expect(xarClient.sendInbound).toHaveBeenCalledWith(
      'agent1',
      expect.objectContaining({
        content: 'hello xar',
        source: expect.stringContaining('ch1'),
      }),
    );

    await server.stop();
  });

  it('does NOT call InboxWriter when xarClient is provided', async () => {
    const logger = makeLogger();
    const xarClient = makeXarClient();

    let capturedOnMessage: ((msg: unknown) => Promise<void>) | undefined;
    const registry = makeRegistry();
    (registry.startAll as ReturnType<typeof vi.fn>).mockImplementation(
      async (_channels: unknown, onMessage: (msg: unknown) => Promise<void>) => {
        capturedOnMessage = onMessage;
      },
    );

    const server = new GatewayServer(logger, xarClient);
    await server.start(makeConfig(), registry);

    await capturedOnMessage!({
      id: 'msg1',
      channel_id: 'ch1',
      peer_id: 'peer1',
      peer_name: null,
      conversation_id: 'conv1',
      text: 'hello',
      attachments: [],
      reply_to: null,
      created_at: '2026-01-01T00:00:00.000Z',
      raw: {},
    });

    // xarClient.sendInbound was called — InboxWriter path was NOT taken
    expect(xarClient.sendInbound).toHaveBeenCalledOnce();
    // No inbox-related log (InboxWriter logs "inbox push:")
    const infoLogs = (logger.info as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string);
    expect(infoLogs.some((msg) => msg.includes('inbox push'))).toBe(false);

    await server.stop();
  });

  it('constructs the correct source field in InboundMessage', async () => {
    const logger = makeLogger();
    const xarClient = makeXarClient();

    let capturedOnMessage: ((msg: unknown) => Promise<void>) | undefined;
    const registry = makeRegistry();
    (registry.startAll as ReturnType<typeof vi.fn>).mockImplementation(
      async (_channels: unknown, onMessage: (msg: unknown) => Promise<void>) => {
        capturedOnMessage = onMessage;
      },
    );

    const server = new GatewayServer(logger, xarClient);
    await server.start(makeConfig(), registry);

    await capturedOnMessage!({
      id: 'msg1',
      channel_id: 'ch1',
      peer_id: 'peer1',
      peer_name: null,
      conversation_id: 'conv1',
      text: 'hi',
      attachments: [],
      reply_to: null,
      created_at: '2026-01-01T00:00:00.000Z',
      raw: {},
    });

    const call = (xarClient.sendInbound as ReturnType<typeof vi.fn>).mock.calls[0];
    const inboundMsg = call?.[1] as { source: string };
    // source format: "external:<channel_id>:dm:<conversation_id>:<peer_id>"
    expect(inboundMsg.source).toMatch(/^external:/);
    expect(inboundMsg.source).toContain(':ch1:');
    expect(inboundMsg.source).toContain(':conv1:');
    expect(inboundMsg.source).toContain(':peer1');

    await server.stop();
  });
});

describe('GatewayServer — fallback to InboxWriter when xarClient is absent (req 6.3, 6.4)', () => {
  it('logs a warning when no xarClient is provided and message is dropped', async () => {
    const logger = makeLogger();
    // No xarClient — messages are dropped
    const server = new GatewayServer(logger);

    let capturedOnMessage: ((msg: unknown) => Promise<void>) | undefined;
    const registry = makeRegistry();
    (registry.startAll as ReturnType<typeof vi.fn>).mockImplementation(
      async (_channels: unknown, onMessage: (msg: unknown) => Promise<void>) => {
        capturedOnMessage = onMessage;
      },
    );

    await server.start(makeConfig(), registry);

    // Simulate inbound message — should be dropped with a warning
    await capturedOnMessage!({
      id: 'msg1',
      channel_id: 'ch1',
      peer_id: 'peer1',
      peer_name: null,
      conversation_id: 'conv1',
      text: 'fallback message',
      attachments: [],
      reply_to: null,
      created_at: '2026-01-01T00:00:00.000Z',
      raw: {},
    });

    // Should log a warning about no xar client
    const warnLogs = (logger.warn as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string);
    expect(warnLogs.some((msg) => msg.includes('No xar client') || msg.includes('dropped'))).toBe(true);

    await server.stop();
  });

  it('does not call connect() or onOutbound() when no xarClient is provided', async () => {
    const logger = makeLogger();
    const registry = makeRegistry();
    const server = new GatewayServer(logger);

    // Should not throw and should not try to call xarClient methods
    await expect(server.start(makeConfig(), registry)).resolves.not.toThrow();
    await server.stop();
  });
});
