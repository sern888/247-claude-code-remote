import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { stopAgent, isAgentRunning } from '../lib/process.js';

export const stopCommand = new Command('stop')
  .description('Stop the 247 agent')
  .action(async () => {
    const status = isAgentRunning();

    if (!status.running) {
      console.log(chalk.yellow('Agent is not running.\n'));
      return;
    }

    const spinner = ora(`Stopping agent (PID: ${status.pid})...`).start();

    const result = await stopAgent();

    if (result.success) {
      spinner.succeed('Agent stopped');
    } else {
      spinner.fail(`Failed to stop: ${result.error}`);
      process.exit(1);
    }
  });
