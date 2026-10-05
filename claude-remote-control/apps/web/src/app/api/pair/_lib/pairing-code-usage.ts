import { lookupPairingCode, type PairingCodeInfo } from '@/lib/pairing-codes';

/**
 * Single-use tracking for pairing codes, shared by /api/pair/code and /api/pair/validate.
 *
 * src/lib/pairing-codes.ts exposes no way to delete a code, so consumption is recorded here.
 * Key: code. Value: `expiresAt` of the registration that was consumed — registering the same
 * code again produces a new `expiresAt`, which makes the code usable again.
 * Like the code store itself, this is per-instance memory.
 */
const consumedCodes = new Map<string, number>();

function isConsumed(info: PairingCodeInfo): boolean {
  return consumedCodes.get(info.code) === info.expiresAt;
}

function forgetExpired(now: number): void {
  for (const [code, expiresAt] of consumedCodes) {
    if (expiresAt < now) consumedCodes.delete(code);
  }
}

/** Look up a code that is registered, not expired and not consumed yet. */
export function lookupUsablePairingCode(code: string): PairingCodeInfo | null {
  const info = lookupPairingCode(code);
  return info && !isConsumed(info) ? info : null;
}

/** Mark a code as used: every later lookup of this registration fails. */
export function consumePairingCode(info: PairingCodeInfo, now: number = Date.now()): void {
  forgetExpired(now);
  consumedCodes.set(info.code, info.expiresAt);
}
