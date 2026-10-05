import { NextResponse } from 'next/server';
import { registerPairingCode, type PairingCodeInfo } from '@/lib/pairing-codes';
import { parseHostPort } from '@/lib/host-validation';
import { getAuthenticatedUserId } from '../../_lib/auth';
import { consumePairingCode, lookupUsablePairingCode } from '../_lib/pairing-code-usage';
import {
  isBoundedString,
  jsonError,
  readJsonObject,
  type JsonObject,
  type ValidationResult,
} from '../../_lib/request';

const PAIRING_CODE_PATTERN = /^\d{6}$/;
const PAIRING_CODE_TTL_MS = 10 * 60 * 1000; // must match src/lib/pairing-codes.ts
const MAX_MACHINE_ID_LENGTH = 100;
const MAX_MACHINE_NAME_LENGTH = 100;
const MAX_AUTH_TOKEN_LENGTH = 512;
const WHITESPACE_PATTERN = /\s/;

type PairingCodeInput = Pick<
  PairingCodeInfo,
  'code' | 'machineId' | 'machineName' | 'agentUrl' | 'authToken'
>;

function parsePairingCodeBody(body: JsonObject): ValidationResult<PairingCodeInput> {
  const { code, machineId, machineName, agentUrl, authToken } = body;

  if (typeof code !== 'string' || !PAIRING_CODE_PATTERN.test(code)) {
    return { ok: false, error: 'Code must be 6 digits' };
  }
  if (!isBoundedString(machineId, MAX_MACHINE_ID_LENGTH)) {
    return { ok: false, error: 'machineId must be a non-empty string' };
  }
  if (!isBoundedString(machineName, MAX_MACHINE_NAME_LENGTH)) {
    return { ok: false, error: 'machineName must be a non-empty string' };
  }
  if (typeof agentUrl !== 'string' || !parseHostPort(agentUrl)) {
    return { ok: false, error: 'agentUrl must be a hostname with an optional port' };
  }
  if (
    authToken !== undefined &&
    (!isBoundedString(authToken, MAX_AUTH_TOKEN_LENGTH) || WHITESPACE_PATTERN.test(authToken))
  ) {
    return { ok: false, error: 'authToken must be a non-empty string without whitespace' };
  }

  return {
    ok: true,
    value: {
      code,
      machineId,
      machineName,
      agentUrl,
      authToken: typeof authToken === 'string' ? authToken : undefined,
    },
  };
}

/**
 * POST /api/pair/code - Register a pairing code (requires authentication)
 */
export async function POST(req: Request) {
  try {
    const userId = await getAuthenticatedUserId();
    if (!userId) {
      return jsonError('Unauthorized', 401);
    }

    const body = await readJsonObject(req);
    if (!body) {
      return jsonError('Request body must be a JSON object', 400);
    }

    const input = parsePairingCodeBody(body);
    if (!input.ok) {
      return jsonError(input.error, 400);
    }

    // Never let one machine overwrite a code that is live for another machine
    const existing = lookupUsablePairingCode(input.value.code);
    if (existing && existing.machineId !== input.value.machineId) {
      return jsonError('Code already in use', 409);
    }

    registerPairingCode(input.value);

    return NextResponse.json({
      success: true,
      code: input.value.code,
      expiresIn: PAIRING_CODE_TTL_MS,
    });
  } catch (error) {
    console.error('Error registering pairing code:', error);
    return jsonError('Failed to register pairing code', 500);
  }
}

/**
 * GET /api/pair/code?code=123456 - Look up a pairing code. A successful lookup consumes it.
 */
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const code = searchParams.get('code');

    if (!code) {
      return jsonError('Code parameter is required', 400);
    }
    if (!PAIRING_CODE_PATTERN.test(code)) {
      return jsonError('Code must be 6 digits', 400);
    }

    const codeInfo = lookupUsablePairingCode(code);
    if (!codeInfo) {
      return jsonError('Invalid or expired code', 404);
    }

    consumePairingCode(codeInfo);

    return NextResponse.json({
      valid: true,
      machineId: codeInfo.machineId,
      machineName: codeInfo.machineName,
      agentUrl: codeInfo.agentUrl,
      authToken: codeInfo.authToken,
      expiresAt: codeInfo.expiresAt,
    });
  } catch (error) {
    console.error('Error looking up pairing code:', error);
    return jsonError('Failed to lookup pairing code', 500);
  }
}
