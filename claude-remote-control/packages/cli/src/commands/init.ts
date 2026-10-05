import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import enquirer from 'enquirer';
import { hostname } from 'os';
import { checkAllPrerequisites, allRequiredMet } from '../lib/prerequisites.js';
import {
  createConfig,
  saveConfig,
  configExists,
  loadConfig,
  getProfilePath,
} from '../lib/config.js';
import { ensureDirectories } from '../lib/paths.js';
import { requirePort, requireValidProfileName } from '../lib/cli-input.js';

interface InitOptions {
  name?: string;
  port: string;
  projects: string;
  force?: boolean;
  profile?: string;
}

async function promptForText(name: string, message: string, initial: string): Promise<string> {
  const response = await enquirer.prompt<Record<string, string>>({
    type: 'input',
    name,
    message,
    initial,
  });
  return response[name];
}

export const initCommand = new Command('init')
  .description('Initialize 247 agent configuration')
  .option('-n, --name <name>', 'Machine name')
  .option('-p, --port <port>', 'Agent port', '4678')
  .option('--projects <path>', 'Projects base path', '~/Dev')
  .option('-f, --force', 'Overwrite existing configuration')
  .option('-P, --profile <name>', 'Create or update a named profile')
  .action(async (options: InitOptions, cmd: Command) => {
    // Get profile from command option or parent (global) option
    const profileName: string | undefined = options.profile || cmd.parent?.opts().profile;
    requireValidProfileName(profileName);
    const port = requirePort(options.port, '--port');
    const profileLabel = profileName ? ` (profile: ${profileName})` : '';

    console.log(`
  ╭──────────────────────────────────╮
  │  247 - The Vibe Company          │
  │  Access Claude Code 24/7         │
  ╰──────────────────────────────────╯
`);

    // Check if config already exists
    if (configExists(profileName) && !options.force) {
      const existing = loadConfig(profileName);
      console.log(chalk.yellow(`Configuration${profileLabel} already exists:`));
      console.log(`  Machine: ${existing?.machine.name}`);
      console.log(`  Port: ${existing?.agent.port}`);
      console.log(`  Projects: ${existing?.projects.basePath}`);
      console.log('\nUse --force to overwrite.\n');
      return;
    }

    // Check prerequisites
    const spinner = ora('Checking prerequisites...').start();
    const checks = await checkAllPrerequisites(port);
    spinner.stop();

    console.log(chalk.dim('Prerequisites:'));
    for (const check of checks) {
      const icon =
        check.status === 'ok'
          ? chalk.green('✓')
          : check.status === 'warn'
            ? chalk.yellow('!')
            : chalk.red('✗');
      console.log(`  ${icon} ${check.name}: ${check.message}`);
    }
    console.log();

    if (!allRequiredMet(checks)) {
      console.log(chalk.red('Please fix the errors above before continuing.\n'));
      process.exit(1);
    }

    // Gather configuration
    // Both values are prompted for unless the machine name was given on the command line
    const machineName =
      options.name || (await promptForText('machineName', 'Machine name:', hostname()));
    const projectsPath = options.name
      ? options.projects
      : await promptForText('projectsPath', 'Projects directory:', options.projects);

    // Create and save configuration
    const configSpinner = ora(`Creating configuration${profileLabel}...`).start();
    try {
      ensureDirectories();
      const config = createConfig({
        machineName,
        port,
        projectsPath,
      });
      saveConfig(config, profileName);
      configSpinner.succeed(`Configuration${profileLabel} saved`);

      const configPath = getProfilePath(profileName);
      console.log(chalk.dim(`  → ${configPath}`));
    } catch (err) {
      configSpinner.fail(`Failed to create configuration: ${(err as Error).message}`);
      process.exit(1);
    }

    // Success message
    console.log(chalk.green(`\n✓ Setup${profileLabel} complete!\n`));

    console.log('Next steps:');
    if (profileName) {
      console.log(
        chalk.cyan(`  247 start --profile ${profileName}`) +
          chalk.dim('   # Start the agent with this profile')
      );
      console.log(
        chalk.cyan(`  247 profile show ${profileName}`) +
          chalk.dim('     # View profile configuration')
      );
    } else {
      console.log(chalk.cyan('  247 start                   ') + chalk.dim('# Start the agent'));
      console.log(
        chalk.cyan('  247 service install --start ') + chalk.dim('# Install as system service')
      );
    }
    console.log();
  });
