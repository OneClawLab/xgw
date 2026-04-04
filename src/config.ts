import yaml from 'js-yaml';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { ChannelConfig } from './channels/types.js';
import type { XarConfig } from './xar/types.js';

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

export interface Config {
  gateway: GatewayConfig;
  channels: ChannelConfig[];
  routing: RoutingRule[];
  /** Plugin registry: type → npm package name */
  plugins?: Record<string, string>;
  /** Optional xar IPC connection config (v2 mode) */
  xar?: XarConfig;
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
        // channel_id must be in <type>:<instance> format
        if (!entry['id'].includes(':')) {
          errors.push(`Channel id "${entry['id']}" must be in <type>:<instance> format (e.g. "telegram:main")`);
        }
        ids.add(entry['id']);
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
      }
    }
  }

  // ── plugins (optional) ──
  if ('plugins' in c && c['plugins'] !== undefined) {
    if (typeof c['plugins'] !== 'object' || Array.isArray(c['plugins'])) {
      errors.push('Field plugins must be an object mapping type names to npm package names');
    } else {
      for (const [type, pkg] of Object.entries(c['plugins'] as object)) {
        if (typeof pkg !== 'string' || pkg === '') {
          errors.push(`plugins.${type} must be a non-empty string (npm package name)`);
        }
      }
    }
  }

  // ── xar (optional) ──
  if ('xar' in c && c['xar'] !== undefined) {
    const xarResult = parseXarConfig(c['xar']);
    if (!xarResult.ok) {
      errors.push(xarResult.error);
    }
  }

  return { valid: errors.length === 0, errors };
}

// ── XarConfig defaults ─────────────────────────────────────────────

const XAR_DEFAULTS: XarConfig = {
  port: 28213,
  reconnect_interval_ms: 3000,
};

/**
 * Parse and validate the xar config section from a raw config object.
 * Fills in defaults for missing fields.
 * Returns { ok: true, value } on success, or { ok: false, error } on format error.
 */
export function parseXarConfig(
  raw: unknown,
): { ok: true; value: XarConfig } | { ok: false; error: string } {
  if (raw == null) {
    return { ok: true, value: { ...XAR_DEFAULTS } };
  }

  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'Field xar must be an object - Fix the xar section in your config file' };
  }

  const x = raw as Record<string, unknown>;

  // port
  let port = XAR_DEFAULTS.port;
  if ('port' in x) {
    if (typeof x['port'] !== 'number' || !Number.isInteger(x['port']) || x['port'] <= 0 || x['port'] > 65535) {
      return { ok: false, error: 'Field xar.port has invalid value (expected integer 1-65535) - Fix the value in your config file' };
    }
    port = x['port'];
  }

  // reconnect_interval_ms
  let reconnect_interval_ms = XAR_DEFAULTS.reconnect_interval_ms;
  if ('reconnect_interval_ms' in x) {
    if (typeof x['reconnect_interval_ms'] !== 'number' || !Number.isInteger(x['reconnect_interval_ms']) || x['reconnect_interval_ms'] <= 0) {
      return { ok: false, error: 'Field xar.reconnect_interval_ms has invalid value (expected positive integer) - Fix the value in your config file' };
    }
    reconnect_interval_ms = x['reconnect_interval_ms'];
  }

  return { ok: true, value: { port, reconnect_interval_ms } };
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
