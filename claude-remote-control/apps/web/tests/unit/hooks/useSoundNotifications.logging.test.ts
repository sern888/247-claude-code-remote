import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSoundNotifications } from '@/hooks/useSoundNotifications';

const mocks = vi.hoisted(() => ({
  debug: vi.fn(),
  tags: [] as string[],
}));

vi.mock('@/lib/logger', () => ({
  createLogger: (tag: string) => {
    mocks.tags.push(tag);
    return { debug: mocks.debug, info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  },
}));

describe('useSoundNotifications logging', () => {
  let play: ReturnType<typeof vi.fn>;
  let listeners: Record<string, () => void>;

  beforeEach(() => {
    mocks.debug.mockClear();
    listeners = {};
    play = vi.fn().mockRejectedValue(new Error('Autoplay blocked'));
    const audio = {
      play,
      addEventListener: (event: string, callback: () => void) => {
        listeners[event] = callback;
      },
      removeEventListener: vi.fn(),
      currentTime: 0,
      preload: '',
      volume: 1,
    };
    vi.stubGlobal(
      'Audio',
      class {
        constructor() {
          return audio;
        }
      }
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('creates a logger tagged "Sound"', () => {
    expect(mocks.tags).toContain('Sound');
  });

  it('reports blocked playback through the logger instead of console.debug', async () => {
    const consoleDebug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const { result } = renderHook(() => useSoundNotifications());
    act(() => listeners.canplaythrough());

    let played = true;
    await act(async () => {
      played = await result.current.playSound();
    });

    expect(played).toBe(false);
    expect(mocks.debug).toHaveBeenCalledWith('Sound playback blocked', {
      errorMessage: 'Autoplay blocked',
    });
    expect(consoleDebug).not.toHaveBeenCalled();
  });

  it('reports a blocked preview through the logger instead of console.debug', async () => {
    const consoleDebug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const { result } = renderHook(() => useSoundNotifications());

    let played = true;
    await act(async () => {
      played = await result.current.previewSound('/sounds/bell.mp3');
    });

    expect(played).toBe(false);
    expect(mocks.debug).toHaveBeenCalledWith('Preview sound playback blocked', {
      errorMessage: 'Autoplay blocked',
    });
    expect(consoleDebug).not.toHaveBeenCalled();
  });
});
