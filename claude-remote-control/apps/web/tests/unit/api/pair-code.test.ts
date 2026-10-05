import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { jsonRequest } from './helpers/mockDb';

const { neonAuth } = vi.hoisted(() => ({ neonAuth: vi.fn() }));

vi.mock('@neondatabase/auth/next/server', () => ({ neonAuth }));

import { GET, POST } from '@/app/api/pair/code/route';

const CODE_URL = 'http://localhost/api/pair/code';

const registration = (code: string, overrides: Record<string, unknown> = {}) => ({
  code,
  machineId: `machine-${code}`,
  machineName: 'My Mac',
  agentUrl: 'machine.tailnet.ts.net',
  ...overrides,
});

const register = (body: unknown) => POST(jsonRequest(CODE_URL, 'POST', body));
const lookup = (code: string) => GET(new Request(`${CODE_URL}?code=${encodeURIComponent(code)}`));

describe('/api/pair/code', () => {
  beforeEach(() => {
    neonAuth.mockResolvedValue({ user: { id: 'user-1' } });
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('POST', () => {
    it('returns 401 for an unauthenticated caller and registers nothing', async () => {
      neonAuth.mockResolvedValue({ user: null });

      const res = await register(registration('100001'));

      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'Unauthorized' });
      expect((await lookup('100001')).status).toBe(404);
    });

    it('returns 400 for malformed JSON', async () => {
      const res = await register('{nope');

      expect(res.status).toBe(400);
    });

    it.each([
      ['a 5-digit code', registration('12345')],
      ['a non-numeric code', registration('abcdef')],
      ['a numeric (non-string) code', { ...registration('100002'), code: 100002 }],
      ['a missing machineId', registration('100003', { machineId: undefined })],
      ['a non-string machineName', registration('100004', { machineName: 42 })],
      ['an over-long machineName', registration('100005', { machineName: 'n'.repeat(101) })],
      ['an agentUrl with a scheme', registration('100006', { agentUrl: 'https://a.ts.net' })],
      ['an agentUrl with a path', registration('100007', { agentUrl: 'a.ts.net/x' })],
      ['a missing agentUrl', registration('100008', { agentUrl: undefined })],
    ])('returns 400 for %s', async (_label, body) => {
      const res = await register(body);

      expect(res.status).toBe(400);
      expect(typeof (await res.json()).error).toBe('string');
    });

    it('registers a code for an authenticated caller', async () => {
      const res = await register(registration('200001'));

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true, code: '200001', expiresIn: 600_000 });
    });

    it('refuses to overwrite a live code that belongs to another machine', async () => {
      await register(registration('200002', { machineId: 'machine-a' }));

      const res = await register(registration('200002', { machineId: 'machine-b' }));

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'Code already in use' });
      expect(await (await lookup('200002')).json()).toMatchObject({ machineId: 'machine-a' });
    });

    it('lets the same machine register its code again', async () => {
      await register(registration('200003', { machineId: 'machine-a' }));

      const res = await register(registration('200003', { machineId: 'machine-a' }));

      expect(res.status).toBe(200);
    });
  });

  describe('GET', () => {
    it('returns 400 when the code parameter is missing', async () => {
      const res = await GET(new Request(CODE_URL));

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Code parameter is required' });
    });

    it.each(['12345', '1234567', 'abcdef', '12 456', '１２３４５６'])(
      'returns 400 for the malformed code %j',
      async (code) => {
        const res = await lookup(code);

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: 'Code must be 6 digits' });
      }
    );

    it('returns 404 for an unknown code', async () => {
      const res = await lookup('999999');

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Invalid or expired code' });
    });

    it('returns the registered agent', async () => {
      await register(registration('300001'));

      const res = await lookup('300001');

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        valid: true,
        machineId: 'machine-300001',
        machineName: 'My Mac',
        agentUrl: 'machine.tailnet.ts.net',
        expiresAt: expect.any(Number),
      });
    });

    it('consumes the code: a second lookup returns 404', async () => {
      await register(registration('300002'));

      const first = await lookup('300002');
      const second = await lookup('300002');

      expect(first.status).toBe(200);
      expect(second.status).toBe(404);
    });

    it('makes a consumed code usable again once it is registered anew', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      await register(registration('300003'));
      await lookup('300003');

      vi.setSystemTime(new Date('2026-01-01T00:00:05Z'));
      const reRegistered = await register(registration('300003'));
      const res = await lookup('300003');

      expect(reRegistered.status).toBe(200);
      expect(res.status).toBe(200);
    });

    it('returns 404 once the code has expired', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      await register(registration('300004'));

      vi.setSystemTime(new Date('2026-01-01T00:10:01Z'));
      const res = await lookup('300004');

      expect(res.status).toBe(404);
    });
  });
});
