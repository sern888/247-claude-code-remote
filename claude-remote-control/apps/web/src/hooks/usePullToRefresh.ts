'use client';

import { useState, useRef, useCallback, type TouchEvent } from 'react';

interface UsePullToRefreshOptions {
  onRefresh: () => Promise<void>;
  threshold?: number; // Distance to trigger refresh (default: 80px)
  resistance?: number; // Pull resistance factor (default: 2.5)
  maxPullZoneY?: number; // Max Y position to start pull (default: 100px)
  disabled?: boolean;
}

interface UsePullToRefreshReturn {
  pullDistance: number;
  isRefreshing: boolean;
  isPulling: boolean;
  isThresholdReached: boolean;
  handlers: {
    onTouchStart: (e: TouchEvent) => void;
    onTouchMove: (e: TouchEvent) => void;
    onTouchEnd: () => void;
  };
}

const DEFAULT_THRESHOLD = 80;
const DEFAULT_RESISTANCE = 2.5;
const DEFAULT_MAX_PULL_ZONE_Y = 100;

export function usePullToRefresh({
  onRefresh,
  threshold = DEFAULT_THRESHOLD,
  resistance = DEFAULT_RESISTANCE,
  maxPullZoneY = DEFAULT_MAX_PULL_ZONE_Y,
  disabled = false,
}: UsePullToRefreshOptions): UsePullToRefreshReturn {
  const [pullDistance, setPullDistance] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isPulling, setIsPulling] = useState(false);

  const startYRef = useRef<number | null>(null);
  const isActiveRef = useRef(false);

  const handleTouchStart = useCallback(
    (e: TouchEvent) => {
      if (disabled || isRefreshing) return;

      const touch = e.touches[0];
      if (!touch) return;

      // Only activate if touch starts near the top of the screen
      if (touch.clientY > maxPullZoneY) return;

      startYRef.current = touch.clientY;
      isActiveRef.current = true;
    },
    [disabled, isRefreshing, maxPullZoneY]
  );

  const handleTouchMove = useCallback(
    (e: TouchEvent) => {
      if (!isActiveRef.current || !startYRef.current || disabled || isRefreshing) return;

      const touch = e.touches[0];
      if (!touch) return;

      const deltaY = touch.clientY - startYRef.current;

      // Only pull down, not up
      if (deltaY <= 0) {
        setPullDistance(0);
        setIsPulling(false);
        return;
      }

      // Apply resistance for natural feel
      const resistedDelta = deltaY / resistance;

      // No preventDefault() here: React registers touchmove as a passive listener, so the
      // call is ignored and only logs a warning. The browser's own pull-to-refresh is
      // disabled with CSS instead (overscroll-behavior on the page and the scroll container).

      setPullDistance(resistedDelta);
      setIsPulling(true);
    },
    [disabled, isRefreshing, resistance]
  );

  const handleTouchEnd = useCallback(async () => {
    if (!isActiveRef.current || disabled) {
      return;
    }

    isActiveRef.current = false;
    startYRef.current = null;

    const wasThresholdReached = pullDistance >= threshold;

    if (wasThresholdReached && !isRefreshing) {
      setIsRefreshing(true);
      setIsPulling(false);
      // Keep showing indicator at threshold during refresh
      setPullDistance(threshold);

      try {
        await onRefresh();
      } finally {
        setIsRefreshing(false);
        setPullDistance(0);
      }
    } else {
      // Reset if threshold not reached
      setPullDistance(0);
      setIsPulling(false);
    }
  }, [pullDistance, threshold, isRefreshing, onRefresh, disabled]);

  return {
    pullDistance,
    isRefreshing,
    isPulling,
    isThresholdReached: pullDistance >= threshold,
    handlers: {
      onTouchStart: handleTouchStart,
      onTouchMove: handleTouchMove,
      onTouchEnd: handleTouchEnd,
    },
  };
}
