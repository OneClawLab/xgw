import { describe, it, expect, vi } from 'vitest';
import { ChannelRegistry } from '../../src/channels/registry.js';
import type { ChannelConfig, ChannelPlugin } from '../../src/channels/types.js';
import type { Message, SendParams, HealthResult, PairResult } from '../../src/types.js';

// ── Fake plugin factory ───────────────────────────────────────────────────────

function makePlugin(type: string, opts: { failStart?: boolean; failStop?: boolean; failHealth?: boolean } = {}): ChannelPlugin & {
  startCalls: number;
  stopCalls: number;
  sendCalls: SendParams[];
} {
  return {
    type,
    startCalls: 0,
    stopCalls: 0,
    sendCalls: [],
    async pair(_cfg: ChannelConfig): Promise<PairResult> {
      return { success: true, pair_mode: 'ws', pair_info: {} };
    },
    async start(_cfg: ChannelConfig, _onMsg: (m: Message) => Promise<void>): Promise<void> {
      this.startCalls++;
      if (opts.failStart) throw new Error('start failed');
    },
    async stop(): Promise<void> {
      this.stopCalls++;
      if (opts.failStop) throw new Error('stop failed');
    },
    async send(params: SendParams): Promise<void> {
      this.sendCalls.push(params);
    },
    async health(): Promise<HealthResult> {
      if (opts.failHealth) throw new Error('health failed');
      return { ok: true };
    },
  };
}

function makeConfig(id: string, type: string, paired = false): ChannelConfig {
  return { id, type, paired };
}

// ── register ──────────────────────────────────────────────────────────────────

describe('ChannelRegistry.register', () => {
  it('registers a valid plugin without error', () => {
    const reg = new ChannelRegistry();
    expect(() => reg.register('tui', makePlugin('tui'))).not.toThrow();
  });

  it('throws when plugin is missing required methods', () => {
    const reg = new ChannelRegistry();
    expect(() => reg.register('bad', {} as ChannelPlugin)).toThrow();
  });

  it('throws when plugin type field is missing', () => {
    const reg = new ChannelRegistry();
    const bad = { ...makePlugin('tui'), type: undefined } as unknown as ChannelPlugin;
    expect(() => reg.register('tui', bad)).toThrow();
  });

  it('overwrites existing registration for same type', () => {
    const reg = new ChannelRegistry();
    const p1 = makePlugin('tui');
    const p2 = makePlugin('tui');
    reg.register('tui', p1);
    reg.register('tui', p2);
    reg.loadPlugins([makeConfig('ch1', 'tui')]);
    expect(reg.getPlugin('ch1')).toBe(p2);
  });
});

// ── loadPlugins ───────────────────────────────────────────────────────────────

describe('ChannelRegistry.loadPlugins', () => {
  it('loads plugin for each channel config entry', () => {
    const reg = new ChannelRegistry();
    const plugin = makePlugin('tui');
    reg.register('tui', plugin);
    reg.loadPlugins([makeConfig('ch1', 'tui'), makeConfig('ch2', 'tui')]);
    expect(reg.getPlugin('ch1')).toBe(plugin);
    expect(reg.getPlugin('ch2')).toBe(plugin);
  });

  it('skips channels with unregistered type (logs error, no throw)', () => {
    const reg = new ChannelRegistry();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    reg.loadPlugins([makeConfig('ch1', 'unknown')]);
    expect(reg.getPlugin('ch1')).toBeUndefined();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('unknown'));
    errSpy.mockRestore();
  });

  it('returns undefined for channel not in loaded set', () => {
    const reg = new ChannelRegistry();
    expect(reg.getPlugin('nonexistent')).toBeUndefined();
  });
});

// ── startAll ──────────────────────────────────────────────────────────────────

describe('ChannelRegistry.startAll', () => {
  it('starts only paired channels', async () => {
    const reg = new ChannelRegistry();
    const plugin = makePlugin('tui');
    reg.register('tui', plugin);
    reg.loadPlugins([makeConfig('ch1', 'tui', true), makeConfig('ch2', 'tui', false)]);

    await reg.startAll(
      [makeConfig('ch1', 'tui', true), makeConfig('ch2', 'tui', false)],
      async () => {},
    );

    expect(plugin.startCalls).toBe(1);
  });

  it('continues when one channel fails to start', async () => {
    const reg = new ChannelRegistry();
    const bad = makePlugin('bad', { failStart: true });
    const good = makePlugin('good');
    reg.register('bad', bad);
    reg.register('good', good);
    reg.loadPlugins([makeConfig('ch1', 'bad', true), makeConfig('ch2', 'good', true)]);

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await reg.startAll(
      [makeConfig('ch1', 'bad', true), makeConfig('ch2', 'good', true)],
      async () => {},
    );
    errSpy.mockRestore();

    expect(good.startCalls).toBe(1);
  });

  it('skips channel with no loaded plugin', async () => {
    const reg = new ChannelRegistry();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await reg.startAll([makeConfig('ch1', 'tui', true)], async () => {});
    errSpy.mockRestore();
    // no throw
  });
});

// ── stopAll ───────────────────────────────────────────────────────────────────

describe('ChannelRegistry.stopAll', () => {
  it('stops all running plugins', async () => {
    const reg = new ChannelRegistry();
    const plugin = makePlugin('tui');
    reg.register('tui', plugin);
    reg.loadPlugins([makeConfig('ch1', 'tui', true)]);
    await reg.startAll([makeConfig('ch1', 'tui', true)], async () => {});

    await reg.stopAll();
    expect(plugin.stopCalls).toBe(1);
  });

  it('continues when stop throws, clears running set', async () => {
    const reg = new ChannelRegistry();
    const plugin = makePlugin('tui', { failStop: true });
    reg.register('tui', plugin);
    reg.loadPlugins([makeConfig('ch1', 'tui', true)]);
    await reg.startAll([makeConfig('ch1', 'tui', true)], async () => {});

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(reg.stopAll()).resolves.toBeUndefined();
    errSpy.mockRestore();
  });

  it('is idempotent — second stopAll does nothing', async () => {
    const reg = new ChannelRegistry();
    const plugin = makePlugin('tui');
    reg.register('tui', plugin);
    reg.loadPlugins([makeConfig('ch1', 'tui', true)]);
    await reg.startAll([makeConfig('ch1', 'tui', true)], async () => {});

    await reg.stopAll();
    await reg.stopAll();
    expect(plugin.stopCalls).toBe(1);
  });
});

// ── healthCheck ───────────────────────────────────────────────────────────────

describe('ChannelRegistry.healthCheck', () => {
  it('returns ok=true for running healthy channel', async () => {
    const reg = new ChannelRegistry();
    reg.register('tui', makePlugin('tui'));
    reg.loadPlugins([makeConfig('ch1', 'tui', true)]);
    await reg.startAll([makeConfig('ch1', 'tui', true)], async () => {});

    const result = await reg.healthCheck('ch1');
    expect(result['ch1']?.ok).toBe(true);
  });

  it('returns ok=false for non-running channel', async () => {
    const reg = new ChannelRegistry();
    const result = await reg.healthCheck('ch1');
    expect(result['ch1']?.ok).toBe(false);
    expect(result['ch1']?.detail).toBe('not running');
  });

  it('returns ok=false when health() throws', async () => {
    const reg = new ChannelRegistry();
    reg.register('tui', makePlugin('tui', { failHealth: true }));
    reg.loadPlugins([makeConfig('ch1', 'tui', true)]);
    await reg.startAll([makeConfig('ch1', 'tui', true)], async () => {});

    const result = await reg.healthCheck('ch1');
    expect(result['ch1']?.ok).toBe(false);
    expect(result['ch1']?.detail).toContain('health failed');
  });

  it('returns health for all running channels when no id given', async () => {
    const reg = new ChannelRegistry();
    reg.register('tui', makePlugin('tui'));
    reg.loadPlugins([makeConfig('ch1', 'tui', true), makeConfig('ch2', 'tui', true)]);
    await reg.startAll(
      [makeConfig('ch1', 'tui', true), makeConfig('ch2', 'tui', true)],
      async () => {},
    );

    const result = await reg.healthCheck();
    expect(Object.keys(result)).toHaveLength(2);
    expect(result['ch1']?.ok).toBe(true);
    expect(result['ch2']?.ok).toBe(true);
  });
});
