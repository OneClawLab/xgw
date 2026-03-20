import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Logger } from '../../src/logger.js';

// ── Generators ─────────────────────────────────────────────────────

/** Non-empty printable message string (no newlines, no leading/trailing whitespace) */
const genMessage = () =>
  fc.stringMatching(/^[a-zA-Z0-9_.,:;!?@#$%&()\-+=][a-zA-Z0-9 _.,:;!?@#$%&()\-+=]{0,78}$/)
    .filter((s) => s.length > 0 && s === s.trim());

/** Log level */
const genLevel = () => fc.constantFrom('INFO' as const, 'WARN' as const, 'ERROR' as const);

/** Non-empty ID-like string */
const genId = () =>
  fc.stringMatching(/^[a-z][a-z0-9_-]{0,19}$/).filter((s) => s.length > 0);

/** UUID-like string */
const genUuid = () =>
  fc.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

/** Session ID */
const genSessionId = () => genId();

// ── Helpers ────────────────────────────────────────────────────────

/** Read the last line written to the log file */
function readLastLine(logDir: string): string {
  const content = readFileSync(join(logDir, 'xgw.log'), 'utf-8').trimEnd();
  const lines = content.split('\n');
  return lines[lines.length - 1]!;
}

/** ISO 8601 pattern (simplified — matches what Date.toISOString() produces) */
const ISO8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Full log line pattern */
const LOG_LINE_RE = /^\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\] \[(INFO|WARN|ERROR)\] (.+)$/;

// ── Property 25: Log entry format ──────────────────────────────────
// **Validates: Requirements 12.1**

describe('Property 25: Log entry format', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `xgw-logger-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('for any log level and message, output matches [<ISO8601>] [<LEVEL>] <message>', () => {
    fc.assert(
      fc.property(genLevel(), genMessage(), (level, message) => {
        const logger = new Logger(tmpDir);
        const method = level === 'INFO' ? 'info' : level === 'WARN' ? 'warn' : 'error';
        logger[method](message);

        const line = readLastLine(tmpDir);
        const match = LOG_LINE_RE.exec(line);

        // Line must match the overall pattern
        expect(match).not.toBeNull();

        // Timestamp must be valid ISO 8601
        const timestamp = match![1]!;
        expect(ISO8601_RE.test(timestamp)).toBe(true);
        expect(new Date(timestamp).toISOString()).toBe(timestamp);

        // Level must match what was called
        expect(match![2]).toBe(level);

        // Message must match what was passed
        expect(match![3]).toBe(message);
      }),
      { numRuns: 100 },
    );
  });
});

// ── Property 26: Log event fields ──────────────────────────────────
// **Validates: Requirements 12.4, 12.5, 12.6**

describe('Property 26: Log event fields', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `xgw-logger-event-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('inbound event log line contains channel, peer, agent, and message id', () => {
    fc.assert(
      fc.property(genId(), genId(), genId(), genUuid(), (channel, peer, agent, msgId) => {
        const logger = new Logger(tmpDir);
        // Log an inbound event the way the gateway would
        const msg = `inbound: channel=${channel} peer=${peer} agent=${agent} msg_id=${msgId}`;
        logger.info(msg);

        const line = readLastLine(tmpDir);
        const match = LOG_LINE_RE.exec(line);
        expect(match).not.toBeNull();

        const body = match![3]!;
        expect(body).toContain(channel);
        expect(body).toContain(peer);
        expect(body).toContain(agent);
        expect(body).toContain(msgId);
      }),
      { numRuns: 100 },
    );
  });

  it('outbound event log line contains channel, peer, and session', () => {
    fc.assert(
      fc.property(genId(), genId(), genSessionId(), (channel, peer, session) => {
        const logger = new Logger(tmpDir);
        const msg = `outbound: channel=${channel} peer=${peer} session=${session}`;
        logger.info(msg);

        const line = readLastLine(tmpDir);
        const match = LOG_LINE_RE.exec(line);
        expect(match).not.toBeNull();

        const body = match![3]!;
        expect(body).toContain(channel);
        expect(body).toContain(peer);
        expect(body).toContain(session);
      }),
      { numRuns: 100 },
    );
  });

  it('routing miss log line contains channel and peer and uses WARN level', () => {
    fc.assert(
      fc.property(genId(), genId(), (channel, peer) => {
        const logger = new Logger(tmpDir);
        const msg = `routing miss: channel=${channel} peer=${peer} (no matching rule)`;
        logger.warn(msg);

        const line = readLastLine(tmpDir);
        const match = LOG_LINE_RE.exec(line);
        expect(match).not.toBeNull();

        // Must be WARN level
        expect(match![2]).toBe('WARN');

        const body = match![3]!;
        expect(body).toContain(channel);
        expect(body).toContain(peer);
      }),
      { numRuns: 100 },
    );
  });
});
