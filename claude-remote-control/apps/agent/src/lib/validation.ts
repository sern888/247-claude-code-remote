/**
 * Validation for values that arrive over HTTP/WebSocket and end up in tmux
 * arguments, file paths or generated scripts.
 */

import os from 'os';
import path from 'path';

const SESSION_NAME_PATTERN = /^[\w-]{1,100}$/;
const SEMVER_PATTERN = /^\d{1,5}\.\d{1,5}\.\d{1,5}$/;
const REPO_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export const DEFAULT_HISTORY_LINES = 10000;
export const MAX_HISTORY_LINES = 50000;

/**
 * Session names are used as tmux targets and as part of a temp file name,
 * so only word characters and dashes are allowed.
 */
export function isValidSessionName(value: unknown): value is string {
  return typeof value === 'string' && SESSION_NAME_PATTERN.test(value);
}

/**
 * Make an arbitrary project name usable inside a session name.
 * tmux itself rewrites "." and ":" to "_", so this keeps both sides in sync.
 */
export function sanitizeSessionNamePart(value: string): string {
  return value.replace(/[^\w-]/g, '_');
}

/**
 * Coerce a requested scrollback size to a positive integer within bounds.
 */
export function clampHistoryLines(
  value: unknown,
  fallback: number = DEFAULT_HISTORY_LINES
): number {
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(parsed, MAX_HISTORY_LINES);
}

export function isValidSemver(value: unknown): value is string {
  return typeof value === 'string' && SEMVER_PATTERN.test(value);
}

/**
 * A directory name git may clone into: must not look like an option ("-x")
 * or a path ("..", "a/b").
 */
export function isValidRepoName(value: unknown): value is string {
  return typeof value === 'string' && REPO_NAME_PATTERN.test(value) && value !== '.git';
}

/**
 * Resolve `child` against `basePath` and return it only when the result is
 * strictly inside `basePath`. Returns null for traversal or absolute paths.
 */
export function resolveInsideBase(basePath: string, child: string): string | null {
  if (!child || child.includes('\0')) {
    return null;
  }
  const base = path.resolve(basePath);
  const resolved = path.resolve(base, child);
  return resolved.startsWith(base + path.sep) ? resolved : null;
}

/**
 * Expand a leading "~" to the user's home directory.
 */
export function expandHome(value: string): string {
  if (value === '~') {
    return os.homedir();
  }
  return value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
}
