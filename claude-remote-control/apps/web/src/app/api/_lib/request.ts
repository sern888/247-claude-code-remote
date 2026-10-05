import { NextResponse } from 'next/server';

export type JsonObject = Record<string, unknown>;

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read a request body that must be a JSON object.
 * Returns null when the body is missing, malformed or not an object (caller answers 400).
 */
export async function readJsonObject(req: Request): Promise<JsonObject | null> {
  try {
    const body: unknown = await req.json();
    return isJsonObject(body) ? body : null;
  } catch {
    return null;
  }
}

/** Non-empty string of at most `maxLength` characters. */
export function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

/** Consistent JSON error shape for every API route: `{ error: string }`. */
export function jsonError(error: string, status: number, headers?: HeadersInit) {
  return NextResponse.json({ error }, { status, headers });
}
