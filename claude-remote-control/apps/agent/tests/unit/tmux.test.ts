import { describe, it, expect, vi, beforeEach } from 'vitest';

type ExecFileCallback = (error: unknown, result?: { stdout: string; stderr: string }) => void;

const calls: { file: string; args: string[] }[] = [];
let asyncResult: { stdout: string; stderr: string } | Error = { stdout: '', stderr: '' };
let syncResult: string | Error = '';

vi.mock('child_process', () => ({
  execFile: vi.fn((file: string, args: string[], _options: unknown, callback: ExecFileCallback) => {
    calls.push({ file, args });
    if (asyncResult instanceof Error) {
      callback(asyncResult);
    } else {
      callback(null, asyncResult);
    }
  }),
  execFileSync: vi.fn((file: string, args: string[]) => {
    calls.push({ file, args });
    if (syncResult instanceof Error) throw syncResult;
    return syncResult;
  }),
}));

const tmux = await import('../../src/lib/tmux.js');

function tmuxExitError(code: number): Error {
  return Object.assign(new Error(`tmux exited with ${code}`), { code, status: code });
}

describe('tmux wrapper', () => {
  beforeEach(() => {
    calls.length = 0;
    asyncResult = { stdout: '', stderr: '' };
    syncResult = '';
  });

  describe('argument handling', () => {
    it('targets sessions with an exact match', async () => {
      await tmux.hasSession('proj');
      await tmux.killSession('proj');

      expect(calls[0]).toEqual({ file: 'tmux', args: ['has-session', '-t', '=proj'] });
      expect(calls[1]).toEqual({ file: 'tmux', args: ['kill-session', '-t', '=proj'] });
    });

    it('sends input literally so tmux and the shell cannot interpret it', async () => {
      const hostile = '-n $(touch /tmp/pwned) `id` ; "q"';

      await tmux.sendKeys('proj--a', hostile, true);

      expect(calls).toEqual([
        { file: 'tmux', args: ['send-keys', '-t', '=proj--a:', '-l', '--', hostile] },
        { file: 'tmux', args: ['send-keys', '-t', '=proj--a:', 'Enter'] },
      ]);
    });

    it('does not press Enter unless asked', async () => {
      await tmux.sendKeys('proj--a', 'ls', false);

      expect(calls).toHaveLength(1);
    });

    it('captures a pane with the requested scrollback size', async () => {
      asyncResult = { stdout: 'line 1\nline 2\n', stderr: '' };

      const output = await tmux.capturePane('proj--a', 250);

      expect(output).toBe('line 1\nline 2\n');
      expect(calls[0].args).toEqual(['capture-pane', '-t', '=proj--a:', '-p', '-S', '-250', '-J']);
    });

    it('can capture without joining wrapped lines', async () => {
      await tmux.capturePane('proj--a', 20, { joinLines: false });

      expect(calls[0].args).not.toContain('-J');
    });
  });

  describe('input validation', () => {
    const hostileName = 'x";id;"';

    it('never passes an invalid session name to tmux', async () => {
      await expect(tmux.killSession(hostileName)).rejects.toThrow('Invalid session name');
      await expect(tmux.sendKeys(hostileName, 'ls', true)).rejects.toThrow('Invalid session name');
      await expect(tmux.capturePane(hostileName, 10)).rejects.toThrow('Invalid session name');
      expect(await tmux.hasSession(hostileName)).toBe(false);
      expect(tmux.hasSessionSync(hostileName)).toBe(false);

      expect(calls).toHaveLength(0);
    });

    it('rejects a scrollback size that is not a positive integer', async () => {
      await expect(tmux.capturePane('proj', Number.NaN)).rejects.toThrow('positive integer');
      await expect(tmux.capturePane('proj', -5)).rejects.toThrow('positive integer');
      expect(calls).toHaveLength(0);
    });
  });

  describe('hasSession', () => {
    it('is false when tmux reports the session missing', async () => {
      asyncResult = tmuxExitError(1);
      syncResult = tmuxExitError(1);

      expect(await tmux.hasSession('proj')).toBe(false);
      expect(tmux.hasSessionSync('proj')).toBe(false);
    });

    it('is true when tmux succeeds', async () => {
      expect(await tmux.hasSession('proj')).toBe(true);
      expect(tmux.hasSessionSync('proj')).toBe(true);
    });
  });

  describe('listSessions', () => {
    it('parses names and creation times', async () => {
      asyncResult = { stdout: 'proj--a|1700000000\n--fair-fox-44|1700000100\n', stderr: '' };

      expect(await tmux.listSessions()).toEqual([
        { name: 'proj--a', createdAt: 1700000000000 },
        { name: '--fair-fox-44', createdAt: 1700000100000 },
      ]);
    });

    it('returns an empty list when no tmux server is running', async () => {
      asyncResult = tmuxExitError(1);

      expect(await tmux.listSessions()).toEqual([]);
    });

    it('rejects when tmux itself cannot be run', async () => {
      asyncResult = Object.assign(new Error('spawn tmux ENOENT'), { code: 'ENOENT' });

      await expect(tmux.listSessions()).rejects.toThrow('ENOENT');
    });
  });

  describe('listSessionNamesSync', () => {
    it('returns the running session names', () => {
      syncResult = 'proj--a\nproj--b\n';

      expect(tmux.listSessionNamesSync()).toEqual(new Set(['proj--a', 'proj--b']));
    });

    it('returns an empty set when no tmux server is running', () => {
      syncResult = tmuxExitError(1);

      expect(tmux.listSessionNamesSync()).toEqual(new Set());
    });

    // null (unknown) must stay distinguishable from "no sessions": the caller
    // deletes session records that are not in the returned set.
    it('returns null when tmux cannot be queried', () => {
      syncResult = Object.assign(new Error('spawnSync tmux ENOENT'), { code: 'ENOENT' });

      expect(tmux.listSessionNamesSync()).toBeNull();
    });
  });
});
