import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'fs';
import { basename, dirname } from 'path';

export type ClaudeSettings = Record<string, unknown>;

/** Suffix of the one-time backup written next to settings.json before 247 modifies it. */
export const SETTINGS_BACKUP_SUFFIX = '.247-backup';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read a Claude Code settings file.
 * A missing or empty file yields an empty object. Unparseable content throws, so
 * callers never overwrite a file they could not understand.
 */
export function readClaudeSettings(settingsPath: string): ClaudeSettings {
  if (!existsSync(settingsPath)) return {};

  const content = readFileSync(settingsPath, 'utf-8');
  if (content.trim() === '') return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`${settingsPath} is not valid JSON; fix or remove it`);
  }

  if (!isRecord(parsed)) {
    throw new Error(`${settingsPath} does not contain a JSON object; fix or remove it`);
  }
  return parsed;
}

/**
 * Keep a single copy of the user's original settings file. An existing backup is
 * never replaced, so it always holds the content from before the first 247 write.
 */
function backupSettingsOnce(settingsPath: string): void {
  const backupPath = `${settingsPath}${SETTINGS_BACKUP_SUFFIX}`;
  if (existsSync(settingsPath) && !existsSync(backupPath)) {
    copyFileSync(settingsPath, backupPath);
  }
}

/**
 * Write a Claude Code settings file, backing up the existing one first.
 */
export function writeClaudeSettings(settingsPath: string, settings: ClaudeSettings): void {
  const dir = dirname(settingsPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  backupSettingsOnce(settingsPath);
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

/**
 * True when a hook command runs the given script file. The script must appear as
 * the file name of one of the command's words, so unrelated commands that merely
 * contain a similar substring do not match.
 */
export function commandReferencesScript(command: unknown, scriptName: string): boolean {
  if (typeof command !== 'string') return false;
  return command
    .split(/\s+/)
    .some((word) => basename(word.replace(/^["']+|["']+$/g, '')) === scriptName);
}

/**
 * Return hook entries without the hook commands that run the given script.
 * Entries left with no commands are dropped; everything else is preserved as is.
 */
export function removeScriptHooks(entries: readonly unknown[], scriptName: string): unknown[] {
  return entries.flatMap((entry) => {
    if (!isRecord(entry) || !Array.isArray(entry.hooks)) return [entry];

    const remaining = entry.hooks.filter(
      (hook) => !(isRecord(hook) && commandReferencesScript(hook.command, scriptName))
    );
    if (remaining.length === entry.hooks.length) return [entry];
    return remaining.length > 0 ? [{ ...entry, hooks: remaining }] : [];
  });
}
