import { NextResponse } from 'next/server';
import { db, pushSubscription } from '@/lib/db';
import { and, eq } from 'drizzle-orm';
import { isPublicHttpsUrl } from '@/lib/host-validation';
import { getAuthenticatedUserId } from '../../_lib/auth';
import {
  isBoundedString,
  isJsonObject,
  jsonError,
  readJsonObject,
  type JsonObject,
} from '../../_lib/request';

const MAX_KEY_LENGTH = 512;
const MAX_USER_AGENT_LENGTH = 512;

interface SubscriptionInput {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/**
 * The endpoint is later POSTed to by the server (web-push), so it must be a public https URL:
 * anything else would turn /api/push/notify into a request forgery primitive.
 */
function parseSubscription(body: JsonObject): SubscriptionInput | null {
  const { subscription } = body;
  if (!isJsonObject(subscription) || !isJsonObject(subscription.keys)) return null;

  const { endpoint, keys } = subscription;
  if (!isPublicHttpsUrl(endpoint)) return null;
  if (!isBoundedString(keys.p256dh, MAX_KEY_LENGTH)) return null;
  if (!isBoundedString(keys.auth, MAX_KEY_LENGTH)) return null;

  return { endpoint, p256dh: keys.p256dh, auth: keys.auth };
}

function resolveUserAgent(body: JsonObject, req: Request): string | null {
  const candidate =
    typeof body.userAgent === 'string' ? body.userAgent : req.headers.get('user-agent');
  return candidate ? candidate.slice(0, MAX_USER_AGENT_LENGTH) : null;
}

/**
 * POST /api/push/subscribe
 * Subscribe to push notifications (requires authentication)
 */
export async function POST(req: Request) {
  try {
    const userId = await getAuthenticatedUserId();
    if (!userId) {
      return jsonError('Unauthorized', 401);
    }

    const body = await readJsonObject(req);
    const subscription = body ? parseSubscription(body) : null;
    if (!body || !subscription) {
      return jsonError('Invalid subscription', 400);
    }

    const userAgent = resolveUserAgent(body, req);

    // Upsert: refresh keys when this user re-subscribes the same endpoint.
    // Ownership is never reassigned: `setWhere` skips the update (and returns no row) when
    // the endpoint already belongs to a different user.
    const [result] = await db
      .insert(pushSubscription)
      .values({ id: crypto.randomUUID(), userId, ...subscription, userAgent })
      .onConflictDoUpdate({
        target: pushSubscription.endpoint,
        set: { p256dh: subscription.p256dh, auth: subscription.auth, userAgent },
        setWhere: eq(pushSubscription.userId, userId),
      })
      .returning({ id: pushSubscription.id });

    if (!result) {
      return jsonError('This push subscription is already registered to another account', 409);
    }

    return NextResponse.json({ success: true, id: result.id });
  } catch (error) {
    console.error('[Push] Error subscribing:', error);
    return jsonError('Failed to subscribe', 500);
  }
}

/**
 * DELETE /api/push/subscribe
 * Unsubscribe from push notifications (only the caller's own subscription)
 */
export async function DELETE(req: Request) {
  try {
    const userId = await getAuthenticatedUserId();
    if (!userId) {
      return jsonError('Unauthorized', 401);
    }

    const body = await readJsonObject(req);
    const endpoint = body?.endpoint;
    if (typeof endpoint !== 'string' || endpoint.length === 0) {
      return jsonError('Endpoint required', 400);
    }

    await db
      .delete(pushSubscription)
      .where(and(eq(pushSubscription.endpoint, endpoint), eq(pushSubscription.userId, userId)));

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[Push] Error unsubscribing:', error);
    return jsonError('Failed to unsubscribe', 500);
  }
}
