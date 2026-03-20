import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { SendHandler } from '../../src/gateway/send.js';
import { ChannelRegistry } from '../../src/channels/registry.js';
import type { ChannelConfig, ChannelPlugin } from '../../src/channels/types.js';
import type { Message, SendParams, HealthResult, PairResult } from '../../src/types.js';

// ── Fake ChannelPlugin ─────────────────────────────────────────────
// A lightweight real implementation of ChannelPlugin that records
// send() calls. NOT a mock — it implements the full interface.

function createFakePlugin(
  typeName: string,
): ChannelPlugin & {
  sendCalls: SendParams[];
} {
  return {
    type: typeName,
    sendCalls: [],

    async pair(_config: ChannelConfig): Promise<PairResult> {
      return { success: true, pair_mode: 'ws', pair_info: {} };
    },
    async start(
      _config: ChannelConfig,
      _onMessage: (msg: Message) => Promise<void>,
    ): Promise<void> {},
    async stop(): Promise<void> {},
    async send(params: SendParams): Promise<void> {
      this.sendCalls.push(params);
    },
    async health(): Promise<HealthResult> {
      return { ok: true };
    },
  };
}

// ── Generators ─────────────────────────────────────────────────────

const genId = () =>
  fc.stringMatching(/^[a-z][a-z0-9_-]{0,19}$/).filter((s) => s.length > 0);

const genSendParams = (): fc.Arbitrary<SendParams> =>
  fc
    .record({
      peer_id: genId(),
      session_id: genId(),
      text: fc.string({ minLength: 1, maxLength: 200 }),
      reply_to: fc.option(genId(), { nil: undefined }),
    })
    .map((r) => {
      const p: SendParams = {
        peer_id: r.peer_id,
        session_id: r.session_id,
        text: r.text,
      };
      if (r.reply_to !== undefined) p.reply_to = r.reply_to;
      return p;
    });

/** Generate 1–5 unique channel ids */
const genUniqueChannelIds = () =>
  fc
    .array(genId(), { minLength: 1, maxLength: 5 })
    .map((ids) => [...new Set(ids)])
    .filter((ids) => ids.length > 0);

// ── Helpers ────────────────────────────────────────────────────────

/** Set up a registry with one fake plugin per channel id, all loaded. */
function setupRegistry(channelIds: string[]): {
  registry: ChannelRegistry;
  plugins: Map<string, ReturnType<typeof createFakePlugin>>;
} {
  const registry = new ChannelRegistry();
  const plugins = new Map<string, ReturnType<typeof createFakePlugin>>();

  for (const id of channelIds) {
    const plugin = createFakePlugin(`__fake_${id}`);
    plugins.set(id, plugin);
    registry.register(`__fake_${id}`, plugin);
  }

  const channels: ChannelConfig[] = channelIds.map((id) => ({
    id,
    type: `__fake_${id}`,
  }));
  registry.loadPlugins(channels);

  return { registry, plugins };
}

// ── Property 22: Send handler dispatches to correct plugin ─────────
// **Validates: Requirements 6.1**

describe('Property 22: Send handler dispatches to correct plugin', () => {
  const handler = new SendHandler();

  it('invokes send() on the plugin registered for the target channel id', async () => {
    await fc.assert(
      fc.asyncProperty(
        genUniqueChannelIds(),
        genSendParams(),
        async (channelIds, params) => {
          const { registry, plugins } = setupRegistry(channelIds);

          // Pick a random channel to send to (use first — fast-check already randomizes the list)
          const targetId = channelIds[0];

          const result = await handler.send(targetId, params, registry);

          // The correct plugin was called
          const targetPlugin = plugins.get(targetId)!;
          expect(result.success).toBe(true);
          expect(result.channel_id).toBe(targetId);
          expect(result.peer_id).toBe(params.peer_id);
          expect(targetPlugin.sendCalls).toHaveLength(1);
          expect(targetPlugin.sendCalls[0]).toEqual(params);

          // No other plugin was called
          for (const [id, plugin] of plugins) {
            if (id !== targetId) {
              expect(plugin.sendCalls).toHaveLength(0);
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('returns failure when channel id is not in the registry', async () => {
    await fc.assert(
      fc.asyncProperty(
        genUniqueChannelIds(),
        genId(),
        genSendParams(),
        async (channelIds, extraId, params) => {
          // Ensure extraId is not in the registered set
          fc.pre(!channelIds.includes(extraId));

          const { registry, plugins } = setupRegistry(channelIds);

          const result = await handler.send(extraId, params, registry);

          expect(result.success).toBe(false);
          expect(result.channel_id).toBe(extraId);
          expect(result.error).toBeDefined();

          // No plugin was called
          for (const plugin of plugins.values()) {
            expect(plugin.sendCalls).toHaveLength(0);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
