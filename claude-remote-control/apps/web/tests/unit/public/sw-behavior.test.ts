import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import vm from 'vm';

const SW_PATH = path.resolve(__dirname, '../../../public/sw.js');
const SW_SOURCE = readFileSync(SW_PATH, 'utf-8');
const ORIGIN = 'https://247.example';
const DEEPLINK_CACHE = 'notification-deeplink';
const DEEPLINK_KEY = '/__notification_deeplink__';

type Listener = (event: Record<string, unknown>) => void;

class FakeRequest {
  constructor(public url: string) {}
}

class FakeResponse {
  constructor(private body: string) {}
  async json() {
    return JSON.parse(this.body);
  }
}

/** Minimal CacheStorage: named caches holding key -> response. */
function createCacheStorage(initialNames: string[] = []) {
  const stores = new Map<string, Map<string, FakeResponse>>(
    initialNames.map((name) => [name, new Map()])
  );
  const keyOf = (key: string | FakeRequest) => (typeof key === 'string' ? key : key.url);

  return {
    stores,
    keys: vi.fn(async () => [...stores.keys()]),
    delete: vi.fn(async (name: string) => stores.delete(name)),
    open: vi.fn(async (name: string) => {
      const store = stores.get(name) ?? new Map<string, FakeResponse>();
      stores.set(name, store);
      return {
        put: async (key: string | FakeRequest, response: FakeResponse) => {
          store.set(keyOf(key), response);
        },
        match: async (key: string | FakeRequest) => store.get(keyOf(key)),
        delete: async (key: string | FakeRequest) => store.delete(keyOf(key)),
      };
    }),
  };
}

function createWindowClient(overrides: Record<string, unknown> = {}) {
  return {
    url: `${ORIGIN}/`,
    focused: false,
    postMessage: vi.fn(),
    navigate: vi.fn().mockResolvedValue(undefined),
    focus: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

/** Evaluate public/sw.js against a fake ServiceWorkerGlobalScope. */
function loadServiceWorker(options: { cacheNames?: string[]; clients?: unknown[] } = {}) {
  const listeners = new Map<string, Listener>();
  const caches = createCacheStorage(options.cacheNames);
  const self = {
    addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
    skipWaiting: vi.fn().mockResolvedValue(undefined),
    location: { origin: ORIGIN },
    clients: {
      claim: vi.fn().mockResolvedValue(undefined),
      matchAll: vi.fn().mockResolvedValue(options.clients ?? []),
      openWindow: vi.fn().mockResolvedValue(null),
    },
    registration: {
      showNotification: vi.fn().mockResolvedValue(undefined),
      navigationPreload: { disable: vi.fn().mockResolvedValue(undefined) },
    },
  };
  const navigator = {
    setAppBadge: vi.fn().mockResolvedValue(undefined),
    clearAppBadge: vi.fn().mockResolvedValue(undefined),
  };
  const consoleMock = { warn: vi.fn(), error: vi.fn() };

  vm.runInNewContext(
    SW_SOURCE,
    { self, caches, navigator, console: consoleMock, Request: FakeRequest, Response: FakeResponse },
    { filename: 'sw.js' }
  );

  /** Dispatch an event and wait for everything it passed to waitUntil(). */
  const dispatch = async (type: string, event: Record<string, unknown> = {}) => {
    const pending: Promise<unknown>[] = [];
    const listener = listeners.get(type);
    if (!listener) throw new Error(`sw.js registered no "${type}" listener`);
    listener({ waitUntil: (promise: Promise<unknown>) => pending.push(promise), ...event });
    await Promise.all(pending);
  };

  return { self, caches, navigator, console: consoleMock, listeners, dispatch };
}

function pushEvent(payload: unknown) {
  return { data: { json: () => payload } };
}

function clickEvent(url: string | undefined, action = '') {
  return { action, notification: { close: vi.fn(), data: url ? { url } : undefined } };
}

describe('public/sw.js behaviour', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  describe('listeners', () => {
    it('registers exactly the lifecycle and notification listeners, and no fetch listener', () => {
      const { listeners } = loadServiceWorker();

      expect([...listeners.keys()].sort()).toEqual(
        ['activate', 'install', 'message', 'notificationclick', 'push'].sort()
      );
    });
  });

  describe('install', () => {
    it('skips waiting so the new worker replaces the old bundle immediately', async () => {
      const sw = loadServiceWorker();

      await sw.dispatch('install');

      expect(sw.self.skipWaiting).toHaveBeenCalledTimes(1);
    });
  });

  describe('activate', () => {
    it('deletes caches left by the old bundle but keeps the deeplink cache', async () => {
      const sw = loadServiceWorker({
        cacheNames: ['serwist-precache-v2-https://247.example/', 'apis', 'pages', DEEPLINK_CACHE],
      });

      await sw.dispatch('activate');

      expect([...sw.caches.stores.keys()]).toEqual([DEEPLINK_CACHE]);
      expect(sw.caches.delete).not.toHaveBeenCalledWith(DEEPLINK_CACHE);
    });

    it('claims open clients and disables navigation preload', async () => {
      const sw = loadServiceWorker();

      await sw.dispatch('activate');

      expect(sw.self.clients.claim).toHaveBeenCalledTimes(1);
      expect(sw.self.registration.navigationPreload.disable).toHaveBeenCalledTimes(1);
    });

    it('still claims clients when the cache cleanup fails', async () => {
      const sw = loadServiceWorker();
      sw.caches.keys.mockRejectedValueOnce(new Error('storage unavailable'));

      await sw.dispatch('activate');

      expect(sw.self.clients.claim).toHaveBeenCalledTimes(1);
      expect(sw.console.error).toHaveBeenCalled();
    });
  });

  describe('push', () => {
    const payload = {
      title: 'Claude - project',
      body: 'Permission requise',
      tag: 'claude-project--1',
      data: { sessionName: 'project--1', url: '/?machine=m1&session=project--1' },
    };

    it('posts PUSH_NOTIFICATION_FOREGROUND to the focused client instead of notifying', async () => {
      const focused = createWindowClient({ focused: true });
      const sw = loadServiceWorker({ clients: [createWindowClient(), focused] });

      await sw.dispatch('push', pushEvent(payload));

      expect(focused.postMessage).toHaveBeenCalledWith({
        type: 'PUSH_NOTIFICATION_FOREGROUND',
        payload: { title: payload.title, body: payload.body, data: payload.data },
      });
      expect(sw.self.registration.showNotification).not.toHaveBeenCalled();
      expect(sw.navigator.setAppBadge).not.toHaveBeenCalled();
    });

    it('shows a system notification and sets the badge when no client is focused', async () => {
      const sw = loadServiceWorker({ clients: [createWindowClient()] });

      await sw.dispatch('push', pushEvent(payload));

      expect(sw.self.registration.showNotification).toHaveBeenCalledTimes(1);
      const [title, options] = sw.self.registration.showNotification.mock.calls[0];
      expect(title).toBe(payload.title);
      expect(options).toMatchObject({
        body: payload.body,
        icon: '/icon-192x192.png',
        badge: '/icon-192x192.png',
        tag: payload.tag,
        data: { url: payload.data.url },
        requireInteraction: true,
      });
      expect(options.actions.map((a: { action: string }) => a.action)).toEqual(['view', 'dismiss']);
      expect(sw.navigator.setAppBadge).toHaveBeenCalledWith(1);
    });

    it('falls back to "/" when the payload carries no url', async () => {
      const sw = loadServiceWorker();

      await sw.dispatch('push', pushEvent({ title: 'Claude', body: 'Hi' }));

      const [, options] = sw.self.registration.showNotification.mock.calls[0];
      expect(options.data).toEqual({ url: '/' });
    });

    it('ignores a push without data', async () => {
      const sw = loadServiceWorker();

      await sw.dispatch('push', { data: null });

      expect(sw.self.registration.showNotification).not.toHaveBeenCalled();
      expect(sw.self.clients.matchAll).not.toHaveBeenCalled();
    });

    it('does not throw on an unparsable payload', async () => {
      const sw = loadServiceWorker();
      const badEvent = {
        data: {
          json: () => {
            throw new SyntaxError('bad json');
          },
        },
      };

      await expect(sw.dispatch('push', badEvent)).resolves.toBeUndefined();
      expect(sw.console.error).toHaveBeenCalled();
      expect(sw.self.registration.showNotification).not.toHaveBeenCalled();
    });
  });

  describe('notificationclick', () => {
    const url = '/?machine=m1&session=project--1';

    it('stores the deeplink, then navigates and focuses an existing client', async () => {
      const client = createWindowClient();
      const sw = loadServiceWorker({ clients: [client] });
      const event = clickEvent(url);

      await sw.dispatch('notificationclick', event);

      expect(event.notification.close).toHaveBeenCalled();
      expect(sw.navigator.clearAppBadge).toHaveBeenCalled();
      expect(client.navigate).toHaveBeenCalledWith(url);
      expect(client.focus).toHaveBeenCalled();
      expect(sw.self.clients.openWindow).not.toHaveBeenCalled();

      const stored = await sw.caches.stores.get(DEEPLINK_CACHE)?.get(DEEPLINK_KEY)?.json();
      expect(stored.url).toBe(url);
      expect(typeof stored.timestamp).toBe('number');
    });

    it('focuses and posts NOTIFICATION_CLICK when the client cannot navigate', async () => {
      const client = createWindowClient({ navigate: undefined });
      delete (client as Record<string, unknown>).navigate;
      const sw = loadServiceWorker({ clients: [client] });

      await sw.dispatch('notificationclick', clickEvent(url));

      expect(client.focus).toHaveBeenCalled();
      expect(client.postMessage).toHaveBeenCalledWith({ type: 'NOTIFICATION_CLICK', url });
      expect(sw.self.clients.openWindow).not.toHaveBeenCalled();
    });

    it('opens a new window when there is no client for this origin', async () => {
      const foreign = createWindowClient({ url: 'https://other.example/' });
      const sw = loadServiceWorker({ clients: [foreign] });

      await sw.dispatch('notificationclick', clickEvent(url));

      expect(foreign.navigate).not.toHaveBeenCalled();
      expect(sw.self.clients.openWindow).toHaveBeenCalledWith(url);
    });

    it('opens a new window when navigating the existing client fails', async () => {
      const client = createWindowClient({
        navigate: vi.fn().mockRejectedValue(new Error('navigation blocked')),
      });
      const sw = loadServiceWorker({ clients: [client] });

      await sw.dispatch('notificationclick', clickEvent(url));

      expect(sw.self.clients.openWindow).toHaveBeenCalledWith(url);
    });

    it('defaults to "/" when the notification has no url', async () => {
      const sw = loadServiceWorker();

      await sw.dispatch('notificationclick', clickEvent(undefined));

      expect(sw.self.clients.openWindow).toHaveBeenCalledWith('/');
    });

    it('only closes the notification for the dismiss action', async () => {
      const client = createWindowClient();
      const sw = loadServiceWorker({ clients: [client] });
      const event = clickEvent(url, 'dismiss');

      await sw.dispatch('notificationclick', event);

      expect(event.notification.close).toHaveBeenCalled();
      expect(client.navigate).not.toHaveBeenCalled();
      expect(sw.self.clients.openWindow).not.toHaveBeenCalled();
      expect(sw.caches.stores.has(DEEPLINK_CACHE)).toBe(false);
    });
  });

  describe('message: CHECK_NOTIFICATION_DEEPLINK', () => {
    const url = '/?machine=m1&session=project--1';
    const check = (source: { postMessage: ReturnType<typeof vi.fn> }) => ({
      data: { type: 'CHECK_NOTIFICATION_DEEPLINK' },
      source,
    });

    it('answers with NOTIFICATION_DEEPLINK for a fresh deeplink and consumes it', async () => {
      const sw = loadServiceWorker();
      await sw.dispatch('notificationclick', clickEvent(url));
      const source = { postMessage: vi.fn() };

      await sw.dispatch('message', check(source));
      await sw.dispatch('message', check(source));

      expect(source.postMessage).toHaveBeenCalledTimes(1);
      expect(source.postMessage).toHaveBeenCalledWith({ type: 'NOTIFICATION_DEEPLINK', url });
    });

    it('drops a deeplink older than 30 seconds without answering', async () => {
      const sw = loadServiceWorker();
      const stale = JSON.stringify({ url, timestamp: Date.now() - 31_000 });
      sw.caches.stores.set(DEEPLINK_CACHE, new Map([[DEEPLINK_KEY, new FakeResponse(stale)]]));
      const source = { postMessage: vi.fn() };

      await sw.dispatch('message', check(source));

      expect(source.postMessage).not.toHaveBeenCalled();
      expect(sw.caches.stores.get(DEEPLINK_CACHE)?.has(DEEPLINK_KEY)).toBe(false);
    });

    it('stays silent when there is no pending deeplink', async () => {
      const sw = loadServiceWorker();
      const source = { postMessage: vi.fn() };

      await sw.dispatch('message', check(source));

      expect(source.postMessage).not.toHaveBeenCalled();
    });

    it('ignores unrelated messages', async () => {
      const sw = loadServiceWorker();
      const source = { postMessage: vi.fn() };

      await sw.dispatch('message', { data: { type: 'SOMETHING_ELSE' }, source });
      await sw.dispatch('message', { data: null, source });

      expect(source.postMessage).not.toHaveBeenCalled();
      expect(sw.caches.open).not.toHaveBeenCalled();
    });
  });
});
