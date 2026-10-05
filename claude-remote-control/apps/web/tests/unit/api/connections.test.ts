import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  agentConnection,
  failDbWith,
  jsonRequest,
  operators,
  queueDbResults,
  recordedQueries,
  resetDb,
} from './helpers/mockDb';

const { neonAuth } = vi.hoisted(() => ({ neonAuth: vi.fn() }));

vi.mock('@neondatabase/auth/next/server', () => ({ neonAuth }));
vi.mock('@/lib/db', async () => (await import('./helpers/mockDb')).dbModule);
vi.mock('drizzle-orm', async () => (await import('./helpers/mockDb')).operators);

import { GET, POST } from '@/app/api/connections/route';
import { DELETE, PUT } from '@/app/api/connections/[id]/route';

const USER_ID = 'user-1';
const URL_BASE = 'http://localhost/api/connections';
const { eq, ne, and } = operators;

const validBody = { url: 'machine.tailnet.ts.net', name: 'My Mac', method: 'tailscale' };
const ownedBy = (id: string) =>
  and(eq(agentConnection.id, id), eq(agentConnection.userId, USER_ID));
const routeContext = (id: string) => ({ params: Promise.resolve({ id }) });

describe('/api/connections', () => {
  beforeEach(() => {
    resetDb();
    neonAuth.mockResolvedValue({ user: { id: USER_ID } });
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('GET', () => {
    it('returns 401 when unauthenticated', async () => {
      neonAuth.mockResolvedValue({ user: null });

      const res = await GET();

      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'Unauthorized' });
      expect(recordedQueries()).toHaveLength(0);
    });

    it("returns only the caller's connections", async () => {
      const rows = [{ id: 'c1', userId: USER_ID, url: 'a.ts.net', name: 'A' }];
      queueDbResults(rows);

      const res = await GET();

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(rows);
      expect(recordedQueries('select')[0].where).toEqual(eq(agentConnection.userId, USER_ID));
    });

    it('returns 500 with a JSON error when the database fails', async () => {
      failDbWith(new Error('db down'));

      const res = await GET();

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'Failed to fetch connections' });
    });
  });

  describe('POST', () => {
    it('returns 401 when unauthenticated', async () => {
      neonAuth.mockResolvedValue({ user: null });

      const res = await POST(jsonRequest(URL_BASE, 'POST', validBody));

      expect(res.status).toBe(401);
      expect(recordedQueries()).toHaveLength(0);
    });

    it('returns 400 (not 500) for malformed JSON', async () => {
      const res = await POST(jsonRequest(URL_BASE, 'POST', '{not json'));

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Request body must be a JSON object' });
      expect(recordedQueries()).toHaveLength(0);
    });

    it.each([
      ['a JSON array', []],
      ['a JSON string', 'hello'],
      ['null', null],
    ])('returns 400 when the body is %s', async (_label, body) => {
      const res = await POST(jsonRequest(URL_BASE, 'POST', JSON.stringify(body)));

      expect(res.status).toBe(400);
    });

    it.each([
      ['a missing url', { name: 'Mac' }],
      ['an empty url', { url: '', name: 'Mac' }],
      ['a non-string url', { url: 42, name: 'Mac' }],
      ['a url with whitespace', { url: 'host name.ts.net', name: 'Mac' }],
      ['a url longer than 255 chars', { url: 'a'.repeat(256), name: 'Mac' }],
      ['a missing name', { url: 'a.ts.net' }],
      ['a blank name', { url: 'a.ts.net', name: '   ' }],
      ['a name longer than 100 chars', { url: 'a.ts.net', name: 'n'.repeat(101) }],
      ['an unknown method', { url: 'a.ts.net', name: 'Mac', method: 'ssh' }],
      ['a non-string method', { url: 'a.ts.net', name: 'Mac', method: 1 }],
      ['a non-hex color', { url: 'a.ts.net', name: 'Mac', color: 'red' }],
      ['a non-string color', { url: 'a.ts.net', name: 'Mac', color: 123 }],
      ['a non-string machineId', { url: 'a.ts.net', name: 'Mac', machineId: 5 }],
      ['an empty machineId', { url: 'a.ts.net', name: 'Mac', machineId: '' }],
      ['a machineId longer than 100', { url: 'a.ts.net', name: 'Mac', machineId: 'm'.repeat(101) }],
    ])('returns 400 for %s', async (_label, body) => {
      const res = await POST(jsonRequest(URL_BASE, 'POST', body));

      expect(res.status).toBe(400);
      expect(typeof (await res.json()).error).toBe('string');
      expect(recordedQueries('insert')).toHaveLength(0);
    });

    it('inserts a validated connection for the signed-in user', async () => {
      const created = { id: 'generated', userId: USER_ID, ...validBody };
      queueDbResults([created]);

      const res = await POST(
        jsonRequest(URL_BASE, 'POST', { ...validBody, name: '  My Mac  ', color: '#f97316' })
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(created);
      const [insert] = recordedQueries('insert');
      expect(insert.table).toBe(agentConnection);
      expect(insert.values).toMatchObject({
        userId: USER_ID,
        url: validBody.url,
        name: 'My Mac',
        method: 'tailscale',
        color: '#f97316',
      });
      expect(typeof insert.values?.id).toBe('string');
    });

    it('never takes userId or id from the request body', async () => {
      queueDbResults([{ id: 'generated' }]);

      await POST(jsonRequest(URL_BASE, 'POST', { ...validBody, userId: 'victim', id: 'chosen' }));

      const [insert] = recordedQueries('insert');
      expect(insert.values?.userId).toBe(USER_ID);
      expect(insert.values?.id).not.toBe('chosen');
    });

    it('defaults method to tailscale when omitted', async () => {
      queueDbResults([{ id: 'generated' }]);

      await POST(jsonRequest(URL_BASE, 'POST', { url: 'a.ts.net', name: 'Mac' }));

      expect(recordedQueries('insert')[0].values?.method).toBe('tailscale');
    });

    it.each(['localhost', 'tailscale', 'custom', 'cloud'])('accepts method %s', async (method) => {
      queueDbResults([{ id: 'generated' }]);

      const res = await POST(jsonRequest(URL_BASE, 'POST', { ...validBody, method }));

      expect(res.status).toBe(200);
    });

    it('rejects with 409 a machineId already linked to a different user', async () => {
      queueDbResults([{ id: 'someone-elses-connection' }]);

      const res = await POST(jsonRequest(URL_BASE, 'POST', { ...validBody, machineId: 'm-1' }));

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: 'This machine is already linked to another account',
      });
      expect(recordedQueries('select')[0].where).toEqual(
        and(eq(agentConnection.machineId, 'm-1'), ne(agentConnection.userId, USER_ID))
      );
      expect(recordedQueries('insert')).toHaveLength(0);
    });

    it('inserts when the machineId is free or already owned by the caller', async () => {
      queueDbResults([], [{ id: 'generated', machineId: 'm-1' }]);

      const res = await POST(jsonRequest(URL_BASE, 'POST', { ...validBody, machineId: 'm-1' }));

      expect(res.status).toBe(200);
      expect(recordedQueries('insert')[0].values?.machineId).toBe('m-1');
    });

    it('skips the ownership query when no machineId is sent', async () => {
      queueDbResults([{ id: 'generated' }]);

      await POST(jsonRequest(URL_BASE, 'POST', validBody));

      expect(recordedQueries('select')).toHaveLength(0);
    });

    it('returns 500 with a JSON error when the database fails', async () => {
      failDbWith(new Error('db down'));

      const res = await POST(jsonRequest(URL_BASE, 'POST', validBody));

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'Failed to create connection' });
    });
  });
});

describe('/api/connections/[id]', () => {
  beforeEach(() => {
    resetDb();
    neonAuth.mockResolvedValue({ user: { id: USER_ID } });
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('DELETE', () => {
    it('returns 401 when unauthenticated', async () => {
      neonAuth.mockResolvedValue({ user: null });

      const res = await DELETE(jsonRequest(`${URL_BASE}/c1`, 'DELETE'), routeContext('c1'));

      expect(res.status).toBe(401);
      expect(recordedQueries()).toHaveLength(0);
    });

    it("deletes the caller's connection", async () => {
      queueDbResults([{ id: 'c1' }]);

      const res = await DELETE(jsonRequest(`${URL_BASE}/c1`, 'DELETE'), routeContext('c1'));

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true });
      expect(recordedQueries('delete')[0].where).toEqual(ownedBy('c1'));
    });

    it('returns 404 when nothing was deleted (unknown id or not the owner)', async () => {
      queueDbResults([]);

      const res = await DELETE(jsonRequest(`${URL_BASE}/nope`, 'DELETE'), routeContext('nope'));

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Connection not found' });
    });

    it('returns 500 with a JSON error when the database fails', async () => {
      failDbWith(new Error('db down'));

      const res = await DELETE(jsonRequest(`${URL_BASE}/c1`, 'DELETE'), routeContext('c1'));

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'Failed to delete connection' });
    });
  });

  describe('PUT', () => {
    const put = (id: string, body: unknown) =>
      PUT(jsonRequest(`${URL_BASE}/${id}`, 'PUT', body), routeContext(id));

    it('returns 401 when unauthenticated', async () => {
      neonAuth.mockResolvedValue({ user: null });

      const res = await put('c1', { name: 'New' });

      expect(res.status).toBe(401);
      expect(recordedQueries()).toHaveLength(0);
    });

    it('returns 400 for malformed JSON', async () => {
      const res = await put('c1', '{oops');

      expect(res.status).toBe(400);
      expect(recordedQueries()).toHaveLength(0);
    });

    it.each([
      ['an empty object', {}],
      ['an empty name', { name: '' }],
      ['a url with whitespace', { url: 'a b' }],
      ['an unknown method', { method: 'ssh' }],
      ['a null name', { name: null }],
      ['a non-hex color', { color: 'javascript:alert(1)' }],
    ])('returns 400 for %s', async (_label, body) => {
      const res = await put('c1', body);

      expect(res.status).toBe(400);
      expect(recordedQueries('update')).toHaveLength(0);
    });

    it('updates only the provided fields, scoped to the owner', async () => {
      const updated = { id: 'c1', name: 'Renamed', color: '#22c55e' };
      queueDbResults([updated]);

      const res = await put('c1', { name: 'Renamed', color: '#22c55e' });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(updated);
      const [update] = recordedQueries('update');
      expect(update.where).toEqual(ownedBy('c1'));
      expect(update.set).toEqual({
        name: 'Renamed',
        color: '#22c55e',
        updatedAt: expect.any(Date),
      });
    });

    it('clears the color when it is null', async () => {
      queueDbResults([{ id: 'c1', color: null }]);

      await put('c1', { color: null });

      expect(recordedQueries('update')[0].set).toMatchObject({ color: null });
    });

    it('ignores fields that must not be changed (userId, machineId)', async () => {
      queueDbResults([{ id: 'c1' }]);

      await put('c1', { name: 'Renamed', userId: 'attacker', machineId: 'other' });

      const set = recordedQueries('update')[0].set;
      expect(set).not.toHaveProperty('userId');
      expect(set).not.toHaveProperty('machineId');
    });

    it('returns 404 when nothing was updated', async () => {
      queueDbResults([]);

      const res = await put('missing', { name: 'Renamed' });

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Connection not found' });
    });

    it('returns 500 with a JSON error when the database fails', async () => {
      failDbWith(new Error('db down'));

      const res = await put('c1', { name: 'Renamed' });

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'Failed to update connection' });
    });
  });
});
