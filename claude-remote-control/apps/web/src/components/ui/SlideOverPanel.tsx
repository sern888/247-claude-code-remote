'use client';

import { useEffect, useId, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X } from 'lucide-react';

/** Overlays currently listening for Escape, innermost last. */
let escapeLayers: readonly symbol[] = [];

/**
 * Closes an overlay (dialog, slide-over, menu) with the Escape key.
 *
 * Only the innermost open overlay reacts, and the event is marked as handled
 * (preventDefault + stopPropagation) so page-level shortcuts such as
 * "Escape leaves the session" do not fire for the same key press.
 */
export function useEscapeKey(active: boolean, onEscape: () => void): void {
  const onEscapeRef = useRef(onEscape);

  useEffect(() => {
    onEscapeRef.current = onEscape;
  }, [onEscape]);

  useEffect(() => {
    if (!active) return;

    const layer = Symbol('escape-layer');
    escapeLayers = [...escapeLayers, layer];

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (escapeLayers[escapeLayers.length - 1] !== layer) return;
      event.preventDefault();
      event.stopPropagation();
      onEscapeRef.current();
    };

    // Capture phase: runs before a focused widget (e.g. the terminal) can swallow the key
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      escapeLayers = escapeLayers.filter((entry) => entry !== layer);
    };
  }, [active]);
}

interface SlideOverPanelProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}

export function SlideOverPanel({ open, onClose, title, children }: SlideOverPanelProps) {
  const titleId = useId();
  useEscapeKey(open, onClose);

  return (
    <AnimatePresence>
      {open && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            aria-hidden="true"
            className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm"
          />

          {/* Panel from right */}
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', damping: 30, stiffness: 300 }}
            className="fixed bottom-0 right-0 top-0 z-50 w-full max-w-lg"
          >
            <div className="flex h-full flex-col border-l border-white/10 bg-[#0d0d14]">
              {/* Header */}
              <div className="flex items-center justify-between border-b border-white/5 p-4">
                <h2 id={titleId} className="text-lg font-semibold text-white">
                  {title}
                </h2>
                <button
                  type="button"
                  onClick={onClose}
                  aria-label={`Close ${title}`}
                  className="rounded-lg p-2 text-white/50 hover:bg-white/5 hover:text-white"
                >
                  <X className="h-5 w-5" aria-hidden="true" />
                </button>
              </div>

              {/* Content */}
              <div className="flex-1 overflow-auto p-4">{children}</div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
