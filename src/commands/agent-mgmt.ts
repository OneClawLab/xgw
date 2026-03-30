import type { Config } from '../config.js';

/**
 * List all agents referenced in routing rules.
 * (Agent lifecycle is managed by xar, not xgw. xgw only knows about agents through routing.)
 */
export function agentList(config: Config): Array<{ id: string; channels: string[] }> {
  const agentMap = new Map<string, Set<string>>();
  for (const rule of config.routing) {
    const channels = agentMap.get(rule.agent) ?? new Set<string>();
    channels.add(rule.channel);
    agentMap.set(rule.agent, channels);
  }
  return Array.from(agentMap.entries()).map(([id, channels]) => ({
    id,
    channels: Array.from(channels),
  }));
}
