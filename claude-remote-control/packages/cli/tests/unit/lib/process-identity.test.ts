/**
 * Process Identity Tests
 *
 * A PID from the PID file is only trusted when its command line is the agent's.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}));

vi.mock('fs', () => ({
  readFileSync: vi.fn(),
}));

function psExitedWith(status: number): Error {
  return Object.assign(new Error(`Command failed: ps (exit ${status})`), { status });
}

function missingBinary(): Error {
  return Object.assign(new Error('spawnSync ps ENOENT'), { code: 'ENOENT' });
}

describe('Process identity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  describe('readProcessCommand', () => {
    it('returns the trimmed command line reported by ps', async () => {
      const { execFileSync } = await import('child_process');
      vi.mocked(execFileSync).mockReturnValue('/usr/bin/node /opt/agent/index.js\n');

      const { readProcessCommand } = await import('../../../src/lib/process-identity.js');

      expect(readProcessCommand(4242)).toBe('/usr/bin/node /opt/agent/index.js');
    });

    it('passes the PID as a separate argument so nothing is shell-interpreted', async () => {
      const { execFileSync } = await import('child_process');
      vi.mocked(execFileSync).mockReturnValue('node\n');

      const { readProcessCommand } = await import('../../../src/lib/process-identity.js');
      readProcessCommand(4242);

      expect(execFileSync).toHaveBeenCalledWith(
        'ps',
        ['-ww', '-p', '4242', '-o', 'command='],
        expect.objectContaining({ encoding: 'utf-8' })
      );
    });

    it('returns an empty string when ps finds no such process', async () => {
      const { execFileSync } = await import('child_process');
      const { readFileSync } = await import('fs');
      vi.mocked(execFileSync).mockImplementation(() => {
        throw psExitedWith(1);
      });
      vi.mocked(readFileSync).mockImplementation(() => {
        throw new Error('ENOENT');
      });

      const { readProcessCommand } = await import('../../../src/lib/process-identity.js');

      expect(readProcessCommand(4242)).toBe('');
    });

    it('falls back to /proc when ps is unavailable', async () => {
      const { execFileSync } = await import('child_process');
      const { readFileSync } = await import('fs');
      vi.mocked(execFileSync).mockImplementation(() => {
        throw missingBinary();
      });
      vi.mocked(readFileSync).mockReturnValue('/usr/bin/node\0/opt/agent/index.js\0');

      const { readProcessCommand } = await import('../../../src/lib/process-identity.js');

      expect(readProcessCommand(4242)).toBe('/usr/bin/node /opt/agent/index.js');
      expect(readFileSync).toHaveBeenCalledWith('/proc/4242/cmdline', 'utf-8');
    });

    it('returns null when the command line cannot be determined at all', async () => {
      const { execFileSync } = await import('child_process');
      const { readFileSync } = await import('fs');
      vi.mocked(execFileSync).mockImplementation(() => {
        throw missingBinary();
      });
      vi.mocked(readFileSync).mockImplementation(() => {
        throw new Error('ENOENT');
      });

      const { readProcessCommand } = await import('../../../src/lib/process-identity.js');

      expect(readProcessCommand(4242)).toBeNull();
    });
  });

  describe('isAgentCommand', () => {
    const agentRoot = '/repo/apps/agent';

    it('accepts a command running code from this install', async () => {
      const { isAgentCommand } = await import('../../../src/lib/process-identity.js');

      expect(isAgentCommand('npx tsx /repo/apps/agent/src/index.ts', agentRoot)).toBe(true);
    });

    it('accepts a packaged agent installed under another prefix', async () => {
      const { isAgentCommand } = await import('../../../src/lib/process-identity.js');
      const command = '/old/node /old/lib/node_modules/247-cli/agent/dist/index.js';

      expect(isAgentCommand(command, agentRoot)).toBe(true);
    });

    it.each(['vim notes.txt', '/usr/bin/postgres -D /var/lib/postgres', 'node server-247.js', ''])(
      'rejects unrelated command %j',
      async (command) => {
        const { isAgentCommand } = await import('../../../src/lib/process-identity.js');

        expect(isAgentCommand(command, agentRoot)).toBe(false);
      }
    );
  });
});
