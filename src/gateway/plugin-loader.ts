import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import type { ChannelPlugin } from '../channels/types.js';
import type { Config } from '../config.js';

/**
 * Dynamically load a channel plugin by type name.
 *
 * Resolution order:
 *   1. Per-channel `plugin` field in config (npm package name)
 *   2. Global `plugins` registry in config (type → npm package name)
 *   3. Built-in development fallback: plugins/<type>/dist/index.js
 *
 * Throws if no plugin can be found or loaded.
 */
export async function loadPluginForType(type: string, config?: Config): Promise<ChannelPlugin> {
  const __dirname = dirname(fileURLToPath(import.meta.url));

  let modulePath: string | undefined;

  if (config) {
    // 1. Per-channel override
    const channelOverride = config.channels.find(
      (ch) => ch.type === type && typeof ch['plugin'] === 'string',
    )?.['plugin'] as string | undefined;

    // 2. Global plugins registry
    const registeredPkg = config.plugins?.[type];
    const pkgName = channelOverride ?? registeredPkg;

    if (pkgName) {
      try {
        modulePath = createRequire(import.meta.url).resolve(pkgName);
      } catch {
        throw new Error(
          `Plugin package "${pkgName}" for type "${type}" is not installed. ` +
          `Run: npm install -g ${pkgName}`,
        );
      }
    }
  }

  // 3. Built-in development fallback
  if (!modulePath) {
    const builtinPath = join(__dirname, '..', 'plugins', type, 'dist', 'index.js');
    if (existsSync(builtinPath)) {
      modulePath = builtinPath;
    }
  }

  if (!modulePath) {
    throw new Error(
      `No plugin found for channel type "${type}". ` +
      `Register one with: xgw plugin add ${type} <npm-package-name>`,
    );
  }

  // On Windows, convert absolute path to file:// URL for ESM import()
  const moduleUrl =
    process.platform === 'win32' && !modulePath.startsWith('file://')
      ? new URL(`file:///${modulePath.replace(/\\/g, '/')}`).href
      : modulePath;

  try {
    const mod = (await import(moduleUrl)) as Record<string, unknown>;
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
      `Plugin module for type "${type}" has no default export, createPlugin, or TuiPlugin export`,
    );
  } catch (err) {
    if (
      err instanceof Error &&
      (err.message.includes('No plugin found') || err.message.includes('not installed'))
    ) {
      throw err;
    }
    throw new Error(
      `Failed to load plugin for channel type "${type}" - ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
