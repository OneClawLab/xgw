import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { resolveConfigPath, loadConfig } from '../config.js';

function getXgwHome(): string {
  return process.env['XGW_HOME'] ?? join(homedir(), '.local', 'share', 'xgw');
}

function readPid(): number | null {
  const pidFile = join(getXgwHome(), 'xgw.pid');
  if (!existsSync(pidFile)) return null;
  try {
    const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
    return Number.isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function statusCommand(opts: { config?: string; json: boolean }): Promise<void> {
  const configPath = resolveConfigPath(opts.config);
  const pid = readPid();
  const running = pid !== null && isRunning(pid);

  let config;
  try {
    config = loadConfig(configPath);
  } catch {
    config = null;
  }

  const channels = config?.channels.map(ch => ({
    id: ch.id,
    type: ch.type,
    paired: ch.paired === true,
  })) ?? [];

  const status = {
    running,
    pid: running ? pid : null,
    channels,
  };

  if (opts.json) {
    process.stdout.write(JSON.stringify(status, null, 2) + '\n');
  } else {
    process.stdout.write(
      `Status: ${running ? 'running' : 'stopped'}${running ? ` (PID ${pid})` : ''}\n`,
    );
    if (channels.length > 0) {
      process.stdout.write('Channels:\n');
      for (const ch of channels) {
        process.stdout.write(`  ${ch.id} (${ch.type}) paired=${ch.paired}\n`);
      }
    }
  }
}

export async function channelHealthCommand(opts: {
  id?: string;
  json: boolean;
  config?: string;
}): Promise<void> {
  const pid = readPid();
  const running = pid !== null && isRunning(pid);
  if (!running) {
    throw new Error("Daemon is not running - Start it with 'xgw start'");
  }

  // Without IPC to the running daemon, we can only report that the daemon is running.
  // Full health check requires daemon-side query (future enhancement).
  const result = opts.id
    ? { [opts.id]: { ok: true, detail: 'daemon running (detailed health requires IPC)' } }
    : { _note: 'daemon running (detailed health requires IPC)' };

  if (opts.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    process.stdout.write(
      'Daemon is running. Detailed channel health requires IPC (not yet implemented).\n',
    );
  }
}
