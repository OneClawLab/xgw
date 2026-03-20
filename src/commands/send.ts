import { readFileSync } from 'node:fs';
import { resolveConfigPath, loadConfig } from '../config.js';
import type { ChannelPlugin } from '../channels/types.js';

/**
 * Attempt to dynamically load a channel plugin by type name.
 * Same pattern as start.ts — convention: plugins/<type>/dist/index.js
 */
async function loadPluginForType(type: string): Promise<ChannelPlugin> {
  const pluginPaths: Record<string, string> = {
    tui: '../../../plugins/tui/dist/index.js',
  };

  const modulePath = pluginPaths[type];
  if (!modulePath) {
    throw new Error(
      `No plugin found for channel type ${type} - Install the plugin or check the type name`,
    );
  }

  try {
    const mod = (await import(modulePath)) as Record<string, unknown>;
    if (typeof mod['default'] === 'function') {
      return new (mod['default'] as new () => ChannelPlugin)();
    }
    if (typeof mod['createPlugin'] === 'function') {
      return (mod['createPlugin'] as () => ChannelPlugin)();
    }
    if (typeof mod['TuiPlugin'] === 'function') {
      return new (mod['TuiPlugin'] as new () => ChannelPlugin)();
    }
    throw new Error(
      `Plugin module for type "${type}" has no recognized export`,
    );
  } catch (err) {
    if (err instanceof Error && err.message.includes('No plugin found')) throw err;
    throw new Error(
      `Failed to load plugin for channel type ${type} - ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function sendCommand(opts: {
  channel: string;
  peer: string;
  session: string;
  message?: string;
  replyTo?: string;
  config?: string;
  json: boolean;
}): Promise<void> {
  const configPath = resolveConfigPath(opts.config);
  const config = loadConfig(configPath);

  // Find channel config
  const ch = config.channels.find((c) => c.id === opts.channel);
  if (!ch) {
    throw new Error(
      `Channel ${opts.channel} not found - Check channels with 'xgw channel list'`,
    );
  }

  // Get message text: --message flag or stdin
  let text = opts.message;
  if (!text) {
    text = readFileSync(0, 'utf-8').trim();
    if (!text) {
      throw new Error(
        'No message provided - Use --message or pipe text to stdin',
      );
    }
  }

  // Load plugin and send
  const plugin = await loadPluginForType(ch.type);
  await plugin.start(ch, async () => {});

  try {
    const sendParams = {
      peer_id: opts.peer,
      session_id: opts.session,
      text,
      ...(opts.replyTo != null ? { reply_to: opts.replyTo } : {}),
    };
    await plugin.send(sendParams);

    const result = {
      success: true,
      channel_id: opts.channel,
      peer_id: opts.peer,
    };
    if (opts.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    } else {
      process.stdout.write(
        `Message sent: channel=${opts.channel} peer=${opts.peer}\n`,
      );
    }
  } catch (err) {
    const result = {
      success: false,
      channel_id: opts.channel,
      peer_id: opts.peer,
      error: err instanceof Error ? err.message : String(err),
    };
    if (opts.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    }
    throw new Error(
      `Failed to send message via channel ${opts.channel} - Check channel health with 'xgw channel health'`,
    );
  } finally {
    await plugin.stop();
  }
}
