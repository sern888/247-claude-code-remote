'use client';

import { useEffect, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { deeplinkLogger } from '@/lib/logger';
import { getServiceWorkerRegistration } from '@/lib/service-worker';

/**
 * Hook to handle notification deep links on iOS PWA
 *
 * On iOS PWA, notification clicks may not properly navigate using
 * clients.navigate(). This hook:
 * 1. Listens for postMessage from service worker (NOTIFICATION_CLICK)
 * 2. Checks for cached deeplinks on mount (CHECK_NOTIFICATION_DEEPLINK)
 * 3. Navigates to the URL when received
 */
export function useNotificationDeeplink() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // Clear app badge when app gains focus
  useEffect(() => {
    const handleFocus = () => {
      if ('clearAppBadge' in navigator) {
        navigator.clearAppBadge().catch((error: unknown) => {
          // Badging is best effort: it is not available in every context (e.g. not installed)
          deeplinkLogger.debug('Could not clear app badge', { error: String(error) });
        });
      }
    };

    window.addEventListener('focus', handleFocus);
    // Also clear on initial load if app is already focused
    if (document.hasFocus()) {
      handleFocus();
    }

    return () => window.removeEventListener('focus', handleFocus);
  }, []);

  // Handle navigation to deeplink URL
  const handleDeeplink = useCallback(
    (url: string) => {
      deeplinkLogger.info(`Navigating to: ${url}`);

      // Parse the URL to extract query params
      try {
        const urlObj = new URL(url, window.location.origin);

        // If we're already on the same path with same params, skip
        const currentPath = window.location.pathname + window.location.search;
        const targetPath = urlObj.pathname + urlObj.search;

        if (currentPath === targetPath) {
          deeplinkLogger.info('Already on target URL, skipping');
          return;
        }

        // Navigate to the URL
        router.push(targetPath);
      } catch (e) {
        deeplinkLogger.error(`Invalid URL: ${url}`, e);
        // Fallback: try navigating to the raw URL
        router.push(url);
      }
    },
    [router]
  );

  useEffect(() => {
    // Skip if service worker not supported
    if (!('serviceWorker' in navigator)) {
      return;
    }

    // Handle messages from service worker
    const handleMessage = (event: MessageEvent) => {
      const { type, url } = event.data || {};

      if (type === 'NOTIFICATION_CLICK' || type === 'NOTIFICATION_DEEPLINK') {
        deeplinkLogger.info(`Received ${type} message: ${url}`);
        if (url) {
          handleDeeplink(url);
        }
      }
    };

    navigator.serviceWorker.addEventListener('message', handleMessage);

    // Set on cleanup: once the listener is gone nobody could receive the worker's answer,
    // and asking would still consume the single-use deeplink
    let cancelled = false;

    // Check for pending deeplink on mount (iOS fallback)
    const checkPendingDeeplink = async () => {
      try {
        const registration = await getServiceWorkerRegistration();
        if (cancelled) {
          return;
        }
        if (!registration?.active) {
          // No active service worker: there cannot be a pending deeplink
          deeplinkLogger.info('No active service worker, skipping deeplink check');
          return;
        }
        deeplinkLogger.info('Checking for pending deeplink...');
        registration.active.postMessage({ type: 'CHECK_NOTIFICATION_DEEPLINK' });
      } catch (e) {
        deeplinkLogger.error('Failed to check pending deeplink', e);
      }
    };

    // Small delay to ensure SW is ready
    const timeoutId = setTimeout(checkPendingDeeplink, 500);

    return () => {
      cancelled = true;
      navigator.serviceWorker.removeEventListener('message', handleMessage);
      clearTimeout(timeoutId);
    };
  }, [handleDeeplink]);

  // Also handle URL params if we have machine/session in the URL
  // This handles the case where the deeplink worked via openWindow
  useEffect(() => {
    const machine = searchParams.get('machine');
    const session = searchParams.get('session');

    if (machine && session) {
      deeplinkLogger.info('URL contains session params', { machine, session });
      // The main app component should handle this - just log it
    }
  }, [searchParams]);
}
