import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfigPath, loadConfig, saveConfig } from './config.js';
import { routeAdd, routeRemove, routeList } from './commands/route.js';
import { agentAdd, agentRemove, agentList } from './commands/agent-mgmt.js';
import { channelAdd, channelRemove, channelList } from './commands/channel-mgmt.js';

// ── Helpers ────────────────────────────────────────────────────────

function errorExit(msg: string, code: 1 | 2 = 1): never {
  process.stderr.write(`Error: ${msg}\n`);
  process.exit(code);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8')) as { version: string };

// ── Program ────────────────────────────────────────────────────────

const program = new Command();

program
  .name('xgw')
  .description('xgw - communication gateway daemon & CLI for TheClaw')
  .version(pkg.version);

// ── start ──────────────────────────────────────────────────────────

program
  .command('start')
  .description('Start the xgw daemon')
  .option('--config <path>', 'config file path')
  .option('--foreground', 'run in foreground mode', false)
  .action(async (opts: { config?: string; foreground: boolean }) => {
    try {
      const mod = await import('./commands/start.js');
      await mod.startCommand(opts);
    } catch (err) {
      errorExit(err instanceof Error ? err.message : String(err));
    }
  });

// ── stop ───────────────────────────────────────────────────────────

program
  .command('stop')
  .description('Stop the xgw daemon')
  .option('--config <path>', 'config file path')
  .action(async (opts: { config?: string }) => {
    try {
      const mod = await import('./commands/stop.js');
      await mod.stopCommand(opts);
    } catch (err) {
      errorExit(err instanceof Error ? err.message : String(err));
    }
  });

// ── status ─────────────────────────────────────────────────────────

program
  .command('status')
  .description('Show daemon status')
  .option('--config <path>', 'config file path')
  .option('--json', 'output as JSON', false)
  .action(async (opts: { config?: string; json: boolean }) => {
    try {
      const mod = await import('./commands/status.js');
      await mod.statusCommand(opts);
    } catch (err) {
      errorExit(err instanceof Error ? err.message : String(err));
    }
  });

// ── send ────────────────────────────────────────────────────────────

program
  .command('send')
  .description('Send a message through a channel')
  .requiredOption('--channel <id>', 'channel id')
  .requiredOption('--peer <id>', 'peer id')
  .requiredOption('--session <id>', 'session id')
  .option('--message <text>', 'message text (reads stdin if omitted)')
  .option('--reply-to <id>', 'reply to message id')
  .option('--config <path>', 'config file path')
  .option('--json', 'output as JSON', false)
  .action(async (opts: {
    channel: string;
    peer: string;
    session: string;
    message?: string;
    replyTo?: string;
    config?: string;
    json: boolean;
  }) => {
    try {
      const mod = await import('./commands/send.js');
      await mod.sendCommand(opts);
    } catch (err) {
      errorExit(err instanceof Error ? err.message : String(err));
    }
  });

// ── reload ─────────────────────────────────────────────────────────

program
  .command('reload')
  .description('Reload daemon configuration')
  .option('--config <path>', 'config file path')
  .action(async (opts: { config?: string }) => {
    try {
      const mod = await import('./commands/reload.js');
      await mod.reloadCommand(opts);
    } catch (err) {
      errorExit(err instanceof Error ? err.message : String(err));
    }
  });

// ── config ─────────────────────────────────────────────────────────

const configCmd = program
  .command('config')
  .description('Configuration management');

configCmd
  .command('check')
  .description('Validate configuration file')
  .option('--config <path>', 'config file path')
  .action(async (opts: { config?: string }) => {
    try {
      const mod = await import('./commands/config-check.js');
      await mod.configCheckCommand(opts);
    } catch (err) {
      errorExit(err instanceof Error ? err.message : String(err));
    }
  });

// ── route ───────────────────────────────────────────────────────────

const routeCmd = program
  .command('route')
  .description('Manage routing rules');

routeCmd
  .command('add')
  .description('Add or update a routing rule')
  .requiredOption('--channel <id>', 'channel id')
  .requiredOption('--peer <id>', 'peer id')
  .requiredOption('--agent <id>', 'target agent id')
  .option('--config <path>', 'config file path')
  .action((opts: { channel: string; peer: string; agent: string; config?: string }) => {
    try {
      const configPath = resolveConfigPath(opts.config);
      const config = loadConfig(configPath);
      const updated = routeAdd(config, opts.channel, opts.peer, opts.agent);
      saveConfig(configPath, updated);
      process.stdout.write(`Route added: channel=${opts.channel} peer=${opts.peer} → agent=${opts.agent}\n`);
    } catch (err) {
      errorExit(err instanceof Error ? err.message : String(err));
    }
  });

routeCmd
  .command('remove')
  .description('Remove a routing rule')
  .requiredOption('--channel <id>', 'channel id')
  .requiredOption('--peer <id>', 'peer id')
  .option('--config <path>', 'config file path')
  .action((opts: { channel: string; peer: string; config?: string }) => {
    try {
      const configPath = resolveConfigPath(opts.config);
      const config = loadConfig(configPath);
      const updated = routeRemove(config, opts.channel, opts.peer);
      saveConfig(configPath, updated);
      process.stdout.write(`Route removed: channel=${opts.channel} peer=${opts.peer}\n`);
    } catch (err) {
      errorExit(err instanceof Error ? err.message : String(err));
    }
  });

routeCmd
  .command('list')
  .description('List all routing rules')
  .option('--json', 'output as JSON', false)
  .option('--config <path>', 'config file path')
  .action((opts: { json: boolean; config?: string }) => {
    try {
      const configPath = resolveConfigPath(opts.config);
      const config = loadConfig(configPath);
      const rules = routeList(config);
      if (opts.json) {
        process.stdout.write(JSON.stringify(rules, null, 2) + '\n');
      } else {
        if (rules.length === 0) {
          process.stdout.write('No routing rules configured.\n');
        } else {
          for (const r of rules) {
            process.stdout.write(`channel=${r.channel}  peer=${r.peer}  → agent=${r.agent}\n`);
          }
        }
      }
    } catch (err) {
      errorExit(err instanceof Error ? err.message : String(err));
    }
  });

// ── channel ─────────────────────────────────────────────────────────

const channelCmd = program
  .command('channel')
  .description('Manage channel instances');

channelCmd
  .command('add')
  .description('Add a new channel')
  .requiredOption('--id <id>', 'channel id')
  .requiredOption('--type <type>', 'channel type')
  .option('--set <pairs...>', 'extra key=value pairs')
  .option('--config <path>', 'config file path')
  .action((opts: { id: string; type: string; set?: string[]; config?: string }) => {
    try {
      const configPath = resolveConfigPath(opts.config);
      const config = loadConfig(configPath);
      const extra: Record<string, unknown> = {};
      if (opts.set) {
        for (const pair of opts.set) {
          const eqIdx = pair.indexOf('=');
          if (eqIdx === -1) {
            errorExit(`Invalid --set value "${pair}" (expected key=value) - Use format key=value`, 2);
          }
          extra[pair.slice(0, eqIdx)] = pair.slice(eqIdx + 1);
        }
      }
      const updated = channelAdd(config, opts.id, opts.type, Object.keys(extra).length > 0 ? extra : undefined);
      saveConfig(configPath, updated);
      process.stdout.write(`Channel added: id=${opts.id} type=${opts.type}\n`);
    } catch (err) {
      errorExit(err instanceof Error ? err.message : String(err));
    }
  });

channelCmd
  .command('remove')
  .description('Remove a channel')
  .requiredOption('--id <id>', 'channel id')
  .option('--config <path>', 'config file path')
  .action((opts: { id: string; config?: string }) => {
    try {
      const configPath = resolveConfigPath(opts.config);
      const config = loadConfig(configPath);
      const updated = channelRemove(config, opts.id);
      saveConfig(configPath, updated);
      process.stdout.write(`Channel removed: id=${opts.id}\n`);
    } catch (err) {
      errorExit(err instanceof Error ? err.message : String(err));
    }
  });

channelCmd
  .command('list')
  .description('List all channels')
  .option('--json', 'output as JSON', false)
  .option('--config <path>', 'config file path')
  .action((opts: { json: boolean; config?: string }) => {
    try {
      const configPath = resolveConfigPath(opts.config);
      const config = loadConfig(configPath);
      const channels = channelList(config);
      if (opts.json) {
        process.stdout.write(JSON.stringify(channels, null, 2) + '\n');
      } else {
        if (channels.length === 0) {
          process.stdout.write('No channels configured.\n');
        } else {
          for (const ch of channels) {
            process.stdout.write(`id=${ch.id}  type=${ch.type}  paired=${ch.paired}\n`);
          }
        }
      }
    } catch (err) {
      errorExit(err instanceof Error ? err.message : String(err));
    }
  });

channelCmd
  .command('health')
  .description('Check channel health')
  .option('--id <id>', 'specific channel id')
  .option('--json', 'output as JSON', false)
  .option('--config <path>', 'config file path')
  .action(async (opts: { id?: string; json: boolean; config?: string }) => {
    try {
      const mod = await import('./commands/status.js');
      await mod.channelHealthCommand(opts);
    } catch (err) {
      errorExit(err instanceof Error ? err.message : String(err));
    }
  });

channelCmd
  .command('pair')
  .description('Pair a channel (validate credentials)')
  .requiredOption('--id <id>', 'channel id')
  .option('--config <path>', 'config file path')
  .action(async (opts: { id: string; config?: string }) => {
    try {
      const mod = await import('./commands/start.js');
      await mod.channelPairCommand(opts);
    } catch (err) {
      errorExit(err instanceof Error ? err.message : String(err));
    }
  });

// ── agent ───────────────────────────────────────────────────────────

const agentCmd = program
  .command('agent')
  .description('Manage agent registrations');

agentCmd
  .command('add')
  .description('Register an agent inbox')
  .requiredOption('--id <id>', 'agent id')
  .requiredOption('--inbox <path>', 'inbox thread path')
  .option('--config <path>', 'config file path')
  .action((opts: { id: string; inbox: string; config?: string }) => {
    try {
      const configPath = resolveConfigPath(opts.config);
      const config = loadConfig(configPath);
      const updated = agentAdd(config, opts.id, opts.inbox);
      saveConfig(configPath, updated);
      process.stdout.write(`Agent registered: id=${opts.id} inbox=${opts.inbox}\n`);
    } catch (err) {
      errorExit(err instanceof Error ? err.message : String(err));
    }
  });

agentCmd
  .command('remove')
  .description('Remove an agent registration')
  .requiredOption('--id <id>', 'agent id')
  .option('--config <path>', 'config file path')
  .action((opts: { id: string; config?: string }) => {
    try {
      const configPath = resolveConfigPath(opts.config);
      const config = loadConfig(configPath);
      const updated = agentRemove(config, opts.id);
      saveConfig(configPath, updated);
      process.stdout.write(`Agent removed: id=${opts.id}\n`);
    } catch (err) {
      errorExit(err instanceof Error ? err.message : String(err));
    }
  });

agentCmd
  .command('list')
  .description('List all registered agents')
  .option('--json', 'output as JSON', false)
  .option('--config <path>', 'config file path')
  .action((opts: { json: boolean; config?: string }) => {
    try {
      const configPath = resolveConfigPath(opts.config);
      const config = loadConfig(configPath);
      const agents = agentList(config);
      if (opts.json) {
        process.stdout.write(JSON.stringify(agents, null, 2) + '\n');
      } else {
        if (agents.length === 0) {
          process.stdout.write('No agents registered.\n');
        } else {
          for (const a of agents) {
            process.stdout.write(`id=${a.id}  inbox=${a.inbox}\n`);
          }
        }
      }
    } catch (err) {
      errorExit(err instanceof Error ? err.message : String(err));
    }
  });

// ── Parse and run ──────────────────────────────────────────────────

program.exitOverride();

try {
  await program.parseAsync(process.argv);
} catch (err) {
  // Commander throws on usage errors (missing required options, unknown commands)
  if (err instanceof Error && 'exitCode' in err) {
    const exitCode = (err as Error & { exitCode: number }).exitCode;
    // exitCode 0 = --help or --version, let it pass
    if (exitCode !== 0) {
      process.exit(2);
    }
  }
}
