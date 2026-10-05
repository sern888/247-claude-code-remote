import { spawn, type ChildProcess, type SpawnOptions } from 'child_process';
import { constants } from 'os';
import chalk from 'chalk';

/** Signals handed on to the child so it can shut down gracefully. */
const FORWARDED_SIGNALS = ['SIGINT', 'SIGTERM'] as const;

/** Shells report "killed by signal N" as exit status 128 + N. */
const SIGNAL_EXIT_BASE = 128;
const FAILURE_EXIT_CODE = 1;

/** The parts of `process` the foreground runner depends on (replaceable in tests). */
export interface ForegroundHost {
  on(event: NodeJS.Signals, listener: () => void): unknown;
  off(event: NodeJS.Signals, listener: () => void): unknown;
  exit(code: number): void;
}

/**
 * Exit status the CLI should finish with for a finished child process: the
 * child's own exit code, or 128 + signal number when it was killed by a signal.
 */
export function exitCodeFromChild(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;

  const signalNumber = signal ? constants.signals[signal] : undefined;
  return signalNumber ? SIGNAL_EXIT_BASE + signalNumber : FAILURE_EXIT_CODE;
}

/**
 * Forward termination signals received by the host to the child.
 * @returns a function that stops forwarding
 */
function forwardSignals(child: ChildProcess, host: ForegroundHost): () => void {
  const listeners = FORWARDED_SIGNALS.map((signal) => {
    const listener = (): void => {
      child.kill(signal);
    };
    host.on(signal, listener);
    return { signal, listener };
  });

  return () => {
    for (const { signal, listener } of listeners) {
      host.off(signal, listener);
    }
  };
}

/**
 * Run a command attached to the terminal until it finishes. SIGINT and SIGTERM
 * are forwarded to it, and the host exits with the command's exit status.
 */
export function runInForeground(
  command: string,
  args: string[],
  options: SpawnOptions,
  host: ForegroundHost = process
): ChildProcess {
  const child = spawn(command, args, options);
  const stopForwarding = forwardSignals(child, host);

  child.on('error', (err) => {
    stopForwarding();
    console.error(chalk.red(`Failed to start: ${err.message}`));
    host.exit(FAILURE_EXIT_CODE);
  });

  child.on('exit', (code, signal) => {
    stopForwarding();
    host.exit(exitCodeFromChild(code, signal));
  });

  return child;
}
