import { appendFileSync, renameSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const MAX_LINES = 10_000;

type LogLevel = 'INFO' | 'WARN' | 'ERROR';

export class Logger {
  private readonly logDir: string;
  private readonly logFile: string;
  private foreground = false;
  private dirReady = false;

  constructor(logDir?: string) {
    const xgwHome = process.env['XGW_HOME'] ?? join(homedir(), '.local', 'share', 'xgw');
    this.logDir = logDir ?? join(xgwHome, 'logs');
    this.logFile = join(this.logDir, 'xgw.log');
  }

  setForeground(enabled: boolean): void {
    this.foreground = enabled;
  }

  info(message: string): void {
    this._write('INFO', message);
  }

  warn(message: string): void {
    this._write('WARN', message);
  }

  error(message: string): void {
    this._write('ERROR', message);
  }

  private _ensureDir(): void {
    if (this.dirReady) return;
    if (!existsSync(this.logDir)) {
      mkdirSync(this.logDir, { recursive: true });
    }
    this.dirReady = true;
  }

  private _write(level: LogLevel, message: string): void {
    const line = `[${new Date().toISOString()}] [${level}] ${message}\n`;

    this._ensureDir();
    appendFileSync(this.logFile, line);

    if (this.foreground) {
      if (level === 'ERROR') {
        process.stderr.write(line);
      } else {
        process.stdout.write(line);
      }
    }

    this._rotateIfNeeded();
  }

  private _rotateIfNeeded(): void {
    if (!existsSync(this.logFile)) return;

    const content = readFileSync(this.logFile, 'utf-8');
    // Count lines by splitting; a trailing newline produces an empty last element
    const lines = content.split('\n');
    const lineCount = content.endsWith('\n') ? lines.length - 1 : lines.length;

    if (lineCount > MAX_LINES) {
      const now = new Date();
      const ts = now.getFullYear().toString()
        + String(now.getMonth() + 1).padStart(2, '0')
        + String(now.getDate()).padStart(2, '0')
        + '-'
        + String(now.getHours()).padStart(2, '0')
        + String(now.getMinutes()).padStart(2, '0')
        + String(now.getSeconds()).padStart(2, '0');
      const rotatedFile = join(this.logDir, `xgw-${ts}.log`);
      renameSync(this.logFile, rotatedFile);
    }
  }
}
