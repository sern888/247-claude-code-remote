/**
 * Integration tests for `247 start` and `247 stop` command workflows
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  mockPaths,
  validConfig,
  createMockFsState,
  createMockChild,
  createProcessKillMock,
  captureConsole,
  setupDefaultDirectories,
  setupAgentEntryPoint,
  setupExistingConfig,
  setupHooksSource,
  type MockFsState,
  type CapturedOutput,
} from '../helpers/mock-system.js';

// ============= MOCK SETUP =============

let fsState: MockFsState;
let runningPids: Set<number>;
let output: CapturedOutput;
let processExitSpy: ReturnType<typeof vi.spyOn>;
const originalKill = process.kill;

// Mock paths module
vi.mock('../../src/lib/paths.js', () => ({
  getAgentPaths: () => mockPaths,
  ensureDirectories: vi.fn(),
}));

// Mock fs module
vi.mock('fs', () => ({
  existsSync: vi.fn((path: string) => fsState?.files.has(path) || fsState?.directories.has(path)),
  readFileSync: vi.fn((path: string) => {
    const content = fsState?.files.get(path);
    if (content === undefined) throw new Error('ENOENT');
    return content;
  }),
  writeFileSync: vi.fn((path: string, content: string) => {
    fsState?.files.set(path, content);
  }),
  chmodSync: vi.fn(),
  mkdirSync: vi.fn((path: string) => {
    fsState?.directories.add(path);
  }),
  unlinkSync: vi.fn((path: string) => {
    fsState?.files.delete(path);
  }),
  readdirSync: vi.fn(() => []),
  openSync: vi.fn(() => 3),
}));

// Mock child_process
vi.mock('child_process', () => ({
  spawn: vi.fn(),
  execSync: vi.fn(() => 'tmux 3.4'),
  // `ps` output used to confirm that a PID really is the agent
  execFileSync: vi.fn(() => '/usr/local/bin/node /mock/agent/dist/index.js\n'),
}));

// Mock ora - capture messages to output
vi.mock('ora', () => ({
  default: vi.fn(() => {
    const spinner = {
      text: '',
      start: vi.fn(function (this: any, text?: string) {
        if (text) this.text = text;
        return this;
      }),
      stop: vi.fn().mockReturnThis(),
      succeed: vi.fn(function (this: any, text?: string) {
        console.log(text || this.text);
        return this;
      }),
      fail: vi.fn(function (this: any, text?: string) {
        console.log(text || this.text);
        return this;
      }),
      warn: vi.fn(function (this: any, text?: string) {
        console.log(text || this.text);
        return this;
      }),
      info: vi.fn().mockReturnThis(),
    };
    return spinner;
  }),
}));

// Mock chalk
vi.mock('chalk', () => ({
  default: {
    red: (s: string) => s,
    green: (s: string) => s,
    yellow: (s: string) => s,
    blue: (s: string) => s,
    cyan: (s: string) => s,
    dim: (s: string) => s,
  },
}));

// Mock net module for port checking
vi.mock('net', () => {
  return {
    createServer: vi.fn(() => {
      const listeners: Record<string, Array<() => void>> = {};
      return {
        listen: vi.fn(function (this: any, _port: number, _host: string) {
          setImmediate(() => {
            listeners['listening']?.forEach((cb) => cb());
          });
          return this;
        }),
        close: vi.fn(),
        once: vi.fn(function (this: any, event: string, callback: () => void) {
          if (!listeners[event]) listeners[event] = [];
          listeners[event].push(callback);
          return this;
        }),
      };
    }),
  };
});

// ============= TESTS =============

describe('247 start workflow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();

    // Reset state
    fsState = createMockFsState();
    runningPids = new Set();
    setupDefaultDirectories(fsState);
    setupAgentEntryPoint(fsState);
    setupHooksSource(fsState);
    output = captureConsole();

    // Mock process.kill
    process.kill = createProcessKillMock(runningPids) as any;

    // The spawned agent answers its health check
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));

    // Mock process.exit
    processExitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    process.kill = originalKill;
  });

  describe('without configuration', () => {
    it('exits with error and suggests running init', async () => {
      // No config file exists

      const { startCommand } = await import('../../src/commands/start.js');

      await expect(startCommand.parseAsync(['node', '247', 'start'])).rejects.toThrow(
        'process.exit(1)'
      );

      expect(output.logs.some((l) => l.includes('247 init'))).toBe(true);
    });

    it('shows profile-specific error when profile not found', async () => {
      // Default config exists but not the requested profile
      setupExistingConfig(fsState);

      const { startCommand } = await import('../../src/commands/start.js');

      await expect(
        startCommand.parseAsync(['node', '247', 'start', '--profile', 'nonexistent'])
      ).rejects.toThrow('process.exit(1)');

      expect(output.logs.some((l) => l.includes('nonexistent'))).toBe(true);
    });

    it('rejects an unsafe profile name before touching the filesystem', async () => {
      setupExistingConfig(fsState);
      const { spawn } = await import('child_process');

      const { startCommand } = await import('../../src/commands/start.js');

      await expect(
        startCommand.parseAsync(['node', '247', 'start', '--profile', '../../etc/passwd'])
      ).rejects.toThrow('process.exit(1)');

      expect(output.errors.join(' ')).toContain('Invalid profile name');
      expect(spawn).not.toHaveBeenCalled();
    });
  });

  describe('with configuration', () => {
    beforeEach(() => {
      setupExistingConfig(fsState);
    });

    it('warns if agent is already running', async () => {
      // Agent is already running
      fsState.files.set(mockPaths.pidFile, '12345');
      runningPids.add(12345);

      const { startCommand } = await import('../../src/commands/start.js');
      await startCommand.parseAsync(['node', '247', 'start']);

      expect(output.logs.some((l) => l.includes('already running'))).toBe(true);
      expect(output.logs.some((l) => l.includes('12345'))).toBe(true);
    });

    it('spawns agent as daemon and writes PID file', async () => {
      const { spawn } = await import('child_process');

      // Create mock child process
      const mockChild = createMockChild({ pid: 99999 });
      vi.mocked(spawn).mockReturnValue(mockChild as any);

      // After spawn, mark PID as running
      runningPids.add(99999);

      const { startCommand } = await import('../../src/commands/start.js');
      await startCommand.parseAsync(['node', '247', 'start']);

      // Verify spawn was called
      expect(spawn).toHaveBeenCalled();

      // Verify PID file was written
      expect(fsState.files.get(mockPaths.pidFile)).toBe('99999');

      // Verify unref was called (detached process)
      expect(mockChild.unref).toHaveBeenCalled();
    });

    it('exits with error if agent entry point is missing', async () => {
      // Remove agent entry point
      fsState.files.delete('/mock/agent/dist/index.js');

      const { startCommand } = await import('../../src/commands/start.js');

      await expect(startCommand.parseAsync(['node', '247', 'start'])).rejects.toThrow(
        'process.exit(1)'
      );

      expect(output.logs.some((l) => l.includes('entry point') || l.includes('not found'))).toBe(
        true
      );
    });

    it('tells the agent which port and profile to use', async () => {
      const profileConfig = { ...validConfig, agent: { port: 5000 } };
      fsState.files.set(`${mockPaths.profilesDir}/dev.json`, JSON.stringify(profileConfig));

      const { spawn } = await import('child_process');
      vi.mocked(spawn).mockReturnValue(createMockChild({ pid: 77777 }) as any);
      runningPids.add(77777);

      const { startCommand } = await import('../../src/commands/start.js');
      await startCommand.parseAsync(['node', '247', 'start', '--profile', 'dev']);

      const env = vi.mocked(spawn).mock.calls[0][2]?.env;
      expect(env?.AGENT_247_PORT).toBe('5000');
      expect(env?.AGENT_247_PROFILE).toBe('dev');
      expect(fetch).toHaveBeenCalledWith('http://localhost:5000/health', expect.any(Object));
    });

    it('reports success only after the agent answers its health check', async () => {
      const { spawn } = await import('child_process');
      vi.mocked(spawn).mockReturnValue(createMockChild({ pid: 99999 }) as any);
      runningPids.add(99999);

      const { startCommand } = await import('../../src/commands/start.js');
      await startCommand.parseAsync(['node', '247', 'start']);

      expect(output.logs.some((l) => l.includes('Agent started (PID: 99999)'))).toBe(true);
      expect(output.logs.some((l) => l.includes('Agent running on'))).toBe(true);
    });

    it('warns instead of claiming success when the agent never answers', async () => {
      vi.useFakeTimers();
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
      const { spawn } = await import('child_process');
      vi.mocked(spawn).mockReturnValue(createMockChild({ pid: 99999 }) as any);
      runningPids.add(99999);

      const { startCommand } = await import('../../src/commands/start.js');
      const pending = startCommand.parseAsync(['node', '247', 'start']);
      await vi.advanceTimersByTimeAsync(60_000);
      await pending;

      expect(output.logs.some((l) => l.includes('not answering'))).toBe(true);
      expect(output.logs.some((l) => l.includes('Agent running on'))).toBe(false);
    });

    it('fails when the agent dies during startup', async () => {
      const { spawn } = await import('child_process');
      vi.mocked(spawn).mockReturnValue(createMockChild({ pid: 99999 }) as any);
      // PID 99999 is never marked as running: the process is already gone

      const { startCommand } = await import('../../src/commands/start.js');

      await expect(startCommand.parseAsync(['node', '247', 'start'])).rejects.toThrow(
        'process.exit(1)'
      );

      expect(output.logs.some((l) => l.includes('exited during startup'))).toBe(true);
      expect(fsState.files.has(mockPaths.pidFile)).toBe(false);
    });

    describe('in foreground mode', () => {
      const startInForeground = async () => {
        const { spawn } = await import('child_process');
        const mockChild = createMockChild({ pid: 66666 });
        vi.mocked(spawn).mockReturnValue(mockChild as any);

        const { startCommand } = await import('../../src/commands/start.js');
        await startCommand.parseAsync(['node', '247', 'start', '--foreground']);

        return { spawn, mockChild };
      };

      it('passes the port to the agent and attaches it to the terminal', async () => {
        const { spawn, mockChild } = await startInForeground();

        const options = vi.mocked(spawn).mock.calls[0][2];
        expect(options?.stdio).toBe('inherit');
        expect(options?.env?.AGENT_247_PORT).toBe(String(validConfig.agent.port));
        expect(options?.env).not.toHaveProperty('AGENT_247_DATA');

        // Finish the child so the signal listeners are removed again
        expect(() => mockChild.emit('exit', 0, null)).toThrow('process.exit(0)');
      });

      it.each(['SIGINT', 'SIGTERM'] as const)('forwards %s to the agent', async (signal) => {
        const { mockChild } = await startInForeground();

        process.emit(signal);

        expect(mockChild.kill).toHaveBeenCalledWith(signal);
        expect(() => mockChild.emit('exit', 0, null)).toThrow('process.exit(0)');
      });

      it("exits with the agent's exit code", async () => {
        const { mockChild } = await startInForeground();

        expect(() => mockChild.emit('exit', 7, null)).toThrow('process.exit(7)');
      });
    });

    it('loads profile config when --profile is specified', async () => {
      // Create profile config
      const profileConfig = { ...validConfig, agent: { port: 5000 } };
      fsState.files.set(`${mockPaths.profilesDir}/dev.json`, JSON.stringify(profileConfig));

      const { spawn } = await import('child_process');
      const mockChild = createMockChild({ pid: 88888 });
      vi.mocked(spawn).mockReturnValue(mockChild as any);
      runningPids.add(88888);

      const { startCommand } = await import('../../src/commands/start.js');
      await startCommand.parseAsync(['node', '247', 'start', '--profile', 'dev']);

      // Should start successfully
      expect(spawn).toHaveBeenCalled();
    });
  });
});

describe('247 stop workflow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();

    // Reset state
    fsState = createMockFsState();
    runningPids = new Set();
    setupDefaultDirectories(fsState);
    output = captureConsole();

    // Mock process.kill
    process.kill = createProcessKillMock(runningPids) as any;

    // The spawned agent answers its health check
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));

    // Mock process.exit
    processExitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    process.kill = originalKill;
  });

  describe('when agent is not running', () => {
    it('shows info message and returns successfully', async () => {
      // No PID file exists

      const { stopCommand } = await import('../../src/commands/stop.js');
      await stopCommand.parseAsync(['node', '247', 'stop']);

      expect(output.logs.some((l) => l.includes('not running'))).toBe(true);
      // Should not throw
    });
  });

  describe('when agent is running', () => {
    beforeEach(() => {
      fsState.files.set(mockPaths.pidFile, '12345');
      runningPids.add(12345);
    });

    it('sends SIGTERM and removes PID file', async () => {
      const { stopCommand } = await import('../../src/commands/stop.js');
      await stopCommand.parseAsync(['node', '247', 'stop']);

      // Process should have been killed
      expect(process.kill).toHaveBeenCalledWith(12345, 'SIGTERM');

      // PID file should be removed
      expect(fsState.files.has(mockPaths.pidFile)).toBe(false);
    });

    it('cleans up stale PID file if process does not exist', async () => {
      // Process doesn't actually exist (stale PID)
      runningPids.delete(12345);

      const { stopCommand } = await import('../../src/commands/stop.js');
      await stopCommand.parseAsync(['node', '247', 'stop']);

      // PID file should be cleaned up
      expect(fsState.files.has(mockPaths.pidFile)).toBe(false);
    });
  });
});
