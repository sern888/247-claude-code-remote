import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// Mock paths module
const mockPaths = {
  configDir: '/mock/.247',
  configPath: '/mock/.247/config.json',
  dataDir: '/mock/.247/data',
  logDir: '/mock/.247/logs',
  pidFile: '/mock/.247/agent.pid',
  agentRoot: '/mock/agent',
  isDev: false,
  nodePath: '/usr/local/bin/node',
};

vi.mock('../../src/lib/paths.js', () => ({
  getAgentPaths: () => mockPaths,
  ensureDirectories: vi.fn(),
}));

// Mock config module
vi.mock('../../src/lib/config.js', () => ({
  loadConfig: vi.fn(),
}));

// Mock fs module
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  openSync: vi.fn(() => 3), // Return fake file descriptor
}));

// Command line `ps` reports for the mocked agent process
const AGENT_COMMAND = '/usr/local/bin/node /mock/agent/dist/index.js';

// Mock child_process
vi.mock('child_process', () => ({
  spawn: vi.fn(),
  execFileSync: vi.fn(),
}));

// Store original process.kill and fetch
const originalKill = process.kill;
const originalFetch = global.fetch;

function errnoError(code: string): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(code);
  err.code = code;
  return err;
}

function createSpawnedChild(pid: number | undefined = 99999) {
  const child = new EventEmitter() as EventEmitter & { pid?: number; unref: () => void };
  child.pid = pid;
  child.unref = vi.fn();
  return child;
}

describe('CLI Process', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();

    // By default the PID in the PID file really is the agent, and it answers /health
    const { execFileSync } = await import('child_process');
    vi.mocked(execFileSync).mockReturnValue(`${AGENT_COMMAND}\n`);
    global.fetch = vi.fn().mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    // Restore process.kill and fetch
    process.kill = originalKill;
    global.fetch = originalFetch;
    vi.useRealTimers();
  });

  describe('isAgentRunning', () => {
    it('returns false if PID file does not exist', async () => {
      const { existsSync } = await import('fs');
      vi.mocked(existsSync).mockReturnValue(false);

      const { isAgentRunning } = await import('../../src/lib/process.js');
      const result = isAgentRunning();

      expect(result).toEqual({ running: false });
    });

    it('returns false if PID file contains invalid content', async () => {
      const { existsSync, readFileSync } = await import('fs');
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue('not-a-number');

      const { isAgentRunning } = await import('../../src/lib/process.js');
      const result = isAgentRunning();

      expect(result).toEqual({ running: false });
    });

    it('returns true with PID if process is running', async () => {
      const { existsSync, readFileSync } = await import('fs');
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue('12345');

      // Mock process.kill to succeed (process exists)
      process.kill = vi.fn() as any;

      const { isAgentRunning } = await import('../../src/lib/process.js');
      const result = isAgentRunning();

      expect(result).toEqual({ running: true, pid: 12345 });
      expect(process.kill).toHaveBeenCalledWith(12345, 0);
    });

    it('returns false and cleans up stale PID file if process not running', async () => {
      const { existsSync, readFileSync, unlinkSync } = await import('fs');
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue('12345');

      // Mock process.kill to throw (process doesn't exist)
      process.kill = vi.fn().mockImplementation(() => {
        throw new Error('ESRCH');
      }) as any;

      const { isAgentRunning } = await import('../../src/lib/process.js');
      const result = isAgentRunning();

      expect(result).toEqual({ running: false });
      expect(unlinkSync).toHaveBeenCalledWith('/mock/.247/agent.pid');
    });

    it('identifies the process with ps through an argument array, not a shell string', async () => {
      const { existsSync, readFileSync } = await import('fs');
      const { execFileSync } = await import('child_process');
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue('12345');
      process.kill = vi.fn() as any;

      const { isAgentRunning } = await import('../../src/lib/process.js');
      isAgentRunning();

      expect(execFileSync).toHaveBeenCalledWith(
        'ps',
        ['-ww', '-p', '12345', '-o', 'command='],
        expect.any(Object)
      );
    });

    it('treats a PID reused by another program as not running and removes the stale PID file', async () => {
      const { existsSync, readFileSync, unlinkSync } = await import('fs');
      const { execFileSync } = await import('child_process');
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue('12345');
      vi.mocked(execFileSync).mockReturnValue('vim /home/user/notes.txt\n');
      process.kill = vi.fn() as any;

      const { isAgentRunning } = await import('../../src/lib/process.js');
      const result = isAgentRunning();

      expect(result).toEqual({ running: false });
      expect(unlinkSync).toHaveBeenCalledWith('/mock/.247/agent.pid');
    });

    it('treats EPERM as alive: an agent owned by another user is reported as running', async () => {
      const { existsSync, readFileSync, unlinkSync } = await import('fs');
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue('12345');
      process.kill = vi.fn().mockImplementation(() => {
        throw errnoError('EPERM');
      }) as any;

      const { isAgentRunning } = await import('../../src/lib/process.js');
      const result = isAgentRunning();

      expect(result).toEqual({ running: true, pid: 12345 });
      expect(unlinkSync).not.toHaveBeenCalled();
    });

    it('trusts the PID file when the process cannot be identified at all', async () => {
      const { existsSync, readFileSync } = await import('fs');
      const { execFileSync } = await import('child_process');
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockImplementation((path) => {
        if (String(path).startsWith('/proc/')) throw errnoError('ENOENT');
        return '12345';
      });
      vi.mocked(execFileSync).mockImplementation(() => {
        throw errnoError('ENOENT'); // ps is not installed
      });
      process.kill = vi.fn() as any;

      const { isAgentRunning } = await import('../../src/lib/process.js');

      expect(isAgentRunning()).toEqual({ running: true, pid: 12345 });
    });
  });

  describe('startAgentDaemon', () => {
    it('returns error if config not found', async () => {
      const { loadConfig } = await import('../../src/lib/config.js');
      vi.mocked(loadConfig).mockReturnValue(null);

      const { startAgentDaemon } = await import('../../src/lib/process.js');
      const result = await startAgentDaemon();

      expect(result.success).toBe(false);
      expect(result.error).toContain('Configuration not found');
    });

    it('returns error if profile not found', async () => {
      const { loadConfig } = await import('../../src/lib/config.js');
      vi.mocked(loadConfig).mockReturnValue(null);

      const { startAgentDaemon } = await import('../../src/lib/process.js');
      const result = await startAgentDaemon('nonexistent');

      expect(result.success).toBe(false);
      expect(result.error).toContain("Profile 'nonexistent' not found");
    });

    it('returns error if agent already running', async () => {
      const { existsSync, readFileSync } = await import('fs');
      const { loadConfig } = await import('../../src/lib/config.js');

      vi.mocked(loadConfig).mockReturnValue({
        machine: { id: 'test', name: 'Test' },
        projects: { basePath: '~/Dev', whitelist: [] },
        agent: { port: 4678 },
      });

      // PID file exists and process is running
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue('12345');
      process.kill = vi.fn() as any; // Process exists

      const { startAgentDaemon } = await import('../../src/lib/process.js');
      const result = await startAgentDaemon();

      expect(result.success).toBe(false);
      expect(result.error).toContain('already running');
    });

    it('returns error if entry point not found', async () => {
      const { existsSync, readFileSync } = await import('fs');
      const { loadConfig } = await import('../../src/lib/config.js');

      vi.mocked(loadConfig).mockReturnValue({
        machine: { id: 'test', name: 'Test' },
        projects: { basePath: '~/Dev', whitelist: [] },
        agent: { port: 4678 },
      });

      // PID file doesn't exist (not running)
      vi.mocked(existsSync).mockImplementation((path) => {
        // Entry point doesn't exist
        return false;
      });

      const { startAgentDaemon } = await import('../../src/lib/process.js');
      const result = await startAgentDaemon();

      expect(result.success).toBe(false);
      expect(result.error).toContain('entry point not found');
    });

    it('spawns agent process with correct options', async () => {
      const { existsSync, readFileSync, writeFileSync } = await import('fs');
      const { loadConfig } = await import('../../src/lib/config.js');
      const { spawn } = await import('child_process');

      vi.mocked(loadConfig).mockReturnValue({
        machine: { id: 'test', name: 'Test' },
        projects: { basePath: '~/Dev', whitelist: [] },
        agent: { port: 4678 },
      });

      let callCount = 0;
      vi.mocked(existsSync).mockImplementation((path) => {
        const pathStr = String(path);
        // PID file check (first call) - not running
        if (pathStr.includes('agent.pid')) {
          callCount++;
          // First check: not running, subsequent checks: running (after spawn)
          return callCount > 1;
        }
        // Entry point exists
        if (pathStr.includes('dist/index.js')) {
          return true;
        }
        return false;
      });

      vi.mocked(readFileSync).mockReturnValue('99999');

      // Mock successful spawn
      const mockChild = createSpawnedChild(99999);
      vi.mocked(spawn).mockReturnValue(mockChild as any);

      // After spawn, process.kill should succeed
      process.kill = vi.fn() as any;

      const { startAgentDaemon } = await import('../../src/lib/process.js');
      const result = await startAgentDaemon();

      expect(spawn).toHaveBeenCalled();
      expect(writeFileSync).toHaveBeenCalledWith('/mock/.247/agent.pid', '99999', 'utf-8');
      expect(mockChild.unref).toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.pid).toBe(99999);
    });

    describe('after spawning', () => {
      const config = {
        machine: { id: 'test', name: 'Test' },
        projects: { basePath: '~/Dev', whitelist: [] },
        agent: { port: 4999 },
      };

      // Config present, entry point present, no PID file until we write one
      const arrangeSpawn = async (child: ReturnType<typeof createSpawnedChild>) => {
        const { existsSync, readFileSync } = await import('fs');
        const { loadConfig } = await import('../../src/lib/config.js');
        const { spawn } = await import('child_process');

        vi.mocked(loadConfig).mockReturnValue(config);
        vi.mocked(existsSync).mockImplementation((path) => String(path).includes('dist/index.js'));
        vi.mocked(readFileSync).mockReturnValue(String(child.pid));
        vi.mocked(spawn).mockReturnValue(child as any);
        return { spawn };
      };

      it('passes the port and profile to the agent and no unused variables', async () => {
        const { spawn } = await arrangeSpawn(createSpawnedChild());
        process.kill = vi.fn() as any;

        const { startAgentDaemon } = await import('../../src/lib/process.js');
        await startAgentDaemon('dev');

        const env = vi.mocked(spawn).mock.calls[0][2]?.env;
        expect(env?.AGENT_247_PORT).toBe('4999');
        expect(env?.AGENT_247_PROFILE).toBe('dev');
        expect(env).not.toHaveProperty('AGENT_247_DATA');
      });

      it('reports healthy once the agent answers GET /health on its port', async () => {
        await arrangeSpawn(createSpawnedChild());
        process.kill = vi.fn() as any;

        const { startAgentDaemon } = await import('../../src/lib/process.js');
        const result = await startAgentDaemon();

        expect(result).toEqual({ success: true, pid: 99999, healthy: true });
        expect(global.fetch).toHaveBeenCalledWith(
          'http://localhost:4999/health',
          expect.any(Object)
        );
      });

      it('reports the spawn failure instead of crashing on an unhandled error event', async () => {
        const child = createSpawnedChild(undefined);
        const { spawn } = await arrangeSpawn(child);
        vi.mocked(spawn).mockImplementation(() => {
          process.nextTick(() => child.emit('error', errnoError('ENOENT')));
          return child as any;
        });

        const { startAgentDaemon } = await import('../../src/lib/process.js');
        const result = await startAgentDaemon();

        expect(result.success).toBe(false);
        expect(result.error).toContain('ENOENT');
      });

      it('fails and removes the PID file when the agent dies during startup', async () => {
        const { unlinkSync, existsSync } = await import('fs');
        await arrangeSpawn(createSpawnedChild());
        vi.mocked(existsSync).mockImplementation((path) => {
          const pathStr = String(path);
          return pathStr.includes('dist/index.js') || pathStr.includes('agent.pid');
        });
        // No PID file before the spawn; afterwards the process is already gone
        const { readFileSync } = await import('fs');
        vi.mocked(readFileSync).mockReturnValue('');
        process.kill = vi.fn().mockImplementation(() => {
          throw errnoError('ESRCH');
        }) as any;

        const { startAgentDaemon } = await import('../../src/lib/process.js');
        const result = await startAgentDaemon();

        expect(result.success).toBe(false);
        expect(result.error).toContain('exited');
        expect(unlinkSync).toHaveBeenCalledWith('/mock/.247/agent.pid');
        expect(global.fetch).not.toHaveBeenCalled();
      });

      it('does not claim a healthy start when the agent never answers /health', async () => {
        vi.useFakeTimers();
        await arrangeSpawn(createSpawnedChild());
        process.kill = vi.fn() as any;
        global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

        const { startAgentDaemon } = await import('../../src/lib/process.js');
        const pending = startAgentDaemon();
        await vi.advanceTimersByTimeAsync(60_000);
        const result = await pending;

        expect(result).toEqual({ success: true, pid: 99999, healthy: false });
      });
    });
  });

  describe('stopAgent', () => {
    it('returns success if agent not running', async () => {
      const { existsSync } = await import('fs');
      vi.mocked(existsSync).mockReturnValue(false);

      const { stopAgent } = await import('../../src/lib/process.js');
      const result = await stopAgent();

      expect(result.success).toBe(true);
    });

    it('sends SIGTERM to running agent', async () => {
      const { existsSync, readFileSync, unlinkSync } = await import('fs');

      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue('12345');

      let killCallCount = 0;
      process.kill = vi.fn().mockImplementation((pid, signal) => {
        killCallCount++;
        // First call (signal 0 check in isAgentRunning) - process exists
        // Second call (SIGTERM) - succeeds
        // Third call (signal 0 check in loop) - process gone
        if (killCallCount >= 3) {
          throw new Error('ESRCH');
        }
      }) as any;

      const { stopAgent } = await import('../../src/lib/process.js');
      const result = await stopAgent();

      expect(result.success).toBe(true);
      expect(process.kill).toHaveBeenCalledWith(12345, 'SIGTERM');
      expect(unlinkSync).toHaveBeenCalledWith('/mock/.247/agent.pid');
    });

    it('returns error if kill fails', async () => {
      const { existsSync, readFileSync } = await import('fs');

      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue('12345');

      let killCallCount = 0;
      process.kill = vi.fn().mockImplementation((pid, signal) => {
        killCallCount++;
        // First call (signal 0 check) - process exists
        if (killCallCount === 1) return true;
        // Second call (SIGTERM) - permission denied
        throw new Error('EPERM: operation not permitted');
      }) as any;

      const { stopAgent } = await import('../../src/lib/process.js');
      const result = await stopAgent();

      expect(result.success).toBe(false);
      expect(result.error).toContain('EPERM');
    });

    it('never signals a PID that was reused by another program', async () => {
      const { existsSync, readFileSync, unlinkSync } = await import('fs');
      const { execFileSync } = await import('child_process');
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue('12345');
      vi.mocked(execFileSync).mockReturnValue('/usr/bin/postgres -D /var/lib/postgres\n');
      process.kill = vi.fn() as any;

      const { stopAgent } = await import('../../src/lib/process.js');
      const result = await stopAgent();

      expect(result.success).toBe(true);
      expect(process.kill).not.toHaveBeenCalledWith(12345, 'SIGTERM');
      expect(process.kill).not.toHaveBeenCalledWith(12345, 'SIGKILL');
      expect(unlinkSync).toHaveBeenCalledWith('/mock/.247/agent.pid');
    });

    it('refuses to kill an agent owned by another user', async () => {
      const { existsSync, readFileSync, unlinkSync } = await import('fs');
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue('12345');
      process.kill = vi.fn().mockImplementation(() => {
        throw errnoError('EPERM');
      }) as any;

      const { stopAgent } = await import('../../src/lib/process.js');
      const result = await stopAgent();

      expect(result.success).toBe(false);
      expect(result.error).toContain('another user');
      expect(process.kill).not.toHaveBeenCalledWith(12345, 'SIGTERM');
      expect(process.kill).not.toHaveBeenCalledWith(12345, 'SIGKILL');
      expect(unlinkSync).not.toHaveBeenCalled();
    });

    it('waits with timers instead of blocking, then force kills an agent that ignores SIGTERM', async () => {
      vi.useFakeTimers();
      const { existsSync, readFileSync, unlinkSync } = await import('fs');
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue('12345');
      process.kill = vi.fn() as any; // never exits on its own

      const { stopAgent } = await import('../../src/lib/process.js');
      let settled = false;
      const pending = stopAgent().then((result) => {
        settled = true;
        return result;
      });

      await vi.advanceTimersByTimeAsync(1000);
      expect(settled).toBe(false);
      expect(process.kill).not.toHaveBeenCalledWith(12345, 'SIGKILL');

      await vi.advanceTimersByTimeAsync(10_000);
      const result = await pending;

      expect(result.success).toBe(true);
      expect(process.kill).toHaveBeenCalledWith(12345, 'SIGKILL');
      expect(unlinkSync).toHaveBeenCalledWith('/mock/.247/agent.pid');
    });
  });

  describe('getAgentHealth', () => {
    it('returns healthy with session count on success', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([{ id: '1' }, { id: '2' }]),
      });
      global.fetch = mockFetch;

      const { getAgentHealth } = await import('../../src/lib/process.js');
      const result = await getAgentHealth(4678);

      expect(result).toEqual({ healthy: true, sessions: 2 });
      expect(mockFetch).toHaveBeenCalledWith('http://localhost:4678/api/sessions');
    });

    it('returns unhealthy on HTTP error', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      });
      global.fetch = mockFetch;

      const { getAgentHealth } = await import('../../src/lib/process.js');
      const result = await getAgentHealth(4678);

      expect(result).toEqual({ healthy: false, error: 'HTTP 500' });
    });

    it('returns unhealthy on network error', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('Connection refused'));
      global.fetch = mockFetch;

      const { getAgentHealth } = await import('../../src/lib/process.js');
      const result = await getAgentHealth(4678);

      expect(result).toEqual({ healthy: false, error: 'Connection refused' });
    });
  });

  describe('restartAgent', () => {
    it('stops and starts the agent', async () => {
      const { existsSync, readFileSync, writeFileSync } = await import('fs');
      const { loadConfig } = await import('../../src/lib/config.js');
      const { spawn } = await import('child_process');

      vi.mocked(loadConfig).mockReturnValue({
        machine: { id: 'test', name: 'Test' },
        projects: { basePath: '~/Dev', whitelist: [] },
        agent: { port: 4678 },
      });

      // Track state: initially running, then stopped, then running again
      let agentState = 'running';
      let callCount = 0;

      vi.mocked(existsSync).mockImplementation((path) => {
        const pathStr = String(path);
        if (pathStr.includes('agent.pid')) {
          return agentState !== 'stopped';
        }
        if (pathStr.includes('dist/index.js')) {
          return true;
        }
        return false;
      });

      vi.mocked(readFileSync).mockReturnValue('12345');

      // Mock process.kill for stop and status checks
      process.kill = vi.fn().mockImplementation((pid, signal) => {
        callCount++;
        if (agentState === 'stopped') {
          throw new Error('ESRCH');
        }
        if (signal === 'SIGTERM') {
          agentState = 'stopped';
        }
      }) as any;

      // Mock spawn for start
      const mockChild = createSpawnedChild(99999);
      vi.mocked(spawn).mockImplementation(() => {
        // After spawn, mark as running
        setTimeout(() => {
          agentState = 'running';
        }, 0);
        return mockChild as any;
      });

      // After spawn completes, update state
      vi.mocked(readFileSync).mockImplementation(() => {
        if (agentState === 'running' && callCount > 2) {
          return '99999';
        }
        return '12345';
      });

      const { restartAgent } = await import('../../src/lib/process.js');
      const result = await restartAgent();

      expect(process.kill).toHaveBeenCalledWith(12345, 'SIGTERM');
      expect(spawn).toHaveBeenCalled();
    });
  });
});
