import type { RoutingRule } from '../config.js';

/**
 * Routes inbound messages by mapping (channel_id, peer_id) → agent_id.
 *
 * Resolution priority:
 *   1. Exact match: channel === channelId AND peer === peerId
 *   2. Wildcard match: channel === channelId AND peer === "*"
 *   3. No match → null
 */
export class Router {
  private rules: RoutingRule[] = [];

  constructor(rules?: RoutingRule[]) {
    if (rules) {
      this.rules = [...rules];
    }
  }

  /** Replace the entire routing table. */
  reload(rules: RoutingRule[]): void {
    this.rules = [...rules];
  }

  /** Resolve (channelId, peerId) to an agent_id, or null if no match. */
  resolve(channelId: string, peerId: string): string | null {
    let wildcardAgent: string | null = null;

    for (const rule of this.rules) {
      if (rule.channel !== channelId) continue;

      if (rule.peer === peerId) {
        return rule.agent; // exact match wins immediately
      }

      if (rule.peer === '*' && wildcardAgent === null) {
        wildcardAgent = rule.agent;
      }
    }

    return wildcardAgent;
  }
}
