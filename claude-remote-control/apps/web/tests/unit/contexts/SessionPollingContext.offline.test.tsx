import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor, act } from '@testing-library/react';
import { useEffect } from 'react';
import { SessionPollingProvider, useSessionPolling } from '@/contexts/SessionPollingContext';

vi.mock('@/lib/notifications', () => ({
  requestNotificationPermission: vi.fn(),
}));

class FailingWebSocket {
  static instances: FailingWebSocket[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onmessage: (() => void) | null = null;
  constructor(public url: string) {
    FailingWebSocket.instances.push(this);
    setTimeout(() => {
      this.onerror?.();
      this.onclose?.({ code: 1006, reason: '' });
    }, 0);
  }
  close() {}
  send() {}
}

function SetMachine() {
  const { setMachines } = useSessionPolling();
  useEffect(() => {
    setMachines([
      {
        id: 'm1',
        name: 'Offline Agent',
        status: 'online',
        config: { projects: [], agentUrl: 'localhost:4678' },
      },
    ]);
  }, [setMachines]);
  return null;
}

describe('SessionPollingProvider with an unreachable agent', () => {
  const originalWebSocket = globalThis.WebSocket;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    FailingWebSocket.instances = [];
    globalThis.WebSocket = FailingWebSocket as unknown as typeof WebSocket;
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
  });

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('logs offline failures as warnings, never as console errors', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { unmount } = render(
      <SessionPollingProvider>
        <SetMachine />
      </SessionPollingProvider>
    );

    await waitFor(() => {
      const messages = warnSpy.mock.calls.map((c) => String(c[0]));
      expect(messages.some((m) => m.includes('[Archived]'))).toBe(true);
      expect(messages.some((m) => m.includes('[WS]') && m.includes('will retry'))).toBe(true);
    });

    await act(async () => {
      await Promise.resolve();
    });

    const errorMessages = errorSpy.mock.calls.map((c) => String(c[0]));
    expect(errorMessages.filter((m) => m.includes('[Archived]') || m.includes('[WS]'))).toEqual([]);

    unmount();
  });
});
