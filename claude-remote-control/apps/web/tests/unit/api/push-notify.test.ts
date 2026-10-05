import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  agentConnection,
  failDbWith,
  jsonRequest,
  operators,
  pushSubscription,
  queueDbResults,
  recordedQueries,
  resetDb,
} from './helpers/mockDb';

const { sendPushNotification } = vi.hoisted(() => ({ sendPushNotification: vi.fn() }));

vi.mock('@/lib/push', () => ({ sendPushNotification }));
vi.mock('@/lib/db', async () => (await import('./helpers/mockDb')).dbModule);
vi.mock('drizzle-orm', async () => (await import('./helpers/mockDb')).operators);

import { POST } from '@/app/api/push/notify/route';

const NOTIFY_URL = 'http://localhost/api/push/notify';
const { eq } = operators;

const connection = { id: 'conn-1', userId: 'user-1', machineId: 'machine' };
const subscriptionRow = (id: string) => ({
  id,
  userId: 'user-1',
  endpoint: `https://push.example.com/${id}`,
  p256dh: `p256dh-${id}`,
  auth: `auth-${id}`,
});

// The rate limiter is keyed by machineId and lives for the whole module: give every test its own
let machineCounter = 0;
const nextMachineId = () => `machine-${++machineCounter}`;

const notify = (body: unknown) => POST(jsonRequest(NOTIFY_URL, 'POST', body));

describe('POST /api/push/notify', () => {
  beforeEach(() => {
    resetDb();
    sendPushNotification.mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('input validation', () => {
    it('returns 400 for malformed JSON', async () => {
      const res = await notify('{nope');

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Request body must be a JSON object' });
    });

    it.each([
      ['a missing machineId', { sessionName: 'proj--1' }],
      ['a non-string machineId', { machineId: { $ne: null }, sessionName: 'proj--1' }],
      ['an empty machineId', { machineId: '', sessionName: 'proj--1' }],
      ['a machineId longer than 100 chars', { machineId: 'm'.repeat(101), sessionName: 'p--1' }],
      ['a missing sessionName', { machineId: 'm1' }],
      ['a non-string sessionName', { machineId: 'm1', sessionName: ['proj--1'] }],
      ['a sessionName longer than 100 chars', { machineId: 'm1', sessionName: 's'.repeat(101) }],
      ['a sessionName with spaces', { machineId: 'm1', sessionName: 'Your bank account' }],
      ['a sessionName with markup', { machineId: 'm1', sessionName: '<img src=x>' }],
      ['a sessionName with a URL', { machineId: 'm1', sessionName: 'https://evil.example' }],
      ['a sessionName with a newline', { machineId: 'm1', sessionName: 'proj\n--1' }],
      ['a non-string reason', { machineId: 'm1', sessionName: 'proj--1', reason: 42 }],
    ])('returns 400 for %s', async (_label, body) => {
      const res = await notify(body);

      expect(res.status).toBe(400);
      expect(typeof (await res.json()).error).toBe('string');
      expect(recordedQueries()).toHaveLength(0);
      expect(sendPushNotification).not.toHaveBeenCalled();
    });
  });

  describe('lookup', () => {
    it('reports "Agent not paired" when no connection has this machineId', async () => {
      const machineId = nextMachineId();
      queueDbResults([]);

      const res = await notify({ machineId, sessionName: 'proj--1' });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true, sent: 0, message: 'Agent not paired' });
      expect(recordedQueries('select')[0].where).toEqual(eq(agentConnection.machineId, machineId));
    });

    it('reports "No subscriptions" when the owner has none', async () => {
      queueDbResults([connection], []);

      const res = await notify({ machineId: nextMachineId(), sessionName: 'proj--1' });

      expect(await res.json()).toEqual({ success: true, sent: 0, message: 'No subscriptions' });
      expect(recordedQueries('select')[1].where).toEqual(eq(pushSubscription.userId, 'user-1'));
    });
  });

  describe('delivery', () => {
    it("sends the payload to every subscription of the connection's owner", async () => {
      queueDbResults([connection], [subscriptionRow('s1'), subscriptionRow('s2')]);
      sendPushNotification.mockResolvedValue({ ok: true });

      const res = await notify({
        machineId: nextMachineId(),
        sessionName: 'my-project--abc123',
        reason: 'permission',
      });

      expect(await res.json()).toEqual({ success: true, sent: 2, expired: 0, failed: 0 });
      expect(sendPushNotification).toHaveBeenCalledTimes(2);
      expect(sendPushNotification).toHaveBeenCalledWith(
        { endpoint: 'https://push.example.com/s1', keys: { p256dh: 'p256dh-s1', auth: 'auth-s1' } },
        {
          title: 'Claude - my-project',
          body: 'Permission requise',
          icon: '/icon-192x192.png',
          badge: '/icon-192x192.png',
          tag: 'claude-my-project--abc123',
          data: {
            sessionName: 'my-project--abc123',
            projectName: 'my-project',
            connectionId: 'conn-1',
            url: '/?machine=conn-1&session=my-project--abc123',
          },
        }
      );
    });

    it.each([
      ['an unknown reason', 'something_else'],
      ['a reason naming an Object.prototype member', 'constructor'],
      ['no reason', undefined],
    ])('uses the default body for %s', async (_label, reason) => {
      queueDbResults([connection], [subscriptionRow('s1')]);
      sendPushNotification.mockResolvedValue({ ok: true });

      await notify({ machineId: nextMachineId(), sessionName: 'proj--1', reason });

      expect(sendPushNotification.mock.calls[0][1].body).toBe('Attention requise');
    });

    it.each([404, 410])(
      'deletes a subscription when the push service answers %i',
      async (statusCode) => {
        queueDbResults([connection], [subscriptionRow('dead'), subscriptionRow('alive')]);
        sendPushNotification
          .mockResolvedValueOnce({ ok: false, gone: true, statusCode })
          .mockResolvedValueOnce({ ok: true });

        const res = await notify({ machineId: nextMachineId(), sessionName: 'proj--1' });

        expect(await res.json()).toEqual({ success: true, sent: 1, expired: 1, failed: 0 });
        const deletes = recordedQueries('delete');
        expect(deletes).toHaveLength(1);
        expect(deletes[0].table).toBe(pushSubscription);
        expect(deletes[0].where).toEqual(eq(pushSubscription.id, 'dead'));
      }
    );

    it.each([
      ['a VAPID misconfiguration', { ok: false, gone: false }],
      ['HTTP 401 from the push service', { ok: false, gone: false, statusCode: 401 }],
      ['HTTP 403 from the push service', { ok: false, gone: false, statusCode: 403 }],
      ['HTTP 429 from the push service', { ok: false, gone: false, statusCode: 429 }],
      ['HTTP 500 from the push service', { ok: false, gone: false, statusCode: 500 }],
      ['HTTP 503 from the push service', { ok: false, gone: false, statusCode: 503 }],
    ])('keeps every subscription on %s', async (_label, failure) => {
      queueDbResults([connection], [subscriptionRow('s1'), subscriptionRow('s2')]);
      sendPushNotification.mockResolvedValue(failure);

      const res = await notify({ machineId: nextMachineId(), sessionName: 'proj--1' });

      expect(await res.json()).toEqual({ success: true, sent: 0, expired: 0, failed: 2 });
      expect(recordedQueries('delete')).toHaveLength(0);
    });

    it('keeps the subscription and counts a failure when sending throws', async () => {
      queueDbResults([connection], [subscriptionRow('s1')]);
      sendPushNotification.mockRejectedValue(new Error('unexpected'));

      const res = await notify({ machineId: nextMachineId(), sessionName: 'proj--1' });

      expect(await res.json()).toEqual({ success: true, sent: 0, expired: 0, failed: 1 });
      expect(recordedQueries('delete')).toHaveLength(0);
    });

    it('returns 500 with a JSON error when the database fails', async () => {
      failDbWith(new Error('db down'));

      const res = await notify({ machineId: nextMachineId(), sessionName: 'proj--1' });

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'Failed to send notification' });
    });
  });

  describe('rate limit', () => {
    it('allows 30 notifications per minute per machineId, then answers 429', async () => {
      const machineId = nextMachineId();
      const statuses: number[] = [];

      for (let i = 0; i < 31; i++) {
        const res = await notify({ machineId, sessionName: 'proj--1' });
        statuses.push(res.status);
      }

      expect(statuses.slice(0, 30).every((status) => status === 200)).toBe(true);
      expect(statuses[30]).toBe(429);
    });

    it('answers 429 with a JSON error and a Retry-After header, without touching the DB', async () => {
      const machineId = nextMachineId();
      for (let i = 0; i < 30; i++) {
        await notify({ machineId, sessionName: 'proj--1' });
      }
      resetDb();

      const res = await notify({ machineId, sessionName: 'proj--1' });

      expect(res.status).toBe(429);
      expect(await res.json()).toEqual({ error: 'Too many notifications, slow down' });
      expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0);
      expect(recordedQueries()).toHaveLength(0);
      expect(sendPushNotification).not.toHaveBeenCalled();
    });

    it('does not let one machine exhaust the budget of another', async () => {
      const noisy = nextMachineId();
      for (let i = 0; i < 31; i++) {
        await notify({ machineId: noisy, sessionName: 'proj--1' });
      }

      const res = await notify({ machineId: nextMachineId(), sessionName: 'proj--1' });

      expect(res.status).toBe(200);
    });

    it('does not spend the budget on invalid requests', async () => {
      const machineId = nextMachineId();
      for (let i = 0; i < 40; i++) {
        await notify({ machineId, sessionName: 'not valid!' });
      }

      const res = await notify({ machineId, sessionName: 'proj--1' });

      expect(res.status).toBe(200);
    });
  });
});
