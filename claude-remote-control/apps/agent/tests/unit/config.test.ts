import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolve } from 'path';

// Mock fs before importing the module
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

describe('Agent Config', () => {
  const mockHome = '/mock/home';
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env.HOME = mockHome;
    delete process.env.AGENT_247_PROFILE;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  const validConfig = {
    machine: { id: 'test-id', name: 'Test Machine' },
    projects: { basePath: '~/Dev', whitelist: [] },
  };

  describe('loadConfig', () => {
    it('loads default config from ~/.247/config.json', async () => {
      const { existsSync, readFileSync } = await import('fs');
      const mockedExistsSync = vi.mocked(existsSync);
      const mockedReadFileSync = vi.mocked(readFileSync);

      mockedExistsSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue(JSON.stringify(validConfig));

      const { loadConfig } = await import('../../src/config.js');
      const config = loadConfig();

      expect(config).toEqual(validConfig);
      expect(mockedExistsSync).toHaveBeenCalledWith(resolve(mockHome, '.247', 'config.json'));
    });

    it('loads profile config from ~/.247/profiles/<name>.json', async () => {
      process.env.AGENT_247_PROFILE = 'dev';

      const { existsSync, readFileSync } = await import('fs');
      const mockedExistsSync = vi.mocked(existsSync);
      const mockedReadFileSync = vi.mocked(readFileSync);

      const profileConfig = { ...validConfig, machine: { id: 'dev-id', name: 'Dev Machine' } };
      mockedExistsSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue(JSON.stringify(profileConfig));

      const { loadConfig } = await import('../../src/config.js');
      const config = loadConfig();

      expect(config).toEqual(profileConfig);
      expect(mockedExistsSync).toHaveBeenCalledWith(
        resolve(mockHome, '.247', 'profiles', 'dev.json')
      );
    });

    it('falls back to default config if profile not found', async () => {
      process.env.AGENT_247_PROFILE = 'nonexistent';

      const { existsSync, readFileSync } = await import('fs');
      const mockedExistsSync = vi.mocked(existsSync);
      const mockedReadFileSync = vi.mocked(readFileSync);

      // Profile doesn't exist, but default does
      mockedExistsSync.mockImplementation((path) => {
        return String(path).includes('config.json') && !String(path).includes('profiles');
      });
      mockedReadFileSync.mockReturnValue(JSON.stringify(validConfig));

      const { loadConfig } = await import('../../src/config.js');
      const config = loadConfig();

      expect(config).toEqual(validConfig);
    });

    it('throws error if no config found', async () => {
      const { existsSync } = await import('fs');
      const mockedExistsSync = vi.mocked(existsSync);
      mockedExistsSync.mockReturnValue(false);

      // Module import will throw because loadConfig() is called at module load time
      await expect(import('../../src/config.js')).rejects.toThrow('No configuration found');
    });

    it('caches config after first load (returns same reference)', async () => {
      const { existsSync, readFileSync } = await import('fs');
      const mockedExistsSync = vi.mocked(existsSync);
      const mockedReadFileSync = vi.mocked(readFileSync);

      mockedExistsSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue(JSON.stringify(validConfig));

      const { loadConfig, config } = await import('../../src/config.js');

      // loadConfig() should return cached config (same as exported config)
      const config2 = loadConfig();

      expect(config).toBe(config2);
      // readFileSync should only be called once (at module load)
      expect(mockedReadFileSync).toHaveBeenCalledTimes(1);
    });

    it('throws error for invalid JSON at module load', async () => {
      const { existsSync, readFileSync } = await import('fs');
      const mockedExistsSync = vi.mocked(existsSync);
      const mockedReadFileSync = vi.mocked(readFileSync);

      mockedExistsSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue('{ invalid json }');

      // Module import will throw because loadConfig() is called at module load time.
      // The error names the broken file instead of claiming there is no config.
      await expect(import('../../src/config.js')).rejects.toThrow('Invalid configuration at');
    });

    it('does not fall back to the default config when the profile file is corrupt', async () => {
      process.env.AGENT_247_PROFILE = 'dev';

      const { existsSync, readFileSync } = await import('fs');
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockImplementation((path) =>
        String(path).includes('profiles') ? '{ invalid json }' : JSON.stringify(validConfig)
      );

      // Falling back would start the agent with another machine id and port
      await expect(import('../../src/config.js')).rejects.toThrow(
        /Invalid configuration at .*dev\.json/
      );
    });

    it('rejects a config without the fields the agent needs', async () => {
      const { existsSync, readFileSync } = await import('fs');
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ agent: { port: 4678 } }));

      await expect(import('../../src/config.js')).rejects.toThrow('"machine.id"');
    });

    it('treats a missing whitelist as empty', async () => {
      const { existsSync, readFileSync } = await import('fs');
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({ machine: { id: 'm', name: 'M' }, projects: { basePath: '~/Dev' } })
      );

      const { config } = await import('../../src/config.js');

      expect(config.projects.whitelist).toEqual([]);
    });
  });
});
