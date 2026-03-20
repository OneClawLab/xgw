import { resolveConfigPath, loadConfig, validateConfig } from '../config.js';

/**
 * Validate the configuration file and report any errors.
 * Requirement 1.4
 */
export async function configCheckCommand(opts: { config?: string }): Promise<void> {
  const configPath = resolveConfigPath(opts.config);

  // loadConfig throws on missing file or invalid YAML
  const config = loadConfig(configPath);

  const result = validateConfig(config);
  if (!result.valid) {
    for (const err of result.errors) {
      process.stderr.write(`Error: ${err}\n`);
    }
    process.exit(1);
  }

  process.stdout.write(`Config OK: ${configPath}\n`);
}
