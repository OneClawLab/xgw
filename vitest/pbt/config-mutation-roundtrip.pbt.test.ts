import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveConfig, loadConfig } from '../../src/config.js';
import type { Config } from '../../src/config.js';
import { routeAdd, routeRemove } from '../../src/commands/route.js';
import { channelAdd, channelRemove } from '../../src/commands/channel-mgmt.js';

// ── Generators ─────────────────────────────────────────────────────

const genId = () =>
  fc.stringMatching(/^[a-z][a-z0-9_-]{0,19}$/).filter((s) => s.length > 0);

/** Channel id in <type>:<instance> format */
const genChannelId = () =>
  fc.tuple(fc.constantFrom('tui', 'telegram', 'slack', 'discord'), genId())
    .map(([type, instance]) => `${type}:${instance}`);

const genGateway = () =>
  fc.record({
    host: fc.constantFrom('127.0.0.1', '0.0.0.0', 'localhost'),
    port: fc.integer({ min: 1024, max: 65535 }),
  });

const genValidConfig = (): fc.Arbitrary<Config> =>
  fc
    .tuple(
      genGateway(),
      fc.array(genChannelId(), { minLength: 1, maxLength: 5 }).chain((channelIds) => {
        const uniqueChannelIds = [...new Set(channelIds)];
        const channels = uniqueChannelIds.map((id) => ({ id, type: id.split(':')[0]! }));
        return fc
          .array(genId(), { minLength: 1, maxLength: 3 })
          .chain((agentIdList) => {
            const uniqueAgentIds = [...new Set(agentIdList)];
            const routing = uniqueChannelIds.flatMap((chId) =>
              uniqueAgentIds.slice(0, 1).map((agentId) => ({
                channel: chId,
                peer: '*',
                agent: agentId,
              })),
            );
            return fc.constant({ channels, routing });
          });
      }),
    )
    .map(([gateway, { channels, routing }]) => ({
      gateway,
      channels,
      routing,
    }));

// ── Helpers ────────────────────────────────────────────────────────

function configsEqual(a: Config, b: Config): void {
  expect(b.gateway).toEqual(a.gateway);
  expect(b.channels).toEqual(a.channels);
  expect(b.routing).toEqual(a.routing);
}

let tmpDir: string;
let fileCounter = 0;

function tmpPath(): string {
  return join(tmpDir, `cfg-${++fileCounter}.yaml`);
}

function saveAndReload(path: string, config: Config): Config {
  saveConfig(path, config);
  return loadConfig(path);
}

// ── Property 3: Config mutation round-trip ─────────────────────────
// **Validates: Requirements 1.5, 14.3**

describe('Property 3: Config mutation round-trip', () => {
  beforeEach(() => {
    tmpDir = join(tmpdir(), `xgw-mut-rt-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
    fileCounter = 0;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('channelAdd then save/reload produces equivalent config', () => {
    fc.assert(
      fc.property(genValidConfig(), genChannelId(), (config, newId) => {
        // Skip if channel id already exists
        if (config.channels.some((ch) => ch.id === newId)) return;

        const mutated = channelAdd(config, newId, 'telegram');
        const reloaded = saveAndReload(tmpPath(), mutated);
        configsEqual(mutated, reloaded);
      }),
      { numRuns: 5 },
    );
  });

  it('channelRemove then save/reload produces equivalent config', () => {
    fc.assert(
      fc.property(genValidConfig(), (config) => {
        // Need at least one channel to remove
        if (config.channels.length === 0) return;

        const targetId = config.channels[0]!.id;
        const mutated = channelRemove(config, targetId);
        const reloaded = saveAndReload(tmpPath(), mutated);
        configsEqual(mutated, reloaded);
      }),
      { numRuns: 5 },
    );
  });

  it('routeAdd then save/reload produces equivalent config', () => {
    fc.assert(
      fc.property(genValidConfig(), genId(), genId(), (config, peerId, agentId) => {
        // Use an existing channel for a valid route
        if (config.channels.length === 0) return;

        const channelId = config.channels[0]!.id;
        const mutated = routeAdd(config, channelId, peerId, agentId);
        const reloaded = saveAndReload(tmpPath(), mutated);
        configsEqual(mutated, reloaded);
      }),
      { numRuns: 5 },
    );
  });

  it('routeRemove then save/reload produces equivalent config', () => {
    fc.assert(
      fc.property(genValidConfig(), (config) => {
        // Need at least one route to remove
        if (config.routing.length === 0) return;

        const target = config.routing[0]!;
        const mutated = routeRemove(config, target.channel, target.peer);
        const reloaded = saveAndReload(tmpPath(), mutated);
        configsEqual(mutated, reloaded);
      }),
      { numRuns: 5 },
    );
  });

  it('multiple mutations then save/reload produces equivalent config', () => {
    fc.assert(
      fc.property(
        genValidConfig(),
        genChannelId(),
        genId(),
        genId(),
        (config, newChannelId, agentId, peerId) => {
          // Skip if channel already exists
          if (config.channels.some((ch) => ch.id === newChannelId)) return;

          // Chain: add channel → add route
          let mutated = channelAdd(config, newChannelId, 'slack');
          mutated = routeAdd(mutated, newChannelId, peerId, agentId);

          const reloaded = saveAndReload(tmpPath(), mutated);
          configsEqual(mutated, reloaded);
        },
      ),
      { numRuns: 5 },
    );
  });
});
