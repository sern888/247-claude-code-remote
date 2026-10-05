import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getServiceWorkerRegistration } from '@/lib/service-worker';

type ServiceWorkerContainerMock = {
  getRegistration: ReturnType<typeof vi.fn>;
  ready: Promise<unknown>;
};

function mockServiceWorker(container: ServiceWorkerContainerMock | undefined) {
  if (container === undefined) {
    Reflect.deleteProperty(navigator, 'serviceWorker');
    return;
  }
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: container });
}

const never = new Promise<never>(() => {});
const activeRegistration = { active: { state: 'activated' }, scope: '/' };

describe('getServiceWorkerRegistration', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    mockServiceWorker(undefined);
  });

  it('returns null when service workers are not supported', async () => {
    mockServiceWorker(undefined);

    await expect(getServiceWorkerRegistration()).resolves.toBeNull();
  });

  it('returns the existing registration immediately when it has an active worker', async () => {
    const getRegistration = vi.fn().mockResolvedValue(activeRegistration);
    mockServiceWorker({ getRegistration, ready: never });

    await expect(getServiceWorkerRegistration()).resolves.toBe(activeRegistration);
    expect(getRegistration).toHaveBeenCalledWith('/');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resolves to null after the timeout when nothing is registered (never hangs)', async () => {
    mockServiceWorker({ getRegistration: vi.fn().mockResolvedValue(undefined), ready: never });
    const onSettled = vi.fn();

    const pending = getServiceWorkerRegistration(3000).then(onSettled);
    await vi.advanceTimersByTimeAsync(2999);
    expect(onSettled).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await pending;

    expect(onSettled).toHaveBeenCalledWith(null);
  });

  it('waits for a worker that is still installing and returns it once ready', async () => {
    let resolveReady: (registration: unknown) => void = () => {};
    const ready = new Promise((resolve) => {
      resolveReady = resolve;
    });
    const installing = { active: null, installing: { state: 'installing' } };
    mockServiceWorker({ getRegistration: vi.fn().mockResolvedValue(installing), ready });

    const pending = getServiceWorkerRegistration(3000);
    await vi.advanceTimersByTimeAsync(500);
    resolveReady(activeRegistration);

    await expect(pending).resolves.toBe(activeRegistration);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses a default timeout of a few seconds', async () => {
    mockServiceWorker({ getRegistration: vi.fn().mockResolvedValue(undefined), ready: never });
    const onSettled = vi.fn();

    const pending = getServiceWorkerRegistration().then(onSettled);
    await vi.advanceTimersByTimeAsync(5000);
    await pending;

    expect(onSettled).toHaveBeenCalledWith(null);
  });

  it('propagates a getRegistration failure to the caller', async () => {
    const failure = new DOMException('The operation is insecure.', 'SecurityError');
    mockServiceWorker({ getRegistration: vi.fn().mockRejectedValue(failure), ready: never });

    await expect(getServiceWorkerRegistration()).rejects.toBe(failure);
  });

  it('propagates a rejected ready promise and clears its timer', async () => {
    const failure = new Error('registration failed');
    mockServiceWorker({
      getRegistration: vi.fn().mockResolvedValue(undefined),
      ready: Promise.reject(failure),
    });

    await expect(getServiceWorkerRegistration(3000)).rejects.toBe(failure);
    expect(vi.getTimerCount()).toBe(0);
  });
});
