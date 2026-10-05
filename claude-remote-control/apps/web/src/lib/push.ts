import webpush from 'web-push';

// Configure VAPID details
const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_EMAIL = 'mailto:stan@quivr.app';

/** HTTP statuses a push service uses to say "this subscription no longer exists". */
const GONE_STATUS_CODES: readonly number[] = [404, 410];

function configureVapid(): boolean {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    return false;
  }
  try {
    webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    return true;
  } catch (error) {
    console.error('[Push] Invalid VAPID configuration:', error);
    return false;
  }
}

// Initialize web-push with VAPID keys
const isVapidConfigured = configureVapid();

export interface PushPayload {
  title: string;
  body: string;
  icon?: string;
  badge?: string;
  tag?: string;
  data?: Record<string, unknown>;
}

export interface PushSubscriptionData {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

/**
 * Outcome of a push delivery attempt.
 * `gone` is true ONLY when the push service answered 404/410, i.e. the subscription is dead
 * and may be deleted. Every other failure (VAPID misconfiguration, 401/403, 429, 5xx, network
 * error) is transient or ours to fix, and must never cause a subscription to be removed.
 */
export type PushSendResult = { ok: true } | { ok: false; gone: boolean; statusCode?: number };

/**
 * Loggable form of an endpoint: the push service origin only. The path is a capability
 * token (whoever knows it can address the device), so it must never reach the logs.
 */
function describeEndpoint(endpoint: string): string {
  try {
    return new URL(endpoint).origin;
  } catch {
    return '(invalid endpoint)';
  }
}

function getStatusCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('statusCode' in error)) {
    return undefined;
  }
  return typeof error.statusCode === 'number' ? error.statusCode : undefined;
}

/**
 * Send a push notification to a subscription
 */
export async function sendPushNotification(
  subscription: PushSubscriptionData,
  payload: PushPayload
): Promise<PushSendResult> {
  if (!isVapidConfigured) {
    console.error('[Push] VAPID keys are not configured; notification not sent');
    return { ok: false, gone: false };
  }

  try {
    await webpush.sendNotification(
      {
        endpoint: subscription.endpoint,
        keys: subscription.keys,
      },
      JSON.stringify(payload)
    );
    return { ok: true };
  } catch (error) {
    const statusCode = getStatusCode(error);
    const failure = statusCode === undefined ? {} : { statusCode };

    if (statusCode !== undefined && GONE_STATUS_CODES.includes(statusCode)) {
      console.warn('[Push] Subscription expired:', describeEndpoint(subscription.endpoint));
      return { ok: false, gone: true, ...failure };
    }

    console.error('[Push] Error sending notification:', {
      statusCode,
      message: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, gone: false, ...failure };
  }
}
