import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { Router } from '../../src/gateway/router.js';
import type { RoutingRule } from '../../src/config.js';

// ── Generators ─────────────────────────────────────────────────────

/** Non-empty alphanumeric ID suitable for channel/peer/agent identifiers */
const genId = () =>
  fc.stringMatching(/^[a-z][a-z0-9_-]{0,19}$/).filter((s) => s.length > 0);

/** Generate a distinct pair of agent IDs (for exact vs wildcard differentiation) */
const genDistinctAgentPair = () =>
  fc.tuple(genId(), genId()).filter(([a, b]) => a !== b);

/**
 * Generate a routing table that contains BOTH an exact (channel, peer) rule
 * AND a wildcard (channel, *) rule for the same channel, with different agents.
 * Also includes optional noise rules for other channels.
 */
const genTableWithExactAndWildcard = () =>
  fc.tuple(
    genId(),                    // target channel
    genId(),                    // target peer
    genDistinctAgentPair(),     // [exactAgent, wildcardAgent]
    fc.array(                   // noise: rules for other channels
      fc.tuple(genId(), genId(), genId()).map(([ch, peer, agent]) => ({
        channel: ch,
        peer,
        agent,
      })),
      { minLength: 0, maxLength: 5 },
    ),
  ).map(([channel, peer, [exactAgent, wildcardAgent], noise]) => {
    const exactRule: RoutingRule = { channel, peer, agent: exactAgent };
    const wildcardRule: RoutingRule = { channel, peer: '*', agent: wildcardAgent };
    // Shuffle exact and wildcard positions among noise to test order-independence
    const allRules = [...noise, wildcardRule, exactRule];
    return { channel, peer, exactAgent, wildcardAgent, rules: allRules };
  });

/**
 * Generate a routing table and a (channel, peer) pair that does NOT match
 * any rule — neither exact nor wildcard.
 */
const genTableWithUnmatchedMessage = () =>
  fc.tuple(
    fc.array(
      fc.tuple(genId(), genId(), genId()).map(([ch, peer, agent]) => ({
        channel: ch,
        peer,
        agent,
      })),
      { minLength: 0, maxLength: 10 },
    ),
    genId(), // query channel
    genId(), // query peer
  ).filter(([rules, qChannel, qPeer]) => {
    // Ensure no rule matches: no exact match AND no wildcard match for this channel
    const hasExact = rules.some((r) => r.channel === qChannel && r.peer === qPeer);
    const hasWildcard = rules.some((r) => r.channel === qChannel && r.peer === '*');
    return !hasExact && !hasWildcard;
  });

// ── Property 8: Router resolves to most specific match ─────────────
// **Validates: Requirements 5.1, 5.2, 5.5**

describe('Property 8: Router resolves to most specific match', () => {
  it('exact (channel, peer) rule wins over wildcard (channel, *) rule', () => {
    fc.assert(
      fc.property(genTableWithExactAndWildcard(), ({ channel, peer, exactAgent, rules }) => {
        const router = new Router(rules);
        const result = router.resolve(channel, peer);
        expect(result).toBe(exactAgent);
      }),
      { numRuns: 100 },
    );
  });

  it('exact match wins regardless of rule insertion order', () => {
    fc.assert(
      fc.property(
        genId(),
        genId(),
        genDistinctAgentPair(),
        fc.boolean(),
        (channel, peer, [exactAgent, wildcardAgent], wildcardFirst) => {
          const exactRule: RoutingRule = { channel, peer, agent: exactAgent };
          const wildcardRule: RoutingRule = { channel, peer: '*', agent: wildcardAgent };
          const rules = wildcardFirst
            ? [wildcardRule, exactRule]
            : [exactRule, wildcardRule];

          const router = new Router(rules);
          expect(router.resolve(channel, peer)).toBe(exactAgent);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('wildcard rule is used when only wildcard matches', () => {
    fc.assert(
      fc.property(
        genId(),
        genId(),
        genId(),
        genId(),
        (channel, exactPeer, queryPeer, wildcardAgent) => {
          // Ensure queryPeer differs from exactPeer so only wildcard matches
          fc.pre(queryPeer !== exactPeer);

          const rules: RoutingRule[] = [
            { channel, peer: exactPeer, agent: 'other-agent' },
            { channel, peer: '*', agent: wildcardAgent },
          ];
          const router = new Router(rules);
          expect(router.resolve(channel, queryPeer)).toBe(wildcardAgent);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ── Property 9: Router returns null for unmatched messages ─────────
// **Validates: Requirements 5.4**

describe('Property 9: Router returns null for unmatched messages', () => {
  it('returns null when no rule matches (channel, peer)', () => {
    fc.assert(
      fc.property(genTableWithUnmatchedMessage(), ([rules, qChannel, qPeer]) => {
        const router = new Router(rules);
        const result = router.resolve(qChannel, qPeer);
        expect(result).toBeNull();
      }),
      { numRuns: 100 },
    );
  });

  it('returns null for empty routing table', () => {
    fc.assert(
      fc.property(genId(), genId(), (channel, peer) => {
        const router = new Router([]);
        expect(router.resolve(channel, peer)).toBeNull();
      }),
      { numRuns: 100 },
    );
  });

  it('returns null after reload clears matching rules', () => {
    fc.assert(
      fc.property(genId(), genId(), genId(), (channel, peer, agent) => {
        const router = new Router([{ channel, peer, agent }]);
        // Verify it resolves before reload
        expect(router.resolve(channel, peer)).toBe(agent);

        // Reload with empty table
        router.reload([]);
        expect(router.resolve(channel, peer)).toBeNull();
      }),
      { numRuns: 100 },
    );
  });
});
