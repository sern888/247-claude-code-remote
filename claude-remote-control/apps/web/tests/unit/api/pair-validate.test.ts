import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { registerPairingCode } from '@/lib/pairing-codes';
import { POST } from '@/app/api/pair/validate/route';
import { GET as lookupCode } from '@/app/api/pair/code/route';
import { jsonRequest } from './helpers/mockDb';

const VALIDATE_URL = 'http://localhost/api/pair/validate';

function makeToken(payload: Record<string, unknown>): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${encoded}.unverifiable-signature`;
}

function tokenFor(url: unknown, overrides: Record<string, unknown> = {}): string {
  return makeToken({ mid: 'machine-1', mn: 'My Mac', url, exp: Date.now() + 60_000, ...overrides });
}

function agentResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const validate = (body: unknown) => POST(jsonRequest(VALIDATE_URL, 'POST', body));

describe('POST /api/pair/validate', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(agentResponse(200, { valid: true }));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe('request validation', () => {
    it('returns 400 for malformed JSON', async () => {
      const res = await validate('{nope');

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ valid: false, error: expect.any(String) });
    });

    it.each([
      ['no token and no code', {}],
      ['a non-string token', { token: 123 }],
      ['an over-long token', { token: 'a'.repeat(5000) }],
    ])('returns 400 for %s', async (_label, body) => {
      const res = await validate(body);

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ valid: false, error: 'Token or code is required' });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([
      ['garbage', 'not-base64-json.sig', 'Failed to parse token'],
      [
        'a JSON array payload',
        makeToken([] as unknown as Record<string, unknown>),
        'Failed to parse token',
      ],
      ['an expired token', tokenFor('agent.ts.net', { exp: Date.now() - 1 }), 'Token expired'],
      [
        'a missing machine id',
        tokenFor('agent.ts.net', { mid: undefined }),
        'Incomplete token payload',
      ],
      [
        'a non-string machine name',
        tokenFor('agent.ts.net', { mn: { a: 1 } }),
        'Incomplete token payload',
      ],
      ['a missing url', tokenFor(undefined), 'Incomplete token payload'],
      ['a non-string url', tokenFor(['agent.ts.net']), 'Incomplete token payload'],
    ])('returns 400 for %s', async (_label, token, error) => {
      const res = await validate({ token });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ valid: false, error });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('SSRF protection', () => {
    it.each([
      ['a scheme', 'http://169.254.169.254'],
      ['a path', 'internal.example.com/admin'],
      ['a path to another API', 'evil.example.com/x?y='],
      ['a query string', 'agent.ts.net?redirect=1'],
      ['userinfo', 'user:pass@agent.ts.net'],
      ['an @ host switch', 'agent.ts.net@169.254.169.254'],
      ['whitespace', 'agent.ts.net evil.example.com'],
      ['a fragment', 'agent.ts.net#x'],
    ])('rejects a token whose url contains %s without fetching', async (_label, url) => {
      const res = await validate({ token: tokenFor(url) });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ valid: false, error: 'Invalid agent URL in token' });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([
      'localhost:4678',
      '127.0.0.1:4678',
      '2130706433',
      '169.254.169.254',
      '10.0.0.5:8080',
      '192.168.1.20',
      '[::1]:4678',
      'metadata.google.internal',
      'printer.local',
    ])('never fetches %s in production and reports it as unverified', async (url) => {
      vi.stubEnv('NODE_ENV', 'production');

      const res = await validate({ token: tokenFor(url) });

      expect(fetchMock).not.toHaveBeenCalled();
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ valid: true, verified: false, agentUrl: url });
    });

    it('uses https for a host that merely starts with "localhost"', async () => {
      await validate({ token: tokenFor('localhost.evil.example.com') });

      expect(fetchMock.mock.calls[0][0]).toBe('https://localhost.evil.example.com/api/pair/verify');
    });

    it('refuses to follow redirects and sets a timeout', async () => {
      const token = tokenFor('agent.tailnet.ts.net');

      await validate({ token });

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://agent.tailnet.ts.net/api/pair/verify');
      expect(init.method).toBe('POST');
      expect(init.redirect).toBe('error');
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(JSON.parse(init.body)).toEqual({ token });
    });
  });

  describe('agent verification', () => {
    it('keeps http for a loopback agent in development', async () => {
      const res = await validate({ token: tokenFor('localhost:4678') });

      expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:4678/api/pair/verify');
      expect(await res.json()).toEqual({
        valid: true,
        machineId: 'machine-1',
        machineName: 'My Mac',
        agentUrl: 'localhost:4678',
        verified: true,
      });
    });

    it('reports verified: true only when the agent confirms the token', async () => {
      vi.stubEnv('NODE_ENV', 'production');

      const res = await validate({ token: tokenFor('agent.tailnet.ts.net') });

      expect(await res.json()).toMatchObject({ valid: true, verified: true });
    });

    it.each([
      ['the agent is unreachable', () => Promise.reject(new TypeError('fetch failed'))],
      ['the request times out', () => Promise.reject(new DOMException('timeout', 'TimeoutError'))],
      ['the agent redirects', () => Promise.reject(new TypeError('unexpected redirect'))],
      [
        'the agent rejects the token',
        () => Promise.resolve(agentResponse(401, { error: 'Invalid signature' })),
      ],
      ['the agent answers 500', () => Promise.resolve(agentResponse(500, {}))],
      [
        'a 200 response does not say valid: true',
        () => Promise.resolve(agentResponse(200, { ok: 1 })),
      ],
      ['a 200 response is not JSON', () => Promise.resolve(new Response('<html>hello</html>'))],
    ])('reports verified: false when %s', async (_label, respond) => {
      fetchMock.mockImplementation(respond);

      const res = await validate({ token: tokenFor('agent.tailnet.ts.net') });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ valid: true, verified: false });
    });
  });

  describe('code-based pairing', () => {
    it('returns the registered agent for a known code', async () => {
      registerPairingCode({
        code: '482913',
        machineId: 'machine-9',
        machineName: 'Studio',
        agentUrl: 'studio.tailnet.ts.net',
      });

      const res = await validate({ code: '482913' });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        valid: true,
        machineId: 'machine-9',
        machineName: 'Studio',
        agentUrl: 'studio.tailnet.ts.net',
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('does not consume the code, so the connect page can validate it again', async () => {
      registerPairingCode({
        code: '482914',
        machineId: 'machine-9',
        machineName: 'Studio',
        agentUrl: 'studio.tailnet.ts.net',
      });

      const first = await validate({ code: '482914' });
      const second = await validate({ code: '482914' });

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
    });

    it('refuses a code that GET /api/pair/code has already consumed', async () => {
      registerPairingCode({
        code: '482915',
        machineId: 'machine-9',
        machineName: 'Studio',
        agentUrl: 'studio.tailnet.ts.net',
      });
      const consumed = await lookupCode(new Request('http://localhost/api/pair/code?code=482915'));

      const res = await validate({ code: '482915' });

      expect(consumed.status).toBe(200);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ valid: false, error: 'Invalid or expired code' });
    });

    it.each([
      ['an unknown code', '000000'],
      ['a code that is not 6 digits', '12345'],
      ['a non-string code', 482913],
      ['an object code', { $gt: '' }],
    ])('returns 400 for %s', async (_label, code) => {
      const res = await validate({ code });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ valid: false, error: 'Invalid or expired code' });
    });
  });
});
