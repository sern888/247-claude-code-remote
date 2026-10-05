import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

// Create a test database in a temp directory
let testDbPath: string;
let db: Database.Database;

// Minimal session functions for testing (extracted from sessions.ts logic)
interface DbSession {
  name: string;
  project: string;
  status: string;
  attention_reason: string | null;
  last_event: string | null;
  last_activity: number;
  last_status_change: number;
  environment_id: string | null;
  created_at: number;
  updated_at: number;
}

function initTestDb(dbInstance: Database.Database): void {
  dbInstance.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      name TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'idle',
      attention_reason TEXT,
      last_event TEXT,
      last_activity INTEGER NOT NULL,
      last_status_change INTEGER NOT NULL,
      environment_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
}

function getSession(dbInstance: Database.Database, name: string): DbSession | null {
  const row = dbInstance.prepare('SELECT * FROM sessions WHERE name = ?').get(name) as
    DbSession | undefined;
  return row ?? null;
}

function upsertSession(
  dbInstance: Database.Database,
  name: string,
  input: {
    project: string;
    status: string;
    attentionReason?: string | null;
    lastEvent?: string | null;
    lastActivity: number;
    lastStatusChange: number;
    environmentId?: string | null;
  }
): DbSession {
  const now = Date.now();
  const existing = getSession(dbInstance, name);
  const statusChanged = !existing || existing.status !== input.status;

  const stmt = dbInstance.prepare(`
    INSERT INTO sessions (
      name, project, status, attention_reason, last_event,
      last_activity, last_status_change, environment_id, created_at, updated_at
    )
    VALUES (
      @name, @project, @status, @attentionReason, @lastEvent,
      @lastActivity, @lastStatusChange, @environmentId, @createdAt, @updatedAt
    )
    ON CONFLICT(name) DO UPDATE SET
      status = @status,
      attention_reason = @attentionReason,
      last_event = @lastEvent,
      last_activity = @lastActivity,
      last_status_change = @lastStatusChange,
      environment_id = COALESCE(@environmentId, environment_id),
      updated_at = @updatedAt
  `);

  stmt.run({
    name,
    project: input.project,
    status: input.status,
    attentionReason: input.attentionReason ?? null,
    lastEvent: input.lastEvent ?? null,
    lastActivity: input.lastActivity,
    lastStatusChange: statusChanged ? now : (existing?.last_status_change ?? now),
    environmentId: input.environmentId ?? null,
    createdAt: existing?.created_at ?? now, // PRESERVE EXISTING createdAt
    updatedAt: now,
  });

  return getSession(dbInstance, name)!;
}

describe('Sessions Database - createdAt Stability', () => {
  beforeAll(() => {
    // Create temp directory for test database
    testDbPath = path.join(os.tmpdir(), `test-sessions-${Date.now()}.db`);
    db = new Database(testDbPath);
    initTestDb(db);
  });

  afterAll(() => {
    db.close();
    // Clean up test database
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
  });

  beforeEach(() => {
    // Clear sessions table before each test
    db.exec('DELETE FROM sessions');
  });

  it('sets createdAt on first insert', () => {
    const before = Date.now();

    const session = upsertSession(db, 'test--session-1', {
      project: 'test',
      status: 'working',
      lastActivity: Date.now(),
      lastStatusChange: Date.now(),
    });

    const after = Date.now();

    expect(session.created_at).toBeGreaterThanOrEqual(before);
    expect(session.created_at).toBeLessThanOrEqual(after);
  });

  it('preserves createdAt across status updates', async () => {
    // Create session
    const session1 = upsertSession(db, 'test--session-1', {
      project: 'test',
      status: 'working',
      lastActivity: Date.now(),
      lastStatusChange: Date.now(),
    });

    const originalCreatedAt = session1.created_at;

    // Wait a bit to ensure timestamps differ
    await new Promise((r) => setTimeout(r, 10));

    // Update status to needs_attention
    const session2 = upsertSession(db, 'test--session-1', {
      project: 'test',
      status: 'needs_attention',
      attentionReason: 'permission',
      lastActivity: Date.now(),
      lastStatusChange: Date.now(),
    });

    expect(session2.created_at).toBe(originalCreatedAt);

    // Wait again
    await new Promise((r) => setTimeout(r, 10));

    // Update status back to working
    const session3 = upsertSession(db, 'test--session-1', {
      project: 'test',
      status: 'working',
      lastActivity: Date.now(),
      lastStatusChange: Date.now(),
    });

    expect(session3.created_at).toBe(originalCreatedAt);

    // Update to idle
    const session4 = upsertSession(db, 'test--session-1', {
      project: 'test',
      status: 'idle',
      lastActivity: Date.now(),
      lastStatusChange: Date.now(),
    });

    expect(session4.created_at).toBe(originalCreatedAt);
  });

  it('preserves createdAt even after many updates', async () => {
    // Create session
    const session = upsertSession(db, 'test--many-updates', {
      project: 'test',
      status: 'working',
      lastActivity: Date.now(),
      lastStatusChange: Date.now(),
    });

    const originalCreatedAt = session.created_at;

    // Simulate many status updates over time
    const statuses = [
      { status: 'needs_attention', reason: 'permission' },
      { status: 'working', reason: undefined },
      { status: 'needs_attention', reason: 'input' },
      { status: 'working', reason: undefined },
      { status: 'needs_attention', reason: 'plan_approval' },
      { status: 'working', reason: undefined },
      { status: 'needs_attention', reason: 'task_complete' },
      { status: 'idle', reason: undefined },
    ];

    for (const { status, reason } of statuses) {
      await new Promise((r) => setTimeout(r, 5));

      const updated = upsertSession(db, 'test--many-updates', {
        project: 'test',
        status,
        attentionReason: reason,
        lastActivity: Date.now(),
        lastStatusChange: Date.now(),
      });

      expect(updated.created_at).toBe(originalCreatedAt);
    }
  });

  it('updatedAt changes on each update while createdAt stays same', async () => {
    // Create session
    const session1 = upsertSession(db, 'test--timestamps', {
      project: 'test',
      status: 'working',
      lastActivity: Date.now(),
      lastStatusChange: Date.now(),
    });

    const originalCreatedAt = session1.created_at;
    const originalUpdatedAt = session1.updated_at;

    await new Promise((r) => setTimeout(r, 10));

    // Update session
    const session2 = upsertSession(db, 'test--timestamps', {
      project: 'test',
      status: 'needs_attention',
      attentionReason: 'permission',
      lastActivity: Date.now(),
      lastStatusChange: Date.now(),
    });

    // createdAt should be same
    expect(session2.created_at).toBe(originalCreatedAt);
    // updatedAt should be newer
    expect(session2.updated_at).toBeGreaterThan(originalUpdatedAt);
  });

  it('different sessions have different createdAt', async () => {
    const session1 = upsertSession(db, 'test--session-a', {
      project: 'test',
      status: 'working',
      lastActivity: Date.now(),
      lastStatusChange: Date.now(),
    });

    await new Promise((r) => setTimeout(r, 10));

    const session2 = upsertSession(db, 'test--session-b', {
      project: 'test',
      status: 'working',
      lastActivity: Date.now(),
      lastStatusChange: Date.now(),
    });

    // Different sessions should have different createdAt
    expect(session2.created_at).toBeGreaterThan(session1.created_at);

    // Update session 1 - its createdAt should NOT change
    await new Promise((r) => setTimeout(r, 10));

    const session1Updated = upsertSession(db, 'test--session-a', {
      project: 'test',
      status: 'idle',
      lastActivity: Date.now(),
      lastStatusChange: Date.now(),
    });

    expect(session1Updated.created_at).toBe(session1.created_at);
    expect(session1Updated.created_at).toBeLessThan(session2.created_at);
  });
});
