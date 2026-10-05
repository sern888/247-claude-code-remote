/**
 * Update Command Tests
 *
 * The update command stops a running agent, installs the new version and
 * restarts the agent. Every message must reflect what actually happened.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const CURRENT_VERSION = '1.0.0';
const LATEST_VERSION = '9.9.9';

vi.mock('chalk', () => ({
  default: {
    bold: (s: string) => s,
    red: (s: string) => s,
    green: (s: string) => s,
    yellow: (s: string) => s,
    dim: (s: string) => s,
  },
}));

// Spinner results are echoed to console.log so tests can assert on what the user sees
vi.mock('ora', () => ({
  default: vi.fn((initialText?: string) => {
    const echo = vi.fn(function (this: { text: string }, text?: string) {
      console.log(text || this.text);
      return this;
    });
    return {
      text: initialText ?? '',
      start: vi.fn().mockReturnThis(),
      succeed: echo,
      fail: echo,
      warn: echo,
      info: echo,
    };
  }),
}));

vi.mock('child_process', () => ({
  exec: vi.fn(),
}));

vi.mock('util', () => ({
  promisify: vi.fn(() => vi.fn()),
}));

const serviceManager = {
  platform: 'macos' as const,
  serviceName: 'com.quivr.247',
  status: vi.fn(),
  install: vi.fn(),
  uninstall: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  restart: vi.fn(),
  getLogPaths: vi.fn(),
};

vi.mock('../../../src/service/index.js', () => ({
  createServiceManager: vi.fn(() => serviceManager),
}));

vi.mock('../../../src/lib/process.js', () => ({
  isAgentRunning: vi.fn(),
  stopAgent: vi.fn(),
}));

describe('Update Command', () => {
  let logs: string[];
  let mockExecAsync: ReturnType<typeof vi.fn>;

  const output = () => logs.join('\n');
  const ranNpmInstall = () =>
    mockExecAsync.mock.calls.some(([command]) => String(command).startsWith('npm install'));

  const runUpdate = async (...args: string[]) => {
    const { updateCommand } = await import('../../../src/commands/update.js');
    await updateCommand.parseAsync(['node', 'update', ...args]);
  };

  const arrangeAgent = async (state: {
    service?: { installed: boolean; running: boolean };
    daemonRunning?: boolean;
  }) => {
    const { isAgentRunning, stopAgent } = await import('../../../src/lib/process.js');
    const service = state.service ?? { installed: false, running: false };
    serviceManager.status.mockResolvedValue({ ...service, enabled: service.installed });
    serviceManager.stop.mockResolvedValue({ success: true });
    serviceManager.start.mockResolvedValue({ success: true });
    vi.mocked(isAgentRunning).mockReturnValue(
      state.daemonRunning ? { running: true, pid: 4242 } : { running: false }
    );
    vi.mocked(stopAgent).mockResolvedValue({ success: true });
    return { stopAgent: vi.mocked(stopAgent) };
  };

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    vi.doMock('../../../package.json', () => ({
      default: { version: CURRENT_VERSION },
    }));

    logs = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => {
      logs.push(args.join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation((...args) => {
      logs.push(args.join(' '));
    });
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });

    // npm: a newer version exists and installs cleanly
    mockExecAsync = vi.fn(async (command: string) => {
      if (command.startsWith('npm view')) return { stdout: `${LATEST_VERSION}\n`, stderr: '' };
      if (command.startsWith('npm ls')) {
        const installed = { dependencies: { '247-cli': { version: LATEST_VERSION } } };
        return { stdout: JSON.stringify(installed), stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });
    const { promisify } = await import('util');
    vi.mocked(promisify).mockReturnValue(mockExecAsync as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('updates without touching the agent when nothing is running', async () => {
    const { stopAgent } = await arrangeAgent({});

    await runUpdate();

    expect(stopAgent).not.toHaveBeenCalled();
    expect(serviceManager.stop).not.toHaveBeenCalled();
    expect(serviceManager.start).not.toHaveBeenCalled();
    expect(ranNpmInstall()).toBe(true);
    expect(output()).toContain('Update complete');
  });

  it('only checks for updates with --check', async () => {
    const { stopAgent } = await arrangeAgent({ daemonRunning: true });

    await runUpdate('--check');

    expect(stopAgent).not.toHaveBeenCalled();
    expect(ranNpmInstall()).toBe(false);
  });

  describe('agent running as a daemon', () => {
    it('stops the daemon even though no service is installed', async () => {
      const { stopAgent } = await arrangeAgent({ daemonRunning: true });

      await runUpdate();

      expect(stopAgent).toHaveBeenCalled();
      expect(serviceManager.stop).not.toHaveBeenCalled();
      expect(output()).toContain('Agent stopped');
    });

    it('asks for a manual restart and never claims the agent was restarted', async () => {
      await arrangeAgent({ daemonRunning: true });

      await runUpdate();

      expect(output()).toContain('247 start');
      expect(output()).not.toContain('Agent restarted');
      expect(serviceManager.start).not.toHaveBeenCalled();
    });

    it('aborts with a failure when the daemon cannot be stopped', async () => {
      const { stopAgent } = await arrangeAgent({ daemonRunning: true });
      stopAgent.mockResolvedValue({ success: false, error: 'owned by another user' });

      await expect(runUpdate()).rejects.toThrow('process.exit(1)');

      expect(output()).toContain('owned by another user');
      expect(output()).not.toContain('Agent stopped');
      expect(output()).not.toContain('Update complete');
      expect(ranNpmInstall()).toBe(false);
    });
  });

  describe('agent running as a service', () => {
    const runningService = { service: { installed: true, running: true } };

    it('stops the service, updates and restarts it', async () => {
      const { stopAgent } = await arrangeAgent(runningService);

      await runUpdate();

      expect(serviceManager.stop).toHaveBeenCalled();
      expect(stopAgent).not.toHaveBeenCalled();
      expect(serviceManager.start).toHaveBeenCalled();
      expect(output()).toContain('Agent stopped');
      expect(output()).toContain('Agent restarted');
      expect(output()).toContain('Update complete');
    });

    it('aborts with a failure when the service cannot be stopped', async () => {
      await arrangeAgent(runningService);
      serviceManager.stop.mockResolvedValue({ success: false, error: 'launchctl failed' });

      await expect(runUpdate()).rejects.toThrow('process.exit(1)');

      expect(output()).toContain('launchctl failed');
      expect(output()).not.toContain('Agent stopped');
      expect(ranNpmInstall()).toBe(false);
    });

    it('reports a failure when the service cannot be restarted', async () => {
      await arrangeAgent(runningService);
      serviceManager.start.mockResolvedValue({ success: false, error: 'load failed' });

      await expect(runUpdate()).rejects.toThrow('process.exit(1)');

      expect(output()).toContain('load failed');
      expect(output()).not.toContain('Agent restarted');
      expect(output()).not.toContain('Update complete');
    });
  });

  it('fails when npm installs a different version than requested', async () => {
    await arrangeAgent({});
    mockExecAsync.mockImplementation(async (command: string) => {
      if (command.startsWith('npm view')) return { stdout: `${LATEST_VERSION}\n`, stderr: '' };
      if (command.startsWith('npm ls')) {
        return { stdout: JSON.stringify({ dependencies: { '247-cli': { version: '1.0.0' } } }) };
      }
      return { stdout: '', stderr: '' };
    });

    await expect(runUpdate()).rejects.toThrow('process.exit(1)');

    expect(output()).toContain(`instead of ${LATEST_VERSION}`);
    expect(output()).not.toContain('Update complete');
  });
});
