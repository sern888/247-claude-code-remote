import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, waitFor } from '@testing-library/react';
import { SessionPollingProvider } from '@/contexts/SessionPollingContext';
import { useHomeState } from '@/app/home/useHomeState';

const mocks = vi.hoisted(() => ({
  router: { push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn() },
  search: { value: new URLSearchParams() },
  connectionsState: {
    connections: [
      { id: 'm1', url: 'localhost:4678', name: 'Mac mini', method: 'localhost', createdAt: 1 },
    ],
    loading: false,
    error: null,
    addConnection: vi.fn(),
    removeConnection: vi.fn(),
    updateConnection: vi.fn(),
    refetch: vi.fn(),
  },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => mocks.router,
  usePathname: () => '/',
  useSearchParams: () => mocks.search.value,
}));

vi.mock('@/hooks/useAgentConnections', () => ({
  useAgentConnections: () => mocks.connectionsState,
}));

class IdleWebSocket {
  static instances: IdleWebSocket[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor(public url: string) {
    IdleWebSocket.instances.push(this);
  }
  close() {}
  send() {}

  /** The agent pushes its session list over the sessions socket. */
  reportSessions(sessions: unknown[]) {
    this.onopen?.();
    this.onmessage?.({ data: JSON.stringify({ type: 'sessions-list', sessions }) });
  }
}

type HomeState = ReturnType<typeof useHomeState>;

async function setup(query = '') {
  mocks.search.value = new URLSearchParams(query);
  const snapshots: HomeState[] = [];

  function Harness() {
    snapshots.push(useHomeState());
    return null;
  }

  await act(async () => {
    render(
      <SessionPollingProvider>
        <Harness />
      </SessionPollingProvider>
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  return { current: () => snapshots[snapshots.length - 1] };
}

function lastReplacedUrl(): URLSearchParams {
  const calls = mocks.router.replace.mock.calls;
  return new URLSearchParams(String(calls[calls.length - 1][0]).replace(/^\?/, ''));
}

describe('useHomeState and the URL', () => {
  const originalWebSocket = globalThis.WebSocket;
  const originalFetch = globalThis.fetch;
  let agentSessions: unknown[];

  beforeEach(() => {
    agentSessions = [];
    IdleWebSocket.instances = [];
    // Like the real router: replacing the URL changes what useSearchParams returns
    mocks.router.replace.mockReset().mockImplementation((url: string) => {
      mocks.search.value = new URLSearchParams(url.replace(/^[/?]+/, ''));
    });
    globalThis.WebSocket = IdleWebSocket as unknown as typeof WebSocket;
    globalThis.fetch = vi.fn(async (url: string) => ({
      ok: true,
      json: async () => (url.endsWith('/api/sessions') ? agentSessions : []),
    })) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
    globalThis.fetch = originalFetch;
  });

  it('creates a session from the URL with a name the agent would accept', async () => {
    const home = await setup('session=my.app--custom&machine=m1&create=true&project=my.app');

    const selected = home.current().selectedSession;

    expect(selected?.sessionName).toBe('my_app--custom');
    expect(selected?.project).toBe('my.app');
    expect(selected?.machineId).toBe('m1');
    expect(selected?.viewKey).toBeTruthy();
  });

  it('passes the planning project from the URL to the new session', async () => {
    const home = await setup(
      'session=demo--new&machine=m1&create=true&project=demo&planningProjectId=plan-7'
    );

    expect(home.current().selectedSession?.planningProjectId).toBe('plan-7');
  });

  it('restores an existing session from the URL once the agent reports it', async () => {
    agentSessions = [{ name: 'demo--brave-fox-1', project: 'demo', createdAt: 1 }];

    const home = await setup('session=demo--brave-fox-1&machine=m1');

    await waitFor(() =>
      expect(home.current().selectedSession).toEqual({
        machineId: 'm1',
        sessionName: 'demo--brave-fox-1',
        project: 'demo',
      })
    );
    expect(home.current().getSelectedSessionInfo()?.name).toBe('demo--brave-fox-1');
  });

  it('does not select a session the agent does not know', async () => {
    agentSessions = [{ name: 'demo--other', project: 'demo', createdAt: 1 }];

    const home = await setup('session=demo--missing&machine=m1');

    expect(home.current().allSessions).toHaveLength(1);
    expect(home.current().selectedSession).toBeNull();
  });

  it('writes the selected session to the URL', async () => {
    const home = await setup();

    act(() => home.current().handleSelectSession('m1', 'demo--brave-fox-1', 'demo'));

    expect(lastReplacedUrl().get('session')).toBe('demo--brave-fox-1');
    expect(lastReplacedUrl().get('machine')).toBe('m1');
  });

  it('marks a started session as "create" in the URL and drops the flag once it exists', async () => {
    const home = await setup();

    act(() => home.current().handleStartSession('m1', 'my.app', 'env-1'));

    expect(lastReplacedUrl().get('session')).toBe('my_app--new');
    expect(lastReplacedUrl().get('create')).toBe('true');
    expect(home.current().selectedSession?.environmentId).toBe('env-1');
    expect(home.current().newSessionOpen).toBe(false);

    act(() => home.current().handleSessionCreated('my_app--brave-lion-7'));

    expect(lastReplacedUrl().get('session')).toBe('my_app--brave-lion-7');
    expect(lastReplacedUrl().has('create')).toBe(false);
  });

  it('keeps the started session view when the agent later lists that session', async () => {
    const home = await setup();
    act(() => home.current().handleStartSession('m1', 'demo', 'env-1'));
    act(() => home.current().handleSessionCreated('demo--brave-lion-7'));
    const created = home.current().selectedSession;

    act(() =>
      IdleWebSocket.instances[0].reportSessions([
        { name: 'demo--brave-lion-7', project: 'demo', createdAt: 1 },
      ])
    );

    expect(home.current().allSessions).toHaveLength(1);
    expect(home.current().selectedSession).toBe(created);
    expect(home.current().selectedSession?.viewKey).toBeTruthy();
    expect(home.current().selectedSession?.environmentId).toBe('env-1');
  });

  it('does not let the URL override a session the user selected meanwhile', async () => {
    const home = await setup('session=demo--from-url&machine=m1');
    act(() => home.current().handleSelectSession('m1', 'demo--picked', 'demo'));
    mocks.search.value = new URLSearchParams('session=demo--from-url&machine=m1');

    act(() =>
      IdleWebSocket.instances[0].reportSessions([
        { name: 'demo--from-url', project: 'demo', createdAt: 1 },
        { name: 'demo--picked', project: 'demo', createdAt: 2 },
      ])
    );

    expect(home.current().selectedSession?.sessionName).toBe('demo--picked');
  });

  it('removes the session from the URL when it is cleared', async () => {
    const home = await setup('session=demo--a&machine=m1&tab=x');

    act(() => home.current().clearSessionFromUrl());

    expect(mocks.router.replace).toHaveBeenLastCalledWith('?tab=x', { scroll: false });
  });
});
