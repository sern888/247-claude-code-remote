/**
 * Service Definition Environment Tests
 *
 * The launchd plist and systemd unit must hand the agent the same AGENT_247_*
 * environment the CLI uses when it starts the agent itself.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockPaths = {
  cliRoot: '/mock/cli',
  agentRoot: '/mock/agent',
  configDir: '/mock/.247',
  configPath: '/mock/.247/config.json',
  dataDir: '/mock/.247/data',
  logDir: '/mock/.247/logs',
  pidFile: '/mock/.247/agent.pid',
  nodePath: '/usr/local/bin/node',
  isDev: false,
};

vi.mock('../../../src/lib/paths.js', () => ({
  getAgentPaths: () => mockPaths,
  getTestableHomedir: () => '/mock',
}));

vi.mock('../../../src/lib/config.js', () => ({
  loadConfig: vi.fn(),
}));

vi.mock('../../../src/lib/prerequisites.js', () => ({
  checkTmux: vi.fn(() => ({ name: 'tmux', status: 'ok', message: 'tmux 3.4' })),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(() => true),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock('child_process', () => ({
  exec: vi.fn(
    (_command: string, callback: (err: null, result: { stdout: string; stderr: string }) => void) =>
      callback(null, { stdout: '', stderr: '' })
  ),
}));

const config = {
  machine: { id: 'test-id', name: 'Test Machine' },
  agent: { port: 4999 },
  projects: { basePath: '~/Dev', whitelist: [] },
};

async function writtenServiceFile(): Promise<string> {
  const { writeFileSync } = await import('fs');
  return String(vi.mocked(writeFileSync).mock.calls[0][1]);
}

describe('Service definition environment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  describe('launchd plist', () => {
    it('passes the configured port next to the other AGENT_247 variables', async () => {
      const { loadConfig } = await import('../../../src/lib/config.js');
      vi.mocked(loadConfig).mockReturnValue(config);

      const { LaunchdService } = await import('../../../src/service/launchd.js');
      const result = await new LaunchdService().install();

      const plist = await writtenServiceFile();
      expect(result.success).toBe(true);
      expect(plist).toContain('<key>AGENT_247_CONFIG</key>');
      expect(plist).toMatch(/<key>AGENT_247_PORT<\/key>\s*<string>4999<\/string>/);
    });

    it('omits the port when no configuration can be loaded', async () => {
      const { loadConfig } = await import('../../../src/lib/config.js');
      vi.mocked(loadConfig).mockReturnValue(null);

      const { LaunchdService } = await import('../../../src/service/launchd.js');
      await new LaunchdService().install();

      const plist = await writtenServiceFile();
      expect(plist).toContain('<key>AGENT_247_CONFIG</key>');
      expect(plist).not.toContain('AGENT_247_PORT');
    });

    it('does not set the unused AGENT_247_DATA variable', async () => {
      const { loadConfig } = await import('../../../src/lib/config.js');
      vi.mocked(loadConfig).mockReturnValue(config);

      const { LaunchdService } = await import('../../../src/service/launchd.js');
      await new LaunchdService().install();

      expect(await writtenServiceFile()).not.toContain('AGENT_247_DATA');
    });
  });

  describe('systemd unit', () => {
    it('passes the configured port next to the other AGENT_247 variables', async () => {
      const { loadConfig } = await import('../../../src/lib/config.js');
      vi.mocked(loadConfig).mockReturnValue(config);

      const { SystemdService } = await import('../../../src/service/systemd.js');
      const result = await new SystemdService().install();

      const unit = await writtenServiceFile();
      expect(result.success).toBe(true);
      expect(unit).toContain('Environment="AGENT_247_CONFIG=/mock/.247/config.json"');
      expect(unit).toContain('Environment="AGENT_247_PORT=4999"');
    });

    it('omits the port when no configuration can be loaded', async () => {
      const { loadConfig } = await import('../../../src/lib/config.js');
      vi.mocked(loadConfig).mockReturnValue(null);

      const { SystemdService } = await import('../../../src/service/systemd.js');
      await new SystemdService().install();

      const unit = await writtenServiceFile();
      expect(unit).toContain('AGENT_247_CONFIG');
      expect(unit).not.toContain('AGENT_247_PORT');
    });

    it('does not set the unused AGENT_247_DATA variable', async () => {
      const { loadConfig } = await import('../../../src/lib/config.js');
      vi.mocked(loadConfig).mockReturnValue(config);

      const { SystemdService } = await import('../../../src/service/systemd.js');
      await new SystemdService().install();

      expect(await writtenServiceFile()).not.toContain('AGENT_247_DATA');
    });
  });
});
