import yaml from 'js-yaml';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { ChannelConfig } from './channels/types.js';

// ── Types ──────────────────────────────────────────────────────────

export interface GatewayConfig {
  host: string;
  port: number;
}

export interface RoutingRule {
  channel: string;
  peer: string;
  agent: string;
}

export interface AgentConfig {
  id: string;
  inbox: string;
}

export interface Config {
  gateway: GatewayConfig;
  channels: ChannelConfig[];
  routing: RoutingRule[];
  agents: Record<string, { inbox: string }>;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

// ── Functions ──────────────────────────────────────────────────────

const DEFAULT_CONFIG_PATH = '.config/xgw/config.yaml';

/**
 * Resolve config path with precedence: --config flag > XGW_CONFIG env > default.
 */
export function resolveConfigPath(cliFlag?: string): string {
  if (cliFlag) return resolve(cliFlag);
  const envPath = process.env['XGW_CONFIG'];
  if (envPath) return resolve(envPath);
  return resolve(homedir(), DEFAULT_CONFIG_PATH);
}

/**
 * Load and parse YAML config file. Throws on missing file or invalid YAML.
 */
export function loadConfig(configPath: string): Config {
  let content: string;
  try {
    content = readFileSync(configPath, 'utf-8');
  } catch {
    throw new Error(`Config file not found at ${configPath} - Create the file or specify a valid path with --config`);
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(content);
  } catch {
    throw new Error(`Invalid YAML syntax in ${configPath} - Check syntax`);
  }

  return parsed as Config;
}

/**
 * Validate a config object. Returns { valid, errors }.
 */
export function validateConfig(config: unknown): ValidationResult {
  const errors: string[] = [];

  if (config == null || typeof config !== 'object') {
    return { valid: false, errors: ['Config must be a non-null object - Provide a valid YAML config file'] };
  }

  const c = config as Record<string, unknown>;

  // ── gateway ──
  if (c['gateway'] == null || typeof c['gateway'] !== 'object') {
    errors.push('Missing required field gateway - Add the field to your config file');
  } else {
    const gw = c['gateway'] as Record<string, unknown>;
    if (typeof gw['host'] !== 'string') {
      errors.push('Field gateway.host has invalid type (expected string) - Fix the value in your config file');
    }
    if (typeof gw['port'] !== 'number') {
      errors.push('Field gateway.port has invalid type (expected number) - Fix the value in your config file');
    }
  }

  // ── channels ──
  if (!Array.isArray(c['channels'])) {
    errors.push('Missing required field channels - Add the field to your config file');
  } else {
    const ids = new Set<string>();
    for (const ch of c['channels'] as unknown[]) {
      if (ch == null || typeof ch !== 'object') {
        errors.push('Each channel entry must be an object - Fix the channels array in your config file');
        continue;
      }
      const entry = ch as Record<string, unknown>;
      if (typeof entry['id'] !== 'string') {
        errors.push('Channel entry missing id (expected string) - Add an id field to the channel entry');
      } else {
        if (ids.has(entry['id'])) {
          errors.push(`Duplicate channel id: ${entry['id']} - Use unique ids for each channel`);
        }
        ids.add(entry['id']);
      }
      if (typeof entry['type'] !== 'string') {
        errors.push('Channel entry missing type (expected string) - Add a type field to the channel entry');
      }
    }
  }

  // ── routing ──
  if (!Array.isArray(c['routing'])) {
    errors.push('Missing required field routing - Add the field to your config file');
  } else {
    const channelIds = Array.isArray(c['channels'])
      ? new Set((c['channels'] as Array<Record<string, unknown>>).filter(ch => typeof ch['id'] === 'string').map(ch => ch['id'] as string))
      : new Set<string>();
    const agentIds = (c['agents'] != null && typeof c['agents'] === 'object' && !Array.isArray(c['agents']))
      ? new Set(Object.keys(c['agents'] as object))
      : new Set<string>();

    for (const rule of c['routing'] as unknown[]) {
      if (rule == null || typeof rule !== 'object') {
        errors.push('Each routing rule must be an object - Fix the routing array in your config file');
        continue;
      }
      const r = rule as Record<string, unknown>;
      if (typeof r['channel'] !== 'string') {
        errors.push('Routing rule missing channel (expected string) - Add a channel field to the routing rule');
      } else if (r['channel'] !== '*' && !channelIds.has(r['channel'])) {
        errors.push(`Routing rule references unknown channel: ${r['channel']} - Add the channel or fix the rule`);
      }
      if (typeof r['peer'] !== 'string') {
        errors.push('Routing rule missing peer (expected string) - Add a peer field to the routing rule');
      }
      if (typeof r['agent'] !== 'string') {
        errors.push('Routing rule missing agent (expected string) - Add an agent field to the routing rule');
      } else if (!agentIds.has(r['agent'])) {
        errors.push(`Routing rule references unknown agent: ${r['agent']} - Add the agent or fix the rule`);
      }
    }
  }

  // ── agents ──
  if (c['agents'] == null || typeof c['agents'] !== 'object' || Array.isArray(c['agents'])) {
    errors.push('Missing required field agents - Add the field to your config file');
  } else {
    for (const [id, val] of Object.entries(c['agents'] as object)) {
      if (val == null || typeof val !== 'object') {
        errors.push(`Agent ${id} must be an object with inbox field - Fix the agent entry in your config file`);
        continue;
      }
      const agent = val as Record<string, unknown>;
      if (typeof agent['inbox'] !== 'string' || agent['inbox'] === '') {
        errors.push(`Agent ${id} has invalid or empty inbox path - Set a valid inbox path for the agent`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Serialize Config to YAML and write to file. Creates parent directories if needed.
 */
export function saveConfig(configPath: string, config: Config): void {
  const dir = dirname(configPath);
  mkdirSync(dir, { recursive: true });
  const content = yaml.dump(config, { lineWidth: -1, noRefs: true });
  writeFileSync(configPath, content, 'utf-8');
}
