import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ── Helpers ────────────────────────────────────────────────────────

function getXgwHome(): string {
  return process.env['XGW_HOME'] ?? join(homedir(), '.local', 'share', 'xgw');
}

// ── stopCommand ────────────────────────────────────────────────────

export async function stopCommand(_opts: { config?: string }): Promise<void> {
  const pidFile = join(getXgwHome(), 'xgw.pid');

  if (!existsSync(pidFile)) {
    // Daemon not running — idempotent success (Req 2.3)
    process.stdout.write('Daemon is not running.\n');
    return;
  }

  const content = readFileSync(pidFile, 'utf-8').trim();
  const pid = parseInt(content, 10);

  if (Number.isNaN(pid)) {
    // Invalid PID file — clean up stale file
    try { unlinkSync(pidFile); } catch { /* ignore */ }
    process.stdout.write('Daemon is not running (cleaned up stale PID file).\n');
    return;
  }

  try {
    // Check if process is actually running (signal 0 = existence check)
    process.kill(pid, 0);
    // Send SIGTERM for graceful shutdown
    process.kill(pid, 'SIGTERM');
    process.stdout.write(`Daemon stopped (PID ${pid}).\n`);
  } catch {
    // Process not running — clean up stale PID file
    try { unlinkSync(pidFile); } catch { /* ignore */ }
    process.stdout.write('Daemon is not running (cleaned up stale PID file).\n');
  }
}
