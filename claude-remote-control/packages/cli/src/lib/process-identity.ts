import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

/** Path fragment present in the command line of every packaged agent, whatever the install prefix. */
const PACKAGED_AGENT_MARKER = join('247-cli', 'agent');

const PS_TIMEOUT_MS = 2000;

/**
 * Read the command line of a process from /proc (Linux), for systems where `ps`
 * is missing or does not support the options used below.
 */
function readProcCommandLine(pid: number): string | null {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf-8').replace(/\0/g, ' ').trim();
  } catch {
    return null;
  }
}

/**
 * Get the command line a process was started with.
 *
 * @returns the command line, an empty string when no such process was found, or
 *          null when the command line could not be determined at all.
 */
export function readProcessCommand(pid: number): string | null {
  try {
    // Arguments are passed as an array: nothing here is interpreted by a shell.
    return execFileSync('ps', ['-ww', '-p', String(pid), '-o', 'command='], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: PS_TIMEOUT_MS,
    }).trim();
  } catch (err) {
    const fromProc = readProcCommandLine(pid);
    if (fromProc !== null) return fromProc;

    // `ps` ran and exited non-zero: it did not find the process.
    const psRan = typeof (err as { status?: unknown }).status === 'number';
    return psRan ? '' : null;
  }
}

/**
 * True when a command line belongs to the 247 agent: it runs code from this
 * install's agent directory, or from a packaged agent under another prefix
 * (for example after switching Node versions).
 */
export function isAgentCommand(command: string, agentRoot: string): boolean {
  return command.includes(agentRoot) || command.includes(PACKAGED_AGENT_MARKER);
}
