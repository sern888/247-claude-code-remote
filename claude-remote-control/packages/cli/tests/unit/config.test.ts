import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock paths module
vi.mock('../../src/lib/paths.js', () => ({
  getAgentPaths: () => ({
    configDir: '/mock/.247',
    configPath: '/mock/.247/config.json',
    dataDir: '/mock/.247/data',
    logDir: '/mock/.247/logs',
    pidFile: '/mock/.247/agent.pid',
  }),
  ensureDirectories: vi.fn(),
}));

// Mock fs module
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

// Mock crypto
vi.mock('crypto', () => ({
  randomUUID: () => 'test-uuid-1234',
}));

describe('CLI Config', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  const validConfig = {
    machine: { id: 'test-id', name: 'Test Machine' },
    agent: { port: 4678 },
    projects: { basePath: '~/Dev', whitelist: [] },
  };

  describe('getProfilePath', () => {
    it('returns default config path for undefined profile', async () => {
      const { getProfilePath } = await import('../../src/lib/config.js');
      expect(getProfilePath()).toBe('/mock/.247/config.json');
    });

    it('returns default config path for "default" profile', async () => {
      const { getProfilePath } = await import('../../src/lib/config.js');
      expect(getProfilePath('default')).toBe('/mock/.247/config.json');
    });

    it('returns profile path for named profile', async () => {
      const { getProfilePath } = await import('../../src/lib/config.js');
      expect(getProfilePath('dev')).toBe('/mock/.247/profiles/dev.json');
    });

    it.each(['../../etc/passwd', 'a/b', 'has space', '-leading-dash', '.hidden', 'a'.repeat(65)])(
      'rejects unsafe profile name %j',
      async (name) => {
        const { getProfilePath } = await import('../../src/lib/config.js');
        expect(() => getProfilePath(name)).toThrow('Invalid profile name');
      }
    );

    it.each(['dev', 'Prod_2', 'my-profile', '0', 'a'.repeat(64)])(
      'accepts safe profile name %j',
      async (name) => {
        const { getProfilePath } = await import('../../src/lib/config.js');
        expect(getProfilePath(name)).toBe(`/mock/.247/profiles/${name}.json`);
      }
    );
  });

  describe('getProfileNameError', () => {
    it('returns null for the default profile and valid names', async () => {
      const { getProfileNameError } = await import('../../src/lib/config.js');
      expect(getProfileNameError(undefined)).toBeNull();
      expect(getProfileNameError(null)).toBeNull();
      expect(getProfileNameError('default')).toBeNull();
      expect(getProfileNameError('dev')).toBeNull();
    });

    it('returns a clear message naming the rejected value', async () => {
      const { getProfileNameError } = await import('../../src/lib/config.js');
      expect(getProfileNameError('../evil')).toContain("Invalid profile name '../evil'");
    });
  });

  describe('parsePort', () => {
    it.each([
      ['1', 1],
      ['4678', 4678],
      ['65535', 65535],
    ])('parses %j', async (value, expected) => {
      const { parsePort } = await import('../../src/lib/config.js');
      expect(parsePort(value)).toBe(expected);
    });

    it.each(['abc', '', '0', '65536', '-1', '80.5', '80abc', ' 80', '1e3'])(
      'rejects %j with a clear message',
      async (value) => {
        const { parsePort } = await import('../../src/lib/config.js');
        expect(() => parsePort(value)).toThrow('must be an integer between 1 and 65535');
      }
    );

    it('names the source of the invalid value', async () => {
      const { parsePort } = await import('../../src/lib/config.js');
      expect(() => parsePort('abc', 'AGENT_247_PORT')).toThrow("Invalid AGENT_247_PORT 'abc'");
    });
  });

  describe('loadConfig', () => {
    it('returns null if config file does not exist', async () => {
      const { existsSync } = await import('fs');
      vi.mocked(existsSync).mockReturnValue(false);

      const { loadConfig } = await import('../../src/lib/config.js');
      expect(loadConfig()).toBeNull();
    });

    it('loads and parses valid config', async () => {
      const { existsSync, readFileSync } = await import('fs');
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify(validConfig));

      const { loadConfig } = await import('../../src/lib/config.js');
      const config = loadConfig();

      expect(config).toEqual(validConfig);
    });

    it('applies AGENT_247_PORT env override', async () => {
      process.env.AGENT_247_PORT = '5000';

      const { existsSync, readFileSync } = await import('fs');
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify(validConfig));

      const { loadConfig } = await import('../../src/lib/config.js');
      const config = loadConfig();

      expect(config?.agent.port).toBe(5000);
    });

    it('applies AGENT_247_PROJECTS env override', async () => {
      process.env.AGENT_247_PROJECTS = '/custom/projects';

      const { existsSync, readFileSync } = await import('fs');
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify(validConfig));

      const { loadConfig } = await import('../../src/lib/config.js');
      const config = loadConfig();

      expect(config?.projects.basePath).toBe('/custom/projects');
    });

    it('returns null for invalid JSON', async () => {
      const { existsSync, readFileSync } = await import('fs');
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue('{ invalid json }');

      const { loadConfig } = await import('../../src/lib/config.js');
      expect(loadConfig()).toBeNull();
    });

    it('returns null and reports a non-numeric AGENT_247_PORT override', async () => {
      process.env.AGENT_247_PORT = 'not-a-port';
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const { existsSync, readFileSync } = await import('fs');
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify(validConfig));

      const { loadConfig } = await import('../../src/lib/config.js');

      expect(loadConfig()).toBeNull();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('AGENT_247_PORT'));
      errorSpy.mockRestore();
    });

    it('returns null and reports an invalid stored port', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const { existsSync, readFileSync } = await import('fs');
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({ ...validConfig, agent: { port: null } })
      );

      const { loadConfig } = await import('../../src/lib/config.js');

      expect(loadConfig()).toBeNull();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('agent.port'));
      errorSpy.mockRestore();
    });

    it('does not mutate or persist env overrides into the stored config', async () => {
      process.env.AGENT_247_PORT = '5000';
      process.env.AGENT_247_PROJECTS = '/custom/projects';

      const { existsSync, readFileSync } = await import('fs');
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify(validConfig));

      const { loadConfig, loadStoredConfig } = await import('../../src/lib/config.js');

      expect(loadConfig()?.agent.port).toBe(5000);
      expect(loadStoredConfig()).toEqual(validConfig);
    });
  });

  describe('loadStoredConfig', () => {
    it('returns null if config file does not exist', async () => {
      const { existsSync } = await import('fs');
      vi.mocked(existsSync).mockReturnValue(false);

      const { loadStoredConfig } = await import('../../src/lib/config.js');
      expect(loadStoredConfig('dev')).toBeNull();
    });
  });

  describe('saveConfig', () => {
    it('writes config to file', async () => {
      const { existsSync, writeFileSync } = await import('fs');
      vi.mocked(existsSync).mockReturnValue(true);

      const { saveConfig } = await import('../../src/lib/config.js');
      saveConfig(validConfig);

      expect(writeFileSync).toHaveBeenCalledWith(
        '/mock/.247/config.json',
        JSON.stringify(validConfig, null, 2),
        'utf-8'
      );
    });

    it('creates profiles directory for named profile', async () => {
      const { existsSync, writeFileSync, mkdirSync } = await import('fs');
      vi.mocked(existsSync).mockReturnValue(false);

      const { saveConfig } = await import('../../src/lib/config.js');
      saveConfig(validConfig, 'dev');

      expect(mkdirSync).toHaveBeenCalledWith('/mock/.247/profiles', { recursive: true });
      expect(writeFileSync).toHaveBeenCalledWith(
        '/mock/.247/profiles/dev.json',
        JSON.stringify(validConfig, null, 2),
        'utf-8'
      );
    });
  });

  describe('listProfiles', () => {
    it('returns empty array if no profiles exist', async () => {
      const { existsSync } = await import('fs');
      vi.mocked(existsSync).mockReturnValue(false);

      const { listProfiles } = await import('../../src/lib/config.js');
      expect(listProfiles()).toEqual([]);
    });

    it('includes default if config.json exists', async () => {
      const { existsSync, readdirSync } = await import('fs');
      vi.mocked(existsSync).mockImplementation((path) => {
        return String(path).endsWith('config.json');
      });
      vi.mocked(readdirSync).mockReturnValue([]);

      const { listProfiles } = await import('../../src/lib/config.js');
      expect(listProfiles()).toContain('default');
    });

    it('lists named profiles from profiles directory', async () => {
      const { existsSync, readdirSync } = await import('fs');
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readdirSync).mockReturnValue(['dev.json', 'prod.json'] as any);

      const { listProfiles } = await import('../../src/lib/config.js');
      const profiles = listProfiles();

      expect(profiles).toContain('default');
      expect(profiles).toContain('dev');
      expect(profiles).toContain('prod');
    });

    it('skips files whose names are not valid profile names', async () => {
      const { existsSync, readdirSync } = await import('fs');
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readdirSync).mockReturnValue(['dev.json', 'bad name.json', 'notes.txt'] as any);

      const { listProfiles } = await import('../../src/lib/config.js');

      expect(listProfiles()).toEqual(['default', 'dev']);
    });
  });

  describe('profileExists', () => {
    it('returns true if profile file exists', async () => {
      const { existsSync } = await import('fs');
      vi.mocked(existsSync).mockReturnValue(true);

      const { profileExists } = await import('../../src/lib/config.js');
      expect(profileExists('dev')).toBe(true);
    });

    it('returns false if profile file does not exist', async () => {
      const { existsSync } = await import('fs');
      vi.mocked(existsSync).mockReturnValue(false);

      const { profileExists } = await import('../../src/lib/config.js');
      expect(profileExists('nonexistent')).toBe(false);
    });
  });

  describe('deleteProfile', () => {
    it('throws error when trying to delete default profile', async () => {
      const { deleteProfile } = await import('../../src/lib/config.js');
      expect(() => deleteProfile('default')).toThrow('Cannot delete default profile');
    });

    it('returns false if profile does not exist', async () => {
      const { existsSync } = await import('fs');
      vi.mocked(existsSync).mockReturnValue(false);

      const { deleteProfile } = await import('../../src/lib/config.js');
      expect(deleteProfile('nonexistent')).toBe(false);
    });

    it('deletes profile and returns true', async () => {
      const { existsSync, unlinkSync } = await import('fs');
      vi.mocked(existsSync).mockReturnValue(true);

      const { deleteProfile } = await import('../../src/lib/config.js');
      expect(deleteProfile('dev')).toBe(true);
      expect(unlinkSync).toHaveBeenCalledWith('/mock/.247/profiles/dev.json');
    });
  });

  describe('createConfig', () => {
    it('creates config with defaults and provided options', async () => {
      const { createConfig } = await import('../../src/lib/config.js');
      const config = createConfig({ machineName: 'My Machine' });

      expect(config.machine.id).toBe('test-uuid-1234');
      expect(config.machine.name).toBe('My Machine');
      expect(config.agent.port).toBe(4678);
      expect(config.projects.basePath).toBe('~/Dev');
    });

    it('uses provided port and projects path', async () => {
      const { createConfig } = await import('../../src/lib/config.js');
      const config = createConfig({
        machineName: 'My Machine',
        port: 5000,
        projectsPath: '/custom/path',
      });

      expect(config.agent.port).toBe(5000);
      expect(config.projects.basePath).toBe('/custom/path');
    });
  });

  describe('copyConfigForNewProfile', () => {
    const source = {
      machine: { id: 'source-id', name: 'Source Machine' },
      agent: { port: 4678 },
      projects: { basePath: '~/Work', whitelist: ['a'] },
    };

    it('gives the copy a fresh machine id and the requested port', async () => {
      const { copyConfigForNewProfile } = await import('../../src/lib/config.js');

      const copy = copyConfigForNewProfile(source, { port: 4700 });

      expect(copy.machine).toEqual({ id: 'test-uuid-1234', name: 'Source Machine' });
      expect(copy.agent.port).toBe(4700);
      expect(copy.projects).toEqual(source.projects);
    });

    it('uses the provided machine name and leaves the source untouched', async () => {
      const { copyConfigForNewProfile } = await import('../../src/lib/config.js');
      const snapshot = JSON.parse(JSON.stringify(source));

      const copy = copyConfigForNewProfile(source, { port: 4700, machineName: 'Copy' });

      expect(copy.machine.name).toBe('Copy');
      expect(source).toEqual(snapshot);
    });
  });

  describe('configExists', () => {
    it('returns true if config file exists', async () => {
      const { existsSync } = await import('fs');
      vi.mocked(existsSync).mockReturnValue(true);

      const { configExists } = await import('../../src/lib/config.js');
      expect(configExists()).toBe(true);
    });

    it('returns false if config file does not exist', async () => {
      const { existsSync } = await import('fs');
      vi.mocked(existsSync).mockReturnValue(false);

      const { configExists } = await import('../../src/lib/config.js');
      expect(configExists()).toBe(false);
    });
  });
});
