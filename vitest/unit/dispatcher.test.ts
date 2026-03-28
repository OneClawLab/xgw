import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
    type: 'tui',
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

function makeReplyContext(overrides: Partial<ReplyContext> = {}): ReplyContext {
  return {
    channel_type: 'tui',
    channel_id: 'ch1',
    session_type: 'direct',
    session_id: 'sess1',
    peer_id: 'peer1',
    ...overrides,
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

function streamError(session_id: string, error: string): XarOutboundEvent {
  return { type: 'stream_error', session_id, error };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Dispatcher — stream_start initialises session state (req 3.4)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('registers the session so subsequent stream_token events are routed correctly', () => {
    const plugin = makePlugin();
    const registry = makeRegistry({ ch1: plugin });
    const logger = makeLogger();
    const dispatcher = new Dispatcher(registry, logger);

    const ctx = makeReplyContext({ channel_type: 'tui', channel_id: 'ch1', peer_id: 'peer1' });
    dispatcher.handle(streamStart('sess1', ctx));

    // A stream_token after stream_start should buffer (no immediate send)
    dispatcher.handle(streamToken('sess1', 'hello'));
    expect(plugin.send).not.toHaveBeenCalled();

    // After timer fires, the batch is flushed
    vi.runAllTimers();
    expect(plugin.send).toHaveBeenCalledOnce();
    expect(plugin.send).toHaveBeenCalledWith({
      peer_id: 'peer1',
      session_id: 'sess1',
      text: 'hello',
      stream: 'chunk',
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('does not call plugin.send on stream_start itself', () => {
    const plugin = makePlugin();
    const registry = makeRegistry({ ch1: plugin });
    const logger = makeLogger();
    const dispatcher = new Dispatcher(registry, logger);

    const ctx = makeReplyContext({ channel_type: 'tui', channel_id: 'ch1' });
    dispatcher.handle(streamStart('sess1', ctx));

    vi.runAllTimers();
    expect(plugin.send).not.toHaveBeenCalled();
  });
});

describe('Dispatcher — TUI stream_end flushes buffer and sends stream_end frame', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('flushes remaining tokens and sends stream_end frame on stream_end', () => {
    const plugin = makePlugin();
    const registry = makeRegistry({ ch1: plugin });
    const logger = makeLogger();
    const dispatcher = new Dispatcher(registry, logger);

    const ctx = makeReplyContext({ channel_type: 'tui', channel_id: 'ch1' });
    dispatcher.handle(streamStart('sess1', ctx));
    dispatcher.handle(streamToken('sess1', 'tok1'));
    dispatcher.handle(streamToken('sess1', 'tok2'));

    // No flush yet (timer pending)
    expect(plugin.send).not.toHaveBeenCalled();

    dispatcher.handle(streamEnd('sess1'));

    // stream_end should: flush buffered tokens as chunk, then send stream_end
    expect(plugin.send).toHaveBeenCalledTimes(2);
    expect(plugin.send).toHaveBeenNthCalledWith(1, {
      peer_id: 'peer1',
      session_id: 'sess1',
      text: 'tok1tok2',
      stream: 'chunk',
    });
    expect(plugin.send).toHaveBeenNthCalledWith(2, {
      peer_id: 'peer1',
      session_id: 'sess1',
      text: '',
      stream: 'end',
    });
  });

  it('sends only stream_end frame when buffer is empty at stream_end', () => {
    const plugin = makePlugin();
    const registry = makeRegistry({ ch1: plugin });
    const logger = makeLogger();
    const dispatcher = new Dispatcher(registry, logger);

    const ctx = makeReplyContext({ channel_type: 'tui', channel_id: 'ch1' });
    dispatcher.handle(streamStart('sess1', ctx));

    // Flush via timer first (empty buffer)
    vi.runAllTimers();
    plugin.send.mockClear();

    dispatcher.handle(streamEnd('sess1'));

    // Only stream_end frame, no chunk (buffer was empty)
    expect(plugin.send).toHaveBeenCalledOnce();
    expect(plugin.send).toHaveBeenCalledWith({
      peer_id: 'peer1',
      session_id: 'sess1',
      text: '',
      stream: 'end',
    });
  });

  it('cleans up session state after stream_end', () => {
    const plugin = makePlugin();
    const registry = makeRegistry({ ch1: plugin });
    const logger = makeLogger();
    const dispatcher = new Dispatcher(registry, logger);

    const ctx = makeReplyContext({ channel_type: 'tui', channel_id: 'ch1' });
    dispatcher.handle(streamStart('sess1', ctx));
    dispatcher.handle(streamEnd('sess1'));

    // After session is cleaned up, a stray stream_token should warn
    dispatcher.handle(streamToken('sess1', 'orphan'));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('sess1'));
  });
});

describe('Dispatcher — TUI token batching via timer', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('batches multiple tokens into one send call when timer fires', () => {
    const plugin = makePlugin();
    const registry = makeRegistry({ ch1: plugin });
    const logger = makeLogger();
    const dispatcher = new Dispatcher(registry, logger);

    const ctx = makeReplyContext({ channel_type: 'tui', channel_id: 'ch1', peer_id: 'p1' });
    dispatcher.handle(streamStart('sess1', ctx));
    dispatcher.handle(streamToken('sess1', 'a'));
    dispatcher.handle(streamToken('sess1', 'b'));
    dispatcher.handle(streamToken('sess1', 'c'));

    expect(plugin.send).not.toHaveBeenCalled();
    vi.runAllTimers();

    expect(plugin.send).toHaveBeenCalledOnce();
    expect(plugin.send).toHaveBeenCalledWith({
      peer_id: 'p1',
      session_id: 'sess1',
      text: 'abc',
      stream: 'chunk',
    });
  });

  it('cancels pending timer when stream_end arrives', () => {
    const plugin = makePlugin();
    const registry = makeRegistry({ ch1: plugin });
    const logger = makeLogger();
    const dispatcher = new Dispatcher(registry, logger);

    const ctx = makeReplyContext({ channel_type: 'tui', channel_id: 'ch1', peer_id: 'p1' });
    dispatcher.handle(streamStart('sess1', ctx));
    dispatcher.handle(streamToken('sess1', 'x'));

    // stream_end before timer fires — should flush immediately, not double-send
    dispatcher.handle(streamEnd('sess1'));

    // Running timers now should not cause additional sends
    vi.runAllTimers();

    // Exactly 2 calls: chunk flush + stream_end
    expect(plugin.send).toHaveBeenCalledTimes(2);
  });
});

describe('Dispatcher — stream_error logs error (req 3.3)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('logs an error message containing the session_id and error text', () => {
    const plugin = makePlugin();
    const registry = makeRegistry({ ch1: plugin });
    const logger = makeLogger();
    const dispatcher = new Dispatcher(registry, logger);

    const ctx = makeReplyContext({ channel_type: 'tui', channel_id: 'ch1' });
    dispatcher.handle(streamStart('sess1', ctx));
    dispatcher.handle(streamError('sess1', 'something went wrong'));

    expect(logger.error).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('sess1'));
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('something went wrong'));
  });

  it('does not call plugin.send on stream_error', () => {
    const plugin = makePlugin();
    const registry = makeRegistry({ ch1: plugin });
    const logger = makeLogger();
    const dispatcher = new Dispatcher(registry, logger);

    const ctx = makeReplyContext({ channel_type: 'tui', channel_id: 'ch1' });
    dispatcher.handle(streamStart('sess1', ctx));
    dispatcher.handle(streamError('sess1', 'oops'));

    vi.runAllTimers();
    expect(plugin.send).not.toHaveBeenCalled();
  });

  it('cleans up session state after stream_error', () => {
    const plugin = makePlugin();
    const registry = makeRegistry({ ch1: plugin });
    const logger = makeLogger();
    const dispatcher = new Dispatcher(registry, logger);

    const ctx = makeReplyContext({ channel_type: 'tui', channel_id: 'ch1' });
    dispatcher.handle(streamStart('sess1', ctx));
    dispatcher.handle(streamError('sess1', 'err'));

    dispatcher.handle(streamToken('sess1', 'late'));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('sess1'));
  });
});

describe('Dispatcher — plugin not found: warn and no throw (req 3.6)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('logs warn and does not throw when plugin is missing for stream_token (after timer)', () => {
    const registry = makeRegistry({});
    const logger = makeLogger();
    const dispatcher = new Dispatcher(registry, logger);

    const ctx = makeReplyContext({ channel_type: 'tui', channel_id: 'missing-ch' });
    dispatcher.handle(streamStart('sess1', ctx));
    dispatcher.handle(streamToken('sess1', 'tok'));

    expect(() => vi.runAllTimers()).not.toThrow();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('missing-ch'));
  });

  it('logs warn and does not throw when plugin is missing for stream_end (non-TUI)', () => {
    const registry = makeRegistry({});
    const logger = makeLogger();
    const dispatcher = new Dispatcher(registry, logger);

    const ctx = makeReplyContext({ channel_type: 'telegram', channel_id: 'missing-ch' });
    dispatcher.handle(streamStart('sess1', ctx));
    dispatcher.handle(streamToken('sess1', 'tok'));

    expect(() => dispatcher.handle(streamEnd('sess1'))).not.toThrow();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('missing-ch'));
  });

  it('logs warn for stream_token with unknown session_id', () => {
    const registry = makeRegistry({});
    const logger = makeLogger();
    const dispatcher = new Dispatcher(registry, logger);

    expect(() => dispatcher.handle(streamToken('unknown-sess', 'tok'))).not.toThrow();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('unknown-sess'));
  });
});

describe('Dispatcher — non-TUI channel accumulates tokens and sends on stream_end', () => {
  it('does not call plugin.send during stream_token for non-TUI channel', () => {
    const plugin = makePlugin();
    const registry = makeRegistry({ 'tg-ch': plugin });
    const logger = makeLogger();
    const dispatcher = new Dispatcher(registry, logger);

    const ctx = makeReplyContext({ channel_type: 'telegram', channel_id: 'tg-ch' });
    dispatcher.handle(streamStart('sess1', ctx));
    dispatcher.handle(streamToken('sess1', 'hello '));
    dispatcher.handle(streamToken('sess1', 'world'));

    expect(plugin.send).not.toHaveBeenCalled();
  });

  it('calls plugin.send once with full text on stream_end for non-TUI channel', () => {
    const plugin = makePlugin();
    const registry = makeRegistry({ 'tg-ch': plugin });
    const logger = makeLogger();
    const dispatcher = new Dispatcher(registry, logger);

    const ctx = makeReplyContext({ channel_type: 'telegram', channel_id: 'tg-ch', peer_id: 'p1' });
    dispatcher.handle(streamStart('sess1', ctx));
    dispatcher.handle(streamToken('sess1', 'hello '));
    dispatcher.handle(streamToken('sess1', 'world'));
    dispatcher.handle(streamEnd('sess1'));

    expect(plugin.send).toHaveBeenCalledOnce();
    expect(plugin.send).toHaveBeenCalledWith({
      peer_id: 'p1',
      session_id: 'sess1',
      text: 'hello world',
    });
  });
});
