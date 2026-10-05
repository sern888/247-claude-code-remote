import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { setVapidDetails, sendNotification } = vi.hoisted(() => ({
  setVapidDetails: vi.fn(),
  sendNotification: vi.fn(),
}));

vi.mock('web-push', () => ({ default: { setVapidDetails, sendNotification } }));

const subscription = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
  keys: { p256dh: 'p256dh-key', auth: 'auth-secret' },
};
const payload = { title: 'Claude - project', body: 'Attention requise' };

/** Error shaped like web-push's WebPushError */
function pushServiceError(statusCode: number): Error {
  return Object.assign(new Error(`Received unexpected response code ${statusCode}`), {
    statusCode,
  });
}

async function loadPushModule(options: { configured: boolean } = { configured: true }) {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_VAPID_PUBLIC_KEY', options.configured ? 'test-public-key' : '');
  vi.stubEnv('VAPID_PRIVATE_KEY', options.configured ? 'test-private-key' : '');
  return import('@/lib/push');
}

describe('sendPushNotification', () => {
  beforeEach(() => {
    setVapidDetails.mockReset();
    sendNotification.mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('returns { ok: true } when the push service accepts the notification', async () => {
    sendNotification.mockResolvedValue({ statusCode: 201 });
    const { sendPushNotification } = await loadPushModule();

    const result = await sendPushNotification(subscription, payload);

    expect(result).toEqual({ ok: true });
    expect(sendNotification).toHaveBeenCalledWith(subscription, JSON.stringify(payload));
  });

  it.each([404, 410])('marks the subscription as gone on HTTP %i', async (statusCode) => {
    sendNotification.mockRejectedValue(pushServiceError(statusCode));
    const { sendPushNotification } = await loadPushModule();

    const result = await sendPushNotification(subscription, payload);

    expect(result).toEqual({ ok: false, gone: true, statusCode });
  });

  it.each([400, 401, 403, 413, 429, 500, 502, 503])(
    'does NOT mark the subscription as gone on HTTP %i',
    async (statusCode) => {
      sendNotification.mockRejectedValue(pushServiceError(statusCode));
      const { sendPushNotification } = await loadPushModule();

      const result = await sendPushNotification(subscription, payload);

      expect(result).toEqual({ ok: false, gone: false, statusCode });
    }
  );

  it('does NOT mark the subscription as gone on a network error', async () => {
    sendNotification.mockRejectedValue(new Error('ECONNRESET'));
    const { sendPushNotification } = await loadPushModule();

    const result = await sendPushNotification(subscription, payload);

    expect(result).toEqual({ ok: false, gone: false });
  });

  it('does NOT mark the subscription as gone when a non-Error value is thrown', async () => {
    sendNotification.mockRejectedValue('boom');
    const { sendPushNotification } = await loadPushModule();

    const result = await sendPushNotification(subscription, payload);

    expect(result).toEqual({ ok: false, gone: false });
  });

  it('fails without calling the push service when VAPID keys are missing', async () => {
    const { sendPushNotification } = await loadPushModule({ configured: false });

    const result = await sendPushNotification(subscription, payload);

    expect(result).toEqual({ ok: false, gone: false });
    expect(setVapidDetails).not.toHaveBeenCalled();
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('treats invalid VAPID keys as "not configured" instead of crashing at import', async () => {
    setVapidDetails.mockImplementation(() => {
      throw new Error('Vapid public key should be 65 bytes long when decoded.');
    });
    const { sendPushNotification } = await loadPushModule();

    const result = await sendPushNotification(subscription, payload);

    expect(result).toEqual({ ok: false, gone: false });
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it.each([410, 500])(
    'logs only the push service origin on HTTP %i, never the endpoint path (a capability token)',
    async (statusCode) => {
      const secretPath = 'device-token-abc123';
      sendNotification.mockRejectedValue(pushServiceError(statusCode));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { sendPushNotification } = await loadPushModule();

      await sendPushNotification(
        { ...subscription, endpoint: `https://fcm.googleapis.com/fcm/send/${secretPath}` },
        payload
      );

      const logged = [...warn.mock.calls, ...error.mock.calls]
        .flat()
        .map((entry) => (typeof entry === 'string' ? entry : JSON.stringify(entry)))
        .join(' ');
      expect(logged).not.toContain(secretPath);
      expect(logged).not.toContain(subscription.keys.auth);
    }
  );

  it('names the push service origin when a subscription has expired', async () => {
    sendNotification.mockRejectedValue(pushServiceError(410));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { sendPushNotification } = await loadPushModule();

    await sendPushNotification(subscription, payload);

    expect(warn).toHaveBeenCalledWith('[Push] Subscription expired:', 'https://fcm.googleapis.com');
  });
});
