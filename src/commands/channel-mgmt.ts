import type { Config } from '../config.js';
import type { ChannelConfig } from '../channels/types.js';

/**
 * Add a new channel entry to the config.
 *
 * Throws if a channel with the same id already exists.
 * Returns a new Config (does not mutate the original).
 */
export function channelAdd(
  config: Config,
  id: string,
  type: string,
  extra?: Record<string, unknown>,
): Config {
  const existing = config.channels.find(ch => ch.id === id);
  if (existing) {
    throw new Error(
      `Channel ${id} already exists - Remove it first with 'xgw channel remove'`,
    );
  }

  const entry: ChannelConfig = { id, type, ...extra };
  return { ...config, channels: [...config.channels, entry] };
}

/**
 * Remove a channel entry and clean up routing rules referencing it.
 *
 * Throws if the channel does not exist.
 * Returns a new Config (does not mutate the original).
 */
export function channelRemove(config: Config, id: string): Config {
  const idx = config.channels.findIndex(ch => ch.id === id);
  if (idx === -1) {
    throw new Error(
      `Channel ${id} not found - Check channels with 'xgw channel list'`,
    );
  }

  const channels = config.channels.filter((_, i) => i !== idx);
  const routing = config.routing.filter(r => r.channel !== id);
  return { ...config, channels, routing };
}

/**
 * List all configured channels with id, type, and paired status.
 */
export function channelList(
  config: Config,
): Array<{ id: string; type: string; paired: boolean }> {
  return config.channels.map(ch => ({
    id: ch.id,
    type: ch.type,
    paired: ch.paired === true,
  }));
}
