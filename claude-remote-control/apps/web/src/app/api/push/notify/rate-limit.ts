export interface RateLimiterOptions {
  /** Maximum number of hits allowed per key inside one window */
  limit: number;
  windowMs: number;
  /** Upper bound on tracked keys, so unauthenticated callers cannot grow the map forever */
  maxKeys: number;
}

export type RateLimitDecision = { allowed: true } | { allowed: false; retryAfterMs: number };

export interface RateLimiter {
  tryAcquire(key: string, now?: number): RateLimitDecision;
}

/**
 * Small in-memory sliding-window rate limiter.
 * State is per server instance: it bounds bursts, it is not a global quota.
 */
export function createRateLimiter({ limit, windowMs, maxKeys }: RateLimiterOptions): RateLimiter {
  const hitsByKey = new Map<string, readonly number[]>();

  const isRecent = (timestamp: number, now: number) => now - timestamp < windowMs;

  const makeRoom = (now: number) => {
    for (const [key, hits] of hitsByKey) {
      if (!hits.some((timestamp) => isRecent(timestamp, now))) {
        hitsByKey.delete(key);
      }
    }
    // Still full of active keys: drop the least recently used one (first in Map order)
    const leastRecentKey = hitsByKey.keys().next().value;
    if (hitsByKey.size >= maxKeys && leastRecentKey !== undefined) {
      hitsByKey.delete(leastRecentKey);
    }
  };

  /** Callers delete the key first, so this (re)inserts it as the most recently used entry. */
  const remember = (key: string, hits: readonly number[]) => {
    hitsByKey.set(key, hits);
  };

  return {
    tryAcquire(key, now = Date.now()) {
      const recentHits = (hitsByKey.get(key) ?? []).filter((timestamp) => isRecent(timestamp, now));
      const isNewKey = !hitsByKey.delete(key);

      if (recentHits.length >= limit) {
        remember(key, recentHits);
        return { allowed: false, retryAfterMs: windowMs - (now - recentHits[0]) };
      }

      if (isNewKey && hitsByKey.size >= maxKeys) {
        makeRoom(now);
      }

      remember(key, [...recentHits, now]);
      return { allowed: true };
    },
  };
}
