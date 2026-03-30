import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Dispatcher } from '../../src/xar/dispatcher.js';
import type { ChannelRegistry } from '../../src/channels/registry.js';
import type { XarOutboundEvent, OutboundTarget } from '../../src/xar/types.js';

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

function makeTarget(overrides: Partial<OutboundTarget> = {}): OutboundTarget {
  return {
    channel_id: 'tui:default',
    peer_id: 'peer1',
    conversation_id: 'conv1',
    ...overrides,
  };
}

function streamStart(stream_id: string, target: OutboundTarget): XarOutboundEvent {
  return { type: 'stream_start', stream_id, target };
}

function streamToken(stream_id: string, token: string): XarOutboundEvent {
  return { type: 'stream_token', stream_id, token };
}

function streamEnd(stream_id: string): XarOutboundEvent {
  return { type: 'stream_end', stream_id };
}

function streamError(stream_id: string, error: string): XarOutboundEvent {
  return { type: 'stream_error', stream_id, error };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Dispatcher — stream_start initialises stream state (req 3.4)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('registers the stream so subsequent stream_token events are routed correctly', () => {
    const plugin = makePlugin();
    const registry = makeRegistry({ 'tui:default': plugin });
    const logger = makeLogger();
    const dispatcher = new Dispatcher(registry, logger);

    const target = makeTarget({ channel_id: 'tui:default', peer_id: 'peer1', conversation_id: 'conv1' });
    dispatcher.handle(streamStart('tui:default:conv1:1', target));

    // A stream_token after stream_start should buffer (no immediate send)
    dispatcher.handle(streamToken('tui:default:conv1:1', 'hello'));
    expect(plugin.send).not.toHaveBeenCalled();

    // Advance only past the TUI flush interval (100ms), not the watchdog (120s)
    vi.advanceTimersByTime(200);
    expect(plugin.send).toHaveBeenCalledOnce();
    expect(plugin.send).toHaveBeenCalledWith({
      peer_id: 'peer1',
      conversation_id: 'conv1',
      text: 'hello',
      stream: 'chunk',
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('does not call plugin.send on stream_start itself', () => {
    const plugin = makePlugin();
    const registry = makeRegistry({ 'tui:default': plugin });
    const logger = makeLogger();
    const dispatcher = new Dispatcher(registry, logger);

    const target = makeTarget({ channel_id: 'tui:default' });
    dispatcher.handle(streamStart('tui:default:conv1:1', target));

    vi.runAllTimers();
    expect(plugin.send).not.toHaveBeenCalled();
  });
});

describe('Dispatcher — TUI stream_end flushes buffer and sends stream_end frame', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('flushes remaining tokens and sends stream_end frame on stream_end', () => {
    const plugin = makePlugin();
    const registry = makeRegistry({ 'tui:default': plugin });
    const logger = makeLogger();
    const dispatcher = new Dispatcher(registry, logger);

    const target = makeTarget({ channel_id: 'tui:default' });
    dispatcher.handle(streamStart('tui:default:conv1:1', target));
    dispatcher.handle(streamToken('tui:default:conv1:1', 'tok1'));
    dispatcher.handle(streamToken('tui:default:conv1:1', 'tok2'));

    // No flush yet (timer pending)
    expect(plugin.send).not.toHaveBeenCalled();

    dispatcher.handle(streamEnd('tui:default:conv1:1'));

    // stream_end should: flush buffered tokens as chunk, then send stream_end
    expect(plugin.send).toHaveBeenCalledTimes(2);
    expect(plugin.send).toHaveBeenNthCalledWith(1, {
      peer_id: 'peer1',
      conversation_id: 'conv1',
      text: 'tok1tok2',
      stream: 'chunk',
    });
    expect(plugin.send).toHaveBeenNthCalledWith(2, {
      peer_id: 'peer1',
      conversation_id: 'conv1',
      text: '',
      stream: 'end',
    });
  });

  it('sends only stream_end frame when buffer is empty at stream_end', () => {
    const plugin = makePlugin();
    const registry = makeRegistry({ 'tui:default': plugin });
    const logger = makeLogger();
    const dispatcher = new Dispatcher(registry, logger);

    const target = makeTarget({ channel_id: 'tui:default' });
    dispatcher.handle(streamStart('tui:default:conv1:1', target));

    // Advance past TUI flush interval only (not watchdog)
    vi.advanceTimersByTime(200);
    plugin.send.mockClear();

    dispatcher.handle(streamEnd('tui:default:conv1:1'));

    // Only stream_end frame, no chunk (buffer was empty)
    expect(plugin.send).toHaveBeenCalledOnce();
    expect(plugin.send).toHaveBeenCalledWith({
      peer_id: 'peer1',
      conversation_id: 'conv1',
      text: '',
      stream: 'end',
    });
  });

  it('cleans up stream state after stream_end', () => {
    const plugin = makePlugin();
    const registry = makeRegistry({ 'tui:default': plugin });
    const logger = makeLogger();
    const dispatcher = new Dispatcher(registry, logger);

    const target = makeTarget({ channel_id: 'tui:default' });
    dispatcher.handle(streamStart('tui:default:conv1:1', target));
    dispatcher.handle(streamEnd('tui:default:conv1:1'));

    // After stream is cleaned up, a stray stream_token should warn
    dispatcher.handle(streamToken('tui:default:conv1:1', 'orphan'));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('tui:default:conv1:1'));
  });
});

describe('Dispatcher — TUI token batching via timer', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('batches multiple tokens into one send call when timer fires', () => {
    const plugin = makePlugin();
    const registry = makeRegistry({ 'tui:default': plugin });
    const logger = makeLogger();
    const dispatcher = new Dispatcher(registry, logger);

    const target = makeTarget({ channel_id: 'tui:default', peer_id: 'p1', conversation_id: 'conv1' });
    dispatcher.handle(streamStart('tui:default:conv1:1', target));
    dispatcher.handle(streamToken('tui:default:conv1:1', 'a'));
    dispatcher.handle(streamToken('tui:default:conv1:1', 'b'));
    dispatcher.handle(streamToken('tui:default:conv1:1', 'c'));

    expect(plugin.send).not.toHaveBeenCalled();
    vi.runAllTimers();

    expect(plugin.send).toHaveBeenCalledOnce();
    expect(plugin.send).toHaveBeenCalledWith({
      peer_id: 'p1',
      conversation_id: 'conv1',
      text: 'abc',
      stream: 'chunk',
    });
  });

  it('cancels pending timer when stream_end arrives', () => {
    const plugin = makePlugin();
    const registry = makeRegistry({ 'tui:default': plugin });
    const logger = makeLogger();
    const dispatcher = new Dispatcher(registry, logger);

    const target = makeTarget({ channel_id: 'tui:default', peer_id: 'p1', conversation_id: 'conv1' });
    dispatcher.handle(streamStart('tui:default:conv1:1', target));
    dispatcher.handle(streamToken('tui:default:conv1:1', 'x'));

    // stream_end before timer fires — should flush immediately, not double-send
    dispatcher.handle(streamEnd('tui:default:conv1:1'));

    // Running timers now should not cause additional sends
    vi.runAllTimers();

    // Exactly 2 calls: chunk flush + stream_end
    expect(plugin.send).toHaveBeenCalledTimes(2);
  });
});

describe('Dispatcher — stream_error logs error (req 3.3)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('logs an error message containing the stream_id and error text', () => {
    const plugin = makePlugin();
    const registry = makeRegistry({ 'tui:default': plugin });
    const logger = makeLogger();
    const dispatcher = new Dispatcher(registry, logger);

    const target = makeTarget({ channel_id: 'tui:default' });
    dispatcher.handle(streamStart('tui:default:conv1:1', target));
    dispatcher.handle(streamError('tui:default:conv1:1', 'something went wrong'));

    expect(logger.error).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('tui:default:conv1:1'));
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('something went wrong'));
  });

  it('forwards error to client on stream_error', () => {
    const plugin = makePlugin();
    const registry = makeRegistry({ 'tui:default': plugin });
    const logger = makeLogger();
    const dispatcher = new Dispatcher(registry, logger);

    const target = makeTarget({ channel_id: 'tui:default' });
    dispatcher.handle(streamStart('tui:default:conv1:1', target));
    dispatcher.handle(streamError('tui:default:conv1:1', 'oops'));

    vi.runAllTimers();
    expect(plugin.send).toHaveBeenCalledOnce();
    expect(plugin.send).toHaveBeenCalledWith(expect.objectContaining({
      peer_id: 'peer1',
      conversation_id: 'conv1',
      text: 'Error: oops',
    }));
  });

  it('cleans up stream state after stream_error', () => {
    const plugin = makePlugin();
    const registry = makeRegistry({ 'tui:default': plugin });
    const logger = makeLogger();
    const dispatcher = new Dispatcher(registry, logger);

    const target = makeTarget({ channel_id: 'tui:default' });
    dispatcher.handle(streamStart('tui:default:conv1:1', target));
    dispatcher.handle(streamError('tui:default:conv1:1', 'err'));

    dispatcher.handle(streamToken('tui:default:conv1:1', 'late'));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('tui:default:conv1:1'));
  });
});

describe('Dispatcher — plugin not found: warn and no throw (req 3.6)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('logs warn and does not throw when plugin is missing for stream_token (after timer)', () => {
    const registry = makeRegistry({});
    const logger = makeLogger();
    const dispatcher = new Dispatcher(registry, logger);

    const target = makeTarget({ channel_id: 'tui:missing' });
    dispatcher.handle(streamStart('tui:missing:conv1:1', target));
    dispatcher.handle(streamToken('tui:missing:conv1:1', 'tok'));

    expect(() => vi.runAllTimers()).not.toThrow();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('tui:missing'));
  });

  it('logs warn and does not throw when plugin is missing for stream_end (non-TUI)', () => {
    const registry = makeRegistry({});
    const logger = makeLogger();
    const dispatcher = new Dispatcher(registry, logger);

    const target = makeTarget({ channel_id: 'telegram:main' });
    dispatcher.handle(streamStart('telegram:main:conv1:1', target));
    dispatcher.handle(streamToken('telegram:main:conv1:1', 'tok'));

    expect(() => dispatcher.handle(streamEnd('telegram:main:conv1:1'))).not.toThrow();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('telegram:main'));
  });

  it('logs warn for stream_token with unknown stream_id', () => {
    const registry = makeRegistry({});
    const logger = makeLogger();
    const dispatcher = new Dispatcher(registry, logger);

    expect(() => dispatcher.handle(streamToken('unknown:stream:id:1', 'tok'))).not.toThrow();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('unknown:stream:id:1'));
  });
});

describe('Dispatcher — non-TUI channel accumulates tokens and sends on stream_end', () => {
  it('does not call plugin.send during stream_token for non-TUI channel', () => {
    const plugin = makePlugin();
    const registry = makeRegistry({ 'telegram:main': plugin });
    const logger = makeLogger();
    const dispatcher = new Dispatcher(registry, logger);

    const target = makeTarget({ channel_id: 'telegram:main' });
    dispatcher.handle(streamStart('telegram:main:conv1:1', target));
    dispatcher.handle(streamToken('telegram:main:conv1:1', 'hello '));
    dispatcher.handle(streamToken('telegram:main:conv1:1', 'world'));

    expect(plugin.send).not.toHaveBeenCalled();
  });

  it('calls plugin.send once with full text on stream_end for non-TUI channel', () => {
    const plugin = makePlugin();
    const registry = makeRegistry({ 'telegram:main': plugin });
    const logger = makeLogger();
    const dispatcher = new Dispatcher(registry, logger);

    const target = makeTarget({ channel_id: 'telegram:main', peer_id: 'p1', conversation_id: 'conv1' });
    dispatcher.handle(streamStart('telegram:main:conv1:1', target));
    dispatcher.handle(streamToken('telegram:main:conv1:1', 'hello '));
    dispatcher.handle(streamToken('telegram:main:conv1:1', 'world'));
    dispatcher.handle(streamEnd('telegram:main:conv1:1'));

    expect(plugin.send).toHaveBeenCalledOnce();
    expect(plugin.send).toHaveBeenCalledWith({
      peer_id: 'p1',
      conversation_id: 'conv1',
      text: 'hello world',
    });
  });
});

describe('Dispatcher — streaming plugin receives tokens in real-time', () => {
  function makeStreamingPlugin() {
    return { ...makePlugin(), streaming: true };
  }

  it('forwards each stream_token as accumulated chunk immediately', () => {
    const plugin = makeStreamingPlugin();
    const registry = makeRegistry({ 'feishu:main': plugin });
    const logger = makeLogger();
    const dispatcher = new Dispatcher(registry, logger);

    const target = makeTarget({ channel_id: 'feishu:main', peer_id: 'p1', conversation_id: 'conv1' });
    dispatcher.handle(streamStart('feishu:main:conv1:1', target));
    dispatcher.handle(streamToken('feishu:main:conv1:1', 'Hello'));
    dispatcher.handle(streamToken('feishu:main:conv1:1', ', '));
    dispatcher.handle(streamToken('feishu:main:conv1:1', 'world'));

    // Each token triggers an immediate send with accumulated text
    expect(plugin.send).toHaveBeenCalledTimes(3);
    expect(plugin.send).toHaveBeenNthCalledWith(1, { peer_id: 'p1', conversation_id: 'conv1', text: 'Hello', stream: 'chunk' });
    expect(plugin.send).toHaveBeenNthCalledWith(2, { peer_id: 'p1', conversation_id: 'conv1', text: 'Hello, ', stream: 'chunk' });
    expect(plugin.send).toHaveBeenNthCalledWith(3, { peer_id: 'p1', conversation_id: 'conv1', text: 'Hello, world', stream: 'chunk' });
  });

  it('sends only stream_end (no extra chunk) on stream_end', () => {
    const plugin = makeStreamingPlugin();
    const registry = makeRegistry({ 'feishu:main': plugin });
    const logger = makeLogger();
    const dispatcher = new Dispatcher(registry, logger);

    const target = makeTarget({ channel_id: 'feishu:main', peer_id: 'p1', conversation_id: 'conv1' });
    dispatcher.handle(streamStart('feishu:main:conv1:1', target));
    dispatcher.handle(streamToken('feishu:main:conv1:1', 'hi'));
    plugin.send.mockClear();

    dispatcher.handle(streamEnd('feishu:main:conv1:1'));

    expect(plugin.send).toHaveBeenCalledOnce();
    expect(plugin.send).toHaveBeenCalledWith({ peer_id: 'p1', conversation_id: 'conv1', text: 'hi', stream: 'end' });
  });
});
