import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { neon, drizzle } = vi.hoisted(() => ({ neon: vi.fn(), drizzle: vi.fn() }));

vi.mock('@neondatabase/serverless', () => ({ neon }));
vi.mock('drizzle-orm/neon-http', () => ({ drizzle }));

const TEST_DATABASE_URL = 'postgres://test-user:test-pass@db.example.test/app';

async function loadDbModule() {
  vi.resetModules();
  return import('@/lib/db');
}

describe('lib/db', () => {
  beforeEach(() => {
    neon.mockReset().mockReturnValue('sql-client');
    drizzle.mockReset().mockReturnValue({ select: 'select-builder' });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('can be imported without DATABASE_URL (builds must not need it)', async () => {
    vi.stubEnv('DATABASE_URL', '');

    await expect(loadDbModule()).resolves.toBeDefined();
    expect(neon).not.toHaveBeenCalled();
  });

  it('throws a clear error on first use when DATABASE_URL is not set', async () => {
    vi.stubEnv('DATABASE_URL', '');
    const { getDb, db } = await loadDbModule();

    expect(() => getDb()).toThrow('DATABASE_URL is not set');
    expect(() => db.select).toThrow('DATABASE_URL is not set');
    expect(neon).not.toHaveBeenCalled();
  });

  it('connects lazily, once, with DATABASE_URL', async () => {
    vi.stubEnv('DATABASE_URL', TEST_DATABASE_URL);
    const { getDb, db } = await loadDbModule();

    expect(neon).not.toHaveBeenCalled();

    const first = getDb();
    const second = getDb();

    expect(first).toBe(second);
    expect(neon).toHaveBeenCalledTimes(1);
    expect(neon).toHaveBeenCalledWith(TEST_DATABASE_URL);
    expect(drizzle).toHaveBeenCalledTimes(1);
    expect(db.select).toBe('select-builder');
  });
});
