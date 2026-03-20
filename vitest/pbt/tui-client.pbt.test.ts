import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  formatAgentMessage,
  computeBackoffMs,
  formatConnectionStatus,
  MAX_RECONNECT_ATTEMPTS,
} from '../../clients/tui/src/helpers.js';

// ── Generators ─────────────────────────────────────────────────────

/** Arbitrary non-empty message text */
const genText = () =>
  fc.string({ minLength: 1, maxLength: 500 }).filter((s) => s.trim().length > 0);

/** Alphanumeric identifier suitable for channel/peer ids */
const genId = () =>
  fc.stringMatching(/^[a-zA-Z0-9_-]{1,20}$/).filter((s) => s.length >= 1);

/** Reconnection attempt number: 1, 2, or 3 */
const genAttempt = () => fc.integer({ min: 1, max: 3 });

// ── Property 23: XGW-TUI agent message formatting ─────────────────
// **Validates: Requirements 11.3**

describe('Property 23: XGW-TUI agent message formatting', () => {
  it('formats any message text with "agent> " prefix', () => {
    fc.assert(
      fc.property(genText(), (text) => {
        const result = formatAgentMessage(text);
        expect(result).toBe(`agent> ${text}`);
        // The result always starts with the prefix
        expect(result.startsWith('agent> ')).toBe(true);
        // The original text is preserved after the prefix
        expect(result.slice('agent> '.length)).toBe(text);
      }),
      { numRuns: 100 },
    );
  });
});

// ── Property 24: XGW-TUI reconnection backoff ─────────────────────
// **Validates: Requirements 11.5**

describe('Property 24: XGW-TUI reconnection backoff', () => {
  it('computes backoff as 2^(n-1) seconds for attempts 1..3', () => {
    fc.assert(
      fc.property(genAttempt(), (attempt) => {
        const delayMs = computeBackoffMs(attempt);
        const expectedMs = Math.pow(2, attempt - 1) * 1000;
        expect(delayMs).toBe(expectedMs);
      }),
      { numRuns: 100 },
    );
  });

  it('produces exactly 1s, 2s, 4s for attempts 1, 2, 3', () => {
    expect(computeBackoffMs(1)).toBe(1000);
    expect(computeBackoffMs(2)).toBe(2000);
    expect(computeBackoffMs(3)).toBe(4000);
  });

  it('no more than 3 reconnect attempts are allowed', () => {
    expect(MAX_RECONNECT_ATTEMPTS).toBe(3);
    // Verify the backoff values for all valid attempts are within bounds.
    fc.assert(
      fc.property(genAttempt(), (attempt) => {
        expect(attempt).toBeGreaterThanOrEqual(1);
        expect(attempt).toBeLessThanOrEqual(MAX_RECONNECT_ATTEMPTS);
        const delayMs = computeBackoffMs(attempt);
        // Delay should be between 1s and 4s inclusive
        expect(delayMs).toBeGreaterThanOrEqual(1000);
        expect(delayMs).toBeLessThanOrEqual(4000);
      }),
      { numRuns: 100 },
    );
  });
});

// ── Property 28: XGW-TUI connection status format ─────────────────
// **Validates: Requirements 11.7**

describe('Property 28: XGW-TUI connection status format', () => {
  it('formats connection status as [<channel>/<peer>] Connected.', () => {
    fc.assert(
      fc.property(genId(), genId(), (channel, peer) => {
        const result = formatConnectionStatus(channel, peer);
        expect(result).toBe(`[${channel}/${peer}] Connected.`);
        // Verify structural properties
        expect(result.startsWith('[')).toBe(true);
        expect(result.endsWith('] Connected.')).toBe(true);
        expect(result).toContain('/');
      }),
      { numRuns: 100 },
    );
  });
});
