/**
 * Terminal constants and theme configuration
 */

// Reconnection constants
export const WS_RECONNECT_BASE_DELAY = 1000; // 1 second
export const WS_RECONNECT_MAX_DELAY = 30000; // 30 seconds

// Heartbeat constants (adaptive ping)
export const WS_PING_INTERVAL = 10000; // 10 seconds between pings
export const WS_PONG_TIMEOUT = 5000; // 5 seconds to receive pong
export const WS_ACTIVITY_PAUSE = 3000; // 3 seconds after activity before resuming pings

// xterm.js theme
export const TERMINAL_THEME = {
  background: '#0a0a10',
  foreground: '#e4e4e7',
  cursor: '#f97316',
  cursorAccent: '#0a0a10',
  selectionBackground: 'rgba(249, 115, 22, 0.3)',
  selectionForeground: '#ffffff',
  black: '#18181b',
  red: '#f87171',
  green: '#4ade80',
  yellow: '#fbbf24',
  blue: '#60a5fa',
  magenta: '#c084fc',
  cyan: '#22d3ee',
  white: '#e4e4e7',
  brightBlack: '#52525b',
  brightRed: '#fca5a5',
  brightGreen: '#86efac',
  brightYellow: '#fde047',
  brightBlue: '#93c5fd',
  brightMagenta: '#d8b4fe',
  brightCyan: '#67e8f9',
  brightWhite: '#fafafa',
};

// Session names
// The agent only accepts names matching /^[\w-]{1,100}$/ (they become tmux targets).
export const SESSION_NAME_MAX_LENGTH = 100;
export const SESSION_NAME_SEPARATOR = '--';
/** Suffix of the placeholder name a session has until the agent confirms its real name. */
export const NEW_SESSION_SUFFIX = 'new';

const SESSION_NAME_UNSAFE_CHARS = /[^A-Za-z0-9_-]/g;
const SESSION_NAME_REPLACEMENT = '_';
const SESSION_NAME_ADJECTIVES = [
  'brave',
  'swift',
  'calm',
  'bold',
  'wise',
  'keen',
  'fair',
  'wild',
  'bright',
  'cool',
];
const SESSION_NAME_NOUNS = [
  'lion',
  'hawk',
  'wolf',
  'bear',
  'fox',
  'owl',
  'deer',
  'lynx',
  'eagle',
  'tiger',
];
const SESSION_NAME_NUMBER_RANGE = 100;

function pickRandom(items: readonly string[]): string {
  return items[Math.floor(Math.random() * items.length)];
}

/**
 * Make an arbitrary project name usable inside a session name
 * (same replacement as the agent's sanitizeSessionNamePart).
 */
export function sanitizeSessionNamePart(value: string): string {
  return value.replace(SESSION_NAME_UNSAFE_CHARS, SESSION_NAME_REPLACEMENT);
}

/** Make a complete, externally supplied session name acceptable to the agent. */
export function sanitizeSessionName(name: string): string {
  return sanitizeSessionNamePart(name).slice(0, SESSION_NAME_MAX_LENGTH);
}

/**
 * Build `<project>--<suffix>` with a sanitised project part, truncating the
 * project so the whole name never exceeds SESSION_NAME_MAX_LENGTH.
 */
export function buildSessionName(project: string, suffix: string): string {
  const tail = `${SESSION_NAME_SEPARATOR}${suffix}`;
  const maxProjectLength = Math.max(0, SESSION_NAME_MAX_LENGTH - tail.length);
  return `${sanitizeSessionNamePart(project).slice(0, maxProjectLength)}${tail}`;
}

// Session name generator (same shape as the agent's)
export function generateSessionName(project: string): string {
  const adjective = pickRandom(SESSION_NAME_ADJECTIVES);
  const noun = pickRandom(SESSION_NAME_NOUNS);
  const number = Math.floor(Math.random() * SESSION_NAME_NUMBER_RANGE);
  return buildSessionName(project, `${adjective}-${noun}-${number}`);
}
