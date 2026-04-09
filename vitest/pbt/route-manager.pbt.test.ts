import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { routeAdd, routeRemove, routeList } from '../../src/commands/route.js';
import type { Config, RoutingRule } from '../../src/config.js';

// ── Generators ─────────────────────────────────────────────────────

/** Non-empty alphanumeric ID for channel/peer/agent identifiers */
const genId = () =>
  fc.stringMatching(/^[a-z][a-z0-9_-]{0,19}$/).filter((s) => s.length > 0);

/** Generate a minimal valid Config shell (only routing matters for route manager) */
const genBaseConfig = (routing: RoutingRule[]): Config => ({
  gateway: { host: '127.0.0.1', port: 29212 },
  channels: [],
  routing,
  agents: {},
});

/** Generate an exact routing rule (peer is NOT "*") */
const genExactRule = () =>
  fc.tuple(genId(), genId(), genId()).map(([channel, peer, agent]): RoutingRule => ({
    channel, peer, agent,
  }));

/** Generate a wildcard routing rule (peer === "*") */
const genWildcardRule = () =>
  fc.tuple(genId(), genId()).map(([channel, agent]): RoutingRule => ({
    channel, peer: '*', agent,
  }));

/**
 * Generate a routing table with exact rules followed by wildcard rules.
 * Ensures at least one wildcard rule exists.
 */
const genTableWithWildcards = () =>
  fc.tuple(
    fc.array(genExactRule(), { minLength: 0, maxLength: 5 }),
    fc.array(genWildcardRule(), { minLength: 1, maxLength: 3 }),
  ).map(([exact, wildcards]) => [...exact, ...wildcards]);

/**
 * Generate a routing table with a known existing (channel, peer) rule
 * so we can test duplicate update behavior.
 */
const genTableWithDuplicate = () =>
  fc.tuple(
    fc.array(genExactRule(), { minLength: 0, maxLength: 4 }),
    genId(), genId(), genId(), genId(), // channel, peer, oldAgent, newAgent
    fc.array(genExactRule(), { minLength: 0, maxLength: 4 }),
  ).map(([before, channel, peer, oldAgent, newAgent, after]) => ({
    rules: [...before, { channel, peer, agent: oldAgent }, ...after],
    channel,
    peer,
    oldAgent,
    newAgent,
  }));

/**
 * Generate a routing table containing a known rule for routeRemove testing.
 */
const genTableWithKnownRule = () =>
  fc.tuple(
    fc.array(genExactRule(), { minLength: 0, maxLength: 4 }),
    genExactRule(),
    fc.array(genExactRule(), { minLength: 0, maxLength: 4 }),
  ).map(([before, target, after]) => ({
    rules: [...before, target, ...after],
    channel: target.channel,
    peer: target.peer,
  }));

/**
 * Generate a mixed routing table for routeList sorting tests.
 */
const genMixedTable = () =>
  fc.tuple(
    fc.array(genExactRule(), { minLength: 0, maxLength: 5 }),
    fc.array(genWildcardRule(), { minLength: 0, maxLength: 5 }),
  ).chain(([exact, wildcards]) =>
    // Shuffle them together so the input order is random
    fc.shuffledSubarray([...exact, ...wildcards], {
      minLength: exact.length + wildcards.length,
      maxLength: exact.length + wildcards.length,
    }),
  );

// ── Property 10: Route add inserts before wildcards ────────────────
// **Validates: Requirements 7.1**

describe('Property 10: Route add inserts before wildcards', () => {
  it('new exact rule is placed before all wildcard rules', () => {
    fc.assert(
      fc.property(
        genTableWithWildcards(),
        genId(),
        genId(),
        genId(),
        (existingRules, newChannel, newPeer, newAgent) => {
          // Ensure the new rule doesn't duplicate an existing (channel, peer)
          fc.pre(!existingRules.some(r => r.channel === newChannel && r.peer === newPeer));

          const config = genBaseConfig(existingRules);
          const result = routeAdd(config, newChannel, newPeer, newAgent);

          // Find the index of the newly added rule
          const newIdx = result.routing.findIndex(
            r => r.channel === newChannel && r.peer === newPeer && r.agent === newAgent,
          );
          expect(newIdx).toBeGreaterThanOrEqual(0);

          // All wildcard rules must come after the new rule
          for (let i = 0; i < result.routing.length; i++) {
            if (result.routing[i]!.peer === '*') {
              expect(i).toBeGreaterThan(newIdx);
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('total rule count increases by one when adding a new rule', () => {
    fc.assert(
      fc.property(
        genTableWithWildcards(),
        genId(),
        genId(),
        genId(),
        (existingRules, newChannel, newPeer, newAgent) => {
          fc.pre(!existingRules.some(r => r.channel === newChannel && r.peer === newPeer));

          const config = genBaseConfig(existingRules);
          const result = routeAdd(config, newChannel, newPeer, newAgent);
          expect(result.routing.length).toBe(existingRules.length + 1);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ── Property 11: Route add updates existing duplicate ──────────────
// **Validates: Requirements 7.2**

describe('Property 11: Route add updates existing duplicate', () => {
  it('updates agent of existing (channel, peer) rule without creating a duplicate', () => {
    fc.assert(
      fc.property(genTableWithDuplicate(), ({ rules, channel, peer, newAgent }) => {
        const config = genBaseConfig(rules);
        const originalCount = rules.length;

        const result = routeAdd(config, channel, peer, newAgent);

        // Rule count stays the same
        expect(result.routing.length).toBe(originalCount);

        // Exactly one rule matches (channel, peer)
        const matches = result.routing.filter(r => r.channel === channel && r.peer === peer);
        expect(matches.length).toBe(1);

        // The agent is updated to the new value
        expect(matches[0]!.agent).toBe(newAgent);
      }),
      { numRuns: 100 },
    );
  });
});

// ── Property 12: Route remove deletes the matching rule ────────────
// **Validates: Requirements 7.3**

describe('Property 12: Route remove deletes the matching rule', () => {
  it('removes the matching (channel, peer) rule and decreases count by one', () => {
    fc.assert(
      fc.property(genTableWithKnownRule(), ({ rules, channel, peer }) => {
        const config = genBaseConfig(rules);
        const originalCount = rules.length;

        const result = routeRemove(config, channel, peer);

        // Count decreased by one
        expect(result.routing.length).toBe(originalCount - 1);

        // No rule with that (channel, peer) remains
        const remaining = result.routing.filter(r => r.channel === channel && r.peer === peer);
        expect(remaining.length).toBe(0);
      }),
      { numRuns: 100 },
    );
  });

  it('does not mutate the original config', () => {
    fc.assert(
      fc.property(genTableWithKnownRule(), ({ rules, channel, peer }) => {
        const config = genBaseConfig(rules);
        const originalRouting = [...config.routing];

        routeRemove(config, channel, peer);

        // Original config is unchanged
        expect(config.routing).toEqual(originalRouting);
      }),
      { numRuns: 100 },
    );
  });
});

// ── Property 13: Route list is sorted by match priority ────────────
// **Validates: Requirements 7.5**

describe('Property 13: Route list is sorted by match priority', () => {
  it('all exact-peer rules appear before wildcard-peer rules', () => {
    fc.assert(
      fc.property(genMixedTable(), (rules) => {
        const config = genBaseConfig(rules);
        const sorted = routeList(config);

        // Find the index of the first wildcard rule
        const firstWildcardIdx = sorted.findIndex(r => r.peer === '*');

        if (firstWildcardIdx === -1) {
          // No wildcards — all rules are exact, which is trivially sorted
          return;
        }

        // Every rule before the first wildcard must be exact
        for (let i = 0; i < firstWildcardIdx; i++) {
          expect(sorted[i]!.peer).not.toBe('*');
        }

        // Every rule from the first wildcard onward must be a wildcard
        for (let i = firstWildcardIdx; i < sorted.length; i++) {
          expect(sorted[i]!.peer).toBe('*');
        }
      }),
      { numRuns: 100 },
    );
  });

  it('preserves all rules (no rules lost or added)', () => {
    fc.assert(
      fc.property(genMixedTable(), (rules) => {
        const config = genBaseConfig(rules);
        const sorted = routeList(config);

        expect(sorted.length).toBe(rules.length);

        // Every original rule appears in the sorted output
        for (const rule of rules) {
          expect(sorted).toContainEqual(rule);
        }
      }),
      { numRuns: 100 },
    );
  });
});
