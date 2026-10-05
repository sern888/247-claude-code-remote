import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { TouchEvent } from 'react';
import { usePullToRefresh } from '@/hooks/usePullToRefresh';

function touchAt(clientY: number) {
  const preventDefault = vi.fn();
  const event = { touches: [{ clientY }], preventDefault } as unknown as TouchEvent;
  return { event, preventDefault };
}

describe('usePullToRefresh', () => {
  it('tracks the pull distance without calling preventDefault on the passive touchmove', () => {
    const { result } = renderHook(() =>
      usePullToRefresh({ onRefresh: vi.fn().mockResolvedValue(undefined), resistance: 2 })
    );
    const move = touchAt(110);

    act(() => result.current.handlers.onTouchStart(touchAt(10).event));
    act(() => result.current.handlers.onTouchMove(move.event));

    expect(result.current.isPulling).toBe(true);
    expect(result.current.pullDistance).toBe(50);
    expect(move.preventDefault).not.toHaveBeenCalled();
  });

  it('refreshes when released past the threshold', async () => {
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      usePullToRefresh({ onRefresh, threshold: 40, resistance: 1 })
    );

    act(() => result.current.handlers.onTouchStart(touchAt(10).event));
    act(() => result.current.handlers.onTouchMove(touchAt(90).event));
    expect(result.current.isThresholdReached).toBe(true);
    await act(async () => result.current.handlers.onTouchEnd());

    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(result.current.isRefreshing).toBe(false);
    expect(result.current.pullDistance).toBe(0);
  });

  it('does not refresh when released before the threshold', async () => {
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      usePullToRefresh({ onRefresh, threshold: 80, resistance: 1 })
    );

    act(() => result.current.handlers.onTouchStart(touchAt(10).event));
    act(() => result.current.handlers.onTouchMove(touchAt(40).event));
    await act(async () => result.current.handlers.onTouchEnd());

    expect(onRefresh).not.toHaveBeenCalled();
    expect(result.current.isPulling).toBe(false);
  });

  it('ignores touches that start below the pull zone or while disabled', () => {
    const { result, rerender } = renderHook(
      ({ disabled }) => usePullToRefresh({ onRefresh: vi.fn(), disabled, maxPullZoneY: 100 }),
      { initialProps: { disabled: false } }
    );

    act(() => result.current.handlers.onTouchStart(touchAt(300).event));
    act(() => result.current.handlers.onTouchMove(touchAt(400).event));
    expect(result.current.isPulling).toBe(false);

    rerender({ disabled: true });
    act(() => result.current.handlers.onTouchStart(touchAt(10).event));
    act(() => result.current.handlers.onTouchMove(touchAt(200).event));
    expect(result.current.isPulling).toBe(false);
  });
});
