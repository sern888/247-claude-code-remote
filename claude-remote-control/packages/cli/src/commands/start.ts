import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { join } from 'path';
import { loadConfig, configExists, getProfilePath } from '../lib/config.js';
import { getAgentPaths } from '../lib/paths.js';
import {
  startAgentDaemon,
  isAgentRunning,
  getAgentLaunchSpec,
  buildAgentEnv,
} from '../lib/process.js';
import { runInForeground } from '../lib/foreground.js';
import { isAbiVersionChanged, ensureNativeModules } from '../lib/prerequisites.js';
import { requireValidProfileName } from '../lib/cli-input.js';

interface StartOptions {
  foreground?: boolean;
  profile?: string;
}

export const startCommand = new Command('start')
  .description('Start the 247 agent')
  .option('-f, --foreground', 'Run in foreground (not as daemon)')
  .option('-P, --profile <name>', 'Use a specific profile')
  .action(async (options: StartOptions, cmd: Command) => {
    // Get profile from command option or parent (global) option
    const profileName: string | undefined = options.profile || cmd.parent?.opts().profile;
    requireValidProfileName(profileName);
    const profileLabel = profileName ? ` (profile: ${profileName})` : '';

    // Check configuration
    if (!configExists(profileName)) {
      if (profileName) {
        console.log(
          chalk.red(`Profile '${profileName}' not found. Run: 247 profile create ${profileName}\n`)
        );
      } else {
        console.log(chalk.red('Configuration not found. Run: 247 init\n'));
      }
      process.exit(1);
    }

    const config = loadConfig(profileName);
    if (!config) {
      console.log(chalk.red('Failed to load configuration.\n'));
      process.exit(1);
    }

    // Check native module compatibility (auto-rebuild if Node version changed)
    if (isAbiVersionChanged()) {
      const rebuildSpinner = ora('Node version changed, rebuilding native modules...').start();
      const nativeCheck = await ensureNativeModules();
      if (nativeCheck.status === 'ok') {
        rebuildSpinner.succeed('Native modules rebuilt successfully');
      } else {
        rebuildSpinner.fail(nativeCheck.message);
        process.exit(1);
      }
    } else {
      const nativeCheck = await ensureNativeModules();
      if (nativeCheck.status === 'error') {
        console.log(chalk.red(`${nativeCheck.message}\n`));
        process.exit(1);
      }
    }

    // Check if already running
    const status = isAgentRunning();
    if (status.running) {
      console.log(chalk.yellow(`Agent is already running (PID: ${status.pid})\n`));
      console.log('Use "247 restart" to restart or "247 stop" to stop.\n');
      return;
    }

    if (options.foreground) {
      // Run in foreground
      console.log(
        chalk.blue(`Starting agent${profileLabel} in foreground on port ${config.agent.port}...\n`)
      );

      const paths = getAgentPaths();
      const launch = getAgentLaunchSpec(paths);

      if (!launch.entryPointExists) {
        console.log(chalk.red(`Agent entry point not found: ${launch.entryPoint}\n`));
        process.exit(1);
      }

      // Signals are forwarded to the agent and its exit status becomes ours
      runInForeground(launch.command, launch.args, {
        cwd: paths.agentRoot,
        stdio: 'inherit',
        env: {
          ...buildAgentEnv({ profileName, port: config.agent.port }),
          AGENT_247_CONFIG: getProfilePath(profileName),
        },
      });
    } else {
      // Run as daemon
      const spinner = ora(`Starting agent${profileLabel}...`).start();

      const result = await startAgentDaemon(profileName);

      if (!result.success) {
        spinner.fail(`Failed to start: ${result.error}`);
        process.exit(1);
      }

      const logPath = join(getAgentPaths().logDir, 'agent.log');
      const agentUrl = `http://localhost:${config.agent.port}`;

      if (result.healthy) {
        spinner.succeed(`Agent started${profileLabel} (PID: ${result.pid})`);
        console.log(chalk.dim(`  Logs: ${logPath}`));
        console.log();
        console.log(`Agent running on ${chalk.cyan(agentUrl)}`);
      } else {
        // The process is alive but has not answered its health check: do not claim success
        spinner.warn(
          `Agent process started${profileLabel} (PID: ${result.pid}) but is not answering on ${agentUrl} yet`
        );
        console.log(chalk.dim(`  Logs: ${logPath}`));
        console.log();
        console.log(chalk.yellow('Check the logs, then run "247 status" to confirm it came up.'));
      }
      console.log();
    }
  });
