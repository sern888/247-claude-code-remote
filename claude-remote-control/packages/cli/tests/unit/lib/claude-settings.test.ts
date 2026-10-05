/**
 * Claude Settings Helper Tests
 *
 * These helpers decide what in the user's ~/.claude/settings.json belongs to 247.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  copyFileSync: vi.fn(),
}));

const SETTINGS_PATH = '/home/testuser/.claude/settings.json';
const SCRIPT_NAME = 'notify-247.sh';

describe('Claude settings helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('readClaudeSettings', () => {
    it('returns an empty object when the file does not exist', async () => {
      const { existsSync } = await import('fs');
      vi.mocked(existsSync).mockReturnValue(false);

      const { readClaudeSettings } = await import('../../../src/lib/claude-settings.js');

      expect(readClaudeSettings(SETTINGS_PATH)).toEqual({});
    });

    it('treats an empty file as empty settings', async () => {
      const { existsSync, readFileSync } = await import('fs');
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue('  \n');

      const { readClaudeSettings } = await import('../../../src/lib/claude-settings.js');

      expect(readClaudeSettings(SETTINGS_PATH)).toEqual({});
    });

    it('throws an error naming the file when the content is not valid JSON', async () => {
      const { existsSync, readFileSync } = await import('fs');
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue('{ "model": ');

      const { readClaudeSettings } = await import('../../../src/lib/claude-settings.js');

      expect(() => readClaudeSettings(SETTINGS_PATH)).toThrow(
        `${SETTINGS_PATH} is not valid JSON; fix or remove it`
      );
    });
  });

  describe('writeClaudeSettings', () => {
    it('creates the settings directory when it is missing', async () => {
      const { existsSync, mkdirSync, writeFileSync, copyFileSync } = await import('fs');
      vi.mocked(existsSync).mockReturnValue(false);

      const { writeClaudeSettings } = await import('../../../src/lib/claude-settings.js');
      writeClaudeSettings(SETTINGS_PATH, { model: 'opus' });

      expect(mkdirSync).toHaveBeenCalledWith('/home/testuser/.claude', { recursive: true });
      expect(copyFileSync).not.toHaveBeenCalled();
      expect(writeFileSync).toHaveBeenCalledWith(
        SETTINGS_PATH,
        JSON.stringify({ model: 'opus' }, null, 2)
      );
    });

    it('copies the existing file to the backup before overwriting it', async () => {
      const { existsSync, writeFileSync, copyFileSync } = await import('fs');
      vi.mocked(existsSync).mockImplementation((path) => !String(path).endsWith('.247-backup'));

      const { writeClaudeSettings } = await import('../../../src/lib/claude-settings.js');
      writeClaudeSettings(SETTINGS_PATH, {});

      expect(copyFileSync).toHaveBeenCalledWith(SETTINGS_PATH, `${SETTINGS_PATH}.247-backup`);
      const copyOrder = vi.mocked(copyFileSync).mock.invocationCallOrder[0];
      const writeOrder = vi.mocked(writeFileSync).mock.invocationCallOrder[0];
      expect(copyOrder).toBeLessThan(writeOrder);
    });
  });

  describe('commandReferencesScript', () => {
    it.each([
      'bash ~/.247/hooks/notify-247.sh',
      'bash /home/testuser/.247/hooks/notify-247.sh',
      'bash "/home/testuser/.247/hooks/notify-247.sh"',
      'notify-247.sh',
    ])('matches %j', async (command) => {
      const { commandReferencesScript } = await import('../../../src/lib/claude-settings.js');

      expect(commandReferencesScript(command, SCRIPT_NAME)).toBe(true);
    });

    it.each([
      'bash /opt/tools/deploy-247.sh',
      'echo 247',
      'bash ~/scripts/my-notify-247.sh',
      'bash ~/.247/hooks/notify-247.sh.bak',
      undefined,
      42,
    ])('does not match %j', async (command) => {
      const { commandReferencesScript } = await import('../../../src/lib/claude-settings.js');

      expect(commandReferencesScript(command, SCRIPT_NAME)).toBe(false);
    });
  });

  describe('removeScriptHooks', () => {
    it('leaves malformed entries untouched', async () => {
      const { removeScriptHooks } = await import('../../../src/lib/claude-settings.js');
      const entries = ['a string', null, { matcher: '*' }, { matcher: '*', hooks: 'nope' }];

      expect(removeScriptHooks(entries, SCRIPT_NAME)).toEqual(entries);
    });

    it('does not mutate the entries it is given', async () => {
      const { removeScriptHooks } = await import('../../../src/lib/claude-settings.js');
      const entries = [
        {
          matcher: '*',
          hooks: [
            { type: 'command', command: 'bash ~/.247/hooks/notify-247.sh' },
            { type: 'command', command: 'say done' },
          ],
        },
      ];
      const snapshot = JSON.parse(JSON.stringify(entries));

      const result = removeScriptHooks(entries, SCRIPT_NAME);

      expect(entries).toEqual(snapshot);
      expect(result).toEqual([{ matcher: '*', hooks: [{ type: 'command', command: 'say done' }] }]);
    });
  });
});
