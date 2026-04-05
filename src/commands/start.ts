import { writeFileSync, mkdirSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolveConfigPath, loadConfig, validateConfig, saveConfig, parseXarConfig } from '../config.js';
import type { Config } from '../config.js';
import { createFileLogger, createForegroundLogger } from '../repo-utils/logger.js';
import { ChannelRegistry } from '../channels/registry.js';
import { GatewayServer } from '../gateway/server.js';
import { XarClient } from '../xar/client.js';
import { loadPluginForType } from '../gateway/plugin-loader.js';

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
      // Pass logger to plugins that support it (duck-type check)
      if ('setLogger' in plugin && typeof (plugin as Record<string, unknown>)['setLogger'] === 'function') {
        (plugin as { setLogger(l: unknown): void }).setLogger(logger)
      }
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
    logger.info('XarClient created');
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
