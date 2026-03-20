import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { agentAdd, agentRemove } from '../../src/commands/agent-mgmt.js';
import type { Config } from '../../src/config.js';

// ── Generators ─────────────────────────────────────────────────────

/** Non-empty alphanumeric ID for agent identifiers */
const genId = () =>
  fc.stringMatching(/^[a-z][a-z0-9_-]{0,19}$/).filter((s) => s.length > 0);

/** Non-empty inbox path */
const genInboxPath = () =>
  fc.stringMatching(/^\/[a-z][a-z0-9/_-]{0,39}$/).filter((s) => s.length > 0);

/** Generate a minimal valid Config with the given agents map */
const genBaseConfig = (agents: Record<string, { inbox: string }>): Config => ({
  gateway: { host: '127.0.0.1', port: 18790 },
  channels: [],
  routing: [],
  agents,
});

/** Generate a random agents record with 0–5 entries */
const genAgentsRecord = () =>
  fc.array(fc.tuple(genId(), genInboxPath()), { minLength: 0, maxLength: 5 })
    .map((pairs) => {
      const agents: Record<string, { inbox: string }> = {};
      for (const [id, inbox] of pairs) {
        agents[id] = { inbox };
      }
      return agents;
    });

/**
 * Generate a config containing at least one agent that is NOT referenced
 * by any routing rule, so it can be safely removed.
 */
const genConfigWithRemovableAgent = () =>
  fc.tuple(genAgentsRecord(), genId(), genInboxPath()).map(([baseAgents, targetId, targetInbox]) => {
    // Ensure the target agent exists in the map
    const agents = { ...baseAgents, [targetId]: { inbox: targetInbox } };
    // Config has no routing rules referencing any agent (empty routing)
    const config = genBaseConfig(agents);
    return { config, targetId };
  });

// ── Property 14: Agent add/update registers inbox correctly ────────
// **Validates: Requirements 8.1, 8.2**

describe('Property 14: Agent add/update registers inbox correctly', () => {
  it('new agent is registered with the specified inbox path', () => {
    fc.assert(
      fc.property(
        genAgentsRecord(),
        genId(),
        genInboxPath(),
        (existingAgents, newId, newInbox) => {
          const config = genBaseConfig(existingAgents);
          const result = agentAdd(config, newId, newInbox);

          // The agent exists in the result with the correct inbox
          expect(result.agents[newId]).toEqual({ inbox: newInbox });
        },
      ),
      { numRuns: 100 },
    );
  });

  it('existing agent inbox is updated to the new path', () => {
    fc.assert(
      fc.property(
        genAgentsRecord(),
        genId(),
        genInboxPath(),
        genInboxPath(),
        (existingAgents, agentId, oldInbox, newInbox) => {
          // Seed the agent with the old inbox
          const agents = { ...existingAgents, [agentId]: { inbox: oldInbox } };
          const config = genBaseConfig(agents);

          const result = agentAdd(config, agentId, newInbox);

          // Inbox is updated
          expect(result.agents[agentId]).toEqual({ inbox: newInbox });
        },
      ),
      { numRuns: 100 },
    );
  });

  it('does not mutate the original config', () => {
    fc.assert(
      fc.property(
        genAgentsRecord(),
        genId(),
        genInboxPath(),
        (existingAgents, newId, newInbox) => {
          const config = genBaseConfig(existingAgents);
          const originalAgents = { ...config.agents };

          agentAdd(config, newId, newInbox);

          // Original config is unchanged
          expect(config.agents).toEqual(originalAgents);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('preserves all other agents unchanged', () => {
    fc.assert(
      fc.property(
        genAgentsRecord(),
        genId(),
        genInboxPath(),
        (existingAgents, newId, newInbox) => {
          const config = genBaseConfig(existingAgents);
          const result = agentAdd(config, newId, newInbox);

          // Every pre-existing agent (other than the target) is preserved
          for (const [id, entry] of Object.entries(existingAgents)) {
            if (id !== newId) {
              expect(result.agents[id]).toEqual(entry);
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ── Property 15: Agent remove deletes registration ─────────────────
// **Validates: Requirements 8.3**

describe('Property 15: Agent remove deletes registration', () => {
  it('removed agent no longer exists in the config', () => {
    fc.assert(
      fc.property(genConfigWithRemovableAgent(), ({ config, targetId }) => {
        const result = agentRemove(config, targetId);

        expect(result.agents[targetId]).toBeUndefined();
      }),
      { numRuns: 100 },
    );
  });

  it('agent count decreases by one after removal', () => {
    fc.assert(
      fc.property(genConfigWithRemovableAgent(), ({ config, targetId }) => {
        const originalCount = Object.keys(config.agents).length;
        const result = agentRemove(config, targetId);

        expect(Object.keys(result.agents).length).toBe(originalCount - 1);
      }),
      { numRuns: 100 },
    );
  });

  it('preserves all other agents unchanged', () => {
    fc.assert(
      fc.property(genConfigWithRemovableAgent(), ({ config, targetId }) => {
        const result = agentRemove(config, targetId);

        for (const [id, entry] of Object.entries(config.agents)) {
          if (id !== targetId) {
            expect(result.agents[id]).toEqual(entry);
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  it('does not mutate the original config', () => {
    fc.assert(
      fc.property(genConfigWithRemovableAgent(), ({ config, targetId }) => {
        const originalAgents = { ...config.agents };

        agentRemove(config, targetId);

        expect(config.agents).toEqual(originalAgents);
      }),
      { numRuns: 100 },
    );
  });

  it('throws when agent is referenced by routing rules', () => {
    fc.assert(
      fc.property(
        genId(),
        genInboxPath(),
        genId(),
        genId(),
        (agentId, inbox, channel, peer) => {
          const config: Config = {
            gateway: { host: '127.0.0.1', port: 18790 },
            channels: [],
            routing: [{ channel, peer, agent: agentId }],
            agents: { [agentId]: { inbox } },
          };

          expect(() => agentRemove(config, agentId)).toThrow(/referenced by routing rules/);
        },
      ),
      { numRuns: 100 },
    );
  });
});
