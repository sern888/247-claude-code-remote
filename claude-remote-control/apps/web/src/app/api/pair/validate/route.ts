import { NextResponse } from 'next/server';
import { resolveAgentBaseUrl } from '@/lib/host-validation';
import { lookupUsablePairingCode } from '../_lib/pairing-code-usage';
import {
  isBoundedString,
  isJsonObject,
  readJsonObject,
  type ValidationResult,
} from '../../_lib/request';

const PAIRING_CODE_PATTERN = /^\d{6}$/;
const MAX_TOKEN_LENGTH = 4096;
const MAX_MACHINE_ID_LENGTH = 100;
const MAX_MACHINE_NAME_LENGTH = 100;
const AGENT_VERIFY_PATH = '/api/pair/verify';
const AGENT_VERIFY_TIMEOUT_MS = 5000;

interface TokenPayload {
  machineId: string;
  machineName: string;
  agentUrl: string;
}

function invalid(error: string, status: number) {
  return NextResponse.json({ valid: false, error }, { status });
}

/**
 * Decode a token WITHOUT verifying its signature: only the agent holds the secret.
 * Everything in the payload is therefore untrusted input and is validated here; the
 * signature is checked by asking the agent (see verifyWithAgent).
 */
function decodeToken(token: string): ValidationResult<TokenPayload> {
  const [payloadStr] = token.split('.');
  if (!payloadStr) {
    return { ok: false, error: 'Invalid token format' };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(payloadStr, 'base64url').toString());
  } catch {
    return { ok: false, error: 'Failed to parse token' };
  }

  if (!isJsonObject(payload)) {
    return { ok: false, error: 'Failed to parse token' };
  }
  if (typeof payload.exp === 'number' && payload.exp < Date.now()) {
    return { ok: false, error: 'Token expired' };
  }

  const { mid, mn, url } = payload;
  const isComplete =
    isBoundedString(mid, MAX_MACHINE_ID_LENGTH) &&
    isBoundedString(mn, MAX_MACHINE_NAME_LENGTH) &&
    typeof url === 'string' &&
    url.length > 0;
  if (!isComplete) {
    return { ok: false, error: 'Incomplete token payload' };
  }

  return { ok: true, value: { machineId: mid, machineName: mn, agentUrl: url } };
}

/**
 * Ask the agent to verify the token signature.
 * Returns true ONLY when the agent answered 2xx with `{ valid: true }`. Unreachable agent,
 * timeout, redirect, error status or unexpected body all mean "not verified".
 */
async function verifyWithAgent(baseUrl: string, token: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}${AGENT_VERIFY_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
      signal: AbortSignal.timeout(AGENT_VERIFY_TIMEOUT_MS),
      redirect: 'error',
    });

    if (!res.ok) {
      return false;
    }

    const data: unknown = await res.json();
    return isJsonObject(data) && data.valid === true;
  } catch {
    // Unreachable agent / timeout / redirect / non-JSON body: the token stays unverified
    return false;
  }
}

function validateCode(code: unknown) {
  if (typeof code !== 'string' || !PAIRING_CODE_PATTERN.test(code)) {
    return invalid('Invalid or expired code', 400);
  }

  // Not consumed here: the connect page validates on mount (twice under React StrictMode)
  // and must be able to show the agent before the user confirms. A code already consumed
  // through GET /api/pair/code is refused.
  const codeInfo = lookupUsablePairingCode(code);
  if (!codeInfo) {
    return invalid('Invalid or expired code', 400);
  }

  return NextResponse.json({
    valid: true,
    machineId: codeInfo.machineId,
    machineName: codeInfo.machineName,
    agentUrl: codeInfo.agentUrl,
  });
}

async function validateToken(token: unknown) {
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
    return invalid('Token or code is required', 400);
  }

  const decoded = decodeToken(token);
  if (!decoded.ok) {
    return invalid(decoded.error, 400);
  }

  const isProduction = process.env.NODE_ENV === 'production';
  const target = resolveAgentBaseUrl(decoded.value.agentUrl, { isProduction });

  // Not a strict hostname[:port]: refuse the token outright, nothing is fetched
  if (!target.ok && target.reason === 'invalid') {
    return invalid('Invalid agent URL in token', 400);
  }

  // 'blocked' = loopback/private host seen by the production server. The server must not
  // call it, but the user's browser legitimately can (agent on their own machine), so the
  // pairing info is returned as unverified and the agent authenticates the real connection.
  const verified = target.ok ? await verifyWithAgent(target.baseUrl, token) : false;

  if (!verified) {
    console.warn(
      `Pairing token not verified by agent (${target.ok ? target.host : 'host not allowed'})`
    );
  }

  return NextResponse.json({ valid: true, ...decoded.value, verified });
}

/**
 * POST /api/pair/validate
 *
 * Contract:
 * - `valid`: the token/code is well-formed, complete and not expired
 * - `verified` (tokens only): the agent itself confirmed the token signature. It is false
 *   whenever the agent could not be asked or did not confirm — never true by default.
 */
export async function POST(req: Request) {
  try {
    const body = await readJsonObject(req);
    if (!body) {
      return invalid('Request body must be a JSON object', 400);
    }

    const { token, code } = body;
    return code ? validateCode(code) : await validateToken(token);
  } catch (error) {
    console.error('Error validating pairing:', error);
    return invalid('Failed to validate pairing', 500);
  }
}
