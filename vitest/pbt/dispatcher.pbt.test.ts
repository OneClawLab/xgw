import { describe, it, expect, vi } from 'vitest';
import * as fc from 'fast-check';
import { Dispatcher } from '../../src/xar/dispatcher.js';
import type { ChannelRegistry } from '../../src/channels/registry.js';
import type { XarOutboundEvent, ReplyContext } from '../../src/xar/types.js';

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

function makePlugin() {
  return {
    type: 'mock',
    pair: vi.fn().mockResolvedValue({ ok: true }),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue(undefined),
    health: vi.fn().mockResolvedValue({ ok: true }),
  };
}

function makeRegistry(pluginMap: Record<string, ReturnType<typeof makePlugin>>): ChannelRegistry {
  return {
    getPlugin: vi.fn((channelId: string) => pluginMap[channelId]),
  } as unknown as ChannelRegistry;
}

// ── Generators ────────────────────────────────────────────────────────────────

/** Non-empty string without colons — safe for IDs */
const genId = () =>
  fc.string({ minLength: 1, maxLength: 20 }).filter((s) => !s.includes(':') && s.trim().length > 0);

/** Non-empty token text */
const genToken = () => fc.string({ minLength: 1, maxLength: 50 });

/** Array of 1..30 tokens */
const genTokens = () => fc.array(genToken(), { minLength: 1, maxLength: 30 });

/** Non-TUI channel type (anything except 'tui') */
const genNonTuiChannelType = () =>
  fc.oneof(
    fc.constant('telegram'),
    fc.constant('slack'),
    fc.constant('discord'),
    fc.constant('webhook'),
  );

function makeReplyContext(
  channel_type: string,
  channel_id: string,
  session_id: string,
  peer_id: string,
): ReplyContext {
  return {
    channel_type,
    channel_id,
    session_type: 'direct',
    session_id,
    peer_id,
  };
}

function streamStart(session_id: string, reply_context: ReplyContext): XarOutboundEvent {
  return { type: 'stream_start', session_id, reply_context };
}

function streamToken(session_id: string, token: string): XarOutboundEvent {
  return { type: 'stream_token', session_id, token };
}

function streamEnd(session_id: string): XarOutboundEvent {
  return { type: 'stream_end', session_id };
}

// ── Property 5: stream_token 路由到正确 plugin ────────────────────────────────
// Feature: xgw-xar-ipc, Property 5: stream_token 路由到正确 plugin
// **Validates: Requirements 3.1、3.5**

describe('Property 5: stream_token 路由到正确 plugin', () => {
  it(
    '任意 stream_start 建立的会话，stream_token 只路由到对应 channel_id 的 plugin',
    () => {
      fc.assert(
        fc.property(
          genId(), // channel_id for the session
          genId(), // another channel_id (different plugin)
          genId(), // session_id
          genId(), // peer_id
          genToken(), // token text
          (channelId, otherChannelId, sessionId, peerId, token) => {
            fc.pre(channelId !== otherChannelId);

            const targetPlugin = makePlugin();
            const otherPlugin = makePlugin();
            const registry = makeRegistry({
              [channelId]: targetPlugin,
              [otherChannelId]: otherPlugin,
            });
            const logger = makeLogger();
            const dispatcher = new Dispatcher(registry, logger);

            const ctx = makeReplyContext('tui', channelId, sessionId, peerId);
            dispatcher.handle(streamStart(sessionId, ctx));
            dispatcher.handle(streamToken(sessionId, token));

            // The token must be routed to the plugin for channelId
            expect(targetPlugin.send).toHaveBeenCalledOnce();
            // The other plugin must NOT be called
            expect(otherPlugin.send).not.toHaveBeenCalled();
          },
        ),
        { numRuns: 100 },
      );
    },
  );
});

// ── Property 6: TUI 渠道每个 token 立即发送 ───────────────────────────────────
// Feature: xgw-xar-ipc, Property 6: TUI 渠道每个 token 立即发送
// **Validates: Requirements 4.1**

describe('Property 6: TUI 渠道每个 token 立即发送', () => {
  it(
    '任意 TUI 会话中 N 个 stream_token，plugin.send 恰好被调用 N 次，每次 text 等于对应 token',
    () => {
      fc.assert(
        fc.property(
          genId(),    // channel_id
          genId(),    // session_id
          genId(),    // peer_id
          genTokens(), // N tokens
          (channelId, sessionId, peerId, tokens) => {
            const plugin = makePlugin();
            const registry = makeRegistry({ [channelId]: plugin });
            const logger = makeLogger();
            const dispatcher = new Dispatcher(registry, logger);

            const ctx = makeReplyContext('tui', channelId, sessionId, peerId);
            dispatcher.handle(streamStart(sessionId, ctx));

            for (const token of tokens) {
              dispatcher.handle(streamToken(sessionId, token));
            }

            // plugin.send must be called exactly N times
            expect(plugin.send).toHaveBeenCalledTimes(tokens.length);

            // Each call must carry the corresponding token text
            const calls = plugin.send.mock.calls as Array<[{ peer_id: string; session_id: string; text: string }]>;
            for (let i = 0; i < tokens.length; i++) {
              expect(calls[i]![0].text).toBe(tokens[i]);
            }
          },
        ),
        { numRuns: 100 },
      );
    },
  );
});

// ── Property 7: 非 TUI 渠道 token 累积后完整发送 ─────────────────────────────
// Feature: xgw-xar-ipc, Property 7: 非 TUI 渠道 token 累积后完整发送
// **Validates: Requirements 4.2**

describe('Property 7: 非 TUI 渠道 token 累积后完整发送', () => {
  it(
    '任意非 TUI 会话：stream_end 前 plugin.send 不被调用，stream_end 时恰好调用一次且 text 等于所有 token 拼接',
    () => {
      fc.assert(
        fc.property(
          genNonTuiChannelType(), // channel_type (non-TUI)
          genId(),                // channel_id
          genId(),                // session_id
          genId(),                // peer_id
          genTokens(),            // N tokens
          (channelType, channelId, sessionId, peerId, tokens) => {
            const plugin = makePlugin();
            const registry = makeRegistry({ [channelId]: plugin });
            const logger = makeLogger();
            const dispatcher = new Dispatcher(registry, logger);

            const ctx = makeReplyContext(channelType, channelId, sessionId, peerId);
            dispatcher.handle(streamStart(sessionId, ctx));

            // Send all tokens — plugin.send must NOT be called yet
            for (const token of tokens) {
              dispatcher.handle(streamToken(sessionId, token));
            }
            expect(plugin.send).not.toHaveBeenCalled();

            // stream_end — plugin.send must be called exactly once with full text
            dispatcher.handle(streamEnd(sessionId));
            expect(plugin.send).toHaveBeenCalledOnce();

            const calls = plugin.send.mock.calls as Array<[{ peer_id: string; session_id: string; text: string }]>;
            const expectedText = tokens.join('');
            expect(calls[0]![0].text).toBe(expectedText);
          },
        ),
        { numRuns: 100 },
      );
    },
  );
});
