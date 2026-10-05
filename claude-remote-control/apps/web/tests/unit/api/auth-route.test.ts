import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const { handlers } = vi.hoisted(() => ({
  handlers: { GET: vi.fn(), POST: vi.fn(), PUT: vi.fn(), DELETE: vi.fn(), PATCH: vi.fn() },
}));

vi.mock('@neondatabase/auth/next/server', () => ({ authApiHandler: () => handlers }));

import { POST } from '@/app/api/auth/[...path]/route';

const AUTH_PATH = '/api/auth/sign-in/email';
const context = { params: Promise.resolve({ path: ['sign-in', 'email'] }) };
const SECRET_BODY = JSON.stringify({
  code: 'INVALID_EMAIL_OR_PASSWORD',
  email: 'someone@example.com',
  token: 'session-token-value',
});

function authRequest(): NextRequest {
  return new NextRequest(`http://localhost${AUTH_PATH}?callback=1`, { method: 'POST' });
}

describe('POST /api/auth/[...path]', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs only the status and path of a failed auth request, never the body', async () => {
    handlers.POST.mockResolvedValue(new Response(SECRET_BODY, { status: 401 }));

    await POST(authRequest(), context);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith('[Auth POST Error]', 401, AUTH_PATH);
    const logged = errorSpy.mock.calls.flat().map(String).join(' ');
    expect(logged).not.toContain('someone@example.com');
    expect(logged).not.toContain('session-token-value');
    expect(logged).not.toContain('callback=1');
  });

  it('returns the upstream response untouched, with its body still readable', async () => {
    handlers.POST.mockResolvedValue(new Response(SECRET_BODY, { status: 401 }));

    const response = await POST(authRequest(), context);

    expect(response.status).toBe(401);
    expect(await response.text()).toBe(SECRET_BODY);
  });

  it('logs nothing for a successful auth request', async () => {
    handlers.POST.mockResolvedValue(new Response('{}', { status: 200 }));

    const response = await POST(authRequest(), context);

    expect(response.status).toBe(200);
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
