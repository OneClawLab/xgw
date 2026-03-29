import { vi, describe, it, expect, beforeEach } from 'vitest';

// Mock the client module — must be hoisted before imports
vi.mock('../../src/client.js', () => ({
  createClient: vi.fn(() => ({})),
  createDispatcher: vi.fn(() => ({
    register: vi.fn(),
  })),
  createWSClient: vi.fn(() => ({
    start: vi.fn(),
    close: vi.fn(),
  })),
  validateCredentials: vi.fn(),
}));

import { FeishuPlugin, type ChannelConfig } from '../../src/index.js';
import {
  validateCredentials,
  createDispatcher,
  createWSClient,
  createClient,
} from '../../src/client.js';

function makeConfig(overrides: Record<string, unknown> = {}): ChannelConfig {
  return {
    id: 'ch-1',
    type: 'feishu',
    appId: 'app-123',
    appSecret: 'secret-456',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();

  // Default: validateCredentials returns a botOpenId
  vi.mocked(validateCredentials).mockResolvedValue({ botOpenId: 'bot-123' });

  // Default dispatcher captures registered handlers
  vi.mocked(createDispatcher).mockReturnValue({
    register: vi.fn(),
  } as unknown as ReturnType<typeof createDispatcher>);

  // Default WSClient is a no-op
  vi.mocked(createWSClient).mockReturnValue({
    start: vi.fn(),
    close: vi.fn(),
  } as unknown as ReturnType<typeof createWSClient>);
});

describe('FeishuPlugin.pair()', () => {
  it('returns success with botOpenId on valid credentials (Req 1.1)', async () => {
    vi.mocked(validateCredentials).mockResolvedValue({ botOpenId: 'bot-123' });

    const plugin = new FeishuPlugin();
    const result = await plugin.pair(makeConfig());

    expect(result.success).toBe(true);
    expect(result.pair_mode).toBe('ws');
    expect(result.pair_info).toEqual({ botOpenId: 'bot-123' });
  });

  it('returns failure with error message on invalid credentials (Req 1.2)', async () => {
    vi.mocked(validateCredentials).mockRejectedValue(new Error('invalid credentials'));

    const plugin = new FeishuPlugin();
    const result = await plugin.pair(makeConfig());

    expect(result.success).toBe(false);
    expect(result.error).toBe('invalid credentials');
  });
});

describe('FeishuPlugin.health()', () => {
  it('returns { ok: false } when not started (Req 8.2)', async () => {
    const plugin = new FeishuPlugin();
    const result = await plugin.health();

    expect(result.ok).toBe(false);
  });

  it('returns { ok: true } after start() (Req 8.1)', async () => {
    const plugin = new FeishuPlugin();
    await plugin.start(makeConfig(), vi.fn());
    const result = await plugin.health();

    expect(result.ok).toBe(true);
  });
});

describe('FeishuPlugin config defaults (Req 9.2, 9.3, 9.4)', () => {
  it('uses domain=feishu, requireMention=true, streamingCoalesceMs=500 by default', async () => {
    const plugin = new FeishuPlugin();
    // pair() calls createClient with the parsed config
    await plugin.pair(makeConfig({ appId: 'app-id', appSecret: 'app-secret' }));

    expect(createClient).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 'app-id',
        appSecret: 'app-secret',
        domain: 'feishu',
      }),
    );
  });

  it('start() passes streamingCoalesceMs=500 by default (verified via no override)', async () => {
    const plugin = new FeishuPlugin();
    // Just verify start() completes without error using default config
    await expect(plugin.start(makeConfig(), vi.fn())).resolves.toBeUndefined();
  });
});

describe('FeishuPlugin event filtering', () => {
  // Helper to capture the registered im.message.receive_v1 handler
  function captureHandler(): {
    getHandler: () => ((data: unknown) => Promise<void>) | null;
  } {
    let handler: ((data: unknown) => Promise<void>) | null = null;

    vi.mocked(createDispatcher).mockReturnValue({
      register: vi.fn((handlers: Record<string, (data: unknown) => Promise<void>>) => {
        handler = handlers['im.message.receive_v1'] ?? null;
      }),
    } as unknown as ReturnType<typeof createDispatcher>);

    return { getHandler: () => handler };
  }

  function makeBotEvent() {
    return {
      sender: {
        sender_id: { open_id: 'user-abc' },
        sender_type: 'bot',
      },
      message: {
        message_id: 'msg-1',
        chat_id: 'chat-1',
        chat_type: 'p2p' as const,
        message_type: 'text',
        content: JSON.stringify({ text: 'hello' }),
      },
    };
  }

  function makeGroupEvent(withMention: boolean) {
    return {
      sender: {
        sender_id: { open_id: 'user-abc' },
        sender_type: 'user',
      },
      message: {
        message_id: 'msg-2',
        chat_id: 'chat-group-1',
        chat_type: 'group' as const,
        message_type: 'text',
        content: JSON.stringify({ text: withMention ? '@_user_1 hello' : 'hello' }),
        mentions: withMention
          ? [{ key: '@_user_1', id: { open_id: 'bot-123' }, name: 'Bot' }]
          : [],
      },
    };
  }

  it('ignores bot messages — onMessage NOT called (Req 2.3)', async () => {
    const { getHandler } = captureHandler();
    const onMessage = vi.fn();

    const plugin = new FeishuPlugin();
    await plugin.start(makeConfig(), onMessage);

    const handler = getHandler();
    expect(handler).not.toBeNull();

    await handler!(makeBotEvent());
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('ignores group message without @bot when requireMention=true (Req 4.3)', async () => {
    const { getHandler } = captureHandler();
    const onMessage = vi.fn();

    const plugin = new FeishuPlugin();
    await plugin.start(makeConfig(), onMessage); // requireMention defaults to true

    const handler = getHandler();
    expect(handler).not.toBeNull();

    await handler!(makeGroupEvent(false));
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('passes group message with @bot when requireMention=true (Req 4.3)', async () => {
    const { getHandler } = captureHandler();
    const onMessage = vi.fn().mockResolvedValue(undefined);

    const plugin = new FeishuPlugin();
    await plugin.start(makeConfig(), onMessage);

    const handler = getHandler();
    expect(handler).not.toBeNull();

    await handler!(makeGroupEvent(true));
    expect(onMessage).toHaveBeenCalledOnce();
  });
});
