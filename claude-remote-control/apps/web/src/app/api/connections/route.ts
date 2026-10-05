import { NextResponse } from 'next/server';
import { db, agentConnection } from '@/lib/db';
import { and, eq, ne } from 'drizzle-orm';
import { getAuthenticatedUserId } from '../_lib/auth';
import { jsonError, readJsonObject } from '../_lib/request';
import { parseNewConnection } from './validation';

export async function GET() {
  try {
    const userId = await getAuthenticatedUserId();
    if (!userId) {
      return jsonError('Unauthorized', 401);
    }

    const connections = await db
      .select()
      .from(agentConnection)
      .where(eq(agentConnection.userId, userId));

    return NextResponse.json(connections);
  } catch (error) {
    console.error('Error fetching connections:', error);
    return jsonError('Failed to fetch connections', 500);
  }
}

/**
 * A machineId identifies one physical agent and is what /api/push/notify uses to find the
 * owner. Letting a second account register the same machineId would let it receive (or
 * hijack) the first account's notifications, so the first owner keeps it.
 */
async function isMachineOwnedByAnotherUser(machineId: string, userId: string): Promise<boolean> {
  const [existing] = await db
    .select({ id: agentConnection.id })
    .from(agentConnection)
    .where(and(eq(agentConnection.machineId, machineId), ne(agentConnection.userId, userId)))
    .limit(1);

  return existing !== undefined;
}

export async function POST(req: Request) {
  try {
    const userId = await getAuthenticatedUserId();
    if (!userId) {
      return jsonError('Unauthorized', 401);
    }

    const body = await readJsonObject(req);
    if (!body) {
      return jsonError('Request body must be a JSON object', 400);
    }

    const input = parseNewConnection(body);
    if (!input.ok) {
      return jsonError(input.error, 400);
    }

    const { machineId } = input.value;
    if (machineId && (await isMachineOwnedByAnotherUser(machineId, userId))) {
      return jsonError('This machine is already linked to another account', 409);
    }

    const [connection] = await db
      .insert(agentConnection)
      .values({ id: crypto.randomUUID(), userId, ...input.value })
      .returning();

    return NextResponse.json(connection);
  } catch (error) {
    console.error('Error creating connection:', error);
    return jsonError('Failed to create connection', 500);
  }
}
