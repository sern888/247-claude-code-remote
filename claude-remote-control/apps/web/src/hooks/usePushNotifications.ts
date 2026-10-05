'use client';

import { useState, useEffect, useCallback } from 'react';
import { pushLogger } from '@/lib/logger';
import {
  DEFAULT_SW_READY_TIMEOUT_MS,
  SERVICE_WORKER_UNAVAILABLE_MESSAGE,
  getServiceWorkerRegistration,
} from '@/lib/service-worker';

interface PushNotificationState {
  /**
   * True when the browser has the push APIs AND an active service worker registration.
   * False means push is unsupported or currently unavailable on this device.
   */
  isSupported: boolean;
  isSubscribed: boolean;
  permission: NotificationPermission | 'default';
  isLoading: boolean;
  error: string | null;
}

const SUBSCRIBE_ENDPOINT = '/api/push/subscribe';
const VAPID_KEY_ENDPOINT = '/api/push/vapid-key';
const HTTP_CONFLICT = 409;
const SAVE_FAILED_MESSAGE = 'Failed to save subscription';

/** Waiting for the worker when the user explicitly subscribes (iOS can be slow to activate) */
const SUBSCRIBE_SW_TIMEOUT_MS = 15000;
/** pushManager.subscribe() talks to the push service; iOS can be slow */
const PUSH_SUBSCRIBE_TIMEOUT_MS = 20000;

/**
 * Convert a base64 string to Uint8Array for applicationServerKey
 */
function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const buffer = new ArrayBuffer(rawData.length);
  const outputArray = new Uint8Array(buffer);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

/** Reject with `message` if `promise` has not settled after `timeoutMs`. */
function rejectAfter<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
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

function hasPushApis(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

async function fetchVapidPublicKey(): Promise<string> {
  const response = await fetch(VAPID_KEY_ENDPOINT);
  if (!response.ok) {
    throw new Error('Failed to get VAPID key');
  }
  const data: unknown = await response.json();
  const publicKey =
    typeof data === 'object' && data !== null && 'publicKey' in data ? data.publicKey : null;
  if (typeof publicKey !== 'string' || publicKey.length === 0) {
    throw new Error('Failed to get VAPID key');
  }
  return publicKey;
}

function subscribeToPushManager(
  registration: ServiceWorkerRegistration,
  publicKey: string
): Promise<PushSubscription> {
  return rejectAfter(
    registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    }),
    PUSH_SUBSCRIBE_TIMEOUT_MS,
    'Push subscription timeout - please try again'
  );
}

function postSubscription(subscription: PushSubscription): Promise<Response> {
  return fetch(SUBSCRIBE_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      subscription: subscription.toJSON(),
      userAgent: navigator.userAgent,
    }),
  });
}

/**
 * Drop a browser subscription the server did not accept. Left in place, the next page load
 * would report "subscribed" although no push could ever be delivered. Best effort.
 */
async function discardSubscription(subscription: PushSubscription): Promise<void> {
  try {
    await subscription.unsubscribe();
  } catch (error) {
    pushLogger.warn('Could not discard the unsaved subscription', { error: String(error) });
  }
}

type SaveAttempt = { saved: true } | { saved: false; status: number };

/** POST the subscription; when the server does not store it, discard it in the browser too. */
async function postOrDiscard(subscription: PushSubscription): Promise<SaveAttempt> {
  try {
    const response = await postSubscription(subscription);
    if (response.ok) return { saved: true };
    await discardSubscription(subscription);
    return { saved: false, status: response.status };
  } catch (error) {
    await discardSubscription(subscription);
    throw error;
  }
}

/**
 * Store the subscription on the server.
 * 409 means this browser's push endpoint is still registered to another account (shared
 * device): the server never reassigns ownership, so the endpoint is dropped, a fresh one is
 * created and the save is retried once.
 */
async function saveSubscription(
  registration: ServiceWorkerRegistration,
  subscription: PushSubscription,
  publicKey: string
): Promise<void> {
  const firstAttempt = await postOrDiscard(subscription);
  if (firstAttempt.saved) return;
  if (firstAttempt.status !== HTTP_CONFLICT) {
    throw new Error(SAVE_FAILED_MESSAGE);
  }

  pushLogger.info('Endpoint owned by another account, creating a fresh subscription');
  const freshSubscription = await subscribeToPushManager(registration, publicKey);
  const retry = await postOrDiscard(freshSubscription);
  if (!retry.saved) {
    throw new Error(SAVE_FAILED_MESSAGE);
  }
}

/**
 * Best effort: the browser subscription is already gone at this point, and a row the server
 * keeps is removed when the push service next answers 410 for it.
 */
async function removeSubscriptionFromServer(endpoint: string): Promise<void> {
  try {
    const response = await fetch(SUBSCRIBE_ENDPOINT, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint }),
    });
    if (!response.ok) {
      pushLogger.warn(`Server did not remove the subscription (status ${response.status})`);
    }
  } catch (error) {
    pushLogger.warn('Could not reach the server to remove the subscription', {
      error: String(error),
    });
  }
}

/** Push state for an active registration. */
async function readSubscriptionState(
  registration: ServiceWorkerRegistration,
  permission: NotificationPermission
): Promise<PushNotificationState> {
  const subscription = await registration.pushManager.getSubscription();
  return {
    isSupported: true,
    isSubscribed: Boolean(subscription),
    permission,
    isLoading: false,
    error: null,
  };
}

export function usePushNotifications() {
  const [state, setState] = useState<PushNotificationState>({
    isSupported: false,
    isSubscribed: false,
    permission: 'default',
    isLoading: true,
    error: null,
  });

  // Check initial state
  useEffect(() => {
    let cancelled = false;
    const apply = (next: PushNotificationState) => {
      if (!cancelled) setState(next);
    };

    const checkSupport = async () => {
      const idle = { isSubscribed: false, isLoading: false, error: null };

      if (!hasPushApis()) {
        apply({ ...idle, isSupported: false, permission: 'default' });
        return;
      }

      const permission = Notification.permission;

      try {
        const registration = await getServiceWorkerRegistration(DEFAULT_SW_READY_TIMEOUT_MS);
        if (cancelled) return;
        if (registration) {
          apply(await readSubscriptionState(registration, permission));
          return;
        }

        // No active service worker (registration failed, blocked or still installing):
        // push is unavailable for now
        pushLogger.warn('No active service worker registration - push unavailable');
        apply({ ...idle, isSupported: false, permission });

        // A worker that was only slow to install becomes usable once `ready` resolves.
        // (`ready` stays pending forever when nothing is registered; nothing waits on this.)
        const lateRegistration = await navigator.serviceWorker.ready;
        if (cancelled) return;
        apply(await readSubscriptionState(lateRegistration, permission));
      } catch (error) {
        pushLogger.error('Error checking subscription', error);
        apply({
          ...idle,
          isSupported: true,
          permission,
          error: 'Failed to check subscription status',
        });
      }
    };

    checkSupport();

    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Subscribe to push notifications
   */
  const subscribe = useCallback(async () => {
    if (!state.isSupported) {
      setState((s) => ({ ...s, error: 'Push notifications not supported' }));
      return false;
    }

    setState((s) => ({ ...s, isLoading: true, error: null }));

    try {
      // Request notification permission
      pushLogger.info('Requesting permission...');
      const permission = await Notification.requestPermission();
      pushLogger.info(`Permission result: ${permission}`);
      if (permission !== 'granted') {
        setState((s) => ({
          ...s,
          permission,
          isLoading: false,
          error: 'Notification permission denied',
        }));
        return false;
      }

      pushLogger.info('Fetching VAPID key...');
      const publicKey = await fetchVapidPublicKey();

      pushLogger.info('Waiting for service worker...');
      const registration = await getServiceWorkerRegistration(SUBSCRIBE_SW_TIMEOUT_MS);
      if (!registration) {
        throw new Error(SERVICE_WORKER_UNAVAILABLE_MESSAGE);
      }

      pushLogger.info('Subscribing to push manager...');
      const subscription = await subscribeToPushManager(registration, publicKey);

      await saveSubscription(registration, subscription, publicKey);

      setState({
        isSupported: true,
        isSubscribed: true,
        permission: 'granted',
        isLoading: false,
        error: null,
      });

      pushLogger.info('Successfully subscribed');
      return true;
    } catch (error) {
      pushLogger.error('Subscription error', error);
      setState((s) => ({
        ...s,
        isLoading: false,
        error: error instanceof Error ? error.message : 'Failed to subscribe',
      }));
      return false;
    }
  }, [state.isSupported]);

  /**
   * Unsubscribe from push notifications
   */
  const unsubscribe = useCallback(async () => {
    setState((s) => ({ ...s, isLoading: true, error: null }));

    try {
      const registration = await getServiceWorkerRegistration(DEFAULT_SW_READY_TIMEOUT_MS);
      if (!registration) {
        throw new Error(SERVICE_WORKER_UNAVAILABLE_MESSAGE);
      }

      const subscription = await registration.pushManager.getSubscription();

      if (subscription) {
        // Unsubscribe from push manager
        await subscription.unsubscribe();

        await removeSubscriptionFromServer(subscription.endpoint);
      }

      setState((s) => ({
        ...s,
        isSubscribed: false,
        isLoading: false,
        error: null,
      }));

      pushLogger.info('Successfully unsubscribed');
      return true;
    } catch (error) {
      pushLogger.error('Unsubscribe error', error);
      setState((s) => ({
        ...s,
        isLoading: false,
        error: error instanceof Error ? error.message : 'Failed to unsubscribe',
      }));
      return false;
    }
  }, []);

  return {
    ...state,
    subscribe,
    unsubscribe,
  };
}
