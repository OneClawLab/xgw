import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { loadConfig, validateConfig } from '../../src/config.js';
import { routeRemove } from '../../src/commands/route.js';
import { agentRemove } from '../../src/commands/agent-mgmt.js';
import { channelAdd, channelRemove } from '../../src/commands/channel-mgmt.js';
import type { Config } from '../../src/config.js';

// ── Helpers ────────────────────────────────────────────────────────

/**
 * The CLI wraps thrown errors with `Error: ` prefix via errorExit().
 * The final stderr output is: `Error: <description> - <remediation>`
 *
 * We verify that every error message from the domain layer matches
 * `<description> - <remediation>` so that when wrapped by errorExit
 * the full output matches `Error: <description> - <remediation>`.
 */
const ERROR_MSG_RE = /^.+ - .+$/;

function assertErrorFormat(msg: string): void {
  // The full CLI output would be `Error: ${msg}`
  const fullOutput = `Error: ${msg}`;
  expect(fullOutput).toMatch(/^Error: .+ - .+$/);
  // Also verify the message itself has description and remediation
  expect(msg).toMatch(ERROR_MSG_RE);
}

// ── Generators ─────────────────────────────────────────────────────

/** Simple ID-like string for channels, agents, peers */
const genId = () =>
  fc.stringMatching(/^[a-z][a-z0-9_-]{0,14}$/).filter((s) => s.length > 0);

/** Non-empty file path string */
const genPath = () =>
  fc.stringMatching(/^\/tmp\/[a-z][a-z0-9_/-]{0,30}\.yaml$/).filter((s) => s.length > 5);

/** Inbox path */
const genInbox = () =>
  fc.stringMatching(/^\/[a-z][a-z0-9_/-]{0,20}$/).filter((s) => s.length > 1);

/** Generate a valid Config with at least one channel, one agent, one route */
const genValidConfig = (): fc.Arbitrary<Config> =>
  fc.tuple(genId(), genId(), genId(), genInbox(), fc.nat({ max: 65535 })).map(
    ([channelId, agentId, peerId, inbox, port]) => ({
      gateway: { host: '127.0.0.1', port },
      channels: [{ id: channelId, type: 'tui' }],
      routing: [{ channel: channelId, peer: peerId, agent: agentId }],
      agents: { [agentId]: { inbox } },
    }),
  );


// ── Property 27: Error message format ──────────────────────────────
// **Validates: Requirements 13.4**

describe('Property 27: Error message format', () => {
  it('loadConfig error on missing file matches Error: <description> - <remediation>', () => {
    fc.assert(
      fc.property(genPath(), (path) => {
        try {
          loadConfig(path);
          // If it doesn't throw (unlikely for random paths), skip
        } catch (err) {
          expect(err).toBeInstanceOf(Error);
          assertErrorFormat((err as Error).message);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('validateConfig errors match Error: <description> - <remediation>', () => {
    // Generate configs with missing/invalid required fields
    const genBrokenConfig = () =>
      fc.oneof(
        // Missing gateway entirely
        fc.record({
          channels: fc.constant([]),
          routing: fc.constant([]),
          agents: fc.constant({}),
        }),
        // gateway with wrong types
        fc.record({
          gateway: fc.record({
            host: fc.constant(123),
            port: fc.constant('bad'),
          }),
          channels: fc.constant([]),
          routing: fc.constant([]),
          agents: fc.constant({}),
        }),
        // Missing channels
        fc.record({
          gateway: fc.record({ host: fc.constant('127.0.0.1'), port: fc.constant(8080) }),
          routing: fc.constant([]),
          agents: fc.constant({}),
        }),
        // Missing routing
        fc.record({
          gateway: fc.record({ host: fc.constant('127.0.0.1'), port: fc.constant(8080) }),
          channels: fc.constant([]),
          agents: fc.constant({}),
        }),
        // Missing agents
        fc.record({
          gateway: fc.record({ host: fc.constant('127.0.0.1'), port: fc.constant(8080) }),
          channels: fc.constant([]),
          routing: fc.constant([]),
        }),
        // Agent with empty inbox
        fc.record({
          gateway: fc.record({ host: fc.constant('127.0.0.1'), port: fc.constant(8080) }),
          channels: fc.constant([]),
          routing: fc.constant([]),
          agents: fc.constant({ myagent: { inbox: '' } }),
        }),
      );

    fc.assert(
      fc.property(genBrokenConfig(), (brokenConfig) => {
        const result = validateConfig(brokenConfig);
        // Must be invalid
        expect(result.valid).toBe(false);
        expect(result.errors.length).toBeGreaterThan(0);
        // Each error string must contain " - " separating description from remediation
        for (const errMsg of result.errors) {
          expect(errMsg).toMatch(ERROR_MSG_RE);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('routeRemove error on missing route matches Error: <description> - <remediation>', () => {
    fc.assert(
      fc.property(genValidConfig(), genId(), genId(), (config, channel, peer) => {
        // Ensure the (channel, peer) combo does NOT exist in routing
        const filtered = {
          ...config,
          routing: config.routing.filter(
            (r) => !(r.channel === channel && r.peer === peer),
          ),
        };
        // Only test if we actually have no matching route
        if (filtered.routing.some((r) => r.channel === channel && r.peer === peer)) return;

        try {
          routeRemove(filtered, channel, peer);
          // Should have thrown
          expect.unreachable('routeRemove should throw for missing route');
        } catch (err) {
          expect(err).toBeInstanceOf(Error);
          assertErrorFormat((err as Error).message);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('agentRemove error when referenced by routes matches Error: <description> - <remediation>', () => {
    fc.assert(
      fc.property(genValidConfig(), (config) => {
        // The generated config has one agent referenced by one route
        const agentId = Object.keys(config.agents)[0]!;
        try {
          agentRemove(config, agentId);
          // Should throw because routing references this agent
          expect.unreachable('agentRemove should throw for referenced agent');
        } catch (err) {
          expect(err).toBeInstanceOf(Error);
          assertErrorFormat((err as Error).message);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('channelAdd error on duplicate id matches Error: <description> - <remediation>', () => {
    fc.assert(
      fc.property(genValidConfig(), (config) => {
        // Try to add a channel with an id that already exists
        const existingId = config.channels[0]!.id;
        try {
          channelAdd(config, existingId, 'tui');
          expect.unreachable('channelAdd should throw for duplicate id');
        } catch (err) {
          expect(err).toBeInstanceOf(Error);
          assertErrorFormat((err as Error).message);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('channelRemove error on missing channel matches Error: <description> - <remediation>', () => {
    fc.assert(
      fc.property(genValidConfig(), genId(), (config, missingId) => {
        // Ensure the id doesn't exist
        if (config.channels.some((ch) => ch.id === missingId)) return;

        try {
          channelRemove(config, missingId);
          expect.unreachable('channelRemove should throw for missing channel');
        } catch (err) {
          expect(err).toBeInstanceOf(Error);
          assertErrorFormat((err as Error).message);
        }
      }),
      { numRuns: 100 },
    );
  });
});
