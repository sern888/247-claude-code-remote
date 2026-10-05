/**
 * Foreground Runner Tests
 *
 * `247 start --foreground` must behave like the agent itself: signals reach the
 * agent, and the CLI exits with whatever status the agent finished with.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('chalk', () => ({
  default: {
    red: (s: string) => s,
  },
}));

function createChild() {
  const child = new EventEmitter() as EventEmitter & { kill: ReturnType<typeof vi.fn> };
  child.kill = vi.fn();
  return child;
}

function createHost() {
  const host = new EventEmitter() as EventEmitter & { exit: ReturnType<typeof vi.fn> };
  host.exit = vi.fn();
  return host;
}

async function startForeground() {
  const { spawn } = await import('child_process');
  const child = createChild();
  vi.mocked(spawn).mockReturnValue(child as never);
  const host = createHost();

  const { runInForeground } = await import('../../../src/lib/foreground.js');
  runInForeground('node', ['agent.js'], { cwd: '/mock/agent' }, host);

  return { spawn, child, host };
}

describe('Foreground runner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('exitCodeFromChild', () => {
    it("returns the child's own exit code", async () => {
      const { exitCodeFromChild } = await import('../../../src/lib/foreground.js');

      expect(exitCodeFromChild(0, null)).toBe(0);
      expect(exitCodeFromChild(3, null)).toBe(3);
    });

    it('returns 128 + signal number when the child was killed by a signal', async () => {
      const { exitCodeFromChild } = await import('../../../src/lib/foreground.js');

      expect(exitCodeFromChild(null, 'SIGINT')).toBe(130);
      expect(exitCodeFromChild(null, 'SIGTERM')).toBe(143);
    });

    it('returns a failure status when neither a code nor a signal is known', async () => {
      const { exitCodeFromChild } = await import('../../../src/lib/foreground.js');

      expect(exitCodeFromChild(null, null)).toBe(1);
    });
  });

  describe('runInForeground', () => {
    it('spawns the command with the given options', async () => {
      const { spawn } = await startForeground();

      expect(spawn).toHaveBeenCalledWith('node', ['agent.js'], { cwd: '/mock/agent' });
    });

    it.each(['SIGINT', 'SIGTERM'] as const)('forwards %s to the child', async (signal) => {
      const { child, host } = await startForeground();

      host.emit(signal);

      expect(child.kill).toHaveBeenCalledWith(signal);
      expect(host.exit).not.toHaveBeenCalled();
    });

    it("exits with the child's exit code", async () => {
      const { child, host } = await startForeground();

      child.emit('exit', 3, null);

      expect(host.exit).toHaveBeenCalledWith(3);
    });

    it('exits with 128 + signal number when the child is killed by a signal', async () => {
      const { child, host } = await startForeground();

      child.emit('exit', null, 'SIGTERM');

      expect(host.exit).toHaveBeenCalledWith(143);
    });

    it('stops forwarding signals once the child has exited', async () => {
      const { child, host } = await startForeground();

      child.emit('exit', 0, null);

      expect(host.listenerCount('SIGINT')).toBe(0);
      expect(host.listenerCount('SIGTERM')).toBe(0);
    });

    it('reports a spawn failure and exits with a failure status', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { child, host } = await startForeground();

      child.emit('error', new Error('spawn node ENOENT'));

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('spawn node ENOENT'));
      expect(host.exit).toHaveBeenCalledWith(1);
    });
  });
});
