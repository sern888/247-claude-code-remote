import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { usePushNotifications } from '@/hooks/usePushNotifications';

const VAPID_PUBLIC_KEY = 'AQID'; // base64 for bytes [1, 2, 3]
const ENDPOINT = 'https://push.example.com/send/abc';
const UNAVAILABLE = 'Service worker unavailable - try refreshing the page';
const never = new Promise<never>(() => {});

function createSubscription(endpoint = ENDPOINT) {
  return {
    endpoint,
    unsubscribe: vi.fn().mockResolvedValue(true),
    toJSON: () => ({ endpoint, keys: { p256dh: 'p256dh', auth: 'auth' } }),
  };
}

function createRegistration(existingSubscription: unknown = null) {
  return {
    active: { state: 'activated' },
    pushManager: {
      getSubscription: vi.fn().mockResolvedValue(existingSubscription),
      subscribe: vi.fn().mockResolvedValue(createSubscription()),
    },
  };
}

function mockServiceWorker(registration: unknown, ready: Promise<unknown> = never) {
  const getRegistration = vi.fn().mockResolvedValue(registration);
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: { getRegistration, ready },
  });
  return getRegistration;
}

function jsonResponse(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), { status });
}

/** Route the hook's network calls: vapid key, then one response per subscribe call. */
function mockFetch(subscribeResponses: Response[] = [jsonResponse(200, { success: true })]) {
  const queue = [...subscribeResponses];
  const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url === '/api/push/vapid-key') return jsonResponse(200, { publicKey: VAPID_PUBLIC_KEY });
    return queue.shift() ?? jsonResponse(200, { success: true });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function subscribeCalls(fetchMock: ReturnType<typeof mockFetch>, method: string) {
  return fetchMock.mock.calls.filter(
    ([url, init]) => url === '/api/push/subscribe' && init?.method === method
  );
}

async function renderReadyHook() {
  const rendered = renderHook(() => usePushNotifications());
  await waitFor(() => expect(rendered.result.current.isLoading).toBe(false));
  return rendered;
}

describe('usePushNotifications', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'PushManager', { configurable: true, value: class {} });
    window.Notification.requestPermission = vi.fn().mockResolvedValue('granted');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    Reflect.deleteProperty(navigator, 'serviceWorker');
    Reflect.deleteProperty(window, 'PushManager');
  });

  describe('initial state', () => {
    it('is unsupported when the browser has no service worker API', async () => {
      const { result } = await renderReadyHook();

      expect(result.current).toMatchObject({
        isSupported: false,
        isSubscribed: false,
        error: null,
      });
    });

    it('is unsupported when the browser has no PushManager', async () => {
      mockServiceWorker(createRegistration());
      Reflect.deleteProperty(window, 'PushManager');

      const { result } = await renderReadyHook();

      expect(result.current.isSupported).toBe(false);
    });

    it('reports an existing subscription from a real registration check', async () => {
      const registration = createRegistration(createSubscription());
      const getRegistration = mockServiceWorker(registration);

      const { result } = await renderReadyHook();

      expect(getRegistration).toHaveBeenCalled();
      expect(result.current).toMatchObject({ isSupported: true, isSubscribed: true, error: null });
    });

    it('is supported but not subscribed when the worker is active without a subscription', async () => {
      mockServiceWorker(createRegistration(null));

      const { result } = await renderReadyHook();

      expect(result.current).toMatchObject({ isSupported: true, isSubscribed: false });
    });

    it('does not depend on navigator.serviceWorker.controller', async () => {
      // A hard reload leaves the page uncontrolled although a worker is registered and active
      mockServiceWorker(createRegistration(createSubscription()));
      expect((navigator.serviceWorker as { controller?: unknown }).controller).toBeUndefined();

      const { result } = await renderReadyHook();

      expect(result.current.isSubscribed).toBe(true);
    });

    it('stops loading and reports push as unavailable when no worker is registered', async () => {
      vi.useFakeTimers();
      mockServiceWorker(undefined, never);

      const { result } = renderHook(() => usePushNotifications());
      expect(result.current.isLoading).toBe(true);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });

      expect(result.current).toMatchObject({
        isSupported: false,
        isSubscribed: false,
        isLoading: false,
        error: null,
      });
    });

    it('surfaces an error when the subscription check fails', async () => {
      const registration = createRegistration();
      registration.pushManager.getSubscription.mockRejectedValue(new Error('push service down'));
      mockServiceWorker(registration);

      const { result } = await renderReadyHook();

      expect(result.current).toMatchObject({
        isSupported: true,
        isSubscribed: false,
        error: 'Failed to check subscription status',
      });
    });

    it('abandons the check when unmounted before the registration resolves', async () => {
      let resolveRegistration: (value: unknown) => void = () => {};
      const getRegistration = vi.fn(
        () => new Promise((resolve) => (resolveRegistration = resolve))
      );
      Object.defineProperty(navigator, 'serviceWorker', {
        configurable: true,
        value: { getRegistration, ready: never },
      });
      const registration = createRegistration(createSubscription());

      const { unmount } = renderHook(() => usePushNotifications());
      unmount();
      await act(async () => {
        resolveRegistration(registration);
      });

      // Observable effect of the cancellation: the subscription is never even read
      expect(registration.pushManager.getSubscription).not.toHaveBeenCalled();
    });

    it('becomes available when a slow worker finishes installing after the timeout', async () => {
      vi.useFakeTimers();
      let resolveReady: (value: unknown) => void = () => {};
      const ready = new Promise((resolve) => (resolveReady = resolve));
      mockServiceWorker(undefined, ready);

      const { result } = renderHook(() => usePushNotifications());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      expect(result.current).toMatchObject({ isSupported: false, isLoading: false });

      await act(async () => {
        resolveReady(createRegistration(createSubscription()));
      });

      expect(result.current).toMatchObject({
        isSupported: true,
        isSubscribed: true,
        isLoading: false,
        error: null,
      });
    });
  });

  describe('subscribe', () => {
    it('subscribes through the push manager and saves the subscription', async () => {
      const registration = createRegistration();
      mockServiceWorker(registration);
      const fetchMock = mockFetch();
      const { result } = await renderReadyHook();

      let outcome = false;
      await act(async () => {
        outcome = await result.current.subscribe();
      });

      expect(outcome).toBe(true);
      expect(registration.pushManager.subscribe).toHaveBeenCalledWith({
        userVisibleOnly: true,
        applicationServerKey: new Uint8Array([1, 2, 3]),
      });
      const [[, init]] = subscribeCalls(fetchMock, 'POST');
      expect(JSON.parse(String(init?.body)).subscription.endpoint).toBe(ENDPOINT);
      expect(result.current).toMatchObject({
        isSubscribed: true,
        permission: 'granted',
        isLoading: false,
        error: null,
      });
    });

    it('fails when notification permission is denied', async () => {
      const registration = createRegistration();
      mockServiceWorker(registration);
      mockFetch();
      window.Notification.requestPermission = vi.fn().mockResolvedValue('denied');
      const { result } = await renderReadyHook();

      let outcome = true;
      await act(async () => {
        outcome = await result.current.subscribe();
      });

      expect(outcome).toBe(false);
      expect(registration.pushManager.subscribe).not.toHaveBeenCalled();
      expect(result.current).toMatchObject({
        permission: 'denied',
        error: 'Notification permission denied',
        isLoading: false,
      });
    });

    it('refuses to subscribe when push is unsupported', async () => {
      const fetchMock = mockFetch();
      const { result } = await renderReadyHook();

      let outcome = true;
      await act(async () => {
        outcome = await result.current.subscribe();
      });

      expect(outcome).toBe(false);
      expect(result.current.error).toBe('Push notifications not supported');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('fails with a clear error instead of hanging when the worker disappears', async () => {
      const getRegistration = mockServiceWorker(createRegistration());
      mockFetch();
      const { result } = await renderReadyHook();
      getRegistration.mockResolvedValue(undefined);
      vi.useFakeTimers();

      let outcome: boolean | undefined;
      await act(async () => {
        const pending = result.current.subscribe().then((value) => (outcome = value));
        await vi.advanceTimersByTimeAsync(15000);
        await pending;
      });

      expect(outcome).toBe(false);
      expect(result.current).toMatchObject({ isLoading: false, error: UNAVAILABLE });
    });

    it('reports an error when the server cannot save the subscription', async () => {
      const browserSubscription = createSubscription();
      const registration = createRegistration();
      registration.pushManager.subscribe.mockResolvedValue(browserSubscription);
      mockServiceWorker(registration);
      mockFetch([jsonResponse(500, { error: 'Failed to subscribe' })]);
      const { result } = await renderReadyHook();

      let outcome = true;
      await act(async () => {
        outcome = await result.current.subscribe();
      });

      expect(outcome).toBe(false);
      expect(result.current).toMatchObject({
        isSubscribed: false,
        error: 'Failed to save subscription',
      });
      // No orphan: otherwise the next page load would claim "subscribed" with no server row
      expect(browserSubscription.unsubscribe).toHaveBeenCalledTimes(1);
    });

    it('discards the browser subscription when the save request fails on the network', async () => {
      const browserSubscription = createSubscription();
      const registration = createRegistration();
      registration.pushManager.subscribe.mockResolvedValue(browserSubscription);
      mockServiceWorker(registration);
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          if (url === '/api/push/vapid-key') {
            return jsonResponse(200, { publicKey: VAPID_PUBLIC_KEY });
          }
          throw new TypeError('Failed to fetch');
        })
      );
      const { result } = await renderReadyHook();

      let outcome = true;
      await act(async () => {
        outcome = await result.current.subscribe();
      });

      expect(outcome).toBe(false);
      expect(result.current).toMatchObject({ isSubscribed: false, error: 'Failed to fetch' });
      expect(browserSubscription.unsubscribe).toHaveBeenCalledTimes(1);
    });

    it('reports an error when the VAPID key cannot be fetched', async () => {
      const registration = createRegistration();
      mockServiceWorker(registration);
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(500, { error: 'nope' })));
      const { result } = await renderReadyHook();

      await act(async () => {
        await result.current.subscribe();
      });

      expect(result.current.error).toBe('Failed to get VAPID key');
      expect(registration.pushManager.subscribe).not.toHaveBeenCalled();
    });

    it('creates a fresh endpoint and retries once when the server answers 409', async () => {
      const staleSubscription = createSubscription('https://push.example.com/send/stale');
      const freshSubscription = createSubscription('https://push.example.com/send/fresh');
      const registration = createRegistration();
      registration.pushManager.subscribe
        .mockResolvedValueOnce(staleSubscription)
        .mockResolvedValueOnce(freshSubscription);
      mockServiceWorker(registration);
      const fetchMock = mockFetch([jsonResponse(409, { error: 'taken' }), jsonResponse(200)]);
      const { result } = await renderReadyHook();

      let outcome = false;
      await act(async () => {
        outcome = await result.current.subscribe();
      });

      expect(outcome).toBe(true);
      expect(staleSubscription.unsubscribe).toHaveBeenCalledTimes(1);
      const posts = subscribeCalls(fetchMock, 'POST');
      expect(posts).toHaveLength(2);
      expect(JSON.parse(String(posts[1][1]?.body)).subscription.endpoint).toBe(
        'https://push.example.com/send/fresh'
      );
      expect(result.current.isSubscribed).toBe(true);
    });

    it('gives up after one retry when the server keeps answering 409', async () => {
      mockServiceWorker(createRegistration());
      const fetchMock = mockFetch([jsonResponse(409), jsonResponse(409)]);
      const { result } = await renderReadyHook();

      await act(async () => {
        await result.current.subscribe();
      });

      expect(subscribeCalls(fetchMock, 'POST')).toHaveLength(2);
      expect(result.current).toMatchObject({
        isSubscribed: false,
        error: 'Failed to save subscription',
      });
    });
  });

  describe('unsubscribe', () => {
    it('unsubscribes locally and removes the subscription from the server', async () => {
      const subscription = createSubscription();
      mockServiceWorker(createRegistration(subscription));
      const fetchMock = mockFetch();
      const { result } = await renderReadyHook();

      let outcome = false;
      await act(async () => {
        outcome = await result.current.unsubscribe();
      });

      expect(outcome).toBe(true);
      expect(subscription.unsubscribe).toHaveBeenCalledTimes(1);
      const [[, init]] = subscribeCalls(fetchMock, 'DELETE');
      expect(JSON.parse(String(init?.body))).toEqual({ endpoint: ENDPOINT });
      expect(result.current).toMatchObject({ isSubscribed: false, isLoading: false, error: null });
    });

    it('succeeds without a server call when there is no subscription', async () => {
      mockServiceWorker(createRegistration(null));
      const fetchMock = mockFetch();
      const { result } = await renderReadyHook();

      let outcome = false;
      await act(async () => {
        outcome = await result.current.unsubscribe();
      });

      expect(outcome).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('times out with a clear error instead of hanging when no worker is registered', async () => {
      const getRegistration = mockServiceWorker(createRegistration(createSubscription()));
      mockFetch();
      const { result } = await renderReadyHook();
      getRegistration.mockResolvedValue(undefined);
      vi.useFakeTimers();

      let outcome: boolean | undefined;
      await act(async () => {
        const pending = result.current.unsubscribe().then((value) => (outcome = value));
        await vi.advanceTimersByTimeAsync(5000);
        await pending;
      });

      expect(outcome).toBe(false);
      expect(result.current).toMatchObject({ isLoading: false, error: UNAVAILABLE });
    });

    it.each([
      ['answers with an error', () => Promise.resolve(jsonResponse(500))],
      ['is unreachable', () => Promise.reject(new TypeError('Failed to fetch'))],
    ])('still reports unsubscribed when the server %s', async (_label, respond) => {
      // The browser subscription is already gone, so "subscribed" would be wrong
      const subscription = createSubscription();
      mockServiceWorker(createRegistration(subscription));
      vi.stubGlobal('fetch', vi.fn(respond));
      const { result } = await renderReadyHook();

      let outcome = false;
      await act(async () => {
        outcome = await result.current.unsubscribe();
      });

      expect(outcome).toBe(true);
      expect(subscription.unsubscribe).toHaveBeenCalledTimes(1);
      expect(result.current).toMatchObject({ isSubscribed: false, isLoading: false, error: null });
    });

    it('reports an error when the browser fails to unsubscribe', async () => {
      const subscription = createSubscription();
      subscription.unsubscribe.mockRejectedValue(new Error('unsubscribe failed'));
      mockServiceWorker(createRegistration(subscription));
      mockFetch();
      const { result } = await renderReadyHook();

      let outcome = true;
      await act(async () => {
        outcome = await result.current.unsubscribe();
      });

      expect(outcome).toBe(false);
      expect(result.current.error).toBe('unsubscribe failed');
    });
  });
});
