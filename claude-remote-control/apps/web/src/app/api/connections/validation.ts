import { isBoundedString, type JsonObject, type ValidationResult } from '../_lib/request';

export const CONNECTION_METHODS = ['localhost', 'tailscale', 'custom', 'cloud'] as const;
export type ConnectionMethod = (typeof CONNECTION_METHODS)[number];

export const DEFAULT_CONNECTION_METHOD: ConnectionMethod = 'tailscale';

const MAX_URL_LENGTH = 255;
const MAX_NAME_LENGTH = 100;
const MAX_MACHINE_ID_LENGTH = 100;
const HEX_COLOR_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const WHITESPACE_PATTERN = /\s/;

export interface NewConnectionInput {
  url: string;
  name: string;
  method: ConnectionMethod;
  color: string | null | undefined;
  machineId: string | undefined;
}

export interface ConnectionUpdateInput {
  url?: string;
  name?: string;
  method?: ConnectionMethod;
  color?: string | null;
}

function isAbsent(value: unknown): value is undefined | null {
  return value === undefined || value === null;
}

function isConnectionMethod(value: unknown): value is ConnectionMethod {
  return CONNECTION_METHODS.some((method) => method === value);
}

function parseUrl(value: unknown): ValidationResult<string> {
  if (!isBoundedString(value, MAX_URL_LENGTH) || WHITESPACE_PATTERN.test(value)) {
    return {
      ok: false,
      error: `url must be a non-empty string without whitespace (max ${MAX_URL_LENGTH} characters)`,
    };
  }
  return { ok: true, value };
}

function parseName(value: unknown): ValidationResult<string> {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!isBoundedString(name, MAX_NAME_LENGTH)) {
    return {
      ok: false,
      error: `name must be a non-empty string (max ${MAX_NAME_LENGTH} characters)`,
    };
  }
  return { ok: true, value: name };
}

function parseMethod(value: unknown): ValidationResult<ConnectionMethod> {
  if (!isConnectionMethod(value)) {
    return { ok: false, error: `method must be one of: ${CONNECTION_METHODS.join(', ')}` };
  }
  return { ok: true, value };
}

/** `null` clears the color, `undefined` leaves it untouched. */
function parseColor(value: unknown): ValidationResult<string | null | undefined> {
  if (isAbsent(value)) return { ok: true, value };
  if (typeof value !== 'string' || !HEX_COLOR_PATTERN.test(value)) {
    return { ok: false, error: 'color must be a hex color such as #f97316' };
  }
  return { ok: true, value };
}

function parseMachineId(value: unknown): ValidationResult<string | undefined> {
  if (isAbsent(value)) return { ok: true, value: undefined };
  if (!isBoundedString(value, MAX_MACHINE_ID_LENGTH)) {
    return {
      ok: false,
      error: `machineId must be a non-empty string (max ${MAX_MACHINE_ID_LENGTH} characters)`,
    };
  }
  return { ok: true, value };
}

/** Validate the body of POST /api/connections. */
export function parseNewConnection(body: JsonObject): ValidationResult<NewConnectionInput> {
  const url = parseUrl(body.url);
  if (!url.ok) return url;

  const name = parseName(body.name);
  if (!name.ok) return name;

  const method = isAbsent(body.method)
    ? ({ ok: true, value: DEFAULT_CONNECTION_METHOD } as const)
    : parseMethod(body.method);
  if (!method.ok) return method;

  const color = parseColor(body.color);
  if (!color.ok) return color;

  const machineId = parseMachineId(body.machineId);
  if (!machineId.ok) return machineId;

  return {
    ok: true,
    value: {
      url: url.value,
      name: name.value,
      method: method.value,
      color: color.value,
      machineId: machineId.value,
    },
  };
}

/** Validate the body of PUT /api/connections/[id]: every field is optional, at least one is required. */
export function parseConnectionUpdate(body: JsonObject): ValidationResult<ConnectionUpdateInput> {
  const url = body.url === undefined ? undefined : parseUrl(body.url);
  if (url && !url.ok) return url;

  const name = body.name === undefined ? undefined : parseName(body.name);
  if (name && !name.ok) return name;

  const method = body.method === undefined ? undefined : parseMethod(body.method);
  if (method && !method.ok) return method;

  const color = parseColor(body.color);
  if (!color.ok) return color;

  const update: ConnectionUpdateInput = {
    ...(url ? { url: url.value } : {}),
    ...(name ? { name: name.value } : {}),
    ...(method ? { method: method.value } : {}),
    ...(color.value !== undefined ? { color: color.value } : {}),
  };

  if (Object.keys(update).length === 0) {
    return { ok: false, error: 'At least one of url, name, method or color is required' };
  }

  return { ok: true, value: update };
}
