import { NextResponse } from 'next/server';
import { db, agentConnection } from '@/lib/db';
import { eq, and } from 'drizzle-orm';
import { getAuthenticatedUserId } from '../../_lib/auth';
import { jsonError, readJsonObject } from '../../_lib/request';
import { parseConnectionUpdate } from '../validation';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function DELETE(_req: Request, { params }: RouteContext) {
  try {
    const userId = await getAuthenticatedUserId();
    if (!userId) {
      return jsonError('Unauthorized', 401);
    }

    const { id } = await params;

    const deleted = await db
      .delete(agentConnection)
      .where(and(eq(agentConnection.id, id), eq(agentConnection.userId, userId)))
      .returning({ id: agentConnection.id });

    if (deleted.length === 0) {
      return jsonError('Connection not found', 404);
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting connection:', error);
    return jsonError('Failed to delete connection', 500);
  }
}

export async function PUT(req: Request, { params }: RouteContext) {
  try {
    const userId = await getAuthenticatedUserId();
    if (!userId) {
      return jsonError('Unauthorized', 401);
    }

    const body = await readJsonObject(req);
    if (!body) {
      return jsonError('Request body must be a JSON object', 400);
    }

    const update = parseConnectionUpdate(body);
    if (!update.ok) {
      return jsonError(update.error, 400);
    }

    const { id } = await params;

    const [connection] = await db
      .update(agentConnection)
      .set({ ...update.value, updatedAt: new Date() })
      .where(and(eq(agentConnection.id, id), eq(agentConnection.userId, userId)))
      .returning();

    if (!connection) {
      return jsonError('Connection not found', 404);
    }

    return NextResponse.json(connection);
  } catch (error) {
    console.error('Error updating connection:', error);
    return jsonError('Failed to update connection', 500);
  }
}
