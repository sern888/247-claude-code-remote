import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { StrictMode, useState } from 'react';
import {
  SessionPollingProvider,
  useSessionPolling,
  type Machine,
} from '@/contexts/SessionPollingContext';

const RECONNECT_WINDOW_MS = 120_000;
const POLL_INTERVAL_MS = 30_000;

interface CloseEventLike {
  code: number;
  reason: string;
}

/**
 * Controllable WebSocket double. Like a browser socket, close() reports the
 * close asynchronously, after a replacement socket may already exist.
 */
class MockWebSocket {
  static instances: MockWebSocket[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: CloseEventLike) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  closed = false;

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    setTimeout(() => this.onclose?.({ code: 1000, reason: '' }), 0);
  }

  send() {}

  open() {
    this.onopen?.();
  }

  message(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  drop() {
    this.closed = true;
    this.onclose?.({ code: 1006, reason: '' });
  }
}

function machine(id: string, agentUrl: string, name = `Agent ${id}`): Machine {
  return { id, name, status: 'online', config: { projects: [], agentUrl } };
}

function session(name: string, status = 'working') {
  return {
    name,
    project: 'demo',
    createdAt: Date.now(),
    status,
    lastStatusChange: Date.now(),
  };
}

function socketsFor(host: string): MockWebSocket[] {
  return MockWebSocket.instances.filter((ws) => ws.url.includes(host));
}

type Polling = ReturnType<typeof useSessionPolling>;

function setup(options: { strict?: boolean } = {}) {
  const snapshots: Polling[] = [];
  let forceRender: () => void = () => {};

  function Capture() {
    snapshots.push(useSessionPolling());
    return null;
  }

  function Host() {
    const [, setTick] = useState(0);
    forceRender = () => setTick((tick) => tick + 1);
    return (
      <SessionPollingProvider>
        <Capture />
      </SessionPollingProvider>
    );
  }

  const tree = options.strict ? (
    <StrictMode>
      <Host />
    </StrictMode>
  ) : (
    <Host />
  );
  const utils = render(tree);

  return {
    ...utils,
    current: () => snapshots[snapshots.length - 1],
    rerenderHost: () => act(() => forceRender()),
  };
}

async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('SessionPollingProvider connection management', () => {
  const originalWebSocket = globalThis.WebSocket;
  const originalFetch = globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;
  /** Sessions the agents report over HTTP, keyed by host. */
  let httpSessions: Record<string, ReturnType<typeof session>[]>;

  beforeEach(() => {
    vi.useFakeTimers();
    MockWebSocket.instances = [];
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
    httpSessions = {};
    fetchMock = vi.fn(async (url: string) => {
      const host = Object.keys(httpSessions).find((candidate) => url.includes(candidate));
      const isArchive = url.endsWith('/archived');
      return { ok: true, json: async () => (host && !isArchive ? httpSessions[host] : []) };
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.WebSocket = originalWebSocket;
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('does not ask for notification permission on mount', async () => {
    const requestPermission = vi.spyOn(window.Notification, 'requestPermission');

    setup();
    await flush();

    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('keeps the existing socket when another machine is added', async () => {
    const view = setup();
    await act(async () => view.current().setMachines([machine('m1', 'host-a:4678')]));
    await flush();
    await act(async () => socketsFor('host-a')[0].open());

    await act(async () =>
      view.current().setMachines([machine('m1', 'host-a:4678'), machine('m2', 'host-b:4678')])
    );
    await flush(RECONNECT_WINDOW_MS);

    expect(socketsFor('host-a')).toHaveLength(1);
    expect(socketsFor('host-a')[0].closed).toBe(false);
    expect(socketsFor('host-b')).toHaveLength(1);
  });

  it('ignores a replaced socket: no stale reconnect and no stale messages', async () => {
    const view = setup();
    await act(async () => view.current().setMachines([machine('m1', 'host-a:4678')]));
    await flush();
    const oldSocket = socketsFor('host-a')[0];
    await act(async () => oldSocket.open());

    await act(async () => view.current().setMachines([machine('m1', 'host-b:4678')]));
    await flush();
    const newSocket = socketsFor('host-b')[0];
    httpSessions['host-b'] = [session('fresh')];
    await act(async () => {
      newSocket.open();
      newSocket.message({ type: 'sessions-list', sessions: [session('fresh')] });
      oldSocket.message({ type: 'sessions-list', sessions: [session('stale')] });
    });
    await flush(RECONNECT_WINDOW_MS);

    expect(oldSocket.closed).toBe(true);
    expect(socketsFor('host-a')).toHaveLength(1);
    expect(socketsFor('host-b')).toHaveLength(1);
    expect(newSocket.closed).toBe(false);
    expect(
      view
        .current()
        .getAllSessions()
        .map((s) => s.name)
    ).toEqual(['fresh']);
    expect(view.current().isWsConnected('m1')).toBe(true);
  });

  it('closes the socket and prunes sessions of a removed machine', async () => {
    const view = setup();
    await act(async () =>
      view.current().setMachines([machine('m1', 'host-a:4678'), machine('m2', 'host-b:4678')])
    );
    await flush();
    httpSessions['host-a'] = [session('keep')];
    httpSessions['host-b'] = [session('ghost')];
    await act(async () => {
      await act(async () => socketsFor('host-a')[0].open());
      socketsFor('host-b')[0].open();
      socketsFor('host-a')[0].message({ type: 'sessions-list', sessions: [session('keep')] });
      socketsFor('host-b')[0].message({ type: 'sessions-list', sessions: [session('ghost')] });
    });

    await act(async () => view.current().setMachines([machine('m1', 'host-a:4678')]));
    await flush(RECONNECT_WINDOW_MS);

    expect(socketsFor('host-b')).toHaveLength(1);
    expect(socketsFor('host-b')[0].closed).toBe(true);
    expect(view.current().sessionsByMachine.has('m2')).toBe(false);
    expect(
      view
        .current()
        .getAllSessions()
        .map((s) => s.name)
    ).toEqual(['keep']);
  });

  it('reconnects with backoff after an unexpected close, using the current machine list', async () => {
    const view = setup();
    await act(async () => view.current().setMachines([machine('m1', 'host-a:4678')]));
    await flush();
    await act(async () => socketsFor('host-a')[0].open());

    await act(async () => socketsFor('host-a')[0].drop());
    expect(view.current().isWsConnected('m1')).toBe(false);
    await flush(RECONNECT_WINDOW_MS);

    expect(socketsFor('host-a').length).toBeGreaterThanOrEqual(2);
    expect(socketsFor('host-a').filter((ws) => !ws.closed)).toHaveLength(1);
  });

  it('closes every socket and stops reconnecting on unmount', async () => {
    const view = setup();
    await act(async () => view.current().setMachines([machine('m1', 'host-a:4678')]));
    await flush();
    await act(async () => socketsFor('host-a')[0].open());

    view.unmount();
    await vi.advanceTimersByTimeAsync(RECONNECT_WINDOW_MS);

    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.instances[0].closed).toBe(true);
  });

  it('fires onNeedsAttention exactly once per transition, also in Strict Mode', async () => {
    const onNeedsAttention = vi.fn();
    const view = setup({ strict: true });
    await act(async () => {
      view.current().setOnNeedsAttention(onNeedsAttention);
      view.current().setMachines([machine('m1', 'host-a:4678')]);
    });
    await flush();
    const socket = socketsFor('host-a').filter((ws) => !ws.closed)[0];
    await act(async () => {
      socket.open();
      socket.message({ type: 'sessions-list', sessions: [session('alpha', 'working')] });
    });

    await act(async () => {
      socket.message({ type: 'status-update', session: session('alpha', 'needs_attention') });
      socket.message({ type: 'status-update', session: session('alpha', 'needs_attention') });
    });

    expect(onNeedsAttention).toHaveBeenCalledTimes(1);
    expect(onNeedsAttention).toHaveBeenCalledWith('alpha');
    expect(view.current().getSession('m1', 'alpha')?.status).toBe('needs_attention');

    await act(async () => {
      socket.message({ type: 'status-update', session: session('alpha', 'working') });
      socket.message({ type: 'status-update', session: session('alpha', 'needs_attention') });
    });

    expect(onNeedsAttention).toHaveBeenCalledTimes(2);
  });

  it('keeps live sessions when the HTTP poll fails but the WebSocket is healthy', async () => {
    const view = setup();
    await act(async () => view.current().setMachines([machine('m1', 'host-a:4678')]));
    await flush();
    await act(async () => {
      await act(async () => socketsFor('host-a')[0].open());
      socketsFor('host-a')[0].message({ type: 'sessions-list', sessions: [session('alive')] });
    });

    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await flush(POLL_INTERVAL_MS + 1000);

    expect(
      view
        .current()
        .getAllSessions()
        .map((s) => s.name)
    ).toEqual(['alive']);
    expect(view.current().getError('m1')).toBeNull();
    expect(view.current().isWsConnected('m1')).toBe(true);
  });

  it('reports the machine as unreachable when the poll fails and no WebSocket is connected', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const view = setup();

    await act(async () => view.current().setMachines([machine('m1', 'host-a:4678')]));
    await flush();

    expect(view.current().getError('m1')).toBe('Could not connect to agent');
    expect(view.current().getAllSessions()).toEqual([]);
  });

  it('removes a session when the agent reports it gone', async () => {
    const view = setup();
    await act(async () => view.current().setMachines([machine('m1', 'host-a:4678')]));
    await flush();
    await act(async () => {
      socketsFor('host-a')[0].open();
      socketsFor('host-a')[0].message({
        type: 'sessions-list',
        sessions: [session('alpha'), session('beta')],
      });
      socketsFor('host-a')[0].message({ type: 'session-removed', sessionName: 'alpha' });
    });

    expect(
      view
        .current()
        .getSessionsForMachine('m1')
        .map((s) => s.name)
    ).toEqual(['beta']);
    expect(view.current().getSession('m1', 'alpha')).toBeNull();
    expect(view.current().getSessionsForMachine('unknown')).toEqual([]);
  });

  it('moves an archived session to the archive exactly once', async () => {
    const view = setup();
    await act(async () => view.current().setMachines([machine('m1', 'host-a:4678')]));
    await flush();
    const archived = session('alpha', 'idle');
    await act(async () => {
      socketsFor('host-a')[0].open();
      socketsFor('host-a')[0].message({
        type: 'sessions-list',
        sessions: [session('alpha'), session('beta')],
      });
      socketsFor('host-a')[0].message({
        type: 'session-archived',
        sessionName: 'alpha',
        session: archived,
      });
      socketsFor('host-a')[0].message({
        type: 'session-archived',
        sessionName: 'alpha',
        session: archived,
      });
    });

    expect(
      view
        .current()
        .getAllSessions()
        .map((s) => s.name)
    ).toEqual(['beta']);
    const archive = view.current().getArchivedSessions();
    expect(archive.map((s) => s.name)).toEqual(['alpha']);
    expect(archive[0].machineId).toBe('m1');
    expect(archive[0].machineName).toBe('Agent m1');
  });

  it('loads the archive of a machine and forgets it when the machine is removed', async () => {
    fetchMock.mockImplementation(async (url: string) => ({
      ok: true,
      json: async () => (url.endsWith('/archived') ? [session('old-one', 'idle')] : []),
    }));
    const view = setup();

    await act(async () => view.current().setMachines([machine('m1', 'host-a:4678')]));
    await flush();
    expect(
      view
        .current()
        .getArchivedSessions()
        .map((s) => s.name)
    ).toEqual(['old-one']);

    await act(async () => view.current().setMachines([]));
    await flush();
    expect(view.current().getArchivedSessions()).toEqual([]);
  });

  it('ignores malformed messages and keeps the session list', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const view = setup();
    await act(async () => view.current().setMachines([machine('m1', 'host-a:4678')]));
    await flush();
    await act(async () => {
      socketsFor('host-a')[0].open();
      socketsFor('host-a')[0].message({ type: 'sessions-list', sessions: [session('alpha')] });
      socketsFor('host-a')[0].onmessage?.({ data: 'not json' });
      socketsFor('host-a')[0].onmessage?.({ data: '42' });
      socketsFor('host-a')[0].message({ type: 'version-info', agentVersion: '1.2.3' });
      socketsFor('host-a')[0].message({
        type: 'status-update',
        session: session('unknown', 'needs_attention'),
      });
    });

    expect(
      view
        .current()
        .getAllSessions()
        .map((s) => s.name)
    ).toEqual(['alpha']);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0][0])).toContain('Failed to parse message');
  });

  it('does not notify for a session it does not know', async () => {
    const onNeedsAttention = vi.fn();
    const view = setup();
    await act(async () => {
      view.current().setOnNeedsAttention(onNeedsAttention);
      view.current().setMachines([machine('m1', 'host-a:4678')]);
    });
    await flush();
    await act(async () => {
      socketsFor('host-a')[0].open();
      socketsFor('host-a')[0].message({
        type: 'status-update',
        session: session('ghost', 'needs_attention'),
      });
    });

    expect(onNeedsAttention).not.toHaveBeenCalled();
  });

  it('refreshes a single machine over HTTP and reports loading meanwhile', async () => {
    const view = setup();
    await act(async () => view.current().setMachines([machine('m1', 'host-a:4678')]));
    await flush();
    let respond: (value: unknown) => void = () => {};
    fetchMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          respond = resolve;
        })
    );

    let refresh: Promise<void> = Promise.resolve();
    await act(async () => {
      refresh = view.current().refreshMachine('m1');
    });
    expect(view.current().isLoading('m1')).toBe(true);

    await act(async () => {
      respond({ ok: true, json: async () => [session('fetched')] });
      await refresh;
    });

    expect(view.current().isLoading('m1')).toBe(false);
    expect(
      view
        .current()
        .getAllSessions()
        .map((s) => s.name)
    ).toEqual(['fetched']);
  });

  it('does not refresh a machine that is not in the list', async () => {
    const view = setup();
    await flush();
    fetchMock.mockClear();

    await act(async () => view.current().refreshMachine('nope'));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports a timed out poll as an unresponsive agent', async () => {
    fetchMock.mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        })
    );
    const view = setup();

    await act(async () => view.current().setMachines([machine('m1', 'host-a:4678')]));
    await flush(6000);

    expect(view.current().getError('m1')).toBe('Agent not responding');
  });

  it('closes the socket of a machine that goes offline and keeps its sessions', async () => {
    const view = setup();
    await act(async () => view.current().setMachines([machine('m1', 'host-a:4678')]));
    await flush();
    await act(async () => {
      socketsFor('host-a')[0].open();
      socketsFor('host-a')[0].message({ type: 'sessions-list', sessions: [session('alpha')] });
    });

    await act(async () =>
      view.current().setMachines([{ ...machine('m1', 'host-a:4678'), status: 'offline' }])
    );
    await flush(RECONNECT_WINDOW_MS);

    expect(socketsFor('host-a')).toHaveLength(1);
    expect(socketsFor('host-a')[0].closed).toBe(true);
    expect(view.current().isWsConnected('m1')).toBe(false);
    expect(view.current().getAllSessions()).toHaveLength(1);
  });

  it('returns a stable context value and session array across unrelated re-renders', async () => {
    const view = setup();
    await act(async () => view.current().setMachines([machine('m1', 'host-a:4678')]));
    await flush();
    await act(async () => {
      await act(async () => socketsFor('host-a')[0].open());
      socketsFor('host-a')[0].message({ type: 'sessions-list', sessions: [session('alpha')] });
    });
    const before = view.current();
    const sessionsBefore = before.getAllSessions();

    await view.rerenderHost();

    expect(view.current()).toBe(before);
    expect(view.current().getAllSessions()).toBe(sessionsBefore);
    expect(before.getAllSessions()).toBe(sessionsBefore);
  });
});
