/**
 * In-memory stand-in for `@/lib/db` and `drizzle-orm` used by API route tests.
 * No test ever talks to the real (remote, production) database.
 *
 * Usage in a test file:
 *
 *   vi.mock('@/lib/db', async () => (await import('./helpers/mockDb')).dbModule);
 *   vi.mock('drizzle-orm', async () => (await import('./helpers/mockDb')).operators);
 *
 * Every query built from `db` is recorded (see `recordedQueries`) and resolves with the next
 * result queued through `queueDbResults` (an empty array when nothing is queued).
 */

export type QueryKind = 'select' | 'insert' | 'update' | 'delete';

export interface RecordedQuery {
  kind: QueryKind;
  table?: unknown;
  fields?: unknown;
  where?: unknown;
  values?: Record<string, unknown>;
  set?: Record<string, unknown>;
  conflict?: Record<string, unknown>;
  limit?: number;
  returning?: unknown;
}

interface DbState {
  results: unknown[][];
  queries: RecordedQuery[];
  error: Error | null;
}

const state: DbState = { results: [], queries: [], error: null };

/** Queue one result set per upcoming query, in execution order. */
export function queueDbResults(...results: unknown[][]): void {
  state.results.push(...results);
}

/** Make every following query reject with `error`. */
export function failDbWith(error: Error): void {
  state.error = error;
}

export function resetDb(): void {
  state.results = [];
  state.queries = [];
  state.error = null;
}

export function recordedQueries(kind?: QueryKind): RecordedQuery[] {
  return kind ? state.queries.filter((query) => query.kind === kind) : [...state.queries];
}

function createQuery(kind: QueryKind, initial: Partial<RecordedQuery>) {
  const record: RecordedQuery = { kind, ...initial };
  state.queries.push(record);

  const query = {
    from(table: unknown) {
      record.table = table;
      return query;
    },
    where(condition: unknown) {
      record.where = condition;
      return query;
    },
    limit(count: number) {
      record.limit = count;
      return query;
    },
    values(values: Record<string, unknown>) {
      record.values = values;
      return query;
    },
    set(values: Record<string, unknown>) {
      record.set = values;
      return query;
    },
    onConflictDoUpdate(config: Record<string, unknown>) {
      record.conflict = config;
      return query;
    },
    returning(fields?: unknown) {
      record.returning = fields ?? true;
      return query;
    },
    then<TResult1 = unknown[], TResult2 = never>(
      onFulfilled?: ((value: unknown[]) => TResult1 | PromiseLike<TResult1>) | null,
      onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
    ) {
      const outcome = state.error
        ? Promise.reject(state.error)
        : Promise.resolve(state.results.shift() ?? []);
      return outcome.then(onFulfilled, onRejected);
    },
  };

  return query;
}

export const db = {
  select: (fields?: unknown) => createQuery('select', { fields }),
  insert: (table: unknown) => createQuery('insert', { table }),
  update: (table: unknown) => createQuery('update', { table }),
  delete: (table: unknown) => createQuery('delete', { table }),
};

// Tables are plain objects whose "columns" are readable strings, so conditions can be asserted
export const agentConnection = {
  id: 'agent_connection.id',
  userId: 'agent_connection.user_id',
  machineId: 'agent_connection.machine_id',
};

export const pushSubscription = {
  id: 'push_subscription.id',
  userId: 'push_subscription.user_id',
  endpoint: 'push_subscription.endpoint',
};

export const dbModule = { db, agentConnection, pushSubscription };

/** drizzle-orm operators replaced by plain descriptors that `toEqual` can compare. */
export const operators = {
  eq: (column: unknown, value: unknown) => ({ op: 'eq', column, value }),
  ne: (column: unknown, value: unknown) => ({ op: 'ne', column, value }),
  and: (...conditions: unknown[]) => ({ op: 'and', conditions }),
};

export function jsonRequest(url: string, method: string, body?: unknown): Request {
  return new Request(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
}
