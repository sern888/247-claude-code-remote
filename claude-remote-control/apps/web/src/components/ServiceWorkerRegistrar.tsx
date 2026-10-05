'use client';

import { useEffect } from 'react';
import { SERVICE_WORKER_SCOPE, SERVICE_WORKER_URL } from '@/lib/service-worker';

/**
 * Registers public/sw.js once the app has mounted.
 *
 * Push notifications and notification deep links depend on it: without a registration,
 * `navigator.serviceWorker.ready` never resolves. Renders nothing.
 *
 * (Deliberately not named `ServiceWorkerRegistration`: that is a DOM global, so a missing
 * import would compile and then crash at runtime with "Illegal constructor".)
 */
export function ServiceWorkerRegistrar(): null {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) {
      return;
    }

    navigator.serviceWorker
      .register(SERVICE_WORKER_URL, { scope: SERVICE_WORKER_SCOPE, updateViaCache: 'none' })
      .catch((error: unknown) => {
        console.warn('[SW] Service worker registration failed:', error);
      });
  }, []);

  return null;
}
