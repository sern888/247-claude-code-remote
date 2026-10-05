/* global self, caches, navigator, console, Request, Response */

/**
 * 247 service worker — hand-written on purpose, keep it small and readable.
 *
 * Scope: push notifications and notification deep links ONLY.
 * There is deliberately no `fetch` handler and no precache manifest: every request goes
 * straight to the network, so the dashboard can never be served stale JavaScript or cached
 * /api/* responses. Do not add caching here without a product decision.
 *
 * Registered by src/components/ServiceWorkerRegistrar.tsx.
 * Covered by tests/unit/public/sw-syntax.test.ts and tests/unit/public/sw-behavior.test.ts.
 */

const DEEPLINK_CACHE = 'notification-deeplink';
const DEEPLINK_KEY = '/__notification_deeplink__';
const DEEPLINK_MAX_AGE_MS = 30000;
const NOTIFICATION_ICON = '/icon-192x192.png';
const WINDOW_CLIENTS = { type: 'window', includeUncontrolled: true };

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

self.addEventListener('install', (event) => {
  // Replace the previous worker immediately instead of waiting for every tab to close
  event.waitUntil(self.skipWaiting());
});

/** Remove every cache left behind by the old precaching bundle, except the deep link store. */
async function deleteLegacyCaches() {
  const names = await caches.keys();
  const legacyNames = names.filter((name) => name !== DEEPLINK_CACHE);
  await Promise.all(legacyNames.map((name) => caches.delete(name)));
}

/** The old bundle enabled navigation preload; it is registration state and would outlive it. */
async function disableNavigationPreload() {
  if (self.registration.navigationPreload) {
    await self.registration.navigationPreload.disable();
  }
}

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      try {
        await deleteLegacyCaches();
        await disableNavigationPreload();
      } catch (error) {
        console.error('[SW] Cleanup of the previous worker failed:', error);
      }
      await self.clients.claim();
    })()
  );
});

// ---------------------------------------------------------------------------
// Push: toast in the focused tab, system notification otherwise
// ---------------------------------------------------------------------------

async function handlePush(event) {
  try {
    const payload = event.data.json();
    const windowClients = await self.clients.matchAll(WINDOW_CLIENTS);
    const focusedClient = windowClients.find((client) => client.focused);

    if (focusedClient) {
      // App is in the foreground: let the page show an in-app toast (useInAppNotifications)
      focusedClient.postMessage({
        type: 'PUSH_NOTIFICATION_FOREGROUND',
        payload: { title: payload.title, body: payload.body, data: payload.data },
      });
      return;
    }

    await self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: NOTIFICATION_ICON,
      badge: NOTIFICATION_ICON,
      tag: payload.tag,
      data: { url: payload.data?.url || payload.url || '/' },
      requireInteraction: true,
      actions: [
        { action: 'view', title: 'Voir' },
        { action: 'dismiss', title: 'Ignorer' },
      ],
      vibrate: [200, 100, 200],
      timestamp: Date.now(),
    });

    if ('setAppBadge' in navigator) {
      navigator.setAppBadge(1).catch(() => {
        // Badging is best effort: not available on every platform
      });
    }
  } catch (error) {
    console.error('[SW] Failed to handle push payload:', error);
  }
}

self.addEventListener('push', (event) => {
  if (!event.data) {
    console.warn('[SW] Push event received but no data');
    return;
  }
  event.waitUntil(handlePush(event));
});

// ---------------------------------------------------------------------------
// Notification click: remember the deep link, then navigate/focus/open a window
// ---------------------------------------------------------------------------

/** iOS fallback: the page asks for this link on launch (CHECK_NOTIFICATION_DEEPLINK). */
async function storeDeeplink(url) {
  try {
    const cache = await caches.open(DEEPLINK_CACHE);
    const record = JSON.stringify({ url, timestamp: Date.now() });
    await cache.put(new Request(DEEPLINK_KEY), new Response(record));
  } catch (error) {
    console.error('[SW] Failed to store deeplink:', error);
  }
}

/** Bring an existing tab to `url`. Resolves to true when one handled it. */
async function showInExistingClient(client, url) {
  if ('navigate' in client) {
    await client.navigate(url);
    await client.focus();
    return true;
  }
  if ('focus' in client) {
    await client.focus();
    client.postMessage({ type: 'NOTIFICATION_CLICK', url });
    return true;
  }
  return false;
}

async function openDeeplink(url) {
  await storeDeeplink(url);

  const windowClients = await self.clients.matchAll(WINDOW_CLIENTS);
  const ownClients = windowClients.filter((client) => client.url.includes(self.location.origin));

  for (const client of ownClients) {
    try {
      if (await showInExistingClient(client, url)) return;
    } catch (error) {
      console.error('[SW] Navigate/focus failed:', error);
    }
  }

  await self.clients.openWindow(url);
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  if ('clearAppBadge' in navigator) {
    navigator.clearAppBadge().catch(() => {
      // Badging is best effort: not available on every platform
    });
  }

  if (event.action === 'dismiss') return;

  const url = event.notification.data?.url || '/';
  event.waitUntil(openDeeplink(url));
});

// ---------------------------------------------------------------------------
// Messages from the page
// ---------------------------------------------------------------------------

/** Answer with the stored deep link if it is fresh; it is single-use either way. */
async function replyWithPendingDeeplink(source) {
  try {
    const cache = await caches.open(DEEPLINK_CACHE);
    const stored = await cache.match(DEEPLINK_KEY);
    if (!stored) return;

    const { url, timestamp } = await stored.json();
    if (Date.now() - timestamp < DEEPLINK_MAX_AGE_MS) {
      source?.postMessage({ type: 'NOTIFICATION_DEEPLINK', url });
    }
    await cache.delete(DEEPLINK_KEY);
  } catch (error) {
    console.error('[SW] Deeplink check failed:', error);
  }
}

self.addEventListener('message', (event) => {
  if (event.data?.type === 'CHECK_NOTIFICATION_DEEPLINK') {
    event.waitUntil(replyWithPendingDeeplink(event.source));
  }
});
