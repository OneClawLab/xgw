import { describe, it, expect } from 'vitest';
import { agentList } from '../../src/commands/agent-mgmt.js';
import type { Config } from '../../src/config.js';

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    gateway: { host: 'localhost', port: 8080 },
    channels: [],
    routing: [],
    ...overrides,
  };
}

// ── agentList ─────────────────────────────────────────────────────────────────

describe('agentList', () => {
  it('returns empty array when no routing rules', () => {
    const cfg = makeConfig();
    expect(agentList(cfg)).toEqual([]);
  });

  it('returns agents with their associated channels from routing rules', () => {
    const cfg = makeConfig({
      routing: [
        { channel: 'tui:default', peer: '*', agent: 'alpha' },
        { channel: 'telegram:main', peer: '*', agent: 'alpha' },
        { channel: 'slack:work', peer: '*', agent: 'beta' },
      ],
    });
    const result = agentList(cfg);
    expect(result).toHaveLength(2);
    const alpha = result.find((a) => a.id === 'alpha');
    const beta = result.find((a) => a.id === 'beta');
    expect(alpha).toBeDefined();
    expect(alpha!.channels).toContain('tui:default');
    expect(alpha!.channels).toContain('telegram:main');
    expect(alpha!.channels).toHaveLength(2);
    expect(beta).toBeDefined();
    expect(beta!.channels).toEqual(['slack:work']);
  });

  it('deduplicates channels for the same agent', () => {
    const cfg = makeConfig({
      routing: [
        { channel: 'tui:default', peer: 'user1', agent: 'bot' },
        { channel: 'tui:default', peer: 'user2', agent: 'bot' },
      ],
    });
    const result = agentList(cfg);
    expect(result).toHaveLength(1);
    expect(result[0]!.channels).toEqual(['tui:default']);
  });

  it('does not mutate config', () => {
    const cfg = makeConfig({
      routing: [{ channel: 'tui:default', peer: '*', agent: 'bot' }],
    });
    const result = agentList(cfg);
    result.push({ id: 'injected', channels: [] });
    expect(cfg.routing).toHaveLength(1);
  });
});
