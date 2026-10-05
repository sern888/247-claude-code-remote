import { existsSync, readFileSync, writeFileSync, unlinkSync, openSync } from 'fs';
import { spawn, type ChildProcess } from 'child_process';
import { join } from 'path';
import { getAgentPaths, ensureDirectories, type AgentPaths } from './paths.js';
import { loadConfig } from './config.js';
import { isAgentCommand, readProcessCommand } from './process-identity.js';

const STOP_TIMEOUT_MS = 5000;
const STOP_POLL_INTERVAL_MS = 100;
const RESTART_DELAY_MS = 500;
const STARTUP_GRACE_MS = 500;
const STARTUP_TIMEOUT_MS = 8000;
const STARTUP_POLL_INTERVAL_MS = 250;
const HEALTH_REQUEST_TIMEOUT_MS = 1000;

export interface AgentRunStatus {
  running: boolean;
  pid?: number;
}

export interface StopResult {
  success: boolean;
  error?: string;
}

export interface StartResult {
  success: boolean;
  pid?: number;
  error?: string;
  /** Set on success: whether the agent answered its health check before the startup timeout. */
  healthy?: boolean;
}

export interface AgentLaunchSpec {
  entryPoint: string;
  command: string;
  args: string[];
  /** Whether the entry point (or its compiled .js twin) is present on disk. */
  entryPointExists: boolean;
}

/** What the PID file points at. */
type PidState =
  | 'agent' // our agent, and we may signal it
  | 'not-owned' // an agent, but owned by another user: alive, not ours to signal
  | 'foreign' // some other program that reused the PID
  | 'dead';

type Liveness = 'alive' | 'no-permission' | 'dead';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Probe a PID with signal 0. EPERM means the process exists but belongs to
 * someone else, which is not the same as being gone.
 */
function probePid(pid: number): Liveness {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM' ? 'no-permission' : 'dead';
  }
}

/**
 * Decide what a PID from the PID file refers to. A live PID alone proves nothing,
 * because PIDs are reused: the command line must also be the agent's.
 */
function inspectPid(pid: number): PidState {
  const liveness = probePid(pid);
  if (liveness === 'dead') return 'dead';

  const command = readProcessCommand(pid);
  // If the command line cannot be read at all, fall back to trusting the PID
  // file for processes we own (the behaviour before identity checks existed).
  const isAgent =
    command === null ? liveness === 'alive' : isAgentCommand(command, getAgentPaths().agentRoot);

  if (!isAgent) return 'foreign';
  return liveness === 'alive' ? 'agent' : 'not-owned';
}

function readPidFile(): number | null {
  const { pidFile } = getAgentPaths();
  if (!existsSync(pidFile)) return null;

  try {
    const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function removePidFile(): void {
  const { pidFile } = getAgentPaths();
  if (!existsSync(pidFile)) return;

  try {
    unlinkSync(pidFile);
  } catch {
    // A PID file we cannot remove is re-validated on every read, so this is safe to ignore
  }
}

/**
 * Check if the agent process is running
 */
export function isAgentRunning(): AgentRunStatus {
  const pid = readPidFile();
  if (pid === null) {
    return { running: false };
  }

  const state = inspectPid(pid);
  if (state === 'agent' || state === 'not-owned') {
    return { running: true, pid };
  }

  // Process is gone, or the PID now belongs to another program: the file is stale
  removePidFile();
  return { running: false };
}

/**
 * Work out how to launch the agent for this install (tsx in development, node otherwise).
 */
export function getAgentLaunchSpec(paths: AgentPaths): AgentLaunchSpec {
  const entryPoint = paths.isDev
    ? join(paths.agentRoot, 'src', 'index.ts')
    : join(paths.agentRoot, 'dist', 'index.js');

  return {
    entryPoint,
    command: paths.isDev ? 'npx' : paths.nodePath,
    args: paths.isDev ? ['tsx', entryPoint] : [entryPoint],
    entryPointExists: existsSync(entryPoint) || existsSync(entryPoint.replace('.ts', '.js')),
  };
}

/**
 * Environment for a spawned agent: the caller's environment plus the profile
 * and port the CLI resolved, so both sides agree on them.
 */
export function buildAgentEnv(options: {
  profileName?: string | null;
  port: number;
}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AGENT_247_PROFILE: options.profileName || '',
    AGENT_247_PORT: String(options.port),
  };
}

/**
 * Listen for a spawn failure. Without an 'error' listener Node turns a failed
 * spawn into an uncaught exception.
 */
function captureSpawnError(child: ChildProcess): () => Error | undefined {
  const errors: Error[] = [];
  child.on('error', (err: Error) => {
    errors.push(err);
  });
  return () => errors[0];
}

/**
 * Check that the agent answers on its health endpoint.
 */
async function isAgentListening(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://localhost:${port}/health`, {
      signal: AbortSignal.timeout(HEALTH_REQUEST_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Watch a freshly spawned agent until it answers its health check, dies, or
 * the startup timeout passes.
 */
async function waitForStartup(
  pid: number,
  port: number,
  getSpawnError: () => Error | undefined
): Promise<StartResult> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  await sleep(STARTUP_GRACE_MS);

  for (;;) {
    const spawnError = getSpawnError();
    if (spawnError) {
      removePidFile();
      return { success: false, error: `Failed to start agent process: ${spawnError.message}` };
    }
    if (probePid(pid) === 'dead') {
      removePidFile();
      return {
        success: false,
        error: 'Agent process exited during startup. Check logs for errors.',
      };
    }
    if (await isAgentListening(port)) {
      return { success: true, pid, healthy: true };
    }
    if (Date.now() >= deadline) {
      return { success: true, pid, healthy: false };
    }
    await sleep(STARTUP_POLL_INTERVAL_MS);
  }
}

function missingConfigError(profileName?: string | null): string {
  return profileName
    ? `Profile '${profileName}' not found. Run: 247 profile create ${profileName}`
    : 'Configuration not found. Run: 247 init';
}

/**
 * Spawn the agent detached from the CLI, logging to the agent log files.
 */
function spawnDetachedAgent(
  paths: AgentPaths,
  launch: AgentLaunchSpec,
  env: NodeJS.ProcessEnv
): ChildProcess {
  const stdout = openSync(join(paths.logDir, 'agent.log'), 'a');
  const stderr = openSync(join(paths.logDir, 'agent.error.log'), 'a');

  return spawn(launch.command, launch.args, {
    cwd: paths.agentRoot,
    detached: true,
    stdio: ['ignore', stdout, stderr],
    env,
  });
}

/**
 * Start the agent as a background daemon
 * @param profileName - Optional profile name to use
 */
export async function startAgentDaemon(profileName?: string | null): Promise<StartResult> {
  const paths = getAgentPaths();
  const config = loadConfig(profileName);

  if (!config) {
    return { success: false, error: missingConfigError(profileName) };
  }

  // Check if already running
  const status = isAgentRunning();
  if (status.running) {
    return { success: false, error: `Agent is already running (PID: ${status.pid})` };
  }

  ensureDirectories();

  const launch = getAgentLaunchSpec(paths);
  if (!launch.entryPointExists) {
    return { success: false, error: `Agent entry point not found: ${launch.entryPoint}` };
  }

  const env = buildAgentEnv({ profileName, port: config.agent.port });
  const child = spawnDetachedAgent(paths, launch, env);
  const getSpawnError = captureSpawnError(child);

  if (!child.pid) {
    // The reason for a failed spawn arrives asynchronously through the 'error' event
    await sleep(0);
    const reason = getSpawnError()?.message;
    return {
      success: false,
      error: reason ? `Failed to start agent process: ${reason}` : 'Failed to start agent process',
    };
  }

  // Write PID file
  writeFileSync(paths.pidFile, String(child.pid), 'utf-8');

  // Detach from parent
  child.unref();

  return waitForStartup(child.pid, config.agent.port, getSpawnError);
}

/**
 * Wait for a process to exit, polling without blocking the event loop.
 * @returns true if the process exited before the timeout
 */
async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (probePid(pid) !== 'dead') {
    if (Date.now() >= deadline) return false;
    await sleep(STOP_POLL_INTERVAL_MS);
  }
  return true;
}

/**
 * Stop the running agent. Only a process confirmed to be our agent is ever signalled.
 */
export async function stopAgent(): Promise<StopResult> {
  const pid = readPidFile();
  if (pid === null) {
    return { success: true }; // Already stopped
  }

  const state = inspectPid(pid);
  if (state === 'dead' || state === 'foreign') {
    removePidFile(); // Stale PID file: nothing of ours to stop
    return { success: true };
  }
  if (state === 'not-owned') {
    return {
      success: false,
      error: `Agent process (PID ${pid}) is owned by another user; refusing to signal it. Stop it as that user.`,
    };
  }

  try {
    // Send SIGTERM for graceful shutdown
    process.kill(pid, 'SIGTERM');

    // Force kill only if it is still the agent after the grace period
    const exited = await waitForExit(pid, STOP_TIMEOUT_MS);
    if (!exited && inspectPid(pid) === 'agent') {
      process.kill(pid, 'SIGKILL');
    }

    removePidFile();
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/**
 * Restart the agent
 */
export async function restartAgent(): Promise<StartResult> {
  const stopResult = await stopAgent();
  if (!stopResult.success) {
    return { success: false, error: `Failed to stop: ${stopResult.error}` };
  }

  // Wait a moment before starting
  await sleep(RESTART_DELAY_MS);

  return startAgentDaemon();
}

/**
 * Get agent health status by checking the API
 */
export async function getAgentHealth(port: number): Promise<{
  healthy: boolean;
  sessions?: number;
  error?: string;
}> {
  try {
    const response = await fetch(`http://localhost:${port}/api/sessions`);
    if (!response.ok) {
      return { healthy: false, error: `HTTP ${response.status}` };
    }
    const sessions = (await response.json()) as unknown[];
    return { healthy: true, sessions: sessions.length };
  } catch (err) {
    return { healthy: false, error: (err as Error).message };
  }
}
