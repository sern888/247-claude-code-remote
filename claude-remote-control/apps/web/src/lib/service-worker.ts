/**
 * Client-side helpers around the service worker registration (public/sw.js).
 */

export const SERVICE_WORKER_URL = '/sw.js';
export const SERVICE_WORKER_SCOPE = '/';

/** How long to wait for a worker that is still installing before giving up. */
export const DEFAULT_SW_READY_TIMEOUT_MS = 5000;

export const SERVICE_WORKER_UNAVAILABLE_MESSAGE =
  'Service worker unavailable - try refreshing the page';

/** Resolve with the promise's value, or with null once `timeoutMs` has elapsed. */
function raceWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

/**
 * Resolve the active service worker registration without ever hanging.
 *
 * `navigator.serviceWorker.ready` never settles when no worker is (or gets) registered, so:
 * 1. ask for the current registration and return it if it already has an active worker;
 * 2. otherwise wait for `ready`, but only for `timeoutMs`.
 *
 * Returns null when service workers are unsupported or none became active in time —
 * callers must treat that as "push unavailable".
 */
export async function getServiceWorkerRegistration(
  timeoutMs: number = DEFAULT_SW_READY_TIMEOUT_MS
): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return null;
  }

  const existing = await navigator.serviceWorker.getRegistration(SERVICE_WORKER_SCOPE);
  if (existing?.active) {
    return existing;
  }

  return raceWithTimeout(navigator.serviceWorker.ready, timeoutMs);
}
