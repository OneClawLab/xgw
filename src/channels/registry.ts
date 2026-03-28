import type { ChannelConfig, ChannelPlugin } from './types.js';
import type { Message, HealthResult } from '../types.js';
import type { Logger } from '../repo-utils/logger.js';

const REQUIRED_METHODS = ['pair', 'start', 'stop', 'send', 'health'] as const;

function isValidPlugin(plugin: unknown): plugin is ChannelPlugin {
  if (!plugin || typeof plugin !== 'object') return false;
  const p = plugin as Record<string, unknown>;
  if (typeof p['type'] !== 'string') return false;
  return REQUIRED_METHODS.every((m) => typeof p[m] === 'function');
}

export class ChannelRegistry {
  /** plugin type name → prototype plugin instance */
  private pluginTypes = new Map<string, ChannelPlugin>();
  /** channel id → loaded plugin instance (all channels) */
  private loaded = new Map<string, ChannelPlugin>();
  /** channel id → running plugin instance (started only) */
  private running = new Map<string, ChannelPlugin>();
  private logger: Logger | null = null;

  setLogger(logger: Logger): void {
    this.logger = logger;
  }

  private log(level: 'info' | 'warn' | 'error', msg: string): void {
    if (this.logger) {
      this.logger[level](msg);
    } else {
      process.stderr.write(`[ChannelRegistry] ${msg}\n`);
    }
  }

  /**
   * Register a plugin type. Validates it implements the ChannelPlugin interface.
   * Requirement 3.2
   */
  register(type: string, plugin: ChannelPlugin): void {
    if (!isValidPlugin(plugin)) {
      throw new Error(
        `Plugin for type "${type}" does not implement ChannelPlugin interface (requires: type, ${REQUIRED_METHODS.join(', ')})`,
      );
    }
    this.pluginTypes.set(type, plugin);
  }

  /**
   * Load plugins for each channel config entry by looking up registered types.
   * Requirement 3.1
   */
  loadPlugins(channels: ChannelConfig[]): void {
    for (const ch of channels) {
      const plugin = this.pluginTypes.get(ch.type);
      if (!plugin) {
        this.log('error', `No plugin registered for channel type "${ch.type}" (channel: ${ch.id})`);
        continue;
      }
      this.loaded.set(ch.id, plugin);
      this.log('info', `plugin loaded for channel: id=${ch.id} type=${ch.type}`);
    }
  }

  /**
   * Start only channels with paired === true.
   * If a channel's start() fails, log the error and continue.
   * Requirements 3.3, 3.5
   */
  async startAll(
    channels: ChannelConfig[],
    onMessage: (msg: Message) => Promise<void>,
  ): Promise<void> {
    for (const ch of channels) {
      if (!ch.paired) {
        this.log('info', `channel skipped (not paired): id=${ch.id} type=${ch.type}`);
        continue;
      }

      const plugin = this.loaded.get(ch.id);
      if (!plugin) {
        this.log('error', `No loaded plugin for channel "${ch.id}", skipping start`);
        continue;
      }

      try {
        await plugin.start(ch, onMessage);
        this.running.set(ch.id, plugin);
        this.log('info', `channel started: id=${ch.id} type=${ch.type}`);
      } catch (err) {
        this.log('error',
          `Failed to start channel "${ch.id}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /**
   * Stop all running plugins.
   * Requirement 3.4
   */
  async stopAll(): Promise<void> {
    for (const [id, plugin] of this.running) {
      try {
        await plugin.stop();
        this.log('info', `channel stopped: id=${id}`);
      } catch (err) {
        this.log('error',
          `Failed to stop channel "${id}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    this.running.clear();
  }

  /**
   * Get a loaded plugin instance by channel id.
   */
  getPlugin(channelId: string): ChannelPlugin | undefined {
    return this.loaded.get(channelId);
  }

  /**
   * Health check one or all running plugins.
   */
  async healthCheck(channelId?: string): Promise<Record<string, HealthResult>> {
    const results: Record<string, HealthResult> = {};

    if (channelId) {
      const plugin = this.running.get(channelId);
      if (plugin) {
        try {
          results[channelId] = await plugin.health();
        } catch (err) {
          results[channelId] = {
            ok: false,
            detail: err instanceof Error ? err.message : String(err),
          };
        }
      } else {
        results[channelId] = { ok: false, detail: 'not running' };
      }
      return results;
    }

    for (const [id, plugin] of this.running) {
      try {
        results[id] = await plugin.health();
      } catch (err) {
        results[id] = {
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
        };
      }
    }

    return results;
  }
}
