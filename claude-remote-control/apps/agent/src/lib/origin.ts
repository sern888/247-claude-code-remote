/**
 * Browser origin allowlist for the agent's HTTP and WebSocket surface.
 *
 * The agent gives out a shell, so a page the user merely visits must not be
 * able to talk to it. Browsers always send an Origin header on WebSocket
 * upgrades and on cross-origin/non-GET requests; non-browser clients (the CLI,
 * the Claude Code hook script) send none and are not affected.
 */

const DEFAULT_ALLOWED_ORIGINS = [
  'https://247.quivr.com',
  'http://localhost:3001',
  'http://127.0.0.1:3001',
];

export interface AllowedOriginsInput {
  /** Dashboard URL from config (may include a path such as /api) */
  dashboardUrl?: string;
  /** Extra origins from config (agent.allowedOrigins) */
  configured?: string[];
  /** Comma-separated extra origins from AGENT_247_ALLOWED_ORIGINS */
  envValue?: string;
}

function toOrigin(value: string): string | null {
  try {
    const { origin } = new URL(value.trim());
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}

export function buildAllowedOrigins(input: AllowedOriginsInput): ReadonlySet<string> {
  const candidates = [
    ...DEFAULT_ALLOWED_ORIGINS,
    ...(input.dashboardUrl ? [input.dashboardUrl] : []),
    ...(input.configured ?? []),
    ...(input.envValue ? input.envValue.split(',') : []),
  ];

  const origins = candidates.map(toOrigin).filter((origin): origin is string => origin !== null);

  return new Set(origins);
}

/**
 * A missing Origin header means a non-browser client and is allowed;
 * a present one must match the allowlist exactly.
 */
export function isOriginAllowed(origin: string | undefined, allowed: ReadonlySet<string>): boolean {
  if (origin === undefined) {
    return true;
  }
  return allowed.has(origin);
}
