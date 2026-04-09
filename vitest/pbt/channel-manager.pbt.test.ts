import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { channelAdd, channelRemove } from '../../src/commands/channel-mgmt.js';
import type { Config } from '../../src/config.js';
import type { ChannelConfig } from '../../src/channels/types.js';

// ── Generators ─────────────────────────────────────────────────────

/** Non-empty alphanumeric ID for channel identifiers */
const genId = () =>
  fc.stringMatching(/^[a-z][a-z0-9_-]{0,19}$/).filter((s) => s.length > 0);

/** Channel type string */
const genType = () =>
  fc.constantFrom('tui', 'telegram', 'slack', 'webchat', 'discord');

/** Generate a ChannelConfig entry */
const genChannelConfig = (): fc.Arbitrary<ChannelConfig> =>
  fc.tuple(genId(), genType()).map(([id, type]) => ({ id, type }));

/** Generate a list of channels with unique ids */
const genUniqueChannels = () =>
  fc.array(genChannelConfig(), { minLength: 0, maxLength: 5 }).map((channels) => {
    const seen = new Set<string>();
    return channels.filter((ch) => {
      if (seen.has(ch.id)) return false;
      seen.add(ch.id);
      return true;
    });
  });

/** Generate a minimal valid Config with the given channels */
const genBaseConfig = (channels: ChannelConfig[]): Config => ({
  gateway: { host: '127.0.0.1', port: 29212 },
  channels,
  routing: [],
  agents: {},
});

/** Generate a config with a guaranteed channel that can be removed */
const genConfigWithRemovableChannel = () =>
  fc.tuple(genUniqueChannels(), genId(), genType()).map(([baseChannels, targetId, targetType]) => {
    // Filter out any channel that already has the target id
    const filtered = baseChannels.filter((ch) => ch.id !== targetId);
    const channels = [...filtered, { id: targetId, type: targetType }];
    const config = genBaseConfig(channels);
    return { config, targetId };
  });

// ── Property 16: Channel add creates new entry ─────────────────────
// **Validates: Requirements 4.1**

describe('Property 16: Channel add creates new entry', () => {
  it('adds a new channel with the specified id and type', () => {
    fc.assert(
      fc.property(
        genUniqueChannels(),
        genId(),
        genType(),
        (existingChannels, newId, newType) => {
          // Ensure the new id doesn't collide with existing channels
          fc.pre(!existingChannels.some((ch) => ch.id === newId));

          const config = genBaseConfig(existingChannels);
          const result = channelAdd(config, newId, newType);

          const added = result.channels.find((ch) => ch.id === newId);
          expect(added).toBeDefined();
          expect(added!.id).toBe(newId);
          expect(added!.type).toBe(newType);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('channel count increases by one', () => {
    fc.assert(
      fc.property(
        genUniqueChannels(),
        genId(),
        genType(),
        (existingChannels, newId, newType) => {
          fc.pre(!existingChannels.some((ch) => ch.id === newId));

          const config = genBaseConfig(existingChannels);
          const result = channelAdd(config, newId, newType);

          expect(result.channels.length).toBe(config.channels.length + 1);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('preserves all existing channels unchanged', () => {
    fc.assert(
      fc.property(
        genUniqueChannels(),
        genId(),
        genType(),
        (existingChannels, newId, newType) => {
          fc.pre(!existingChannels.some((ch) => ch.id === newId));

          const config = genBaseConfig(existingChannels);
          const result = channelAdd(config, newId, newType);

          for (const original of existingChannels) {
            const found = result.channels.find((ch) => ch.id === original.id);
            expect(found).toEqual(original);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('does not mutate the original config', () => {
    fc.assert(
      fc.property(
        genUniqueChannels(),
        genId(),
        genType(),
        (existingChannels, newId, newType) => {
          fc.pre(!existingChannels.some((ch) => ch.id === newId));

          const config = genBaseConfig(existingChannels);
          const originalChannels = [...config.channels];

          channelAdd(config, newId, newType);

          expect(config.channels).toEqual(originalChannels);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('throws when channel id already exists', () => {
    fc.assert(
      fc.property(
        genUniqueChannels().filter((chs) => chs.length > 0),
        genType(),
        (existingChannels, newType) => {
          const config = genBaseConfig(existingChannels);
          const duplicateId = existingChannels[0]!.id;

          expect(() => channelAdd(config, duplicateId, newType)).toThrow(/already exists/);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ── Property 17: Channel remove cleans up config ───────────────────
// **Validates: Requirements 4.4**

describe('Property 17: Channel remove cleans up config', () => {
  it('removed channel no longer exists in the config', () => {
    fc.assert(
      fc.property(genConfigWithRemovableChannel(), ({ config, targetId }) => {
        const result = channelRemove(config, targetId);

        expect(result.channels.find((ch) => ch.id === targetId)).toBeUndefined();
      }),
      { numRuns: 100 },
    );
  });

  it('channel count decreases by one after removal', () => {
    fc.assert(
      fc.property(genConfigWithRemovableChannel(), ({ config, targetId }) => {
        const originalCount = config.channels.length;
        const result = channelRemove(config, targetId);

        expect(result.channels.length).toBe(originalCount - 1);
      }),
      { numRuns: 100 },
    );
  });

  it('preserves all other channels unchanged', () => {
    fc.assert(
      fc.property(genConfigWithRemovableChannel(), ({ config, targetId }) => {
        const result = channelRemove(config, targetId);

        for (const ch of config.channels) {
          if (ch.id !== targetId) {
            expect(result.channels.find((c) => c.id === ch.id)).toEqual(ch);
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  it('removes routing rules referencing the channel', () => {
    fc.assert(
      fc.property(
        genConfigWithRemovableChannel(),
        genId(),
        genId(),
        ({ config, targetId }, peerId, agentId) => {
          // Add a routing rule referencing the target channel
          const configWithRoute: Config = {
            ...config,
            routing: [
              ...config.routing,
              { channel: targetId, peer: peerId, agent: agentId },
            ],
          };

          const result = channelRemove(configWithRoute, targetId);

          // No routing rules should reference the removed channel
          expect(result.routing.every((r) => r.channel !== targetId)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('does not mutate the original config', () => {
    fc.assert(
      fc.property(genConfigWithRemovableChannel(), ({ config, targetId }) => {
        const originalChannels = [...config.channels];
        const originalRouting = [...config.routing];

        channelRemove(config, targetId);

        expect(config.channels).toEqual(originalChannels);
        expect(config.routing).toEqual(originalRouting);
      }),
      { numRuns: 100 },
    );
  });

  it('throws when channel does not exist', () => {
    fc.assert(
      fc.property(
        genUniqueChannels(),
        genId(),
        (existingChannels, missingId) => {
          fc.pre(!existingChannels.some((ch) => ch.id === missingId));

          const config = genBaseConfig(existingChannels);

          expect(() => channelRemove(config, missingId)).toThrow(/not found/);
        },
      ),
      { numRuns: 100 },
    );
  });
});
