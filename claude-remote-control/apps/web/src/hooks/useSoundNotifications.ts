'use client';

import { useRef, useCallback, useEffect, useState } from 'react';
import { createLogger } from '@/lib/logger';

const DEFAULT_SOUND_PATH = '/sounds/chime.mp3';
const soundLogger = createLogger('Sound');

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface UseSoundNotificationsOptions {
  soundPath?: string;
}

/**
 * Hook for playing notification sounds.
 * Handles browser autoplay policy by tracking user interaction.
 * Preloads audio on mount for instant playback.
 */
export function useSoundNotifications(options?: UseSoundNotificationsOptions) {
  const soundPath = options?.soundPath ?? DEFAULT_SOUND_PATH;
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);
  const [hasUserInteracted, setHasUserInteracted] = useState(false);

  // Preload audio on mount and when sound path changes
  useEffect(() => {
    if (typeof window === 'undefined') return;

    setIsLoaded(false);

    const audio = new Audio(soundPath);
    audio.preload = 'auto';
    audio.volume = 0.5;

    const handleCanPlay = () => {
      setIsLoaded(true);
    };

    const handleError = () => {
      console.warn('Failed to load notification sound:', soundPath);
    };

    audio.addEventListener('canplaythrough', handleCanPlay);
    audio.addEventListener('error', handleError);

    audioRef.current = audio;

    return () => {
      audio.removeEventListener('canplaythrough', handleCanPlay);
      audio.removeEventListener('error', handleError);
      audioRef.current = null;
    };
  }, [soundPath]);

  // Track user interaction for autoplay policy
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const handleInteraction = () => {
      setHasUserInteracted(true);
      document.removeEventListener('click', handleInteraction);
      document.removeEventListener('keydown', handleInteraction);
      document.removeEventListener('touchstart', handleInteraction);
    };

    document.addEventListener('click', handleInteraction);
    document.addEventListener('keydown', handleInteraction);
    document.addEventListener('touchstart', handleInteraction);

    return () => {
      document.removeEventListener('click', handleInteraction);
      document.removeEventListener('keydown', handleInteraction);
      document.removeEventListener('touchstart', handleInteraction);
    };
  }, []);

  /**
   * Play the notification sound.
   * Returns true if sound was played, false if blocked or unavailable.
   */
  const playSound = useCallback(async (): Promise<boolean> => {
    if (!audioRef.current || !isLoaded) {
      return false;
    }

    try {
      // Reset to beginning if already playing
      audioRef.current.currentTime = 0;
      await audioRef.current.play();
      return true;
    } catch (error) {
      // Browser blocked autoplay - this is expected before user interaction
      soundLogger.debug('Sound playback blocked', { errorMessage: errorMessageOf(error) });
      return false;
    }
  }, [isLoaded]);

  /**
   * Test the notification sound (for settings panel).
   * Same as playSound but with clearer intent.
   */
  const testSound = useCallback(async (): Promise<boolean> => {
    return playSound();
  }, [playSound]);

  /**
   * Preview a specific sound without changing the main audio.
   * Used in settings panel for trying different sounds.
   */
  const previewSound = useCallback(async (previewPath: string): Promise<boolean> => {
    if (typeof window === 'undefined') return false;

    try {
      const previewAudio = new Audio(previewPath);
      previewAudio.volume = 0.5;
      await previewAudio.play();
      return true;
    } catch (error) {
      soundLogger.debug('Preview sound playback blocked', {
        errorMessage: errorMessageOf(error),
      });
      return false;
    }
  }, []);

  return {
    playSound,
    testSound,
    previewSound,
    isLoaded,
    hasUserInteracted,
  };
}
