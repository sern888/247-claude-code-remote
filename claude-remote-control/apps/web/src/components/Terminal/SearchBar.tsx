'use client';

import { forwardRef, type KeyboardEvent } from 'react';
import { Search, ChevronUp, ChevronDown, X } from 'lucide-react';
import { cn } from '@/lib/utils';

interface SearchBarProps {
  visible: boolean;
  query: string;
  onQueryChange: (query: string) => void;
  onFindNext: () => void;
  onFindPrevious: () => void;
  onClose: () => void;
}

export const SearchBar = forwardRef<HTMLInputElement, SearchBarProps>(
  ({ visible, query, onQueryChange, onFindNext, onFindPrevious, onClose }, ref) => {
    if (!visible) return null;

    // Escape closes the search and is consumed here, so it does not also leave the session
    const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };

    return (
      <div
        role="search"
        onKeyDown={handleKeyDown}
        className={cn(
          'flex items-center gap-2 px-4 py-2',
          'bg-[#0d0d14]/90 backdrop-blur-sm',
          'border-b border-white/5'
        )}
      >
        <Search className="h-4 w-4 text-white/30" aria-hidden="true" />
        <input
          ref={ref}
          type="text"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="Search in terminal..."
          aria-label="Search in terminal"
          className={cn(
            'flex-1 bg-transparent text-sm text-white placeholder:text-white/30',
            'focus:outline-none focus-visible:ring-1 focus-visible:ring-orange-500/50'
          )}
        />
        <div className="flex items-center gap-1">
          <button
            onClick={onFindPrevious}
            className="rounded p-1.5 text-white/40 transition-colors hover:bg-white/10 hover:text-white focus-visible:ring-1 focus-visible:ring-orange-500/50"
            aria-label="Find previous"
          >
            <ChevronUp className="h-4 w-4" />
          </button>
          <button
            onClick={onFindNext}
            className="rounded p-1.5 text-white/40 transition-colors hover:bg-white/10 hover:text-white focus-visible:ring-1 focus-visible:ring-orange-500/50"
            aria-label="Find next"
          >
            <ChevronDown className="h-4 w-4" />
          </button>
          <button
            onClick={onClose}
            className="rounded p-1.5 text-white/40 transition-colors hover:bg-white/10 hover:text-white focus-visible:ring-1 focus-visible:ring-orange-500/50"
            aria-label="Close search"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
    );
  }
);

SearchBar.displayName = 'SearchBar';
