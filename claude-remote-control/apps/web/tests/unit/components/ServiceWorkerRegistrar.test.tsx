import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { ServiceWorkerRegistrar } from '@/components/ServiceWorkerRegistrar';
import { Providers } from '@/components/Providers';

function mockServiceWorker(register: ReturnType<typeof vi.fn> | undefined) {
  if (register === undefined) {
    Reflect.deleteProperty(navigator, 'serviceWorker');
    return;
  }
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { register } });
}

describe('ServiceWorkerRegistrar', () => {
  afterEach(() => {
    cleanup();
    mockServiceWorker(undefined);
    vi.restoreAllMocks();
  });

  it('registers /sw.js for the whole origin, bypassing the HTTP cache', () => {
    const register = vi.fn().mockResolvedValue({ scope: '/' });
    mockServiceWorker(register);

    render(<ServiceWorkerRegistrar />);

    expect(register).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith('/sw.js', { scope: '/', updateViaCache: 'none' });
  });

  it('registers once on mount, not on every re-render', () => {
    const register = vi.fn().mockResolvedValue({ scope: '/' });
    mockServiceWorker(register);

    const { rerender } = render(<ServiceWorkerRegistrar />);
    rerender(<ServiceWorkerRegistrar />);
    rerender(<ServiceWorkerRegistrar />);

    expect(register).toHaveBeenCalledTimes(1);
  });

  it('renders nothing', () => {
    mockServiceWorker(vi.fn().mockResolvedValue({ scope: '/' }));

    const { container } = render(<ServiceWorkerRegistrar />);

    expect(container.innerHTML).toBe('');
  });

  it('does nothing when service workers are not supported', () => {
    mockServiceWorker(undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => render(<ServiceWorkerRegistrar />)).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });

  it('logs a warning instead of throwing when registration fails', async () => {
    const failure = new Error('sw.js returned 404');
    mockServiceWorker(vi.fn().mockRejectedValue(failure));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    render(<ServiceWorkerRegistrar />);

    await waitFor(() => {
      expect(warn).toHaveBeenCalledWith('[SW] Service worker registration failed:', failure);
    });
  });

  it('is mounted by Providers, so every page registers the worker', () => {
    const register = vi.fn().mockResolvedValue({ scope: '/' });
    mockServiceWorker(register);

    render(
      <Providers>
        <p>child</p>
      </Providers>
    );

    expect(register).toHaveBeenCalledWith('/sw.js', { scope: '/', updateViaCache: 'none' });
  });
});
