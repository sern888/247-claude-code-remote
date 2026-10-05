import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
  chmodSync,
  unlinkSync,
} from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getTestableHomedir } from './paths.js';
import {
  type ClaudeSettings,
  commandReferencesScript,
  isRecord,
  readClaudeSettings,
  removeScriptHooks,
  writeClaudeSettings,
} from './claude-settings.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const HOOK_SCRIPT_NAME = 'notify-247.sh';
const CODEX_NOTIFY_LINE = `notify = ["bash", "~/.247/hooks/${HOOK_SCRIPT_NAME}"]`;
const CODEX_NOTIFY_REGEX = /^\s*notify\s*=\s*\[[^\]]*\]\s*$/m;

// Hook configuration for Claude Code settings.json
const HOOK_MATCHER = '*';
// All hook types we need to register
const HOOK_TYPES = ['Stop', 'PermissionRequest', 'Notification'] as const;

// Paths are resolved on demand so the AGENT_247_HOME override is always honoured.
function getClaudeSettingsPath(): string {
  return join(getTestableHomedir(), '.claude', 'settings.json');
}

function getCodexConfigPath(): string {
  return join(getTestableHomedir(), '.codex', 'config.toml');
}

function getHooksDir(): string {
  return join(getTestableHomedir(), '.247', 'hooks');
}

function getHookScriptPath(): string {
  return join(getHooksDir(), HOOK_SCRIPT_NAME);
}

function getHookCommand(): string {
  return `bash ${getHookScriptPath()}`;
}

export interface HookStatus {
  installed: boolean;
  version: string | null;
  path: string;
  settingsConfigured: boolean;
  needsUpdate: boolean;
  packagedVersion: string;
}

export interface InstallResult {
  success: boolean;
  error?: string;
  installedVersion?: string;
}

export interface UninstallResult {
  success: boolean;
  error?: string;
}

export interface CodexNotifyStatus {
  configPath: string;
  configExists: boolean;
  notifyConfigured: boolean;
  notifyLine?: string;
}

export interface CodexInstallResult {
  success: boolean;
  status: 'installed' | 'updated' | 'already-configured' | 'missing-config' | 'conflict';
  error?: string;
}

export interface CodexUninstallResult {
  success: boolean;
  status: 'removed' | 'not-configured' | 'missing-config' | 'conflict';
  error?: string;
}

/**
 * Get the path to the packaged hook script.
 * In dev mode, it's in packages/hooks; in production, it's bundled with CLI.
 */
function getPackagedHookPath(): string {
  // CLI root is 2 levels up from lib/ (dist/lib -> dist -> cli root)
  const cliRoot = join(__dirname, '..', '..');

  // Check if running from source (monorepo) or installed (npm global)
  const monorepoRoot = join(cliRoot, '..', '..');
  const isDev = existsSync(join(monorepoRoot, 'pnpm-workspace.yaml'));

  if (isDev) {
    // Development: hook is in packages/hooks
    return join(monorepoRoot, 'packages', 'hooks', HOOK_SCRIPT_NAME);
  } else {
    // Production: hook is bundled in cli/hooks
    return join(cliRoot, 'hooks', HOOK_SCRIPT_NAME);
  }
}

/**
 * Extract version from a hook script.
 * Looks for: # VERSION: x.y.z
 */
function extractVersion(scriptPath: string): string | null {
  try {
    if (!existsSync(scriptPath)) return null;
    const content = readFileSync(scriptPath, 'utf-8');
    const match = content.match(/^# VERSION:\s*(\d+\.\d+\.\d+)/m);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * Get the version of the installed hook script.
 */
export function getHookVersion(): string | null {
  return extractVersion(getHookScriptPath());
}

/**
 * Get the version of the packaged hook script.
 */
export function getPackagedHookVersion(): string {
  const packagedPath = getPackagedHookPath();
  const version = extractVersion(packagedPath);
  // Fall back to reading from package.json if not found in script
  if (!version) {
    try {
      const cliRoot = join(__dirname, '..', '..');
      const pkgPath = join(cliRoot, 'package.json');
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
        return pkg.version || '0.0.0';
      }
    } catch {
      // Ignore
    }
    return '0.0.0';
  }
  return version;
}

/**
 * Check if the hook is installed in Claude Code settings for all required hook types.
 */
function isHookInSettings(): boolean {
  try {
    const { hooks } = readClaudeSettings(getClaudeSettingsPath());
    if (!isRecord(hooks)) return false;

    // Check if our hook is registered for all required types
    return HOOK_TYPES.every((hookType) => {
      const entries = hooks[hookType];
      return Array.isArray(entries) && entries.some(isOwnHookEntry);
    });
  } catch {
    // Status checks treat an unreadable settings file as "not configured";
    // install/uninstall surface the underlying error instead.
    return false;
  }
}

/**
 * True for a settings entry that registers our script under our matcher.
 */
function isOwnHookEntry(entry: unknown): boolean {
  if (!isRecord(entry) || entry.matcher !== HOOK_MATCHER || !Array.isArray(entry.hooks)) {
    return false;
  }
  return entry.hooks.some(
    (hook) => isRecord(hook) && commandReferencesScript(hook.command, HOOK_SCRIPT_NAME)
  );
}

/**
 * Check if the hook script file exists.
 */
export function isHookInstalled(): boolean {
  return existsSync(getHookScriptPath()) && isHookInSettings();
}

/**
 * Check if the installed hook needs an update.
 */
export function needsUpdate(): boolean {
  const installedVersion = getHookVersion();
  const packagedVersion = getPackagedHookVersion();

  if (!installedVersion) return true;
  if (!packagedVersion) return false;

  // Simple semver comparison
  const installed = installedVersion.split('.').map(Number);
  const packaged = packagedVersion.split('.').map(Number);

  for (let i = 0; i < 3; i++) {
    if (packaged[i] > installed[i]) return true;
    if (packaged[i] < installed[i]) return false;
  }

  return false;
}

/**
 * Get comprehensive hook status.
 */
export function getHooksStatus(): HookStatus {
  const scriptPath = getHookScriptPath();
  const scriptExists = existsSync(scriptPath);
  const settingsConfigured = isHookInSettings();
  const installedVersion = scriptExists ? getHookVersion() : null;
  const packagedVersion = getPackagedHookVersion();

  return {
    installed: scriptExists && settingsConfigured,
    version: installedVersion,
    path: scriptPath,
    settingsConfigured,
    needsUpdate: scriptExists ? needsUpdate() : false,
    packagedVersion,
  };
}

function isOwnHookType(hookType: string): boolean {
  return (HOOK_TYPES as readonly string[]).includes(hookType);
}

/**
 * Return settings with our hook registered once for every required hook type.
 * Hooks belonging to the user are kept untouched.
 */
function withOwnHooks(settings: ClaudeSettings): ClaudeSettings {
  const existing = isRecord(settings.hooks) ? settings.hooks : {};
  const ownEntry = {
    matcher: HOOK_MATCHER,
    hooks: [{ type: 'command', command: getHookCommand() }],
  };

  const installed = Object.fromEntries(
    HOOK_TYPES.map((hookType) => {
      const current = existing[hookType];
      const entries = Array.isArray(current) ? current : [];
      return [hookType, [...removeScriptHooks(entries, HOOK_SCRIPT_NAME), ownEntry]];
    })
  );

  return { ...settings, hooks: { ...existing, ...installed } };
}

/**
 * Return settings without our hook. Only commands that run our script are
 * removed; hook types and the hooks object are dropped once they become empty.
 */
function withoutOwnHooks(settings: ClaudeSettings): ClaudeSettings {
  if (!isRecord(settings.hooks)) return settings;

  const remainingHooks = Object.entries(settings.hooks).flatMap(([hookType, entries]) => {
    if (!isOwnHookType(hookType) || !Array.isArray(entries)) return [[hookType, entries]];
    const remaining = removeScriptHooks(entries, HOOK_SCRIPT_NAME);
    return remaining.length > 0 ? [[hookType, remaining]] : [];
  });

  if (remainingHooks.length > 0) {
    return { ...settings, hooks: Object.fromEntries(remainingHooks) };
  }
  const { hooks: _removedHooks, ...settingsWithoutHooks } = settings;
  return settingsWithoutHooks;
}

/**
 * Install the hook: copy script and update Claude Code settings.
 * Settings are read first so an unreadable settings.json aborts before any write.
 */
export function installHook(): InstallResult {
  try {
    const packagedPath = getPackagedHookPath();
    if (!existsSync(packagedPath)) {
      return { success: false, error: `Packaged hook not found at ${packagedPath}` };
    }

    const settingsPath = getClaudeSettingsPath();
    const settings = readClaudeSettings(settingsPath);

    const hooksDir = getHooksDir();
    if (!existsSync(hooksDir)) {
      mkdirSync(hooksDir, { recursive: true });
    }

    const scriptPath = getHookScriptPath();
    copyFileSync(packagedPath, scriptPath);
    chmodSync(scriptPath, 0o755); // Make executable

    writeClaudeSettings(settingsPath, withOwnHooks(settings));

    const installedVersion = getHookVersion();
    return { success: true, installedVersion: installedVersion || undefined };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/**
 * Uninstall the hook: remove from settings and optionally delete script.
 */
export function uninstallHook(removeScript: boolean = true): UninstallResult {
  try {
    // 1. Remove from Claude Code settings
    const settingsPath = getClaudeSettingsPath();
    if (existsSync(settingsPath)) {
      const settings = readClaudeSettings(settingsPath);
      if (isRecord(settings.hooks)) {
        writeClaudeSettings(settingsPath, withoutOwnHooks(settings));
      }
    }

    // 2. Remove script file if requested
    const scriptPath = getHookScriptPath();
    if (removeScript && existsSync(scriptPath)) {
      unlinkSync(scriptPath);
    }

    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

function getCodexNotifyLine(config: string): string | null {
  const match = config.match(CODEX_NOTIFY_REGEX);
  return match ? match[0] : null;
}

function readCodexConfig(): string | null {
  try {
    const configPath = getCodexConfigPath();
    if (!existsSync(configPath)) return null;
    return readFileSync(configPath, 'utf-8');
  } catch {
    return null;
  }
}

function writeCodexConfig(content: string): void {
  const configPath = getCodexConfigPath();
  const dir = dirname(configPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(configPath, content);
}

export function getCodexNotifyStatus(): CodexNotifyStatus {
  const configPath = getCodexConfigPath();
  const config = readCodexConfig();
  if (!config) {
    return {
      configPath,
      configExists: false,
      notifyConfigured: false,
    };
  }

  const notifyLine = getCodexNotifyLine(config);
  const notifyConfigured = !!notifyLine && notifyLine.includes(HOOK_SCRIPT_NAME);

  return {
    configPath,
    configExists: true,
    notifyConfigured,
    notifyLine: notifyLine || undefined,
  };
}

export function installCodexNotify(options: { force?: boolean } = {}): CodexInstallResult {
  try {
    const config = readCodexConfig();
    if (!config) {
      return { success: false, status: 'missing-config' };
    }

    const notifyLine = getCodexNotifyLine(config);
    if (notifyLine && notifyLine.includes(HOOK_SCRIPT_NAME)) {
      return { success: true, status: 'already-configured' };
    }

    if (notifyLine && !options.force) {
      return { success: false, status: 'conflict' };
    }

    let updatedConfig = config.trimEnd();
    if (notifyLine) {
      updatedConfig = updatedConfig.replace(CODEX_NOTIFY_REGEX, CODEX_NOTIFY_LINE);
      writeCodexConfig(`${updatedConfig}\n`);
      return { success: true, status: 'updated' };
    }

    const separator = updatedConfig.length > 0 ? '\n\n' : '';
    updatedConfig = `${updatedConfig}${separator}# 247 notifications\n${CODEX_NOTIFY_LINE}\n`;
    writeCodexConfig(updatedConfig);

    return { success: true, status: 'installed' };
  } catch (err) {
    return { success: false, status: 'conflict', error: (err as Error).message };
  }
}

export function uninstallCodexNotify(): CodexUninstallResult {
  try {
    const config = readCodexConfig();
    if (!config) {
      return { success: true, status: 'missing-config' };
    }

    const notifyLine = getCodexNotifyLine(config);
    if (!notifyLine) {
      return { success: true, status: 'not-configured' };
    }

    if (!notifyLine.includes(HOOK_SCRIPT_NAME)) {
      return { success: false, status: 'conflict' };
    }

    let updatedConfig = config.replace(CODEX_NOTIFY_REGEX, '').replace(/\n{3,}/g, '\n\n');
    updatedConfig = updatedConfig.trimEnd();
    writeCodexConfig(updatedConfig.length ? `${updatedConfig}\n` : '');
    return { success: true, status: 'removed' };
  } catch (err) {
    return { success: false, status: 'conflict', error: (err as Error).message };
  }
}
