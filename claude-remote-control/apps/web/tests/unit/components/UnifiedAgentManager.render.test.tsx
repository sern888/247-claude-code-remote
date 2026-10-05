import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, createEvent, act } from '@testing-library/react';
import { UnifiedAgentManager } from '@/components/UnifiedAgentManager';

const agent = {
  id: 'm1',
  url: 'localhost:4678',
  name: 'Mac mini',
  method: 'localhost' as const,
  createdAt: 1,
};

function renderManager(overrides: Partial<Parameters<typeof UnifiedAgentManager>[0]> = {}) {
  const props = {
    open: true,
    onClose: vi.fn(),
    connectedAgents: [agent],
    agentStatuses: new Map([['m1', 'online' as const]]),
    sessionCounts: new Map([['m1', 2]]),
    onDisconnectAgent: vi.fn(),
    onConnectNewAgent: vi.fn(),
    onEditAgent: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  render(<UnifiedAgentManager {...props} />);
  return props;
}

describe('UnifiedAgentManager accessibility', () => {
  it('is a modal dialog with an accessible title', () => {
    renderManager();

    const dialog = screen.getByRole('dialog', { name: 'Agent Manager' });

    expect(dialog.getAttribute('aria-modal')).toBe('true');
  });

  it('names the close, edit and disconnect buttons', () => {
    const { onClose } = renderManager();

    expect(screen.getByRole('button', { name: 'Edit Mac mini' })).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Cannot disconnect Mac mini: only agent' })
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close agent manager' }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape and consumes the key', () => {
    const { onClose } = renderManager();
    const escape = createEvent.keyDown(document.body, { key: 'Escape' });

    fireEvent(document.body, escape);

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(escape.defaultPrevented).toBe(true);
  });

  it('closes only the edit dialog when Escape is pressed while editing', async () => {
    const { onClose } = renderManager();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Mac mini' }));
    expect(await screen.findByRole('dialog', { name: 'Edit Machine' })).toBeTruthy();

    fireEvent.keyDown(document.body, { key: 'Escape' });

    expect(onClose).not.toHaveBeenCalled();
  });

  it('associates the port label with its input in the add form', async () => {
    renderManager();

    fireEvent.click(screen.getByRole('button', { name: /Same Computer/ }));

    const port = (await screen.findByLabelText('Agent Port')) as HTMLInputElement;
    expect(port.tagName).toBe('INPUT');
    expect(port.value).toBe('4678');
    expect(screen.getByRole('button', { name: 'Back to agent list' })).toBeTruthy();
  });

  it('associates the URL label with its input and names the copy buttons', async () => {
    renderManager();

    fireEvent.click(screen.getByRole('button', { name: /Tailscale Funnel/ }));

    const url = (await screen.findByLabelText('Agent URL')) as HTMLInputElement;
    expect(url.tagName).toBe('INPUT');
    fireEvent.click(screen.getByRole('button', { name: /Setup Tailscale Funnel/ }));
    expect(await screen.findByRole('button', { name: 'Copy command: tailscale up' })).toBeTruthy();
  });
});

describe('UnifiedAgentManager agent management', () => {
  const originalWebSocket = globalThis.WebSocket;

  class TestSocket {
    static instances: TestSocket[] = [];
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    closed = false;
    constructor(public url: string) {
      TestSocket.instances.push(this);
    }
    close() {
      this.closed = true;
    }
  }

  beforeEach(() => {
    TestSocket.instances = [];
    globalThis.WebSocket = TestSocket as unknown as typeof WebSocket;
  });

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
  });

  async function openForm(option: RegExp) {
    const props = renderManager();
    fireEvent.click(screen.getByRole('button', { name: option }));
    await screen.findByRole('button', { name: 'Back to agent list' });
    return props;
  }

  it('shows how many agents are online and their session counts', () => {
    renderManager();

    expect(screen.getByText('1 connected')).toBeTruthy();
    expect(screen.getByText('2 sessions')).toBeTruthy();
  });

  it('disconnects an agent when more than one is connected', () => {
    const second = { ...agent, id: 'm2', name: 'Studio' };
    const { onDisconnectAgent } = renderManager({ connectedAgents: [agent, second] });

    fireEvent.click(screen.getByRole('button', { name: 'Disconnect Studio' }));

    expect(onDisconnectAgent).toHaveBeenCalledWith('m2');
  });

  it('shows the empty state without agents', () => {
    renderManager({ connectedAgents: [] });

    expect(screen.getByText('No agents connected')).toBeTruthy();
  });

  it('connects a local agent on the chosen port', async () => {
    const { onConnectNewAgent } = await openForm(/Same Computer/);

    fireEvent.click(screen.getByRole('button', { name: '4680' }));
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    expect(onConnectNewAgent).toHaveBeenCalledWith({
      url: 'localhost:4680',
      name: 'Same Computer',
      method: 'localhost',
    });
  });

  it('strips the protocol from a custom URL before connecting', async () => {
    const { onConnectNewAgent } = await openForm(/Custom URL/);

    fireEvent.change(screen.getByLabelText('Agent URL'), {
      target: { value: 'https://box.example.com:4678' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    expect(onConnectNewAgent).toHaveBeenCalledWith({
      url: 'box.example.com:4678',
      name: 'Custom URL',
      method: 'custom',
    });
  });

  it('reports a successful and a failed connection test', async () => {
    await openForm(/Same Computer/);

    fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    expect(TestSocket.instances[0].url).toBe(
      'ws://localhost:4678/terminal?project=test&session=test-connection'
    );
    act(() => TestSocket.instances[0].onopen?.());
    expect(await screen.findByText('Connection successful!')).toBeTruthy();
    expect(TestSocket.instances[0].closed).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    act(() => TestSocket.instances[1].onerror?.());
    expect(await screen.findByText('Could not connect. Check your settings.')).toBeTruthy();
  });

  it('goes back to the agent list from the add form', async () => {
    await openForm(/Tailscale Funnel/);

    fireEvent.click(screen.getByRole('button', { name: 'Back to agent list' }));

    expect(await screen.findByText('Connected Agents')).toBeTruthy();
  });
});
