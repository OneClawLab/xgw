import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { agentList } from '../../src/commands/agent-mgmt.js';
import type { Config } from '../../src/config.js';

// ── Generators ─────────────────────────────────────────────────────

/** Non-empty alphanumeric ID for agent identifiers */
const genId = () =>
  fc.stringMatching(/^[a-z][a-z0-9_-]{0,19}$/).filter((s) => s.length > 0);

/** Channel id in <type>:<instance> format */
const genChannelId = () =>
  fc.tuple(
    fc.constantFrom('tui', 'telegram', 'slack', 'discord'),
    genId(),
  ).map(([type, instance]) => `${type}:${instance}`);

/** Generate a routing rule */
const genRoutingRule = () =>
  fc.tuple(genChannelId(), genId(), genId()).map(([channel, peer, agent]) => ({
    channel,
    peer,
    agent,
  }));

/** Generate a minimal valid Config with the given routing rules */
const genConfig = (routing: Array<{ channel: string; peer: string; agent: string }>): Config => ({
  gateway: { host: '127.0.0.1', port: 29212 },
  channels: [],
  routing,
});

// ── Property 14: agentList extracts agents from routing rules ──────
// **Validates: Requirements 8.1**

describe('Property 14: agentList extracts agents from routing rules', () => {
  it('every agent referenced in routing appears in the result', () => {
    fc.assert(
      fc.property(
        fc.array(genRoutingRule(), { minLength: 0, maxLength: 10 }),
        (routing) => {
          const config = genConfig(routing);
          const result = agentList(config);

          const expectedAgentIds = new Set(routing.map((r) => r.agent));
          const resultIds = new Set(result.map((a) => a.id));
          expect(resultIds).toEqual(expectedAgentIds);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('each agent lists exactly the unique channels it is associated with', () => {
    fc.assert(
      fc.property(
        fc.array(genRoutingRule(), { minLength: 1, maxLength: 10 }),
        (routing) => {
          const config = genConfig(routing);
          const result = agentList(config);

          for (const entry of result) {
            const expectedChannels = new Set(
              routing.filter((r) => r.agent === entry.id).map((r) => r.channel),
            );
            expect(new Set(entry.channels)).toEqual(expectedChannels);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('returns empty array when routing is empty', () => {
    fc.assert(
      fc.property(
        fc.constant([]),
        (routing) => {
          const config = genConfig(routing);
          expect(agentList(config)).toEqual([]);
        },
      ),
      { numRuns: 1 },
    );
  });

  it('does not mutate the original config', () => {
    fc.assert(
      fc.property(
        fc.array(genRoutingRule(), { minLength: 1, maxLength: 10 }),
        (routing) => {
          const config = genConfig(routing);
          const originalRouting = [...config.routing];

          agentList(config);

          expect(config.routing).toEqual(originalRouting);
        },
      ),
      { numRuns: 100 },
    );
  });
});
