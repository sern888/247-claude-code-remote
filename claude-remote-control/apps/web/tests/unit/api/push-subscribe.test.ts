import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  failDbWith,
  jsonRequest,
  operators,
  pushSubscription,
  queueDbResults,
  recordedQueries,
  resetDb,
} from './helpers/mockDb';

const { neonAuth } = vi.hoisted(() => ({ neonAuth: vi.fn() }));

vi.mock('@neondatabase/auth/next/server', () => ({ neonAuth }));
vi.mock('@/lib/db', async () => (await import('./helpers/mockDb')).dbModule);
vi.mock('drizzle-orm', async () => (await import('./helpers/mockDb')).operators);

import { DELETE, POST } from '@/app/api/push/subscribe/route';

const SUBSCRIBE_URL = 'http://localhost/api/push/subscribe';
const USER_ID = 'user-1';
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/abc123';
const { eq, and } = operators;

const validSubscription = { endpoint: ENDPOINT, keys: { p256dh: 'p256dh-key', auth: 'auth-key' } };
const subscribe = (body: unknown) => POST(jsonRequest(SUBSCRIBE_URL, 'POST', body));
const unsubscribe = (body: unknown) => DELETE(jsonRequest(SUBSCRIBE_URL, 'DELETE', body));

describe('/api/push/subscribe', () => {
  beforeEach(() => {
    resetDb();
    neonAuth.mockResolvedValue({ user: { id: USER_ID } });
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('POST', () => {
    it('returns 401 when unauthenticated', async () => {
      neonAuth.mockResolvedValue({ user: null });

      const res = await subscribe({ subscription: validSubscription });

      expect(res.status).toBe(401);
      expect(recordedQueries()).toHaveLength(0);
    });

    it('returns 400 for malformed JSON', async () => {
      const res = await subscribe('{nope');

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Invalid subscription' });
    });

    it.each([
      ['no subscription', {}],
      ['a string subscription', { subscription: 'x' }],
      ['a missing endpoint', { subscription: { keys: validSubscription.keys } }],
      ['missing keys', { subscription: { endpoint: ENDPOINT } }],
      [
        'a non-string p256dh',
        { subscription: { endpoint: ENDPOINT, keys: { p256dh: 1, auth: 'a' } } },
      ],
      ['an empty auth', { subscription: { endpoint: ENDPOINT, keys: { p256dh: 'p', auth: '' } } }],
      [
        'an over-long key',
        { subscription: { endpoint: ENDPOINT, keys: { p256dh: 'p'.repeat(513), auth: 'a' } } },
      ],
      [
        'a plain http endpoint',
        { subscription: { ...validSubscription, endpoint: 'http://fcm.googleapis.com/x' } },
      ],
      [
        'a loopback endpoint',
        { subscription: { ...validSubscription, endpoint: 'https://127.0.0.1/x' } },
      ],
      [
        'the cloud metadata endpoint',
        { subscription: { ...validSubscription, endpoint: 'https://169.254.169.254/x' } },
      ],
      [
        'a private network endpoint',
        { subscription: { ...validSubscription, endpoint: 'https://10.0.0.8/x' } },
      ],
      [
        'an internal hostname endpoint',
        { subscription: { ...validSubscription, endpoint: 'https://db.internal/x' } },
      ],
    ])('returns 400 for %s', async (_label, body) => {
      const res = await subscribe(body);

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Invalid subscription' });
      expect(recordedQueries()).toHaveLength(0);
    });

    it('stores the subscription for the signed-in user', async () => {
      queueDbResults([{ id: 'sub-1' }]);

      const res = await subscribe({
        subscription: validSubscription,
        userAgent: 'TestBrowser/1.0',
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true, id: 'sub-1' });
      const [insert] = recordedQueries('insert');
      expect(insert.table).toBe(pushSubscription);
      expect(insert.values).toMatchObject({
        userId: USER_ID,
        endpoint: ENDPOINT,
        p256dh: 'p256dh-key',
        auth: 'auth-key',
        userAgent: 'TestBrowser/1.0',
      });
    });

    it('refreshes keys on conflict but never reassigns ownership', async () => {
      queueDbResults([{ id: 'sub-1' }]);

      await subscribe({ subscription: validSubscription, userAgent: 'TestBrowser/1.0' });

      const { conflict } = recordedQueries('insert')[0];
      expect(conflict?.target).toBe(pushSubscription.endpoint);
      expect(conflict?.set).toEqual({
        p256dh: 'p256dh-key',
        auth: 'auth-key',
        userAgent: 'TestBrowser/1.0',
      });
      expect(conflict?.set).not.toHaveProperty('userId');
      // The update only applies to a row the caller already owns
      expect(conflict?.setWhere).toEqual(eq(pushSubscription.userId, USER_ID));
    });

    it('returns 409 when the endpoint already belongs to a different user', async () => {
      // setWhere did not match: the upsert touched no row and returns nothing
      queueDbResults([]);

      const res = await subscribe({ subscription: validSubscription });

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: 'This push subscription is already registered to another account',
      });
    });

    it('falls back to the User-Agent header and caps its length', async () => {
      queueDbResults([{ id: 'sub-1' }]);
      const request = new Request(SUBSCRIBE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'u'.repeat(600) },
        body: JSON.stringify({ subscription: validSubscription }),
      });

      await POST(request);

      const userAgent = recordedQueries('insert')[0].values?.userAgent;
      expect(userAgent).toBe('u'.repeat(512));
    });

    it('returns 500 with a JSON error when the database fails', async () => {
      failDbWith(new Error('db down'));

      const res = await subscribe({ subscription: validSubscription });

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'Failed to subscribe' });
    });
  });

  describe('DELETE', () => {
    it('returns 401 when unauthenticated', async () => {
      neonAuth.mockResolvedValue({ user: null });

      const res = await unsubscribe({ endpoint: ENDPOINT });

      expect(res.status).toBe(401);
      expect(recordedQueries()).toHaveLength(0);
    });

    it.each([
      ['malformed JSON', '{nope'],
      ['a missing endpoint', {}],
      ['an empty endpoint', { endpoint: '' }],
      ['a non-string endpoint', { endpoint: { $ne: null } }],
    ])('returns 400 for %s', async (_label, body) => {
      const res = await unsubscribe(body);

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Endpoint required' });
      expect(recordedQueries()).toHaveLength(0);
    });

    it("only deletes the caller's own subscription for that endpoint", async () => {
      const res = await unsubscribe({ endpoint: ENDPOINT });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true });
      const [deletion] = recordedQueries('delete');
      expect(deletion.table).toBe(pushSubscription);
      expect(deletion.where).toEqual(
        and(eq(pushSubscription.endpoint, ENDPOINT), eq(pushSubscription.userId, USER_ID))
      );
    });

    it('returns 500 with a JSON error when the database fails', async () => {
      failDbWith(new Error('db down'));

      const res = await unsubscribe({ endpoint: ENDPOINT });

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'Failed to unsubscribe' });
    });
  });
});
