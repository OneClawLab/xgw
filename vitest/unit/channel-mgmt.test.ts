import { describe, it, expect } from 'vitest';
import {
  channelAdd,
  channelRemove,
  channelList,
} from '../../src/commands/channel-mgmt.js';
import type { Config } from '../../src/config.js';

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    gateway: { host: 'localhost', port: 8080 },
    channels: [],
    routing: [],
    ...overrides,
  };
}

// ── channelAdd ────────────────────────────────────────────────────────────────

describe('channelAdd', () => {
  it('adds a new channel to empty list', () => {
    const cfg = makeConfig();
    const result = channelAdd(cfg, 'tg', 'telegram');
    expect(result.channels).toHaveLength(1);
    expect(result.channels[0]).toMatchObject({ id: 'tg', type: 'telegram' });
  });

  it('does not mutate original config', () => {
    const cfg = makeConfig();
    channelAdd(cfg, 'tg', 'telegram');
    expect(cfg.channels).toHaveLength(0);
  });

  it('throws when channel id already exists', () => {
    const cfg = makeConfig({ channels: [{ id: 'tg', type: 'telegram' }] });
    expect(() => channelAdd(cfg, 'tg', 'telegram')).toThrow(/tg/);
    expect(() => channelAdd(cfg, 'tg', 'telegram')).toThrow(/already exists/i);
  });

  it('allows adding channel with same type but different id', () => {
    const cfg = makeConfig({ channels: [{ id: 'tg1', type: 'telegram' }] });
    const result = channelAdd(cfg, 'tg2', 'telegram');
    expect(result.channels).toHaveLength(2);
  });

  it('merges extra fields into channel config', () => {
    const cfg = makeConfig();
    const result = channelAdd(cfg, 'tg', 'telegram', { token: 'abc123', webhook: true });
    expect(result.channels[0]).toMatchObject({ id: 'tg', type: 'telegram', token: 'abc123', webhook: true });
  });

  it('preserves existing channels when adding new one', () => {
    const cfg = makeConfig({ channels: [{ id: 'slack', type: 'slack' }] });
    const result = channelAdd(cfg, 'tg', 'telegram');
    expect(result.channels).toHaveLength(2);
    expect(result.channels[0]).toMatchObject({ id: 'slack' });
  });

  it('preserves other config fields', () => {
    const cfg = makeConfig({
      routing: [{ channel: 'x', peer: '*', agent: 'bot' }],
    });
    const result = channelAdd(cfg, 'tg', 'telegram');
    expect(result.routing).toEqual(cfg.routing);
  });
});

// ── channelRemove ─────────────────────────────────────────────────────────────

describe('channelRemove', () => {
  it('removes an existing channel', () => {
    const cfg = makeConfig({ channels: [{ id: 'tg', type: 'telegram' }] });
    const result = channelRemove(cfg, 'tg');
    expect(result.channels).toHaveLength(0);
  });

  it('does not mutate original config', () => {
    const cfg = makeConfig({ channels: [{ id: 'tg', type: 'telegram' }] });
    channelRemove(cfg, 'tg');
    expect(cfg.channels).toHaveLength(1);
  });

  it('throws when channel does not exist', () => {
    const cfg = makeConfig();
    expect(() => channelRemove(cfg, 'nonexistent')).toThrow(/nonexistent/);
    expect(() => channelRemove(cfg, 'nonexistent')).toThrow(/not found/i);
  });

  it('cascades: removes routing rules referencing the channel', () => {
    const cfg = makeConfig({
      channels: [{ id: 'tg', type: 'telegram' }],
      routing: [
        { channel: 'tg', peer: 'user1', agent: 'bot' },
        { channel: 'tg', peer: '*', agent: 'bot' },
        { channel: 'slack', peer: '*', agent: 'bot' },
      ],
    });
    const result = channelRemove(cfg, 'tg');
    expect(result.routing).toHaveLength(1);
    expect(result.routing[0]).toMatchObject({ channel: 'slack' });
  });

  it('preserves other channels when removing one', () => {
    const cfg = makeConfig({
      channels: [
        { id: 'tg', type: 'telegram' },
        { id: 'slack', type: 'slack' },
      ],
    });
    const result = channelRemove(cfg, 'tg');
    expect(result.channels).toHaveLength(1);
    expect(result.channels[0]).toMatchObject({ id: 'slack' });
  });
});

// ── channelList ───────────────────────────────────────────────────────────────

describe('channelList', () => {
  it('returns empty array when no channels', () => {
    expect(channelList(makeConfig())).toEqual([]);
  });

  it('returns id, type, paired for each channel', () => {
    const cfg = makeConfig({
      channels: [
        { id: 'tg', type: 'telegram', paired: true },
        { id: 'slack', type: 'slack' },
      ],
    });
    const result = channelList(cfg);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ id: 'tg', type: 'telegram', paired: true });
    expect(result[1]).toEqual({ id: 'slack', type: 'slack', paired: false });
  });

  it('treats missing paired field as false', () => {
    const cfg = makeConfig({ channels: [{ id: 'tg', type: 'telegram' }] });
    expect(channelList(cfg)[0]?.paired).toBe(false);
  });
});
