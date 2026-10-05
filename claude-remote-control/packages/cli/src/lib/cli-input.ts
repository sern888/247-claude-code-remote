import chalk from 'chalk';
import { getProfileNameError, parsePort } from './config.js';

/**
 * Print an error for the user and terminate the command with a failure status.
 */
export function exitWithError(message: string): never {
  console.error(chalk.red(message));
  process.exit(1);
}

/**
 * Stop the command when a user-supplied profile name is not a safe file name.
 */
export function requireValidProfileName(profileName?: string | null): void {
  const nameError = getProfileNameError(profileName);
  if (nameError) {
    exitWithError(nameError);
  }
}

/**
 * Parse a user-supplied port, stopping the command when it is not a valid port.
 * @param value - Raw option value
 * @param source - Option name shown in the error message
 */
export function requirePort(value: string, source: string = 'port'): number {
  try {
    return parsePort(value, source);
  } catch (err) {
    return exitWithError((err as Error).message);
  }
}
