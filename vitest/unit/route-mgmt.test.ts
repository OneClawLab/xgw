import { describe, it, expect } from 'vitest';
import { routeAdd, routeRemove, routeList } from '../../src/commands/route.js';
import type { Config } from '../../src/config.js';

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    gateway: { host: 'localhost', port: 8080 },
    channels: [],
    routing: [],
    agents: {},
    ...overrides,
  };
}

// ── routeAdd ──────────────────────────────────────────────────────────────────

describe('routeAdd', () => {
  it('appends a new rule to empty routing list', () => {
    const cfg = makeConfig();
    const result = routeAdd(cfg, 'tg', 'user1', 'bot');
    expect(result.routing).toHaveLength(1);
    expect(result.routing[0]).toEqual({ channel: 'tg', peer: 'user1', agent: 'bot' });
  });

  it('does not mutate original config', () => {
    const cfg = makeConfig();
    routeAdd(cfg, 'tg', 'user1', 'bot');
    expect(cfg.routing).toHaveLength(0);
  });

  it('inserts before wildcard rule', () => {
    const cfg = makeConfig({
      routing: [{ channel: 'tg', peer: '*', agent: 'fallback' }],
    });
    const result = routeAdd(cfg, 'tg', 'user1', 'bot');
    expect(result.routing).toHaveLength(2);
    expect(result.routing[0]).toEqual({ channel: 'tg', peer: 'user1', agent: 'bot' });
    expect(result.routing[1]).toEqual({ channel: 'tg', peer: '*', agent: 'fallback' });
  });

  it('appends after non-wildcard rules when no wildcard exists', () => {
    const cfg = makeConfig({
      routing: [{ channel: 'tg', peer: 'user1', agent: 'bot' }],
    });
    const result = routeAdd(cfg, 'tg', 'user2', 'bot');
    expect(result.routing[1]).toEqual({ channel: 'tg', peer: 'user2', agent: 'bot' });
  });

  it('updates agent when rule with same (channel, peer) already exists', () => {
    const cfg = makeConfig({
      routing: [{ channel: 'tg', peer: 'user1', agent: 'old-bot' }],
    });
    const result = routeAdd(cfg, 'tg', 'user1', 'new-bot');
    expect(result.routing).toHaveLength(1);
    expect(result.routing[0]).toEqual({ channel: 'tg', peer: 'user1', agent: 'new-bot' });
  });

  it('inserts before first wildcard when multiple wildcards exist', () => {
    const cfg = makeConfig({
      routing: [
        { channel: 'tg', peer: '*', agent: 'fallback1' },
        { channel: 'slack', peer: '*', agent: 'fallback2' },
      ],
    });
    const result = routeAdd(cfg, 'tg', 'user1', 'bot');
    expect(result.routing[0]).toEqual({ channel: 'tg', peer: 'user1', agent: 'bot' });
    expect(result.routing[1]).toEqual({ channel: 'tg', peer: '*', agent: 'fallback1' });
  });

  it('can add wildcard rule itself', () => {
    const cfg = makeConfig();
    const result = routeAdd(cfg, 'tg', '*', 'fallback');
    expect(result.routing[0]).toEqual({ channel: 'tg', peer: '*', agent: 'fallback' });
  });
});

// ── routeRemove ───────────────────────────────────────────────────────────────

describe('routeRemove', () => {
  it('removes a matching rule', () => {
    const cfg = makeConfig({
      routing: [{ channel: 'tg', peer: 'user1', agent: 'bot' }],
    });
    const result = routeRemove(cfg, 'tg', 'user1');
    expect(result.routing).toHaveLength(0);
  });

  it('does not mutate original config', () => {
    const cfg = makeConfig({
      routing: [{ channel: 'tg', peer: 'user1', agent: 'bot' }],
    });
    routeRemove(cfg, 'tg', 'user1');
    expect(cfg.routing).toHaveLength(1);
  });

  it('throws when no matching rule found', () => {
    const cfg = makeConfig();
    expect(() => routeRemove(cfg, 'tg', 'user1')).toThrow(/tg/);
    expect(() => routeRemove(cfg, 'tg', 'user1')).toThrow(/user1/);
  });

  it('only removes the exact (channel, peer) match', () => {
    const cfg = makeConfig({
      routing: [
        { channel: 'tg', peer: 'user1', agent: 'bot' },
        { channel: 'tg', peer: 'user2', agent: 'bot' },
        { channel: 'tg', peer: '*', agent: 'fallback' },
      ],
    });
    const result = routeRemove(cfg, 'tg', 'user1');
    expect(result.routing).toHaveLength(2);
    expect(result.routing.find(r => r.peer === 'user1')).toBeUndefined();
  });

  it('throws when channel matches but peer does not', () => {
    const cfg = makeConfig({
      routing: [{ channel: 'tg', peer: 'user1', agent: 'bot' }],
    });
    expect(() => routeRemove(cfg, 'tg', 'user99')).toThrow();
  });
});

// ── routeList ─────────────────────────────────────────────────────────────────

describe('routeList', () => {
  it('returns empty array when no routing rules', () => {
    expect(routeList(makeConfig())).toEqual([]);
  });

  it('returns rules sorted: exact peers first, wildcards last', () => {
    const cfg = makeConfig({
      routing: [
        { channel: 'tg', peer: '*', agent: 'fallback' },
        { channel: 'tg', peer: 'user1', agent: 'bot' },
        { channel: 'slack', peer: '*', agent: 'fallback2' },
        { channel: 'slack', peer: 'user2', agent: 'bot2' },
      ],
    });
    const result = routeList(cfg);
    const wildcardIdx = result.findIndex(r => r.peer === '*');
    const exactIdx = result.findIndex(r => r.peer !== '*');
    expect(exactIdx).toBeLessThan(wildcardIdx);
  });

  it('does not mutate original routing array', () => {
    const cfg = makeConfig({
      routing: [
        { channel: 'tg', peer: '*', agent: 'fallback' },
        { channel: 'tg', peer: 'user1', agent: 'bot' },
      ],
    });
    routeList(cfg);
    expect(cfg.routing[0]?.peer).toBe('*');
  });

  it('preserves all rules in output', () => {
    const cfg = makeConfig({
      routing: [
        { channel: 'tg', peer: 'user1', agent: 'bot' },
        { channel: 'tg', peer: '*', agent: 'fallback' },
      ],
    });
    expect(routeList(cfg)).toHaveLength(2);
  });
});
