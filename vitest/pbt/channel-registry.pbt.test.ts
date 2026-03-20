import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { ChannelRegistry } from '../../src/channels/registry.js';
import type { ChannelConfig, ChannelPlugin } from '../../src/channels/types.js';
import type { Message, SendParams, HealthResult, PairResult } from '../../src/types.js';

// ── Fake ChannelPlugin ─────────────────────────────────────────────
// A lightweight real implementation of ChannelPlugin that tracks
// start/stop calls. NOT a mock — it implements the full interface.

function createFakePlugin(typeName: string): ChannelPlugin & {
  started: boolean;
  stopped: boolean;
  startCallCount: number;
  stopCallCount: number;
} {
  return {
    type: typeName,
    started: false,
    stopped: false,
    startCallCount: 0,
    stopCallCount: 0,

    async pair(_config: ChannelConfig): Promise<PairResult> {
      return { success: true, pair_mode: 'ws', pair_info: {} };
    },
    async start(_config: ChannelConfig, _onMessage: (msg: Message) => Promise<void>): Promise<void> {
      this.started = true;
      this.startCallCount++;
    },
    async stop(): Promise<void> {
      this.stopped = true;
      this.stopCallCount++;
    },
    async send(_params: SendParams): Promise<void> {},
    async health(): Promise<HealthResult> {
      return { ok: true };
    },
  };
}

// ── Generators ─────────────────────────────────────────────────────

const genId = () =>
  fc.stringMatching(/^[a-z][a-z0-9_-]{0,19}$/).filter((s) => s.length > 0);

const genType = () =>
  fc.constantFrom('tui', 'telegram', 'slack', 'webchat', 'discord');

/** Generate a ChannelConfig with explicit paired status */
const genChannelConfigWithPaired = (): fc.Arbitrary<ChannelConfig> =>
  fc.tuple(genId(), genType(), fc.boolean()).map(([id, type, paired]) => ({
    id,
    type,
    paired,
  }));

/** Generate a list of channel configs with unique ids and mixed paired status */
const genUniqueChannelConfigs = () =>
  fc
    .array(genChannelConfigWithPaired(), { minLength: 1, maxLength: 10 })
    .map((channels) => {
      const seen = new Set<string>();
      return channels.filter((ch) => {
        if (seen.has(ch.id)) return false;
        seen.add(ch.id);
        return true;
      });
    })
    .filter((chs) => chs.length > 0);

// ── Helpers ────────────────────────────────────────────────────────

/** Set up a registry with fake plugins registered, loaded, and return the plugin map */
function setupRegistry(channels: ChannelConfig[]): {
  registry: ChannelRegistry;
  plugins: Map<string, ReturnType<typeof createFakePlugin>>;
} {
  const registry = new ChannelRegistry();
  const plugins = new Map<string, ReturnType<typeof createFakePlugin>>();

  // Register a fake plugin for each unique type
  const types = new Set(channels.map((ch) => ch.type));
  for (const t of types) {
    const plugin = createFakePlugin(t);
    registry.register(t, plugin);
  }

  // loadPlugins assigns the registered prototype to each channel id.
  // But since all channels of the same type share the same plugin instance,
  // we need per-channel plugins for tracking. We'll use startAll directly
  // and track via a different approach.
  //
  // Actually, looking at the registry code: loadPlugins maps ch.id → the
  // same prototype plugin. For property testing, we need per-channel tracking.
  // So we'll create one plugin per channel and register each channel's type
  // uniquely by using the channel id as the type.

  // Reset and use per-channel approach
  const registry2 = new ChannelRegistry();
  for (const ch of channels) {
    const plugin = createFakePlugin(ch.type);
    plugins.set(ch.id, plugin);
    // Register with a unique key per channel so each gets its own plugin
    registry2.register(`__fake_${ch.id}`, plugin);
  }

  // Remap channel types so loadPlugins picks up the per-channel plugins
  const remappedChannels = channels.map((ch) => ({
    ...ch,
    type: `__fake_${ch.id}`,
  }));
  registry2.loadPlugins(remappedChannels);

  return { registry: registry2, plugins };
}

const noopOnMessage = async (_msg: Message): Promise<void> => {};

// ── Property 6: Channel registry starts only paired channels ───────
// **Validates: Requirements 3.3**

describe('Property 6: Channel registry starts only paired channels', () => {
  it('start() is called only on channels where paired is true', async () => {
    await fc.assert(
      fc.asyncProperty(genUniqueChannelConfigs(), async (channels) => {
        const { registry, plugins } = setupRegistry(channels);
        const remappedChannels = channels.map((ch) => ({
          ...ch,
          type: `__fake_${ch.id}`,
        }));

        await registry.startAll(remappedChannels, noopOnMessage);

        for (const ch of channels) {
          const plugin = plugins.get(ch.id)!;
          if (ch.paired) {
            expect(plugin.started).toBe(true);
          } else {
            expect(plugin.started).toBe(false);
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  it('count of started channels equals count of paired channels', async () => {
    await fc.assert(
      fc.asyncProperty(genUniqueChannelConfigs(), async (channels) => {
        const { registry, plugins } = setupRegistry(channels);
        const remappedChannels = channels.map((ch) => ({
          ...ch,
          type: `__fake_${ch.id}`,
        }));

        await registry.startAll(remappedChannels, noopOnMessage);

        const pairedCount = channels.filter((ch) => ch.paired).length;
        const startedCount = [...plugins.values()].filter((p) => p.started).length;

        expect(startedCount).toBe(pairedCount);
      }),
      { numRuns: 100 },
    );
  });

  it('unpaired channels are never started regardless of config mix', async () => {
    await fc.assert(
      fc.asyncProperty(genUniqueChannelConfigs(), async (channels) => {
        const { registry, plugins } = setupRegistry(channels);
        const remappedChannels = channels.map((ch) => ({
          ...ch,
          type: `__fake_${ch.id}`,
        }));

        await registry.startAll(remappedChannels, noopOnMessage);

        const unpairedChannels = channels.filter((ch) => !ch.paired);
        for (const ch of unpairedChannels) {
          const plugin = plugins.get(ch.id)!;
          expect(plugin.startCallCount).toBe(0);
        }
      }),
      { numRuns: 100 },
    );
  });
});

// ── Property 7: Channel registry stops all running plugins ─────────
// **Validates: Requirements 3.4**

describe('Property 7: Channel registry stops all running plugins', () => {
  it('stop() is called on every plugin that was previously started', async () => {
    await fc.assert(
      fc.asyncProperty(genUniqueChannelConfigs(), async (channels) => {
        const { registry, plugins } = setupRegistry(channels);
        const remappedChannels = channels.map((ch) => ({
          ...ch,
          type: `__fake_${ch.id}`,
        }));

        // Start paired channels first
        await registry.startAll(remappedChannels, noopOnMessage);

        // Now stop all
        await registry.stopAll();

        // Every plugin that was started should now be stopped
        for (const ch of channels) {
          const plugin = plugins.get(ch.id)!;
          if (ch.paired) {
            expect(plugin.stopped).toBe(true);
            expect(plugin.stopCallCount).toBe(1);
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  it('leaves zero running plugins after stopAll', async () => {
    await fc.assert(
      fc.asyncProperty(genUniqueChannelConfigs(), async (channels) => {
        const { registry, plugins } = setupRegistry(channels);
        const remappedChannels = channels.map((ch) => ({
          ...ch,
          type: `__fake_${ch.id}`,
        }));

        await registry.startAll(remappedChannels, noopOnMessage);
        await registry.stopAll();

        // healthCheck with no args returns results for running plugins only.
        // After stopAll, running map is cleared, so healthCheck returns empty.
        const health = await registry.healthCheck();
        expect(Object.keys(health).length).toBe(0);
      }),
      { numRuns: 100 },
    );
  });

  it('plugins that were not started are not stopped', async () => {
    await fc.assert(
      fc.asyncProperty(genUniqueChannelConfigs(), async (channels) => {
        const { registry, plugins } = setupRegistry(channels);
        const remappedChannels = channels.map((ch) => ({
          ...ch,
          type: `__fake_${ch.id}`,
        }));

        await registry.startAll(remappedChannels, noopOnMessage);
        await registry.stopAll();

        const unpairedChannels = channels.filter((ch) => !ch.paired);
        for (const ch of unpairedChannels) {
          const plugin = plugins.get(ch.id)!;
          expect(plugin.stopped).toBe(false);
          expect(plugin.stopCallCount).toBe(0);
        }
      }),
      { numRuns: 100 },
    );
  });
});
