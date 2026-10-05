import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, createEvent } from '@testing-library/react';
import { SearchBar } from '@/components/Terminal/SearchBar';

function renderSearchBar(visible = true) {
  const props = {
    visible,
    query: 'needle',
    onQueryChange: vi.fn(),
    onFindNext: vi.fn(),
    onFindPrevious: vi.fn(),
    onClose: vi.fn(),
  };
  render(<SearchBar {...props} />);
  return props;
}

describe('Terminal SearchBar', () => {
  it('is exposed as a search landmark', () => {
    renderSearchBar();

    expect(screen.getByRole('search')).toBeTruthy();
  });

  it('closes on Escape and stops the key from reaching page shortcuts', () => {
    const { onClose } = renderSearchBar();
    const pageShortcut = vi.fn();
    window.addEventListener('keydown', pageShortcut);
    const input = screen.getByLabelText('Search in terminal');
    const escape = createEvent.keyDown(input, { key: 'Escape' });

    fireEvent(input, escape);
    window.removeEventListener('keydown', pageShortcut);

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(escape.defaultPrevented).toBe(true);
    expect(pageShortcut).not.toHaveBeenCalled();
  });

  it('also closes when Escape is pressed on one of its buttons', () => {
    const { onClose } = renderSearchBar();

    fireEvent.keyDown(screen.getByRole('button', { name: 'Find next' }), { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('lets other keys through', () => {
    const { onClose } = renderSearchBar();
    const input = screen.getByLabelText('Search in terminal');
    const enter = createEvent.keyDown(input, { key: 'Enter' });

    fireEvent(input, enter);

    expect(onClose).not.toHaveBeenCalled();
    expect(enter.defaultPrevented).toBe(false);
  });

  it('renders nothing while hidden', () => {
    renderSearchBar(false);

    expect(screen.queryByRole('search')).toBeNull();
  });
});
