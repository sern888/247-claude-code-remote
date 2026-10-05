import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';

const { push } = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  useSearchParams: () => new URLSearchParams(),
}));

import { useNotificationDeeplink } from '@/hooks/useNotificationDeeplink';

const DEEPLINK_CHECK_DELAY_MS = 500;
const SW_TIMEOUT_MS = 5000;
const never = new Promise<never>(() => {});

type MessageHandler = (event: MessageEvent) => void;

function mockServiceWorker(registration: unknown) {
  const handlers = new Set<MessageHandler>();
  const container = {
    getRegistration: vi.fn().mockResolvedValue(registration),
    ready: never,
    addEventListener: vi.fn((_type: string, handler: MessageHandler) => handlers.add(handler)),
    removeEventListener: vi.fn((_type: string, handler: MessageHandler) =>
      handlers.delete(handler)
    ),
  };
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: container });

  const emit = (data: unknown) => handlers.forEach((handler) => handler({ data } as MessageEvent));
  return { container, handlers, emit };
}

function mockClearAppBadge(result: Promise<void>) {
  const clearAppBadge = vi.fn(() => result);
  Object.defineProperty(navigator, 'clearAppBadge', { configurable: true, value: clearAppBadge });
  return clearAppBadge;
}

describe('useNotificationDeeplink', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    push.mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
  });

  afterEach(() => {
    // Unmount first: the hook's cleanup still needs navigator.serviceWorker
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    Reflect.deleteProperty(navigator, 'serviceWorker');
    Reflect.deleteProperty(navigator, 'clearAppBadge');
  });

  describe('app badge', () => {
    it('registers a single focus listener and removes it on unmount', () => {
      const addSpy = vi.spyOn(window, 'addEventListener');
      const removeSpy = vi.spyOn(window, 'removeEventListener');

      const { unmount } = renderHook(() => useNotificationDeeplink());
      // String(): tsconfig loads both "dom" and "webworker" libs, which narrows the event type
      const focusListeners = addSpy.mock.calls.filter(([type]) => String(type) === 'focus');
      unmount();

      expect(focusListeners).toHaveLength(1);
      expect(removeSpy).toHaveBeenCalledWith('focus', focusListeners[0][1]);
    });

    it('clears the badge once per focus event', () => {
      const clearAppBadge = mockClearAppBadge(Promise.resolve());
      renderHook(() => useNotificationDeeplink());

      act(() => {
        window.dispatchEvent(new Event('focus'));
      });

      expect(clearAppBadge).toHaveBeenCalledTimes(1);
    });

    it('clears the badge on mount when the window is already focused', () => {
      vi.mocked(document.hasFocus).mockReturnValue(true);
      const clearAppBadge = mockClearAppBadge(Promise.resolve());

      renderHook(() => useNotificationDeeplink());

      expect(clearAppBadge).toHaveBeenCalledTimes(1);
    });

    it('handles a rejected clearAppBadge() promise', async () => {
      const rejected = Promise.reject(new Error('NotAllowedError'));
      const catchSpy = vi.spyOn(rejected, 'catch');
      mockClearAppBadge(rejected);
      renderHook(() => useNotificationDeeplink());

      act(() => {
        window.dispatchEvent(new Event('focus'));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(catchSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('pending deeplink check', () => {
    it('asks the active worker for a pending deeplink shortly after mount', async () => {
      const active = { postMessage: vi.fn() };
      mockServiceWorker({ active });

      renderHook(() => useNotificationDeeplink());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(DEEPLINK_CHECK_DELAY_MS);
      });

      expect(active.postMessage).toHaveBeenCalledWith({ type: 'CHECK_NOTIFICATION_DEEPLINK' });
    });

    it('gives up quietly instead of hanging when no worker is registered', async () => {
      const { container } = mockServiceWorker(undefined);

      renderHook(() => useNotificationDeeplink());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(DEEPLINK_CHECK_DELAY_MS + SW_TIMEOUT_MS);
      });

      expect(container.getRegistration).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      expect(console.error).not.toHaveBeenCalled();
    });

    it('does not check after unmount', async () => {
      const active = { postMessage: vi.fn() };
      const { container } = mockServiceWorker({ active });

      const { unmount } = renderHook(() => useNotificationDeeplink());
      unmount();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(DEEPLINK_CHECK_DELAY_MS);
      });

      expect(container.getRegistration).not.toHaveBeenCalled();
      expect(active.postMessage).not.toHaveBeenCalled();
    });

    it('does not consume the deeplink when unmounted while the check is in flight', async () => {
      const active = { postMessage: vi.fn() };
      let resolveRegistration: (value: unknown) => void = () => {};
      const { container } = mockServiceWorker(undefined);
      container.getRegistration.mockReturnValue(
        new Promise((resolve) => (resolveRegistration = resolve))
      );

      const { unmount } = renderHook(() => useNotificationDeeplink());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(DEEPLINK_CHECK_DELAY_MS);
      });
      expect(container.getRegistration).toHaveBeenCalledTimes(1);

      unmount();
      await act(async () => {
        resolveRegistration({ active });
        await vi.advanceTimersByTimeAsync(0);
      });

      // Asking now would delete the single-use deeplink while nobody listens for the answer
      expect(active.postMessage).not.toHaveBeenCalled();
    });

    it('does nothing when service workers are not supported', async () => {
      renderHook(() => useNotificationDeeplink());

      await act(async () => {
        await vi.advanceTimersByTimeAsync(DEEPLINK_CHECK_DELAY_MS);
      });

      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe('messages from the service worker', () => {
    it.each(['NOTIFICATION_DEEPLINK', 'NOTIFICATION_CLICK'])(
      'navigates to the url of a %s message',
      (type) => {
        const { emit } = mockServiceWorker({ active: { postMessage: vi.fn() } });
        renderHook(() => useNotificationDeeplink());

        act(() => emit({ type, url: '/?machine=m1&session=project--1' }));

        expect(push).toHaveBeenCalledWith('/?machine=m1&session=project--1');
      }
    );

    it('ignores unrelated messages and messages without a url', () => {
      const { emit } = mockServiceWorker({ active: { postMessage: vi.fn() } });
      renderHook(() => useNotificationDeeplink());

      act(() => {
        emit({ type: 'PUSH_NOTIFICATION_FOREGROUND', url: '/elsewhere' });
        emit({ type: 'NOTIFICATION_DEEPLINK' });
        emit(null);
      });

      expect(push).not.toHaveBeenCalled();
    });

    it('does not navigate when already on the target url', () => {
      const { emit } = mockServiceWorker({ active: { postMessage: vi.fn() } });
      renderHook(() => useNotificationDeeplink());
      const current = window.location.pathname + window.location.search;

      act(() => emit({ type: 'NOTIFICATION_DEEPLINK', url: current }));

      expect(push).not.toHaveBeenCalled();
    });

    it('removes its message listener on unmount', () => {
      const { container, handlers } = mockServiceWorker({ active: { postMessage: vi.fn() } });

      const { unmount } = renderHook(() => useNotificationDeeplink());
      expect(handlers.size).toBe(1);
      unmount();

      expect(handlers.size).toBe(0);
      expect(container.removeEventListener).toHaveBeenCalledWith('message', expect.any(Function));
    });
  });
});
