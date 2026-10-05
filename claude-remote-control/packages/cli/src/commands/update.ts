import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { exec } from 'child_process';
import { promisify } from 'util';
import { createServiceManager, type ServiceManager } from '../service/index.js';
import { isAgentRunning, stopAgent } from '../lib/process.js';

const execAsync = promisify(exec);

const PACKAGE_NAME = '247-cli';
const NPM_INSTALL_TIMEOUT_MS = 120_000;

/** How the agent was running when the update started. */
type AgentMode = 'service' | 'daemon' | 'none';

async function getCurrentVersion(): Promise<string> {
  const pkg = await import('../../package.json', {
    with: { type: 'json' },
  });
  return pkg.default.version;
}

/**
 * Ask npm for the latest published version, or null when it cannot be reached.
 */
async function getLatestVersion(): Promise<string | null> {
  try {
    const { stdout } = await execAsync(`npm view ${PACKAGE_NAME} version 2>/dev/null`);
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Find out whether an agent is running and who manages it. A system service
 * takes precedence; otherwise the PID file tells us about a daemon.
 */
async function detectRunningAgent(serviceManager: ServiceManager): Promise<AgentMode> {
  const serviceStatus = await serviceManager.status();
  if (serviceStatus.installed && serviceStatus.running) {
    return 'service';
  }
  return isAgentRunning().running ? 'daemon' : 'none';
}

/**
 * Stop the running agent. Reports "stopped" only when the stop actually succeeded.
 */
async function stopRunningAgent(mode: AgentMode, serviceManager: ServiceManager): Promise<boolean> {
  const stopSpinner = ora('Stopping agent...').start();
  const result = mode === 'service' ? await serviceManager.stop() : await stopAgent();

  if (!result.success) {
    stopSpinner.fail(`Failed to stop agent: ${result.error ?? 'unknown error'}`);
    console.log(chalk.dim('Update aborted, nothing was installed. Stop the agent and try again.'));
    return false;
  }

  stopSpinner.succeed('Agent stopped');
  return true;
}

/**
 * Install the requested version globally and verify npm really installed it.
 */
async function installVersion(version: string): Promise<boolean> {
  const updateSpinner = ora(`Updating to ${version} via npm...`).start();
  try {
    const { stdout, stderr } = await execAsync(`npm install -g ${PACKAGE_NAME}@${version} 2>&1`, {
      timeout: NPM_INSTALL_TIMEOUT_MS,
    });

    // Verify the installed version matches what we requested
    const { stdout: installedStr } = await execAsync(
      `npm ls -g ${PACKAGE_NAME} --depth=0 --json 2>/dev/null`
    );
    const installedVersion = JSON.parse(installedStr)?.dependencies?.[PACKAGE_NAME]?.version;

    if (installedVersion !== version) {
      updateSpinner.fail(`npm installed ${installedVersion || 'unknown'} instead of ${version}`);
      if (stderr || stdout) {
        console.log(chalk.dim('\nnpm output:'));
        console.log(chalk.dim(stderr || stdout));
      }
      console.log(chalk.dim(`\nTry: npm install -g ${PACKAGE_NAME}@${version} --force\n`));
      return false;
    }

    updateSpinner.succeed(`Updated to ${version}`);
    return true;
  } catch (err) {
    const execErr = err as Error & { stderr?: string };
    updateSpinner.fail(`Failed to update: ${execErr.message}`);
    if (execErr.stderr) {
      console.log(chalk.dim('\nnpm error output:'));
      console.log(chalk.dim(execErr.stderr));
    }
    console.log(chalk.dim(`\nTry running manually: npm install -g ${PACKAGE_NAME}@${version}\n`));
    return false;
  }
}

/**
 * Bring the agent back after the update. A service is restarted here; a daemon
 * has to be started by the newly installed CLI, so the user is told to do that.
 */
async function restartStoppedAgent(
  mode: AgentMode,
  serviceManager: ServiceManager
): Promise<boolean> {
  if (mode === 'daemon') {
    console.log(chalk.yellow('The agent was stopped for the update and is not running.'));
    console.log(chalk.dim('Start it with the new version: 247 start'));
    return true;
  }

  const startSpinner = ora('Restarting agent...').start();
  const result = await serviceManager.start();

  if (!result.success) {
    startSpinner.fail(`Failed to restart agent: ${result.error ?? 'unknown error'}`);
    console.log(chalk.dim('The update is installed. Start the agent with: 247 service start'));
    return false;
  }

  startSpinner.succeed('Agent restarted');
  return true;
}

/**
 * Stop the agent if needed, install the version, and bring the agent back.
 */
async function installWithAgentRestart(version: string): Promise<boolean> {
  const serviceManager = createServiceManager();
  const mode = await detectRunningAgent(serviceManager);
  const agentWasRunning = mode !== 'none';

  if (agentWasRunning && !(await stopRunningAgent(mode, serviceManager))) {
    return false;
  }
  if (!(await installVersion(version))) {
    return false;
  }
  if (agentWasRunning && !(await restartStoppedAgent(mode, serviceManager))) {
    return false;
  }

  console.log();
  console.log(chalk.green('✓ Update complete!'));
  console.log();
  return true;
}

/**
 * Run the update. Returns false when any step failed.
 */
async function runUpdate(checkOnly: boolean): Promise<boolean> {
  const checkSpinner = ora('Checking for updates...').start();

  const currentVersion = await getCurrentVersion();
  const latestVersion = await getLatestVersion();

  if (latestVersion === null) {
    checkSpinner.fail('Failed to check for updates. Are you connected to the internet?');
    return false;
  }

  if (currentVersion === latestVersion) {
    checkSpinner.succeed(`Already on the latest version (${currentVersion})`);
    return true;
  }

  checkSpinner.succeed(`Update available: ${currentVersion} → ${latestVersion}`);

  if (checkOnly) {
    console.log(chalk.dim('\nRun "247 update" to install the update.\n'));
    return true;
  }

  console.log();
  return installWithAgentRestart(latestVersion);
}

export const updateCommand = new Command('update')
  .description('Update 247 to the latest version')
  .option('--check', 'Only check for updates without installing')
  .action(async (options: { check?: boolean }) => {
    console.log(chalk.bold('\n247 Update\n'));

    let succeeded: boolean;
    try {
      succeeded = await runUpdate(Boolean(options.check));
    } catch (err) {
      console.error(chalk.red(`Error: ${(err as Error).message}`));
      succeeded = false;
    }

    if (!succeeded) {
      process.exit(1);
    }
  });
