import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, fireEvent, screen } from '@testing-library/react';
import { useState } from 'react';
import { SessionPollingProvider } from '@/contexts/SessionPollingContext';
import { useHomeState, getSessionViewKey } from '@/app/home/useHomeState';
import { NewSessionModal } from '@/components/NewSessionModal';
import { SearchBar } from '@/components/Terminal/SearchBar';

const mocks = vi.hoisted(() => ({
  connectionsState: {
    connections: [
      { id: 'm1', url: 'localhost:4678', name: 'Mac mini', method: 'localhost', createdAt: 1 },
      { id: 'm2', url: 'studio.tailnet.ts.net', name: 'Studio', method: 'tailscale', createdAt: 2 },
    ],
    loading: false,
    error: null,
    addConnection: vi.fn(),
    removeConnection: vi.fn(),
    updateConnection: vi.fn(),
    refetch: vi.fn(),
  },
}));

vi.mock('@/hooks/useAgentConnections', () => ({
  useAgentConnections: () => mocks.connectionsState,
}));

class IdleWebSocket {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  constructor(public url: string) {}
  close() {}
  send() {}
}

type HomeState = ReturnType<typeof useHomeState>;

async function setup() {
  const snapshots: HomeState[] = [];
  let showSearch: (visible: boolean) => void = () => {};
  const onCloseSearch = vi.fn();

  function Harness() {
    const state = useHomeState();
    const [searchVisible, setSearchVisible] = useState(false);
    snapshots.push(state);
    showSearch = setSearchVisible;

    return (
      <>
        <NewSessionModal
          open={state.newSessionOpen}
          onOpenChange={state.setNewSessionOpen}
          machines={state.machines}
          onStartSession={state.handleStartSession}
        />
        <SearchBar
          visible={searchVisible}
          query=""
          onQueryChange={() => {}}
          onFindNext={() => {}}
          onFindPrevious={() => {}}
          onClose={() => {
            onCloseSearch();
            setSearchVisible(false);
          }}
        />
      </>
    );
  }

  // Let the provider's initial polls settle inside act()
  await act(async () => {
    render(
      <SessionPollingProvider>
        <Harness />
      </SessionPollingProvider>
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  const current = () => snapshots[snapshots.length - 1];
  return {
    current,
    renderCount: () => snapshots.length,
    onCloseSearch,
    showSearch: (visible: boolean) => act(() => showSearch(visible)),
    select: (name = 'demo--brave-fox-1') =>
      act(() => current().handleSelectSession('m1', name, 'demo')),
  };
}

function pressEscape(target: Element | Window = document.body) {
  fireEvent.keyDown(target, { key: 'Escape' });
}

describe('useHomeState', () => {
  const originalWebSocket = globalThis.WebSocket;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.WebSocket = IdleWebSocket as unknown as typeof WebSocket;
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => [] });
    mocks.connectionsState.addConnection.mockReset().mockResolvedValue(undefined);
    mocks.connectionsState.removeConnection.mockReset().mockResolvedValue(undefined);
    mocks.connectionsState.updateConnection.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
    globalThis.fetch = originalFetch;
    document.body.querySelectorAll('[data-test-overlay]').forEach((node) => node.remove());
    vi.restoreAllMocks();
  });

  describe('Escape key', () => {
    it('leaves the selected session when nothing else is open', async () => {
      const home = await setup();
      home.select();
      expect(home.current().selectedSession).not.toBeNull();

      act(() => pressEscape());

      expect(home.current().selectedSession).toBeNull();
    });

    it('ignores an Escape that another handler already consumed', async () => {
      const home = await setup();
      home.select();
      const consume = (event: KeyboardEvent) => event.preventDefault();
      document.addEventListener('keydown', consume, true);

      act(() => pressEscape());
      document.removeEventListener('keydown', consume, true);

      expect(home.current().selectedSession).not.toBeNull();
    });

    it.each(['dialog', 'alertdialog', 'search'])(
      'keeps the session while an element with role="%s" is open',
      async (role) => {
        const home = await setup();
        home.select();
        const overlay = document.createElement('div');
        overlay.setAttribute('role', role);
        overlay.setAttribute('data-test-overlay', '');
        document.body.appendChild(overlay);

        act(() => pressEscape());

        expect(home.current().selectedSession).not.toBeNull();
      }
    );

    it('closes the New Session modal and keeps the session selected', async () => {
      const home = await setup();
      home.select();
      act(() => home.current().setNewSessionOpen(true));
      expect(screen.getByRole('dialog')).toBeTruthy();

      act(() => pressEscape());

      expect(home.current().newSessionOpen).toBe(false);
      expect(home.current().selectedSession).not.toBeNull();
    });

    it('closes the terminal search bar and keeps the session selected', async () => {
      const home = await setup();
      home.select();
      home.showSearch(true);

      act(() => pressEscape(screen.getByLabelText('Search in terminal')));

      expect(home.onCloseSearch).toHaveBeenCalledTimes(1);
      expect(home.current().selectedSession).not.toBeNull();
    });
  });

  describe('other shortcuts', () => {
    it('opens the New Session modal with Cmd+K', async () => {
      const home = await setup();

      act(() => {
        fireEvent.keyDown(window, { key: 'k', metaKey: true });
      });

      expect(home.current().newSessionOpen).toBe(true);
    });

    it('toggles fullscreen with Ctrl+F and keeps the session on Escape while fullscreen', async () => {
      const home = await setup();
      home.select();

      act(() => {
        fireEvent.keyDown(window, { key: 'f', ctrlKey: true });
      });
      act(() => pressEscape());

      expect(home.current().isFullscreen).toBe(true);
      expect(home.current().selectedSession).not.toBeNull();
    });
  });

  describe('session lifecycle', () => {
    it.each(['handleSessionKilled', 'handleSessionArchived'] as const)(
      '%s clears the selection only for the selected session',
      async (handler) => {
        const home = await setup();
        home.select('demo--brave-fox-1');

        act(() => home.current()[handler]('m1', 'demo--another'));
        expect(home.current().selectedSession).not.toBeNull();

        act(() => home.current()[handler]('m1', 'demo--brave-fox-1'));
        expect(home.current().selectedSession).toBeNull();
      }
    );

    it('resolves the agent URL and session info of the selection', async () => {
      const home = await setup();
      expect(home.current().getAgentUrl()).toBe('');
      expect(home.current().getSelectedSessionInfo()).toBeUndefined();

      act(() => home.current().handleSelectSession('m2', 'demo--a', 'demo'));

      expect(home.current().getAgentUrl()).toBe('studio.tailnet.ts.net');
      expect(home.current().getSelectedSessionInfo()).toBeUndefined();
    });
  });

  describe('connections', () => {
    it('exposes one machine per connection and the first one as the legacy connection', async () => {
      const home = await setup();

      expect(home.current().machines.map((m) => m.id)).toEqual(['m1', 'm2']);
      expect(home.current().currentMachine?.id).toBe('m1');
      expect(home.current().agentConnection?.url).toBe('localhost:4678');
    });

    it('saves a new connection with a default name', async () => {
      const home = await setup();

      await act(async () =>
        home.current().handleConnectionSaved({ url: 'host:4678', method: 'custom' })
      );

      expect(mocks.connectionsState.addConnection).toHaveBeenCalledWith({
        url: 'host:4678',
        name: 'Agent',
        method: 'custom',
      });
    });

    it('clears the selection when its machine is removed', async () => {
      const home = await setup();
      home.select();

      await act(async () => home.current().handleConnectionRemoved('m1'));

      expect(mocks.connectionsState.removeConnection).toHaveBeenCalledWith('m1');
      expect(home.current().selectedSession).toBeNull();
    });

    it('keeps the selection when another machine is removed', async () => {
      const home = await setup();
      home.select();

      await act(async () => home.current().handleConnectionRemoved('m2'));

      expect(home.current().selectedSession).not.toBeNull();
    });

    it('removes every connection when cleared', async () => {
      const home = await setup();
      home.select();

      await act(async () => home.current().handleConnectionCleared());

      expect(mocks.connectionsState.removeConnection.mock.calls).toEqual([['m1'], ['m2']]);
      expect(home.current().selectedSession).toBeNull();
    });

    it('rethrows when editing a connection fails', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      mocks.connectionsState.updateConnection.mockRejectedValue(new Error('nope'));
      const home = await setup();

      await expect(home.current().handleConnectionEdited('m1', { name: 'New' })).rejects.toThrow(
        'nope'
      );
      expect(mocks.connectionsState.updateConnection).toHaveBeenCalledWith('m1', { name: 'New' });
    });
  });

  describe('starting a session', () => {
    it('uses a placeholder name the agent would accept', async () => {
      const home = await setup();

      act(() => home.current().handleStartSession('m1', 'my.app v2'));

      expect(home.current().selectedSession?.sessionName).toBe('my_app_v2--new');
      expect(home.current().selectedSession?.project).toBe('my.app v2');
    });

    it('keeps the view key when the session receives its real name', async () => {
      const home = await setup();
      act(() => home.current().handleStartSession('m1', 'demo'));
      const started = home.current().selectedSession;
      if (!started) throw new Error('expected a selected session');
      const keyBefore = getSessionViewKey(started);

      act(() => home.current().handleSessionCreated('demo--brave-lion-7'));

      const renamed = home.current().selectedSession;
      if (!renamed) throw new Error('expected a selected session');
      expect(renamed.sessionName).toBe('demo--brave-lion-7');
      expect(getSessionViewKey(renamed)).toBe(keyBefore);
    });

    it('gives every started session its own view key', async () => {
      const home = await setup();
      act(() => home.current().handleStartSession('m1', 'demo'));
      const first = home.current().selectedSession;
      act(() => home.current().handleStartSession('m1', 'demo'));
      const second = home.current().selectedSession;
      if (!first || !second) throw new Error('expected a selected session');

      expect(getSessionViewKey(second)).not.toBe(getSessionViewKey(first));
    });

    it('keeps the view when the already open session is selected again', async () => {
      const home = await setup();
      act(() => home.current().handleStartSession('m1', 'demo'));
      act(() => home.current().handleSessionCreated('demo--brave-lion-7'));
      const before = home.current().selectedSession;

      act(() => home.current().handleSelectSession('m1', 'demo--brave-lion-7', 'demo'));

      expect(home.current().selectedSession).toBe(before);
    });
  });

  describe('getSessionViewKey', () => {
    it('derives the key of an existing session from machine, project and name', () => {
      const key = getSessionViewKey({ machineId: 'm1', project: 'demo', sessionName: 'demo--a' });

      expect(key).toBe('m1-demo-demo--a');
    });

    it('differs between two sessions of the same project', () => {
      const first = getSessionViewKey({ machineId: 'm1', project: 'demo', sessionName: 'demo--a' });
      const second = getSessionViewKey({
        machineId: 'm1',
        project: 'demo',
        sessionName: 'demo--b',
      });

      expect(first).not.toBe(second);
    });
  });

  describe('derived data', () => {
    it('returns the same session and machine arrays when nothing changed', async () => {
      const home = await setup();
      const before = home.current();

      act(() => home.current().setIsFullscreen(true));

      expect(home.current()).not.toBe(before);
      expect(home.current().allSessions).toBe(before.allSessions);
      expect(home.current().machines).toBe(before.machines);
    });
  });
});
