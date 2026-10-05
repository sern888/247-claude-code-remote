import { NextResponse } from 'next/server';
import { db, agentConnection, pushSubscription, type PushSubscription } from '@/lib/db';
import { eq } from 'drizzle-orm';
import { sendPushNotification, type PushPayload, type PushSendResult } from '@/lib/push';
import {
  isBoundedString,
  jsonError,
  readJsonObject,
  type JsonObject,
  type ValidationResult,
} from '../../_lib/request';
import { createRateLimiter } from './rate-limit';

/**
 * POST /api/push/notify
 * Send push notification to user (called by agent with machineId)
 *
 * Body:
 * - machineId: string (agent's machine UUID)
 * - sessionName: string (e.g., "project--session-name")
 * - reason?: string (optional: 'permission', 'input', 'plan_approval', 'task_complete')
 *
 * NOTE: this endpoint is intentionally unauthenticated for now: the agent only knows its
 * machineId. Authenticating it needs an agent-side protocol change. Until then the inputs
 * are strictly validated and each machineId is rate limited.
 */

const MAX_MACHINE_ID_LENGTH = 100;
const MAX_SESSION_NAME_LENGTH = 100;
const MAX_REASON_LENGTH = 50;
// Same alphabet the agent enforces for session names, plus "." — safe in a title and a URL
const SESSION_NAME_PATTERN = /^[\w.-]+$/;
const NOTIFICATION_ICON = '/icon-192x192.png';
const DEFAULT_NOTIFICATION_BODY = 'Attention requise';

const NOTIFY_RATE_LIMIT = 30;
const NOTIFY_RATE_WINDOW_MS = 60_000;
const NOTIFY_RATE_MAX_KEYS = 5_000;
const MS_PER_SECOND = 1000;

// Reason-specific messages for notification body
const reasonMessages = new Map<string, string>([
  ['permission', 'Permission requise'],
  ['input', 'Réponse attendue'],
  ['plan_approval', 'Approbation du plan'],
  ['task_complete', 'Tâche terminée'],
]);

const rateLimiter = createRateLimiter({
  limit: NOTIFY_RATE_LIMIT,
  windowMs: NOTIFY_RATE_WINDOW_MS,
  maxKeys: NOTIFY_RATE_MAX_KEYS,
});

interface NotifyInput {
  machineId: string;
  sessionName: string;
  reason: string | undefined;
}

function parseNotifyBody(body: JsonObject): ValidationResult<NotifyInput> {
  const { machineId, sessionName, reason } = body;

  if (!isBoundedString(machineId, MAX_MACHINE_ID_LENGTH)) {
    return { ok: false, error: 'machineId required' };
  }
  if (!isBoundedString(sessionName, MAX_SESSION_NAME_LENGTH)) {
    return {
      ok: false,
      error: `sessionName required (max ${MAX_SESSION_NAME_LENGTH} characters)`,
    };
  }
  if (!SESSION_NAME_PATTERN.test(sessionName)) {
    return { ok: false, error: 'sessionName may only contain letters, digits, ".", "_" and "-"' };
  }
  if (reason !== undefined && reason !== null && !isBoundedString(reason, MAX_REASON_LENGTH)) {
    return { ok: false, error: 'reason must be a string' };
  }

  return { ok: true, value: { machineId, sessionName, reason: reason ?? undefined } };
}

function buildPayload(connectionId: string, { sessionName, reason }: NotifyInput): PushPayload {
  // Extract project name from session name (format: project--session-id)
  const [projectName] = sessionName.split('--');

  // Build URL with query params to auto-select session
  // Use connection.id (not machineId) because that's what the web app uses as machine identifier
  const url = `/?machine=${encodeURIComponent(connectionId)}&session=${encodeURIComponent(sessionName)}`;

  return {
    title: `Claude - ${projectName}`,
    body: (reason && reasonMessages.get(reason)) || DEFAULT_NOTIFICATION_BODY,
    icon: NOTIFICATION_ICON,
    badge: NOTIFICATION_ICON,
    tag: `claude-${sessionName}`,
    data: { sessionName, projectName, connectionId, url },
  };
}

/** Send to one subscription; the row is deleted ONLY when the push service says it is gone. */
async function deliver(sub: PushSubscription, payload: PushPayload): Promise<PushSendResult> {
  const result = await sendPushNotification(
    { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
    payload
  );

  if (!result.ok && result.gone) {
    await db.delete(pushSubscription).where(eq(pushSubscription.id, sub.id));
  }

  return result;
}

function summarise(results: PromiseSettledResult<PushSendResult>[]) {
  const outcomes = results.map((r) => (r.status === 'fulfilled' ? r.value : null));
  const sent = outcomes.filter((o) => o?.ok === true).length;
  const expired = outcomes.filter((o) => o !== null && !o.ok && o.gone).length;
  return { sent, expired, failed: results.length - sent - expired };
}

export async function POST(req: Request) {
  try {
    const body = await readJsonObject(req);
    if (!body) {
      return jsonError('Request body must be a JSON object', 400);
    }

    const input = parseNotifyBody(body);
    if (!input.ok) {
      return jsonError(input.error, 400);
    }
    const { machineId, sessionName } = input.value;

    const decision = rateLimiter.tryAcquire(machineId);
    if (!decision.allowed) {
      const retryAfterSeconds = Math.ceil(decision.retryAfterMs / MS_PER_SECOND);
      return jsonError('Too many notifications, slow down', 429, {
        'Retry-After': String(retryAfterSeconds),
      });
    }

    // Find the agent connection by machineId to get the userId
    const [connection] = await db
      .select()
      .from(agentConnection)
      .where(eq(agentConnection.machineId, machineId))
      .limit(1);

    if (!connection) {
      // No connection found for this machineId - agent not paired
      return NextResponse.json({ success: true, sent: 0, message: 'Agent not paired' });
    }

    // Get all push subscriptions for this user
    const subscriptions = await db
      .select()
      .from(pushSubscription)
      .where(eq(pushSubscription.userId, connection.userId));

    if (subscriptions.length === 0) {
      return NextResponse.json({ success: true, sent: 0, message: 'No subscriptions' });
    }

    const payload = buildPayload(connection.id, input.value);
    const results = await Promise.allSettled(subscriptions.map((sub) => deliver(sub, payload)));
    const summary = summarise(results);

    console.warn(
      `[Push] ${sessionName}: ${summary.sent} sent, ${summary.expired} expired, ${summary.failed} failed`
    );

    return NextResponse.json({ success: true, ...summary });
  } catch (error) {
    console.error('[Push] Error sending notification:', error);
    return jsonError('Failed to send notification', 500);
  }
}
