import { describe, it, expect } from 'vitest';
import { createRateLimiter } from '@/app/api/push/notify/rate-limit';

const WINDOW_MS = 60_000;

describe('createRateLimiter', () => {
  it('allows up to `limit` hits per key inside one window', () => {
    const limiter = createRateLimiter({ limit: 3, windowMs: WINDOW_MS, maxKeys: 10 });

    const decisions = [0, 1, 2].map((offset) => limiter.tryAcquire('m1', 1000 + offset));

    expect(decisions).toEqual([{ allowed: true }, { allowed: true }, { allowed: true }]);
  });

  it('rejects the hit after the limit and reports when to retry', () => {
    const limiter = createRateLimiter({ limit: 2, windowMs: WINDOW_MS, maxKeys: 10 });
    limiter.tryAcquire('m1', 1000);
    limiter.tryAcquire('m1', 2000);

    const decision = limiter.tryAcquire('m1', 3000);

    expect(decision).toEqual({ allowed: false, retryAfterMs: WINDOW_MS - 2000 });
  });

  it('does not count rejected hits against the window', () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: WINDOW_MS, maxKeys: 10 });
    limiter.tryAcquire('m1', 0);
    limiter.tryAcquire('m1', 30_000); // rejected

    expect(limiter.tryAcquire('m1', WINDOW_MS)).toEqual({ allowed: true });
  });

  it('allows hits again once old ones leave the sliding window', () => {
    const limiter = createRateLimiter({ limit: 2, windowMs: WINDOW_MS, maxKeys: 10 });
    limiter.tryAcquire('m1', 0);
    limiter.tryAcquire('m1', 40_000);

    expect(limiter.tryAcquire('m1', 50_000).allowed).toBe(false);
    expect(limiter.tryAcquire('m1', WINDOW_MS).allowed).toBe(true);
    expect(limiter.tryAcquire('m1', WINDOW_MS + 1).allowed).toBe(false);
  });

  it('tracks each key independently', () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: WINDOW_MS, maxKeys: 10 });
    limiter.tryAcquire('m1', 0);

    expect(limiter.tryAcquire('m1', 1).allowed).toBe(false);
    expect(limiter.tryAcquire('m2', 1).allowed).toBe(true);
  });

  it('forgets idle keys instead of growing without bound', () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: WINDOW_MS, maxKeys: 2 });
    limiter.tryAcquire('old-1', 0);
    limiter.tryAcquire('old-2', 0);

    // Both old keys are idle by now, so the new key takes a free slot
    expect(limiter.tryAcquire('new', WINDOW_MS + 1).allowed).toBe(true);
    // ...and the old keys start from scratch
    expect(limiter.tryAcquire('old-1', WINDOW_MS + 2).allowed).toBe(true);
  });

  it('evicts the least recently used key when every tracked key is still active', () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: WINDOW_MS, maxKeys: 2 });
    limiter.tryAcquire('first', 0);
    limiter.tryAcquire('second', 1);

    expect(limiter.tryAcquire('third', 2).allowed).toBe(true);
    // "second" is still tracked and still limited; "first" was evicted to make room
    expect(limiter.tryAcquire('second', 3).allowed).toBe(false);
    expect(limiter.tryAcquire('first', 4).allowed).toBe(true);
  });

  it('does not let a flood of new keys reset the counter of a key that keeps being hit', () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: WINDOW_MS, maxKeys: 3 });
    limiter.tryAcquire('busy', 0);

    for (let i = 1; i <= 20; i++) {
      // The busy key is hit (and rejected) between every new key, so it stays most recent
      limiter.tryAcquire(`flood-${i}`, i);
      expect(limiter.tryAcquire('busy', i).allowed).toBe(false);
    }
  });
});
