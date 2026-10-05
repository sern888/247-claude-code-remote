/**
 * The only place the agent invokes tmux outside of the PTY itself.
 *
 * Every call passes an argument array (never a shell string), so request
 * data cannot be interpreted by a shell. Targets use tmux's "=" prefix for
 * exact matching; without it "proj" would also match "proj--abc".
 */

import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';
import { isValidSessionName } from './validation.js';

const execFileAsync = promisify(execFile);

// Scrollback of a busy session easily exceeds Node's 1 MB default
const CAPTURE_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
// launchd/systemd start the agent with a minimal PATH
const TMUX_PATH_PREFIX = '/opt/homebrew/bin:/usr/local/bin';
const TMUX_NO_SERVER_EXIT_CODE = 1;

export interface TmuxSession {
  name: string;
  /** Creation time in milliseconds since epoch */
  createdAt: number;
}

function tmuxEnv(): NodeJS.ProcessEnv {
  return { ...process.env, PATH: `${TMUX_PATH_PREFIX}:${process.env.PATH ?? ''}` };
}

function assertSessionName(name: string): void {
  if (!isValidSessionName(name)) {
    throw new Error('Invalid session name');
  }
}

const sessionTarget = (name: string): string => `=${name}`;
const paneTarget = (name: string): string => `=${name}:`;

/**
 * tmux exits with 1 and no output when its server is not running, which just
 * means there are no sessions. Anything else (e.g. tmux missing) is a failure.
 */
export function isNoTmuxServerError(err: unknown): boolean {
  const { code, status } = (err ?? {}) as { code?: unknown; status?: unknown };
  return code === TMUX_NO_SERVER_EXIT_CODE || status === TMUX_NO_SERVER_EXIT_CODE;
}

export function hasSessionSync(name: string): boolean {
  if (!isValidSessionName(name)) {
    return false;
  }
  try {
    execFileSync('tmux', ['has-session', '-t', sessionTarget(name)], {
      stdio: 'ignore',
      env: tmuxEnv(),
    });
    return true;
  } catch {
    return false;
  }
}

export async function hasSession(name: string): Promise<boolean> {
  if (!isValidSessionName(name)) {
    return false;
  }
  try {
    await execFileAsync('tmux', ['has-session', '-t', sessionTarget(name)], { env: tmuxEnv() });
    return true;
  } catch {
    return false;
  }
}

/**
 * Capture the last `lines` lines of scrollback. Rejects when the session
 * does not exist.
 */
export async function capturePane(
  name: string,
  lines: number,
  options: { joinLines?: boolean } = {}
): Promise<string> {
  assertSessionName(name);
  if (!Number.isInteger(lines) || lines <= 0) {
    throw new Error('lines must be a positive integer');
  }

  const args = [
    'capture-pane',
    '-t',
    paneTarget(name),
    '-p',
    '-S',
    `-${lines}`,
    ...(options.joinLines === false ? [] : ['-J']),
  ];
  const { stdout } = await execFileAsync('tmux', args, {
    env: tmuxEnv(),
    maxBuffer: CAPTURE_MAX_BUFFER_BYTES,
  });
  return stdout;
}

export async function killSession(name: string): Promise<void> {
  assertSessionName(name);
  await execFileAsync('tmux', ['kill-session', '-t', sessionTarget(name)], { env: tmuxEnv() });
}

/**
 * Type `text` into the session literally ("-l --" stops tmux from reading it
 * as key names or flags), optionally followed by Enter.
 */
export async function sendKeys(name: string, text: string, pressEnter: boolean): Promise<void> {
  assertSessionName(name);
  await execFileAsync('tmux', ['send-keys', '-t', paneTarget(name), '-l', '--', text], {
    env: tmuxEnv(),
  });
  if (pressEnter) {
    await execFileAsync('tmux', ['send-keys', '-t', paneTarget(name), 'Enter'], {
      env: tmuxEnv(),
    });
  }
}

/**
 * List running sessions. Resolves to [] when no tmux server is running and
 * rejects on real failures.
 */
export async function listSessions(): Promise<TmuxSession[]> {
  try {
    const { stdout } = await execFileAsync(
      'tmux',
      ['list-sessions', '-F', '#{session_name}|#{session_created}'],
      { env: tmuxEnv() }
    );
    return stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [name, created] = line.split('|');
        return { name, createdAt: parseInt(created, 10) * 1000 };
      });
  } catch (err) {
    if (isNoTmuxServerError(err)) {
      return [];
    }
    throw err;
  }
}

/**
 * Names of running sessions, or null when tmux could not be queried.
 * Callers must not treat null as "no sessions".
 */
export function listSessionNamesSync(): Set<string> | null {
  try {
    const output = execFileSync('tmux', ['list-sessions', '-F', '#{session_name}'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: tmuxEnv(),
    });
    return new Set(output.trim().split('\n').filter(Boolean));
  } catch (err) {
    return isNoTmuxServerError(err) ? new Set() : null;
  }
}

/**
 * Best effort: a session that vanished in the meantime is not an error.
 */
export function enableMouse(name: string): void {
  if (!isValidSessionName(name)) {
    return;
  }
  execFile(
    'tmux',
    ['set-option', '-t', paneTarget(name), 'mouse', 'on'],
    { env: tmuxEnv() },
    () => undefined
  );
}
