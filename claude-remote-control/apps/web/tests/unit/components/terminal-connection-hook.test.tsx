import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, renderHook, act } from '@testing-library/react';
import { StrictMode, useRef } from 'react';
import { useTerminalConnection } from '@/components/Terminal/hooks/useTerminalConnection';
import { WS_RECONNECT_BASE_DELAY } from '@/components/Terminal/constants';

vi.mock('@xterm/xterm', () => ({
  Terminal: class MockTerminal {
    cols = 80;
    rows = 24;
    element = undefined;
    options = {};
    buffer = { active: { viewportY: 0, baseY: 0, type: 'normal' } };
    loadAddon() {}
    open() {}
    attachCustomKeyEventHandler() {}
    onScroll() {}
    onData() {}
    write() {}
    clear() {}
    scrollToBottom() {}
    dispose() {}
  },
}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }));
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class {} }));
vi.mock('@xterm/addon-canvas', () => ({ CanvasAddon: class {} }));

/** Delay the hook waits before it opens the socket. */
const CONNECT_DELAY_MS = 150;

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];
  readyState = MockWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((err: unknown) => void) | null = null;

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
  }

  send() {}

  close() {
    this.readyState = MockWebSocket.CLOSED;
  }

  open() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  /** The connection is lost without the client asking for it. */
  drop() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }
}

function lastSocket(): MockWebSocket {
  return MockWebSocket.instances[MockWebSocket.instances.length - 1];
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

const onCopySuccess = () => {};

function renderConnection(sessionName: string) {
  const terminalRef = { current: document.createElement('div') };
  return renderHook(
    (props: { sessionName: string }) =>
      useTerminalConnection({
        terminalRef,
        agentUrl: 'localhost:4678',
        project: 'demo',
        sessionName: props.sessionName,
        onCopySuccess,
      }),
    { initialProps: { sessionName } }
  );
}

/** Mounts the hook the way the app does, so Strict Mode replays its effects. */
function TerminalHarness({ sessionName }: { sessionName: string }) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const { connectionState } = useTerminalConnection({
    terminalRef,
    agentUrl: 'localhost:4678',
    project: 'demo',
    sessionName,
    onCopySuccess,
  });
  return <div ref={terminalRef} data-state={connectionState} />;
}

describe('useTerminalConnection auto-reconnect', () => {
  const originalWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    vi.useFakeTimers();
    MockWebSocket.instances = [];
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
    if (!('ResizeObserver' in globalThis)) {
      vi.stubGlobal(
        'ResizeObserver',
        class {
          observe() {}
          disconnect() {}
        }
      );
    }
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    globalThis.WebSocket = originalWebSocket;
  });

  it('reconnects after an unexpected close', async () => {
    const { result } = renderConnection('demo--a');
    await advance(CONNECT_DELAY_MS);
    await act(async () => lastSocket().open());

    await act(async () => lastSocket().drop());
    await advance(WS_RECONNECT_BASE_DELAY);

    expect(MockWebSocket.instances).toHaveLength(2);
    expect(result.current.connectionState).toBe('reconnecting');
  });

  it('still reconnects after the effect was re-run for another session', async () => {
    const { rerender } = renderConnection('demo--a');
    await advance(CONNECT_DELAY_MS);
    await act(async () => lastSocket().open());

    rerender({ sessionName: 'demo--b' });
    await advance(CONNECT_DELAY_MS);
    expect(MockWebSocket.instances).toHaveLength(2);
    expect(lastSocket().url).toContain('session=demo--b');
    await act(async () => lastSocket().open());

    await act(async () => lastSocket().drop());
    await advance(WS_RECONNECT_BASE_DELAY);

    expect(MockWebSocket.instances).toHaveLength(3);
    expect(lastSocket().url).toContain('session=demo--b');
  });

  it('still reconnects after the Strict Mode mount/unmount/mount cycle', async () => {
    render(
      <StrictMode>
        <TerminalHarness sessionName="demo--a" />
      </StrictMode>
    );
    await advance(CONNECT_DELAY_MS);
    expect(MockWebSocket.instances).toHaveLength(1);
    await act(async () => lastSocket().open());

    await act(async () => lastSocket().drop());
    await advance(WS_RECONNECT_BASE_DELAY);

    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it('does not reconnect after unmount', async () => {
    const { unmount } = renderConnection('demo--a');
    await advance(CONNECT_DELAY_MS);
    await act(async () => lastSocket().open());
    const socket = lastSocket();

    unmount();
    socket.drop();
    await vi.advanceTimersByTimeAsync(WS_RECONNECT_BASE_DELAY * 4);

    expect(MockWebSocket.instances).toHaveLength(1);
  });
});
