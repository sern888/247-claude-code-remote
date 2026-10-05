import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, createEvent, act } from '@testing-library/react';
import { AgentConnectionSettings, buildPairingUrl } from '@/components/AgentConnectionSettings';

function renderSettings(onOpenChange = vi.fn()) {
  render(<AgentConnectionSettings open onOpenChange={onOpenChange} />);
  return onOpenChange;
}

describe('buildPairingUrl', () => {
  it('builds the pairing URL for a numeric code', () => {
    expect(buildPairingUrl('123456')).toBe('/connect?code=123456');
  });

  it('encodes characters that would change the query string', () => {
    expect(buildPairingUrl('12&x=1#y z')).toBe('/connect?code=12%26x%3D1%23y%20z');
  });
});

describe('AgentConnectionSettings accessibility', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('is a modal dialog with an accessible title', () => {
    renderSettings();

    const dialog = screen.getByRole('dialog', { name: 'Connect Agent' });

    expect(dialog.getAttribute('aria-modal')).toBe('true');
  });

  it('names the close button', () => {
    const onOpenChange = renderSettings();

    fireEvent.click(screen.getByRole('button', { name: 'Close connection settings' }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('closes on Escape and consumes the key', () => {
    const onOpenChange = renderSettings();
    const escape = createEvent.keyDown(document.body, { key: 'Escape' });

    fireEvent(document.body, escape);

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(escape.defaultPrevented).toBe(true);
  });

  it('labels the pairing code input and keeps digits only', () => {
    renderSettings();
    const input = screen.getByLabelText('Pairing code') as HTMLInputElement;

    fireEvent.change(input, { target: { value: '12a3&4' } });

    expect(input.value).toBe('1234');
  });

  it('associates the port label with its input and names the back button', async () => {
    renderSettings();

    fireEvent.click(screen.getByRole('button', { name: /Same Computer/ }));

    const port = (await screen.findByLabelText('Agent Port')) as HTMLInputElement;
    expect(port.tagName).toBe('INPUT');
    expect(port.value).toBe('4678');
    expect(screen.getByRole('group', { name: 'Quick select' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Back to connection type' })).toBeTruthy();
  });

  it('associates the URL label with its input and names the copy buttons', async () => {
    renderSettings();

    fireEvent.click(screen.getByRole('button', { name: /Remote Access/ }));

    const url = (await screen.findByLabelText('Agent URL')) as HTMLInputElement;
    expect(url.tagName).toBe('INPUT');
    fireEvent.click(screen.getByRole('button', { name: /Setup Tailscale Funnel/ }));
    expect(
      await screen.findByRole('button', { name: 'Copy command: brew install tailscale' })
    ).toBeTruthy();
  });
});

describe('AgentConnectionSettings connection flow', () => {
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
    window.localStorage.clear();
    TestSocket.instances = [];
    globalThis.WebSocket = TestSocket as unknown as typeof WebSocket;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    globalThis.WebSocket = originalWebSocket;
  });

  it('opens the pairing page only for a complete code', () => {
    const location = { href: 'http://localhost/' };
    vi.stubGlobal('location', location);
    renderSettings();
    const input = screen.getByLabelText('Pairing code');

    fireEvent.change(input, { target: { value: '123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Pair' }));
    expect(location.href).toBe('http://localhost/');

    fireEvent.change(input, { target: { value: '123456' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(location.href).toBe('/connect?code=123456');
  });

  it('tests the local connection and reports the result', async () => {
    renderSettings();
    fireEvent.click(screen.getByRole('button', { name: /Same Computer/ }));
    await screen.findByLabelText('Agent Port');
    fireEvent.click(screen.getByRole('button', { name: '4679' }));

    fireEvent.click(screen.getByRole('button', { name: 'Test Connection' }));
    expect(TestSocket.instances[0].url).toBe(
      'ws://localhost:4679/terminal?project=test&session=test-connection'
    );
    act(() => TestSocket.instances[0].onopen?.());
    expect(await screen.findByText('Connection successful!')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Test Connection' }));
    act(() => TestSocket.instances[1].onerror?.());
    expect(await screen.findByText('Could not connect. Is the agent running?')).toBeTruthy();
  });

  it('saves a remote connection without its protocol prefix', async () => {
    const onSave = vi.fn();
    const onOpenChange = vi.fn();
    render(<AgentConnectionSettings open onOpenChange={onOpenChange} onSave={onSave} />);
    fireEvent.click(screen.getByRole('button', { name: /Remote Access/ }));
    const url = await screen.findByLabelText('Agent URL');
    fireEvent.click(screen.getByRole('button', { name: 'Custom URL' }));
    fireEvent.change(url, { target: { value: 'wss://box.example.com:4678' } });

    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    act(() => {
      vi.advanceTimersByTime(1500);
    });

    expect(onSave).toHaveBeenCalledWith({
      url: 'box.example.com:4678',
      name: 'Custom URL',
      method: 'custom',
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('opens on the stored connection and can disconnect it', async () => {
    window.localStorage.setItem(
      'agentConnections',
      JSON.stringify([
        {
          id: 'c1',
          url: 'localhost:4680',
          name: 'Same Computer',
          method: 'localhost',
          createdAt: 1,
        },
      ])
    );
    const onDisconnect = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <AgentConnectionSettings
        open
        onOpenChange={onOpenChange}
        onDisconnect={onDisconnect}
        hasConnection
      />
    );

    const port = (await screen.findByLabelText('Agent Port')) as HTMLInputElement;
    expect(port.value).toBe('4680');
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect Current Agent' }));

    expect(onDisconnect).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
