import * as pty from '@homebridge/node-pty-prebuilt-multiarch';
import {
  generateInitScript,
  writeInitScript,
  cleanupInitScript,
  detectUserShell,
} from './lib/init-script.js';
import * as path from 'path';
import { logger } from './logger.js';
import { capturePane, enableMouse, hasSessionSync } from './lib/tmux.js';
import { clampHistoryLines, DEFAULT_HISTORY_LINES, isValidSessionName } from './lib/validation.js';

const READY_DELAY_MS = 150;
const INIT_SCRIPT_CLEANUP_DELAY_MS = 5000;
const ENABLE_MOUSE_DELAY_MS = 100;

interface Disposable {
  dispose(): void;
}

export interface Terminal {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  onData(callback: (data: string) => void): Disposable;
  onExit(callback: (info: { exitCode: number }) => void): Disposable;
  kill(): void;
  detach(): void;
  captureHistory(lines?: number): Promise<string>;
  isExistingSession(): boolean;
  onReady(callback: () => void): void;
}

export interface CreateTerminalOptions {
  /** Custom environment variables to inject into the session */
  customEnvVars?: Record<string, string>;
}

export function createTerminal(
  cwd: string,
  sessionName: string,
  options: CreateTerminalOptions | Record<string, string> = {}
): Terminal {
  // The name is used as a tmux target and in a temp file name
  if (!isValidSessionName(sessionName)) {
    throw new Error('Invalid session name');
  }

  // Support both old signature (customEnvVars object) and new options object
  const customEnvVars =
    'customEnvVars' in options
      ? ((options as CreateTerminalOptions).customEnvVars ?? {})
      : (options as Record<string, string>);

  // Check if session already exists before spawning
  const existingSession = hasSessionSync(sessionName);
  logger.terminal.info({ session: sessionName, existingSession }, 'Preparing terminal');

  if (Object.keys(customEnvVars).length > 0) {
    logger.terminal.info(
      { session: sessionName, vars: Object.keys(customEnvVars) },
      'Custom env vars for injection'
    );
  }

  // Use tmux for session persistence
  // For existing sessions: use attach-session (more reliable)
  // For new sessions: use new-session with init script for clean setup
  let tmuxArgs: string[];
  let initScriptPath: string | null = null;

  // Detect test/CI environment for animation skipping
  const isTestEnv = !!(process.env.VITEST || process.env.CI || process.env.JEST_WORKER_ID);

  if (existingSession) {
    tmuxArgs = ['attach-session', '-t', `=${sessionName}`];
  } else {
    // Extract project name from cwd (last directory component)
    const projectName = path.basename(cwd) || 'unknown';

    // Detect user's preferred shell for the interactive session
    const userShell = detectUserShell();

    // Generate and write init script for new sessions
    // The init script is always sourced by bash (via --init-file)
    // So we generate it for bash, and it ends with `exec ${userShell} -i`
    // to switch to the user's preferred interactive shell
    const scriptContent = generateInitScript({
      sessionName,
      projectName,
      customEnvVars,
      shell: 'bash', // Always bash since bash sources the init-file
      targetShell: userShell, // User's preferred shell for interactive session
    });
    initScriptPath = writeInitScript(sessionName, scriptContent);

    // Spawn tmux with bash running the init script
    // The script sets up env vars, tmux config, then runs `exec ${userShell} -i`
    // -A attaches instead of failing when two clients create the same session at once
    // Use -e to pass environment variable for animation skipping in tests
    tmuxArgs = [
      'new-session',
      '-A',
      '-s',
      sessionName,
      '-c',
      cwd,
      ...(isTestEnv ? ['-e', '_247_SKIP_ANIMATION=1'] : []),
      `bash --init-file ${initScriptPath}`,
    ];
  }

  const shell = pty.spawn('tmux', tmuxArgs, {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd,
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      AGENT_247_SESSION: sessionName, // Shared session id for hooks
      CLAUDE_TMUX_SESSION: sessionName, // Also set at PTY level for hook detection
      CODEX_TMUX_SESSION: sessionName,
      PATH: `/opt/homebrew/bin:${process.env.PATH}`,
      // Ensure UTF-8 encoding for proper accent/unicode support
      LANG: process.env.LANG || 'en_US.UTF-8',
      LC_ALL: process.env.LC_ALL || 'en_US.UTF-8',
      // Suppress macOS bash deprecation warning
      BASH_SILENCE_DEPRECATION_WARNING: '1',
      // Pass CI/test detection to init script for animation skipping
      ...(isTestEnv ? { _247_SKIP_ANIMATION: '1' } : {}),
    } as { [key: string]: string },
  });

  shell.onExit(({ exitCode, signal }) => {
    logger.terminal.info({ session: sessionName, exitCode, signal }, 'Shell exited');
  });

  // Track terminal readiness state for onReady callback
  // Existing sessions are ready immediately
  let isReady = existingSession;
  const readyCallbacks: (() => void)[] = [];

  const fireReadyCallbacks = () => {
    isReady = true;
    readyCallbacks.forEach((cb) => cb());
    readyCallbacks.length = 0; // Clear the array
  };

  // Handle session initialization and readiness
  if (!existingSession) {
    // For new sessions, the init script handles env vars and tmux config
    // Fire ready callbacks once shell is likely initialized
    setTimeout(fireReadyCallbacks, READY_DELAY_MS);

    // Cleanup init script after shell has started (give it time to read the file)
    if (initScriptPath) {
      setTimeout(() => cleanupInitScript(sessionName), INIT_SCRIPT_CLEANUP_DELAY_MS);
    }
  } else {
    // For existing sessions, just ensure mouse is enabled
    // isReady is already true for existing sessions (set above)
    setTimeout(() => enableMouse(sessionName), ENABLE_MOUSE_DELAY_MS);
  }

  return {
    write: (data) => shell.write(data),
    resize: (cols, rows) => shell.resize(cols, rows),
    onData: (callback) => shell.onData(callback),
    onExit: (callback) => shell.onExit(callback),
    kill: () => shell.kill(),
    // Ending the tmux client detaches it and leaves the session running.
    // (Sending the detach key sequence would depend on the user's tmux prefix.)
    detach: () => shell.kill(),
    isExistingSession: () => existingSession,
    onReady: (callback: () => void) => {
      if (isReady) {
        callback();
      } else {
        readyCallbacks.push(callback);
      }
    },
    captureHistory: async (lines = DEFAULT_HISTORY_LINES): Promise<string> => {
      try {
        return await capturePane(sessionName, clampHistoryLines(lines));
      } catch {
        // The session may have ended between attach and capture
        return '';
      }
    },
  };
}
