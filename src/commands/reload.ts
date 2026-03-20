import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

function getXgwHome(): string {
  return process.env['XGW_HOME'] ?? join(homedir(), '.local', 'share', 'xgw');
}

/**
 * Send SIGUSR1 to the running daemon to trigger config reload.
 * If daemon is not running, exit silently with code 0 (Req 2.7).
 */
export async function reloadCommand(_opts: { config?: string }): Promise<void> {
  const pidFile = join(getXgwHome(), 'xgw.pid');

  if (!existsSync(pidFile)) {
    // Daemon not running — silent success
    process.stdout.write('Daemon is not running. Changes will take effect on next start.\n');
    return;
  }

  const content = readFileSync(pidFile, 'utf-8').trim();
  const pid = parseInt(content, 10);

  if (Number.isNaN(pid)) {
    process.stdout.write('Daemon is not running. Changes will take effect on next start.\n');
    return;
  }

  try {
    process.kill(pid, 0); // check if running
    process.kill(pid, 'SIGUSR1');
    process.stdout.write('Reload signal sent.\n');
  } catch {
    process.stdout.write('Daemon is not running. Changes will take effect on next start.\n');
  }
}
