import type { Config, RoutingRule } from '../config.js';

/**
 * Add or update a routing rule.
 *
 * - If a rule with the same (channel, peer) exists, update its agent.
 * - Otherwise, insert the new rule before any wildcard fallback rules (peer === "*").
 * - If no wildcard rules exist, append at end.
 *
 * Returns a new Config (does not mutate the original).
 */
export function routeAdd(config: Config, channel: string, peer: string, agent: string): Config {
  const rules = [...config.routing];

  // Check for existing rule with same (channel, peer)
  const existingIdx = rules.findIndex(r => r.channel === channel && r.peer === peer);
  if (existingIdx !== -1) {
    rules[existingIdx] = { channel, peer, agent };
    return { ...config, routing: rules };
  }

  // Find first wildcard rule index
  const wildcardIdx = rules.findIndex(r => r.peer === '*');
  if (wildcardIdx !== -1) {
    rules.splice(wildcardIdx, 0, { channel, peer, agent });
  } else {
    rules.push({ channel, peer, agent });
  }

  return { ...config, routing: rules };
}

/**
 * Remove a routing rule matching (channel, peer).
 *
 * Throws if no matching rule is found.
 * Returns a new Config (does not mutate the original).
 */
export function routeRemove(config: Config, channel: string, peer: string): Config {
  const idx = config.routing.findIndex(r => r.channel === channel && r.peer === peer);
  if (idx === -1) {
    throw new Error(`No route found for channel=${channel} peer=${peer} - Check routes with 'xgw route list'`);
  }

  const rules = config.routing.filter((_, i) => i !== idx);
  return { ...config, routing: rules };
}

/**
 * List all routing rules sorted by match priority:
 * exact peer rules first, wildcard peer rules last.
 */
export function routeList(config: Config): RoutingRule[] {
  return [...config.routing].sort((a, b) => {
    const aWild = a.peer === '*' ? 1 : 0;
    const bWild = b.peer === '*' ? 1 : 0;
    return aWild - bWild;
  });
}
