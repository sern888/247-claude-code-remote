import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { createServiceManager } from '../service/index.js';

export const serviceCommand = new Command('service').description(
  'Manage the 247 agent system service'
);

serviceCommand
  .command('install')
  .description('Install 247 agent as a system service')
  .option('--start', 'Start the service after installation')
  .option('--no-enable', 'Do not enable service at boot')
  .action(async (options) => {
    const spinner = ora('Installing service...').start();

    try {
      const manager = createServiceManager();

      const status = await manager.status();
      if (status.installed) {
        spinner.warn('Service is already installed');
        console.log(chalk.dim(`  Config: ${status.configPath}`));

        if (options.start && !status.running) {
          const startSpinner = ora('Starting service...').start();
          const startResult = await manager.start();
          if (startResult.success) {
            startSpinner.succeed('Service started');
          } else {
            startSpinner.fail(`Failed to start: ${startResult.error}`);
          }
        }
        return;
      }

      const result = await manager.install({
        startNow: options.start,
        enableAtBoot: options.enable,
      });

      if (result.success) {
        spinner.succeed('Service installed successfully');
        console.log(chalk.dim(`  Config: ${result.configPath}`));

        if (options.start) {
          console.log(chalk.green('  Service is now running'));
        }

        console.log();
        console.log(chalk.dim('Useful commands:'));
        console.log(chalk.dim('  247 service status  - Check service status'));
        console.log(chalk.dim('  247 service logs    - View service logs'));
        console.log(chalk.dim('  247 service stop    - Stop the service'));
      } else {
        spinner.fail(`Failed to install service: ${result.error}`);
        process.exit(1);
      }
    } catch (err) {
      spinner.fail(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });

serviceCommand
  .command('uninstall')
  .description('Uninstall the 247 agent service')
  .action(async () => {
    const spinner = ora('Uninstalling service...').start();

    try {
      const manager = createServiceManager();

      const status = await manager.status();
      if (!status.installed) {
        spinner.info('Service is not installed');
        return;
      }

      const result = await manager.uninstall();

      if (result.success) {
        spinner.succeed('Service uninstalled successfully');
      } else {
        spinner.fail(`Failed to uninstall: ${result.error}`);
        process.exit(1);
      }
    } catch (err) {
      spinner.fail(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });

serviceCommand
  .command('start')
  .description('Start the 247 agent service')
  .action(async () => {
    const spinner = ora('Starting service...').start();

    try {
      const manager = createServiceManager();

      const status = await manager.status();
      if (!status.installed) {
        spinner.fail('Service is not installed. Run: 247 service install');
        process.exit(1);
      }

      if (status.running) {
        spinner.info('Service is already running');
        if (status.pid) {
          console.log(chalk.dim(`  PID: ${status.pid}`));
        }
        return;
      }

      const result = await manager.start();

      if (result.success) {
        spinner.succeed('Service started');
      } else {
        spinner.fail(`Failed to start: ${result.error}`);
        process.exit(1);
      }
    } catch (err) {
      spinner.fail(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });

serviceCommand
  .command('stop')
  .description('Stop the 247 agent service')
  .action(async () => {
    const spinner = ora('Stopping service...').start();

    try {
      const manager = createServiceManager();

      const status = await manager.status();
      if (!status.installed) {
        spinner.fail('Service is not installed');
        process.exit(1);
      }

      if (!status.running) {
        spinner.info('Service is not running');
        return;
      }

      const result = await manager.stop();

      if (result.success) {
        spinner.succeed('Service stopped');
      } else {
        spinner.fail(`Failed to stop: ${result.error}`);
        process.exit(1);
      }
    } catch (err) {
      spinner.fail(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });

serviceCommand
  .command('restart')
  .description('Restart the 247 agent service')
  .action(async () => {
    const spinner = ora('Restarting service...').start();

    try {
      const manager = createServiceManager();

      const status = await manager.status();
      if (!status.installed) {
        spinner.fail('Service is not installed. Run: 247 service install');
        process.exit(1);
      }

      const result = await manager.restart();

      if (result.success) {
        spinner.succeed('Service restarted');
      } else {
        spinner.fail(`Failed to restart: ${result.error}`);
        process.exit(1);
      }
    } catch (err) {
      spinner.fail(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });

serviceCommand
  .command('status')
  .description('Show service status')
  .action(async () => {
    try {
      const manager = createServiceManager();
      const status = await manager.status();

      console.log(chalk.bold('\n247 Service Status\n'));

      if (!status.installed) {
        console.log(chalk.yellow('● Not installed'));
        console.log(chalk.dim('\nRun "247 service install" to install the service.\n'));
        return;
      }

      const statusIcon = status.running ? chalk.green('●') : chalk.red('●');
      const statusText = status.running ? chalk.green('Running') : chalk.red('Stopped');

      console.log(`${statusIcon} Status: ${statusText}`);
      console.log(`  Platform: ${manager.platform}`);
      console.log(`  Service: ${manager.serviceName}`);

      if (status.pid) {
        console.log(`  PID: ${status.pid}`);
      }

      console.log(`  Enabled at boot: ${status.enabled ? 'Yes' : 'No'}`);
      console.log(`  Config: ${status.configPath}`);

      console.log();
    } catch (err) {
      console.error(chalk.red(`Error: ${(err as Error).message}`));
      process.exit(1);
    }
  });

serviceCommand
  .command('logs')
  .description('Show how to view service logs')
  .action(async () => {
    try {
      const manager = createServiceManager();
      const logs = manager.getLogPaths();

      console.log(chalk.bold('\n247 Service Logs\n'));

      if (manager.platform === 'macos') {
        console.log('View stdout logs:');
        console.log(chalk.cyan(`  tail -f "${logs.stdout}"`));
        console.log();
        console.log('View error logs:');
        console.log(chalk.cyan(`  tail -f "${logs.stderr}"`));
      } else {
        console.log('View all logs:');
        console.log(chalk.cyan(`  ${logs.stdout}`));
        console.log();
        console.log('View error logs only:');
        console.log(chalk.cyan(`  ${logs.stderr}`));
        console.log();
        console.log('Follow logs:');
        console.log(chalk.cyan(`  journalctl --user -u 247-agent -f`));
      }

      console.log();
    } catch (err) {
      console.error(chalk.red(`Error: ${(err as Error).message}`));
      process.exit(1);
    }
  });
