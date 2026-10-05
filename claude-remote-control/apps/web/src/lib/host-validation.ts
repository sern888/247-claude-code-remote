/**
 * Pure helpers to validate hosts before the server opens a connection to them (SSRF protection).
 *
 * Used by /api/pair/validate (agent host taken from an unsigned pairing token) and
 * /api/push/subscribe (push endpoint that web-push will later POST to).
 */

export type HostKind = 'loopback' | 'private' | 'public';

export interface HostPort {
  /** Normalised hostname (lower-case, IPv4 in dotted-quad form, IPv6 in brackets) */
  hostname: string;
  port: number | null;
  /** `hostname` or `hostname:port`, safe to interpolate into a URL */
  host: string;
}

export type AgentBaseUrlResult =
  | { ok: true; baseUrl: string; host: string; kind: HostKind }
  | { ok: false; reason: 'invalid' | 'blocked' };

const MAX_HOST_INPUT_LENGTH = 255;
const MAX_HOSTNAME_LENGTH = 253;
const MAX_LABEL_LENGTH = 63;
const MAX_PORT = 65535;
const MAX_URL_LENGTH = 2048;
const IPV6_GROUP_COUNT = 8;
const ASCII_SPACE = 0x20;
const ASCII_DELETE = 0x7f;

const DNS_LABEL = '[a-z0-9](?:[a-z0-9-]*[a-z0-9])?';
const HOST_PORT_PATTERN = new RegExp(
  `^(?<hostname>${DNS_LABEL}(?:\\.${DNS_LABEL})*|\\[[0-9a-f:.]+\\])(?::(?<port>\\d{1,5}))?$`,
  'i'
);
const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const PRIVATE_NAME_SUFFIXES = ['.local', '.internal'];

function parsePort(rawPort: string | undefined): number | null | 'invalid' {
  if (rawPort === undefined) return null;
  const port = Number(rawPort);
  return Number.isInteger(port) && port >= 1 && port <= MAX_PORT ? port : 'invalid';
}

function hasValidLabels(hostname: string): boolean {
  if (hostname.startsWith('[')) return true;
  if (hostname.length > MAX_HOSTNAME_LENGTH) return false;
  return hostname.split('.').every((label) => label.length <= MAX_LABEL_LENGTH);
}

/**
 * Let the WHATWG URL parser normalise the hostname. This is what `fetch` will do anyway, so
 * exotic spellings of an IP address ("2130706433", "0x7f.1", "127.1") become "127.0.0.1"
 * before classification instead of slipping through as a "DNS name".
 */
function normaliseHostname(hostWithOptionalPort: string): string | null {
  try {
    const url = new URL(`http://${hostWithOptionalPort}`);
    const isBareHost =
      url.username === '' &&
      url.password === '' &&
      url.pathname === '/' &&
      url.search === '' &&
      url.hash === '';
    return isBareHost ? url.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Parse a strict `hostname[:port]` string.
 * Rejects schemes, paths, queries, fragments, userinfo, whitespace and anything non-string.
 */
export function parseHostPort(input: unknown): HostPort | null {
  if (typeof input !== 'string' || input.length === 0 || input.length > MAX_HOST_INPUT_LENGTH) {
    return null;
  }

  const groups = HOST_PORT_PATTERN.exec(input)?.groups;
  if (!groups || !hasValidLabels(groups.hostname)) return null;

  const port = parsePort(groups.port);
  if (port === 'invalid') return null;

  const hostname = normaliseHostname(input);
  if (!hostname) return null;

  return { hostname, port, host: port === null ? hostname : `${hostname}:${port}` };
}

function classifyIpv4(octets: readonly number[]): HostKind {
  const [a, b, c] = octets;
  if (a === 127) return 'loopback';

  const isPrivate =
    a === 0 || // "this network"
    a === 10 || // RFC 1918
    (a === 100 && b >= 64 && b <= 127) || // CGNAT (also Tailscale addresses)
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) || // RFC 1918
    (a === 192 && b === 168) || // RFC 1918
    (a === 192 && b === 0 && c === 0) || // IETF protocol assignments
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224; // multicast, reserved, broadcast

  return isPrivate ? 'private' : 'public';
}

function parseIpv4(hostname: string): number[] | null {
  const match = IPV4_PATTERN.exec(hostname);
  if (!match) return null;
  const octets = match.slice(1).map(Number);
  return octets.every((octet) => octet <= 255) ? octets : null;
}

/** Expand a normalised (URL-serialised) IPv6 literal such as "fe80::1" into its 8 groups. */
function expandIpv6(address: string): number[] | null {
  const halves = address.split('::');
  if (halves.length > 2) return null;

  const parseGroups = (part: string): number[] =>
    part === '' ? [] : part.split(':').map((group) => parseInt(group, 16));
  const head = parseGroups(halves[0]);
  const tail = halves.length === 2 ? parseGroups(halves[1]) : [];
  const missing = IPV6_GROUP_COUNT - head.length - tail.length;

  if (halves.length === 1 && missing !== 0) return null;
  if (halves.length === 2 && missing < 1) return null;

  const groups = [...head, ...new Array<number>(Math.max(missing, 0)).fill(0), ...tail];
  const isValid = groups.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff);
  return isValid ? groups : null;
}

function toOctets(high: number, low: number): number[] {
  return [high >> 8, high & 0xff, low >> 8, low & 0xff];
}

/** The IPv4 address carried inside a mapping/transition IPv6 address, if there is one. */
function embeddedIpv4(groups: readonly number[]): number[] | null {
  const isZero = (from: number, to: number) => groups.slice(from, to).every((g) => g === 0);
  const lowBits = toOctets(groups[6], groups[7]);

  if (isZero(0, 5) && groups[5] === 0xffff) return lowBits; // ::ffff:a.b.c.d (IPv4-mapped)
  if (isZero(0, 4) && groups[4] === 0xffff && groups[5] === 0) return lowBits; // ::ffff:0:a.b.c.d
  if (isZero(0, 6)) return lowBits; // ::a.b.c.d (IPv4-compatible, deprecated)
  if (groups[0] === 0x64 && groups[1] === 0xff9b && isZero(2, 6)) return lowBits; // NAT64
  if (groups[0] === 0x2002) return toOctets(groups[1], groups[2]); // 6to4
  return null;
}

function classifyIpv6(address: string): HostKind {
  const groups = expandIpv6(address);
  if (!groups) return 'private'; // fail closed on anything we cannot parse

  if (groups.every((group) => group === 0)) return 'private'; // unspecified address "::"
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return 'loopback'; // ::1

  const ipv4 = embeddedIpv4(groups);
  if (ipv4) return classifyIpv4(ipv4);

  const first = groups[0];
  const isPrivate =
    (first & 0xfe00) === 0xfc00 || // unique local fc00::/7
    (first & 0xffc0) === 0xfe80 || // link-local fe80::/10
    (first & 0xffc0) === 0xfec0 || // site-local (deprecated)
    (first & 0xff00) === 0xff00 || // multicast
    (first === 0x2001 && groups[1] === 0); // Teredo tunnelling

  return isPrivate ? 'private' : 'public';
}

function classifyName(hostname: string): HostKind {
  // Empty labels ("", "a..b", ".a") are not valid names: fail closed
  if (hostname.split('.').some((label) => label === '')) return 'private';
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return 'loopback';
  if (PRIVATE_NAME_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) return 'private';
  // Single-label names ("intranet", "metadata") only resolve through local search domains
  if (!hostname.includes('.')) return 'private';
  return 'public';
}

/**
 * Classify a normalised hostname (as returned by `parseHostPort` or `URL#hostname`).
 * Note: this inspects the name only; it cannot see what a public DNS name resolves to.
 */
export function classifyHostname(hostname: string): HostKind {
  // "localhost." is the same host as "localhost": drop the root label before classifying
  const normalised = hostname.toLowerCase().replace(/\.$/, '');

  if (normalised.startsWith('[') && normalised.endsWith(']')) {
    return classifyIpv6(normalised.slice(1, -1));
  }

  const ipv4 = parseIpv4(normalised);
  if (ipv4) return classifyIpv4(ipv4);

  return classifyName(normalised);
}

/**
 * Turn an agent host taken from untrusted input into a base URL the server may fetch.
 *
 * - only a strict `hostname[:port]` is accepted ('invalid' otherwise)
 * - in production, loopback/private/link-local hosts are refused ('blocked')
 * - plain http is used for loopback hosts only (local dashboard + local agent), https otherwise
 */
export function resolveAgentBaseUrl(
  agentHost: unknown,
  options: { isProduction: boolean }
): AgentBaseUrlResult {
  const parsed = parseHostPort(agentHost);
  if (!parsed) return { ok: false, reason: 'invalid' };

  const kind = classifyHostname(parsed.hostname);
  if (options.isProduction && kind !== 'public') return { ok: false, reason: 'blocked' };

  const protocol = kind === 'loopback' ? 'http' : 'https';
  return { ok: true, baseUrl: `${protocol}://${parsed.host}`, host: parsed.host, kind };
}

/** Whitespace and control characters: the URL parser silently strips some of them. */
function hasWhitespaceOrControlChars(value: string): boolean {
  return [...value].some((char) => {
    const code = char.charCodeAt(0);
    return code <= ASCII_SPACE || code === ASCII_DELETE;
  });
}

/**
 * True for an `https://` URL without credentials whose host is not loopback/private.
 * The string must be clean (no whitespace/control characters) so it is safe to store and log.
 */
export function isPublicHttpsUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_URL_LENGTH) {
    return false;
  }
  if (hasWhitespaceOrControlChars(value)) {
    return false;
  }

  try {
    const url = new URL(value);
    const hasCredentials = url.username !== '' || url.password !== '';
    return (
      url.protocol === 'https:' && !hasCredentials && classifyHostname(url.hostname) === 'public'
    );
  } catch {
    return false;
  }
}
