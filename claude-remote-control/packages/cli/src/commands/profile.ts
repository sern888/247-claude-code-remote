import { Command } from 'commander';
import chalk from 'chalk';
import {
  type AgentConfig,
  listProfiles,
  loadConfig,
  loadStoredConfig,
  saveConfig,
  deleteProfile,
  profileExists,
  createConfig,
  copyConfigForNewProfile,
  getProfilePath,
} from '../lib/config.js';
import { exitWithError, requirePort, requireValidProfileName } from '../lib/cli-input.js';

interface CreateOptions {
  port: string;
  machineName?: string;
  copyFrom?: string;
}

interface SetOptions {
  port?: string;
  machineName?: string;
  projectsPath?: string;
}

/**
 * Build the config for `profile create`, either from defaults or from the
 * stored (not env-overridden) config of another profile.
 */
function buildNewProfileConfig(name: string, options: CreateOptions): AgentConfig {
  const port = requirePort(options.port, '--port');

  if (!options.copyFrom) {
    return createConfig({ machineName: options.machineName || `${name} agent`, port });
  }

  requireValidProfileName(options.copyFrom);
  const sourceConfig = loadStoredConfig(
    options.copyFrom === 'default' ? undefined : options.copyFrom
  );
  if (!sourceConfig) {
    return exitWithError(`Source profile '${options.copyFrom}' does not exist.`);
  }

  return copyConfigForNewProfile(sourceConfig, { port, machineName: options.machineName });
}

/**
 * Apply `profile set` options to a stored config without mutating it.
 * Returns null when no option was given.
 */
function applyProfileUpdates(config: AgentConfig, options: SetOptions): AgentConfig | null {
  if (!options.port && !options.machineName && !options.projectsPath) {
    return null;
  }

  return {
    ...config,
    agent: options.port
      ? { ...config.agent, port: requirePort(options.port, '--port') }
      : config.agent,
    machine: options.machineName
      ? { ...config.machine, name: options.machineName }
      : config.machine,
    projects: options.projectsPath
      ? { ...config.projects, basePath: options.projectsPath }
      : config.projects,
  };
}

export const profileCommand = new Command('profile')
  .description('Manage configuration profiles')
  .addCommand(
    new Command('list')
      .alias('ls')
      .description('List all profiles')
      .action(() => {
        const profiles = listProfiles();

        if (profiles.length === 0) {
          console.log(chalk.yellow('No profiles found. Run `247 init` to create one.'));
          return;
        }

        console.log(chalk.bold('\nAvailable profiles:\n'));
        for (const profile of profiles) {
          const config = loadConfig(profile === 'default' ? undefined : profile);
          const port = config?.agent.port ?? '?';
          const isDefault = profile === 'default';

          console.log(
            `  ${isDefault ? chalk.green('*') : ' '} ${chalk.cyan(profile.padEnd(15))} ${chalk.dim(`port: ${port}`)}`
          );
        }
        console.log();
      })
  )
  .addCommand(
    new Command('show')
      .argument('[name]', 'Profile name', 'default')
      .description('Show profile configuration')
      .action((name: string) => {
        requireValidProfileName(name);
        const profileName = name === 'default' ? undefined : name;

        if (!profileExists(profileName)) {
          console.error(chalk.red(`Profile '${name}' does not exist.`));
          process.exit(1);
        }

        const config = loadConfig(profileName);
        if (!config) {
          console.error(chalk.red(`Failed to load profile '${name}'.`));
          process.exit(1);
        }

        console.log(chalk.bold(`\nProfile: ${chalk.cyan(name)}`));
        console.log(chalk.dim(`Path: ${getProfilePath(profileName)}\n`));
        // Never print the bearer token to the terminal (scrollback, screenshots,
        // CI logs): redact it while still showing it is set.
        const display = config.agent?.authToken
          ? { ...config, agent: { ...config.agent, authToken: '***redacted***' } }
          : config;
        console.log(JSON.stringify(display, null, 2));
        console.log();
      })
  )
  .addCommand(
    new Command('create')
      .argument('<name>', 'Profile name')
      .option('-p, --port <port>', 'Agent port', '4678')
      .option('-n, --machine-name <name>', 'Machine display name')
      .option('--copy-from <profile>', 'Copy settings from existing profile')
      .description('Create a new profile')
      .action((name: string, options: CreateOptions) => {
        requireValidProfileName(name);

        if (name === 'default') {
          console.error(
            chalk.red('Cannot create a profile named "default". Use `247 init` instead.')
          );
          process.exit(1);
        }

        if (profileExists(name)) {
          console.error(
            chalk.red(`Profile '${name}' already exists. Use 'profile show ${name}' to view it.`)
          );
          process.exit(1);
        }

        const config = buildNewProfileConfig(name, options);

        saveConfig(config, name);

        console.log(chalk.green(`\n✓ Profile '${name}' created successfully!`));
        console.log(chalk.dim(`  Port: ${config.agent.port}`));
        console.log(chalk.dim(`  Path: ${getProfilePath(name)}`));
        console.log();
        console.log(`Start with: ${chalk.cyan(`247 start --profile ${name}`)}`);
        console.log();
      })
  )
  .addCommand(
    new Command('delete')
      .alias('rm')
      .argument('<name>', 'Profile name')
      .option('-f, --force', 'Skip confirmation')
      .description('Delete a profile')
      .action(async (name: string, options: { force?: boolean }) => {
        requireValidProfileName(name);

        if (name === 'default') {
          console.error(chalk.red('Cannot delete the default profile.'));
          process.exit(1);
        }

        if (!profileExists(name)) {
          console.error(chalk.red(`Profile '${name}' does not exist.`));
          process.exit(1);
        }

        if (!options.force) {
          const { prompt } = await import('enquirer');
          const answer = await prompt<{ confirm: boolean }>({
            type: 'confirm',
            name: 'confirm',
            message: `Are you sure you want to delete profile '${name}'?`,
            initial: false,
          });

          if (!answer.confirm) {
            console.log(chalk.dim('Cancelled.'));
            return;
          }
        }

        deleteProfile(name);
        console.log(chalk.green(`\n✓ Profile '${name}' deleted.`));
        console.log();
      })
  )
  .addCommand(
    new Command('set')
      .argument('<name>', 'Profile name')
      .option('-p, --port <port>', 'Agent port')
      .option('-n, --machine-name <name>', 'Machine display name')
      .option('--projects-path <path>', 'Projects base path')
      .description('Update profile settings')
      .action((name: string, options: SetOptions) => {
        requireValidProfileName(name);
        const profileName = name === 'default' ? undefined : name;

        if (!profileExists(profileName)) {
          console.error(chalk.red(`Profile '${name}' does not exist.`));
          process.exit(1);
        }

        // Start from what is on disk: env overrides must not be saved permanently
        const storedConfig = loadStoredConfig(profileName);
        if (!storedConfig) {
          console.error(chalk.red(`Failed to load profile '${name}'.`));
          process.exit(1);
        }

        const updatedConfig = applyProfileUpdates(storedConfig, options);
        if (!updatedConfig) {
          console.log(
            chalk.yellow('No changes specified. Use --port, --machine-name, or --projects-path.')
          );
          return;
        }

        saveConfig(updatedConfig, profileName);
        console.log(chalk.green(`\n✓ Profile '${name}' updated.`));
        console.log();
      })
  );
