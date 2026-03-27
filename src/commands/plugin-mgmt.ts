import type { Config } from '../config.js';

export interface PluginEntry {
  type: string;
  package: string;
}

export function pluginAdd(config: Config, type: string, pkg: string): Config {
  const plugins = { ...(config.plugins ?? {}), [type]: pkg };
  return { ...config, plugins };
}

export function pluginRemove(config: Config, type: string): Config {
  if (!config.plugins || !(type in config.plugins)) {
    throw new Error(`Plugin type "${type}" is not registered - Check with 'xgw plugin list'`);
  }
  const plugins = { ...config.plugins };
  delete plugins[type];
  return { ...config, plugins: Object.keys(plugins).length > 0 ? plugins : undefined };
}

export function pluginList(config: Config): PluginEntry[] {
  if (!config.plugins) return [];
  return Object.entries(config.plugins).map(([type, pkg]) => ({ type, package: pkg }));
}
