import { writeFileSync, mkdirSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { resolveConfigPath, loadConfig, validateConfig, saveConfig, parseXarConfig } from '../config.js';
import { createFileLogger, createForegroundLogger } from '../repo-utils/logger.js';
import { ChannelRegistry } from '../channels/registry.js';
import { GatewayServer } from '../gateway/server.js';
import { XarClient } from '../xar/client.js';
import { channelWritePairResult } from './channel-mgmt.js';
import type { ChannelPlugin } from '../channels/types.js';

// ── Helpers ────────────────────────────────────────────────────────

function getXgwHome(): string {
  return process.env['XGW_HOME'] ?? join(homedir(), '.local', 'share', 'xgw');
}

function getPidFilePath(): string {
  return join(getXgwHome(), 'xgw.pid');
}

function writePidFile(): void {
  const pidDir = getXgwHome();
  mkdirSync(pidDir, { recursive: true });
  writeFileSync(getPidFilePath(), String(process.pid), 'utf-8');
}

function removePidFile(): void {
  const pidFile = getPidFilePath();
  if (existsSync(pidFile)) {
    try { unlinkSync(pidFile); } catch { /* ignore */ }
  }
}

function readPidFile(): number | null {
  const pidFile = getPidFilePath();
  if (!existsSync(pidFile)) return null;
  try {
    const content = readFileSync(pidFile, 'utf-8').trim();
    const pid = parseInt(content, 10);
    return Number.isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Poll for PID file to appear and contain a live PID, up to `timeoutMs`. */
async function waitForReady(timeoutMs: number): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 100));
    const pid = readPidFile();
    if (pid !== null && isProcessRunning(pid)) return pid;
  }
  return null;
}

/**
 * Filter execArgv to pass through loader flags (tsx, esm) but drop
 * debug/inspect flags that would cause port conflicts in the child.
 */
function safeExecArgv(): string[] {
  return process.execArgv.filter(arg =>
    !arg.startsWith('--inspect') &&
    !arg.startsWith('--debug')
  );
}


/**
 * Attempt to dynamically load a channel plugin by type name.
 * For now only the built-in TUI plugin path is known; other types
 * will be resolved from a conventional path pattern in the future.
 */
async function loadPluginForType(type: string, config: Config): Promise<ChannelPlugin> {
  const __dirname = dirname(fileURLToPath(import.meta.url))

  // Resolve npm package name: channel-level override > global plugins registry
  const channelOverride = config.channels.find(ch => ch.type === type && typeof ch['plugin'] === 'string')?.['plugin'] as string | undefined
  const registeredPkg = config.plugins?.[type]
  const pkgName = channelOverride ?? registeredPkg

  let modulePath: string | undefined

  if (pkgName) {
    // Resolve npm package (globally installed or locally linked)
    try {
      modulePath = createRequire(import.meta.url).resolve(pkgName)
    } catch {
      throw new Error(
        `Plugin package "${pkgName}" for type "${type}" is not installed. ` +
        `Run: npm install -g ${pkgName}`,
      )
    }
  } else {
    // Development fallback: built-in plugins/<type>/dist/index.js
    const builtinPath = join(__dirname, '..', 'plugins', type, 'dist', 'index.js')
    if (existsSync(builtinPath)) {
      modulePath = builtinPath
    }
  }

  if (!modulePath) {
    throw new Error(
      `No plugin found for channel type "${type}". ` +
      `Register one with: xgw plugin add ${type} <npm-package-name>`,
    )
  }

  // On Windows, convert absolute path to file:// URL for ESM import()
  const moduleUrl = process.platform === 'win32' && !modulePath.startsWith('file://')
    ? new URL(`file:///${modulePath.replace(/\\/g, '/')}`).href
    : modulePath

  try {
    const mod = await import(moduleUrl) as Record<string, unknown>
    if (typeof mod['default'] === 'function') {
      return new (mod['default'] as new () => ChannelPlugin)()
    }
    if (typeof mod['createPlugin'] === 'function') {
      return (mod['createPlugin'] as () => ChannelPlugin)()
    }
    if (typeof mod['TuiPlugin'] === 'function') {
      return new (mod['TuiPlugin'] as new () => ChannelPlugin)()
    }
    throw new Error(`Plugin module for type "${type}" has no default export, createPlugin, or TuiPlugin export`)
  } catch (err) {
    if (err instanceof Error && (err.message.includes('No plugin found') || err.message.includes('not installed'))) throw err
    throw new Error(
      `Failed to load plugin for channel type "${type}" - ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

// ── startCommand ───────────────────────────────────────────────────

export async function startCommand(opts: { config?: string; foreground: boolean }): Promise<void> {
  // 1. Check if daemon is already running
  const existingPid = readPidFile();
  if (existingPid !== null && isProcessRunning(existingPid)) {
    throw new Error(`Daemon already running (PID ${existingPid}) - Stop it first with 'xgw stop'`);
  }

  if (!opts.foreground) {
    // Background mode: spawn detached child that re-invokes with --foreground
    const { spawn } = await import('node:child_process');
    const xgwHome = getXgwHome();
    const logsDir = join(xgwHome, 'logs');
    mkdirSync(logsDir, { recursive: true });
    const logFile = join(logsDir, 'xgw.log');
    const { openSync } = await import('node:fs');
    const logFd = openSync(logFile, 'a');
    const script = process.argv[1] ?? '';
    const extraArgs = opts.config ? ['--config', opts.config] : [];
    // Do NOT forward --inspect/--debug flags to avoid port conflicts
    const child = spawn(process.execPath, [...safeExecArgv(), script, ...extraArgs, 'start', '--foreground'], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: { ...process.env, XGW_DAEMON: '1' },
    });
    child.unref();

    // Wait up to 5s for daemon to write its PID file
    const pid = await waitForReady(5000);
    if (pid === null) {
      throw new Error('Daemon did not start within 5 seconds. Check logs: ' + logFile);
    }
    process.stdout.write(`Daemon started (PID: ${pid})\n`);
    return;
  }

  // Foreground mode: run daemon in this process
  // 2. Resolve config path, load and validate
  const configPath = resolveConfigPath(opts.config);
  const config = loadConfig(configPath);
  const validation = validateConfig(config);
  if (!validation.valid) {
    throw new Error(
      `Invalid configuration: ${validation.errors.join('; ')} - Fix your config file at ${configPath}`,
    );
  }

  // 3. Create logger, set foreground mode
  const xgwHome = process.env['XGW_HOME'] ?? join(homedir(), '.local', 'share', 'xgw');
  const logsDir = join(xgwHome, 'logs');
  const logger = opts.foreground
    ? await createForegroundLogger(logsDir, 'xgw')
    : await createFileLogger(logsDir, 'xgw');

  logger.info('xgw starting...');

  // 4. Create channel registry and register known plugin types
  const registry = new ChannelRegistry();

  // Collect unique channel types from config
  const channelTypes = new Set(config.channels.map(ch => ch.type));

  for (const type of channelTypes) {
    try {
      const plugin = await loadPluginForType(type, config)
      registry.register(type, plugin)
      logger.info(`plugin loaded: type=${type}`)
    } catch (err) {
      logger.error(`plugin load failed: type=${type} - ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // 5. Load plugins from config (maps channel ids to plugin instances)
  registry.setLogger(logger);
  registry.loadPlugins(config.channels);

  // 6. Create XarClient if xar config is present
  let xarClient: XarClient | undefined;
  if (config.xar !== undefined) {
    const xarResult = parseXarConfig(config.xar);
    if (!xarResult.ok) {
      throw new Error(`Invalid xar configuration: ${xarResult.error}`);
    }
    xarClient = new XarClient(xarResult.value, logger);
    logger.info('XarClient created (v2 IPC mode)');
  }

  // 7. Create and start gateway server (starts all paired channels)
  const server = new GatewayServer(logger, xarClient);
  await server.start(config, registry);

  // 8. Write PID file
  writePidFile();
  logger.info(`PID file written: ${getPidFilePath()} (pid=${process.pid})`);

  // 9. Handle SIGUSR1 for config reload
  process.on('SIGUSR1', () => {
    try {
      logger.info('reload signal received (SIGUSR1)');
      const newConfig = loadConfig(configPath);
      const v = validateConfig(newConfig);
      if (!v.valid) {
        logger.error(`reload failed: invalid config - ${v.errors.join('; ')}`);
        return;
      }
      server.reload(newConfig);
      logger.info('configuration reloaded');
    } catch (err) {
      logger.error(`reload failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // 10. Handle graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`${signal} received, shutting down...`);
    try {
      await server.stop();
    } catch (err) {
      logger.error(`shutdown error: ${err instanceof Error ? err.message : String(err)}`);
    }
    removePidFile();
    logger.info('xgw stopped');
    process.exit(0);
  };

  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT', () => { void shutdown('SIGINT'); });

  // 11. In foreground mode the process stays alive due to the HTTP server.
  //     In daemon mode (future): use notifier to daemonize.
  //     For now both modes run in foreground — the HTTP server keeps the event loop alive.
  if (opts.foreground) {
    logger.info('running in foreground mode (Ctrl+C to stop)');
  } else {
    logger.info('daemon started (use "xgw stop" to terminate)');
  }
}


// ── channelPairCommand ─────────────────────────────────────────────

export async function channelPairCommand(opts: { id: string; config?: string }): Promise<void> {
  // 1. Resolve config path, load config
  const configPath = resolveConfigPath(opts.config);
  const config = loadConfig(configPath);

  // 2. Find channel by id
  const channel = config.channels.find(ch => ch.id === opts.id);
  if (!channel) {
    throw new Error(
      `Channel ${opts.id} not found - Check channels with 'xgw channel list'`,
    );
  }

  // 3. Load the plugin for that channel type
  const plugin = await loadPluginForType(channel.type, config)

  // 4. Call plugin.pair(channelConfig)
  process.stderr.write(`Pairing channel ${opts.id} (type=${channel.type})...\n`);
  const result = await plugin.pair(channel);

  if (!result.success) {
    throw new Error(
      `Pairing failed for channel ${opts.id}: ${result.error ?? 'unknown error'} - Check channel configuration`,
    );
  }

  // 5. Write pair result to config
  const updated = channelWritePairResult(config, opts.id, {
    paired: true,
    pair_mode: result.pair_mode,
    pair_info: result.pair_info,
    paired_at: new Date().toISOString(),
  });

  // 6. Save config
  saveConfig(configPath, updated);
  process.stdout.write(
    `Channel paired: id=${opts.id} mode=${result.pair_mode}\n`,
  );
}
