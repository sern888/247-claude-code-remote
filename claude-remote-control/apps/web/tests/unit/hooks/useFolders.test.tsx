import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useFolders } from '@/components/NewSessionModal/hooks/useFolders';

interface Deferred {
  url: string;
  signal: AbortSignal | undefined;
  resolve: (folders: unknown, ok?: boolean) => void;
  reject: (error: Error) => void;
}

function machine(id: string, agentUrl: string, projects: string[] = []) {
  return { id, name: id, status: 'online', config: { projects, agentUrl } };
}

describe('useFolders', () => {
  const originalFetch = globalThis.fetch;
  let requests: Deferred[];

  beforeEach(() => {
    requests = [];
    globalThis.fetch = vi.fn((url: string, init?: RequestInit) => {
      return new Promise((resolve, reject) => {
        requests.push({
          url,
          signal: init?.signal ?? undefined,
          resolve: (folders, ok = true) =>
            resolve({ ok, status: ok ? 200 : 500, json: async () => folders }),
          reject,
        });
      });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('loads the folders of the selected machine and selects the first one', async () => {
    const machineA = machine('a', 'host-a:4678');
    const { result } = renderHook(() => useFolders(machineA));
    expect(result.current.loadingFolders).toBe(true);

    await act(async () => requests[0].resolve(['alpha', 'beta']));

    expect(requests[0].url).toBe('https://host-a:4678/api/folders');
    expect(result.current.folders).toEqual(['alpha', 'beta']);
    expect(result.current.selectedProject).toBe('alpha');
    expect(result.current.loadingFolders).toBe(false);
  });

  it('ignores a slow response for the previously selected machine', async () => {
    const machineA = machine('a', 'host-a:4678');
    const machineB = machine('b', 'host-b:4678');
    const { result, rerender } = renderHook(({ selected }) => useFolders(selected), {
      initialProps: { selected: machineA },
    });

    rerender({ selected: machineB });
    await act(async () => requests[1].resolve(['from-b']));
    await act(async () => requests[0].resolve(['from-a']));

    expect(result.current.folders).toEqual(['from-b']);
    expect(result.current.selectedProject).toBe('from-b');
    expect(result.current.loadingFolders).toBe(false);
  });

  it('aborts the request of the previous machine', () => {
    const { rerender } = renderHook(({ selected }) => useFolders(selected), {
      initialProps: { selected: machine('a', 'host-a:4678') },
    });

    rerender({ selected: machine('b', 'host-b:4678') });

    expect(requests[0].signal?.aborted).toBe(true);
    expect(requests[1].signal?.aborted).toBe(false);
  });

  it('clears stale folders when the next machine cannot be reached', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { result, rerender } = renderHook(({ selected }) => useFolders(selected), {
      initialProps: { selected: machine('a', 'host-a:4678') },
    });
    await act(async () => requests[0].resolve(['from-a']));

    rerender({ selected: machine('b', 'host-b:4678') });
    await act(async () => requests[1].reject(new TypeError('Failed to fetch')));

    expect(result.current.folders).toEqual([]);
    expect(result.current.selectedProject).toBe('');
    expect(result.current.loadingFolders).toBe(false);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain('[Folders]');
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('clears stale folders when the agent answers with an error status', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { result, rerender } = renderHook(({ selected }) => useFolders(selected), {
      initialProps: { selected: machine('a', 'host-a:4678') },
    });
    await act(async () => requests[0].resolve(['from-a']));

    rerender({ selected: machine('b', 'host-b:4678') });
    await act(async () => requests[1].resolve({ error: 'boom' }, false));

    expect(result.current.folders).toEqual([]);
    expect(result.current.selectedProject).toBe('');
  });

  it('falls back to the configured projects when the fetch fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const machineA = machine('a', 'host-a:4678', ['configured']);
    const { result } = renderHook(() => useFolders(machineA));

    await act(async () => requests[0].reject(new TypeError('Failed to fetch')));

    expect(result.current.folders).toEqual(['configured']);
    expect(result.current.selectedProject).toBe('configured');
  });

  it('resets everything when the machine is deselected', async () => {
    const { result, rerender } = renderHook(
      ({ selected }: { selected: ReturnType<typeof machine> | null }) => useFolders(selected),
      {
        initialProps: {
          selected: machine('a', 'host-a:4678') as ReturnType<typeof machine> | null,
        },
      }
    );
    await act(async () => requests[0].resolve(['from-a']));

    rerender({ selected: null });

    await waitFor(() => expect(result.current.folders).toEqual([]));
    expect(result.current.selectedProject).toBe('');
  });

  it('adds a folder in sorted order and selects it', async () => {
    const machineA = machine('a', 'host-a:4678');
    const { result } = renderHook(() => useFolders(machineA));
    await act(async () => requests[0].resolve(['alpha', 'gamma']));

    act(() => result.current.addFolder('beta'));

    expect(result.current.folders).toEqual(['alpha', 'beta', 'gamma']);
    expect(result.current.selectedProject).toBe('beta');
  });
});
