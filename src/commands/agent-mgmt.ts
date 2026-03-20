import type { Config } from '../config.js';

/**
 * Add or update an agent registration.
 *
 * - If the agent already exists, update its inbox path.
 * - Otherwise, register a new agent.
 *
 * Returns a new Config (does not mutate the original).
 */
export function agentAdd(config: Config, id: string, inbox: string): Config {
  return {
    ...config,
    agents: { ...config.agents, [id]: { inbox } },
  };
}

/**
 * Remove an agent registration.
 *
 * Throws if routing rules reference this agent.
 * Returns a new Config (does not mutate the original).
 */
export function agentRemove(config: Config, id: string): Config {
  const conflicts = config.routing.filter(r => r.agent === id);
  if (conflicts.length > 0) {
    const desc = conflicts.map(r => `channel=${r.channel} peer=${r.peer}`).join(', ');
    throw new Error(`Agent ${id} is referenced by routing rules: ${desc} - Remove the routes first`);
  }

  const { [id]: _, ...rest } = config.agents;
  return { ...config, agents: rest };
}

/**
 * List all registered agents and their inbox paths.
 */
export function agentList(config: Config): Array<{ id: string; inbox: string }> {
  return Object.entries(config.agents).map(([id, { inbox }]) => ({ id, inbox }));
}
