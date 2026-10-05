/**
 * Profile Command Tests
 *
 * Exercises the profile sub-commands against the real config module with an
 * in-memory filesystem, so validation and persistence are tested together.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  mockPaths,
  validConfig,
  createMockFsState,
  captureConsole,
  setupDefaultDirectories,
  setupExistingConfig,
  type MockFsState,
  type CapturedOutput,
} from '../../helpers/mock-system.js';

let fsState: MockFsState;
let output: CapturedOutput;

vi.mock('../../../src/lib/paths.js', () => ({
  getAgentPaths: () => mockPaths,
  ensureDirectories: vi.fn(),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn((path: string) => fsState.files.has(path) || fsState.directories.has(path)),
  readFileSync: vi.fn((path: string) => {
    const content = fsState.files.get(path);
    if (content === undefined) throw new Error('ENOENT');
    return content;
  }),
  writeFileSync: vi.fn((path: string, content: string) => {
    fsState.files.set(path, content);
  }),
  chmodSync: vi.fn(),
  mkdirSync: vi.fn((path: string) => {
    fsState.directories.add(path);
  }),
  unlinkSync: vi.fn((path: string) => {
    fsState.files.delete(path);
  }),
  readdirSync: vi.fn(() => []),
}));

vi.mock('crypto', () => ({
  randomUUID: () => 'fresh-uuid-5678',
  randomBytes: (size: number) => Buffer.alloc(size, 1),
}));

vi.mock('chalk', () => ({
  default: {
    red: (s: string) => s,
    green: (s: string) => s,
    yellow: (s: string) => s,
    cyan: (s: string) => s,
    dim: (s: string) => s,
    bold: (s: string) => s,
  },
}));

const profilePath = (name: string) => `${mockPaths.profilesDir}/${name}.json`;
const readProfile = (name: string) => JSON.parse(fsState.files.get(profilePath(name))!);

async function runProfile(...args: string[]): Promise<void> {
  const { profileCommand } = await import('../../../src/commands/profile.js');
  await profileCommand.parseAsync(['node', 'profile', ...args]);
}

describe('Profile Command', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    process.env = { ...originalEnv };
    delete process.env.AGENT_247_PORT;
    delete process.env.AGENT_247_PROJECTS;

    fsState = createMockFsState();
    setupDefaultDirectories(fsState);
    output = captureConsole();

    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  describe('create', () => {
    it('creates a profile with the given port', async () => {
      await runProfile('create', 'dev', '--port', '4700');

      expect(readProfile('dev').agent.port).toBe(4700);
      expect(readProfile('dev').machine.id).toBe('fresh-uuid-5678');
    });

    it.each(['../evil', 'a/b', 'has space'])(
      'rejects unsafe profile name %j without writing',
      async (name) => {
        await expect(runProfile('create', name)).rejects.toThrow('process.exit(1)');

        expect(output.errors.join(' ')).toContain('Invalid profile name');
        expect(fsState.files.size).toBe(0);
      }
    );

    it.each(['abc', '0', '70000', '80.5'])(
      'rejects invalid port %j without writing',
      async (port) => {
        await expect(runProfile('create', 'dev', '--port', port)).rejects.toThrow(
          'process.exit(1)'
        );

        expect(output.errors.join(' ')).toContain('must be an integer between 1 and 65535');
        expect(fsState.files.has(profilePath('dev'))).toBe(false);
      }
    );

    it('copies a profile with a fresh machine id', async () => {
      setupExistingConfig(fsState);

      await runProfile('create', 'copy', '--copy-from', 'default', '--port', '4700');

      const copy = readProfile('copy');
      expect(copy.machine.id).toBe('fresh-uuid-5678');
      expect(copy.machine.id).not.toBe(validConfig.machine.id);
      expect(copy.machine.name).toBe(validConfig.machine.name);
      expect(copy.agent.port).toBe(4700);
    });

    it('does not persist env overrides when copying a profile', async () => {
      setupExistingConfig(fsState);
      process.env.AGENT_247_PROJECTS = '/env/override';
      process.env.AGENT_247_PORT = '9999';

      await runProfile('create', 'copy', '--copy-from', 'default', '--port', '4700');

      const copy = readProfile('copy');
      expect(copy.projects.basePath).toBe(validConfig.projects.basePath);
      expect(copy.agent.port).toBe(4700);
    });

    it('rejects an unsafe --copy-from name', async () => {
      await expect(runProfile('create', 'copy', '--copy-from', '../../secret')).rejects.toThrow(
        'process.exit(1)'
      );

      expect(output.errors.join(' ')).toContain('Invalid profile name');
      expect(fsState.files.has(profilePath('copy'))).toBe(false);
    });
  });

  describe('set', () => {
    beforeEach(() => {
      fsState.files.set(profilePath('dev'), JSON.stringify(validConfig));
    });

    it('does not persist env overrides when updating a profile', async () => {
      process.env.AGENT_247_PORT = '9999';
      process.env.AGENT_247_PROJECTS = '/env/override';

      await runProfile('set', 'dev', '--machine-name', 'Renamed');

      const saved = readProfile('dev');
      expect(saved.machine.name).toBe('Renamed');
      expect(saved.agent.port).toBe(validConfig.agent.port);
      expect(saved.projects.basePath).toBe(validConfig.projects.basePath);
    });

    it('updates the port when it is valid', async () => {
      await runProfile('set', 'dev', '--port', '4800');

      expect(readProfile('dev').agent.port).toBe(4800);
    });

    it('rejects a non-numeric port and leaves the profile unchanged', async () => {
      await expect(runProfile('set', 'dev', '--port', 'abc')).rejects.toThrow('process.exit(1)');

      expect(output.errors.join(' ')).toContain('must be an integer between 1 and 65535');
      expect(readProfile('dev')).toEqual(validConfig);
    });

    it('rejects an unsafe profile name', async () => {
      await expect(runProfile('set', '../evil', '--port', '4800')).rejects.toThrow(
        'process.exit(1)'
      );

      expect(output.errors.join(' ')).toContain('Invalid profile name');
    });
  });

  describe('show and delete', () => {
    it('show rejects an unsafe profile name', async () => {
      await expect(runProfile('show', '../evil')).rejects.toThrow('process.exit(1)');

      expect(output.errors.join(' ')).toContain('Invalid profile name');
    });

    it('delete rejects an unsafe profile name without deleting', async () => {
      const { unlinkSync } = await import('fs');

      await expect(runProfile('delete', '../config', '--force')).rejects.toThrow('process.exit(1)');

      expect(output.errors.join(' ')).toContain('Invalid profile name');
      expect(unlinkSync).not.toHaveBeenCalled();
    });
  });
});
