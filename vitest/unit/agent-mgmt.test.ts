import { describe, it, expect } from 'vitest';
import { agentAdd, agentRemove, agentList } from '../../src/commands/agent-mgmt.js';
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

// ── agentAdd ──────────────────────────────────────────────────────────────────

describe('agentAdd', () => {
  it('adds a new agent to empty agents map', () => {
    const cfg = makeConfig();
    const result = agentAdd(cfg, 'bot', '/home/user/.theclaw/agents/bot/inbox');
    expect(result.agents['bot']).toEqual({ inbox: '/home/user/.theclaw/agents/bot/inbox' });
  });

  it('does not mutate original config', () => {
    const cfg = makeConfig();
    agentAdd(cfg, 'bot', '/inbox');
    expect(cfg.agents['bot']).toBeUndefined();
  });

  it('adds multiple agents independently', () => {
    const cfg = makeConfig();
    const r1 = agentAdd(cfg, 'alpha', '/alpha/inbox');
    const r2 = agentAdd(r1, 'beta', '/beta/inbox');
    expect(Object.keys(r2.agents)).toHaveLength(2);
    expect(r2.agents['alpha']).toEqual({ inbox: '/alpha/inbox' });
    expect(r2.agents['beta']).toEqual({ inbox: '/beta/inbox' });
  });

  it('updates inbox path when agent already exists', () => {
    const cfg = makeConfig({ agents: { bot: { inbox: '/old/inbox' } } });
    const result = agentAdd(cfg, 'bot', '/new/inbox');
    expect(result.agents['bot']).toEqual({ inbox: '/new/inbox' });
    expect(Object.keys(result.agents)).toHaveLength(1);
  });

  it('preserves existing agents when adding new one', () => {
    const cfg = makeConfig({ agents: { existing: { inbox: '/existing/inbox' } } });
    const result = agentAdd(cfg, 'new', '/new/inbox');
    expect(result.agents['existing']).toEqual({ inbox: '/existing/inbox' });
    expect(result.agents['new']).toEqual({ inbox: '/new/inbox' });
  });

  it('preserves other config fields', () => {
    const cfg = makeConfig({
      channels: [{ id: 'ch1', type: 'tui' }],
      routing: [{ channel: 'ch1', peer: '*', agent: 'other' }],
    });
    const result = agentAdd(cfg, 'bot', '/inbox');
    expect(result.channels).toEqual(cfg.channels);
    expect(result.routing).toEqual(cfg.routing);
    expect(result.gateway).toEqual(cfg.gateway);
  });
});

// ── agentRemove ───────────────────────────────────────────────────────────────

describe('agentRemove', () => {
  it('removes an existing agent', () => {
    const cfg = makeConfig({ agents: { bot: { inbox: '/inbox' } } });
    const result = agentRemove(cfg, 'bot');
    expect(result.agents['bot']).toBeUndefined();
    expect(Object.keys(result.agents)).toHaveLength(0);
  });

  it('does not mutate original config', () => {
    const cfg = makeConfig({ agents: { bot: { inbox: '/inbox' } } });
    agentRemove(cfg, 'bot');
    expect(cfg.agents['bot']).toBeDefined();
  });

  it('throws when agent is referenced by routing rules', () => {
    const cfg = makeConfig({
      agents: { bot: { inbox: '/inbox' } },
      routing: [{ channel: 'ch1', peer: 'user1', agent: 'bot' }],
    });
    expect(() => agentRemove(cfg, 'bot')).toThrow(/bot/);
    expect(() => agentRemove(cfg, 'bot')).toThrow(/routing/i);
  });

  it('error message includes channel and peer of conflicting routes', () => {
    const cfg = makeConfig({
      agents: { bot: { inbox: '/inbox' } },
      routing: [
        { channel: 'telegram', peer: 'user42', agent: 'bot' },
        { channel: 'slack', peer: '*', agent: 'bot' },
      ],
    });
    expect(() => agentRemove(cfg, 'bot')).toThrow(/telegram/);
    expect(() => agentRemove(cfg, 'bot')).toThrow(/slack/);
  });

  it('allows removal when routing references a different agent', () => {
    const cfg = makeConfig({
      agents: { bot: { inbox: '/inbox' }, other: { inbox: '/other' } },
      routing: [{ channel: 'ch1', peer: '*', agent: 'other' }],
    });
    const result = agentRemove(cfg, 'bot');
    expect(result.agents['bot']).toBeUndefined();
    expect(result.agents['other']).toBeDefined();
  });

  it('preserves other agents when removing one', () => {
    const cfg = makeConfig({
      agents: {
        alpha: { inbox: '/alpha' },
        beta: { inbox: '/beta' },
      },
    });
    const result = agentRemove(cfg, 'alpha');
    expect(result.agents['alpha']).toBeUndefined();
    expect(result.agents['beta']).toEqual({ inbox: '/beta' });
  });
});

// ── agentList ─────────────────────────────────────────────────────────────────

describe('agentList', () => {
  it('returns empty array when no agents', () => {
    const cfg = makeConfig();
    expect(agentList(cfg)).toEqual([]);
  });

  it('returns all agents as id+inbox pairs', () => {
    const cfg = makeConfig({
      agents: {
        alpha: { inbox: '/alpha/inbox' },
        beta: { inbox: '/beta/inbox' },
      },
    });
    const result = agentList(cfg);
    expect(result).toHaveLength(2);
    expect(result).toContainEqual({ id: 'alpha', inbox: '/alpha/inbox' });
    expect(result).toContainEqual({ id: 'beta', inbox: '/beta/inbox' });
  });

  it('does not mutate config', () => {
    const cfg = makeConfig({ agents: { bot: { inbox: '/inbox' } } });
    const result = agentList(cfg);
    result.push({ id: 'injected', inbox: '/x' });
    expect(Object.keys(cfg.agents)).toHaveLength(1);
  });
});
