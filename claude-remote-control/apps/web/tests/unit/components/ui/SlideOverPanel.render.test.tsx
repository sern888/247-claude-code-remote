import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, createEvent } from '@testing-library/react';
import { SlideOverPanel, useEscapeKey } from '@/components/ui/SlideOverPanel';

function renderPanel(onClose = vi.fn(), open = true) {
  render(
    <SlideOverPanel open={open} onClose={onClose} title="Connection Guide">
      <p>Panel body</p>
    </SlideOverPanel>
  );
  return onClose;
}

function Layer({ name, onEscape }: { name: string; onEscape: (name: string) => void }) {
  useEscapeKey(true, () => onEscape(name));
  return null;
}

describe('SlideOverPanel', () => {
  it('is a modal dialog named after its title', () => {
    renderPanel();

    const dialog = screen.getByRole('dialog', { name: 'Connection Guide' });

    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(screen.getByText('Panel body')).toBeTruthy();
  });

  it('has a close button with an accessible name', () => {
    const onClose = renderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'Close Connection Guide' }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape and consumes the key', () => {
    const onClose = renderPanel();
    const pageShortcut = vi.fn();
    window.addEventListener('keydown', pageShortcut);
    const escape = createEvent.keyDown(document.body, { key: 'Escape' });

    fireEvent(document.body, escape);
    window.removeEventListener('keydown', pageShortcut);

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(escape.defaultPrevented).toBe(true);
    expect(pageShortcut).not.toHaveBeenCalled();
  });

  it('ignores other keys', () => {
    const onClose = renderPanel();

    fireEvent.keyDown(document.body, { key: 'Enter' });

    expect(onClose).not.toHaveBeenCalled();
  });

  it('renders nothing and leaves Escape alone while closed', () => {
    const onClose = renderPanel(vi.fn(), false);
    const escape = createEvent.keyDown(document.body, { key: 'Escape' });

    fireEvent(document.body, escape);

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(escape.defaultPrevented).toBe(false);
  });
});

describe('useEscapeKey', () => {
  it('lets only the innermost open overlay handle Escape', () => {
    const onEscape = vi.fn();
    const { rerender } = render(<Layer name="outer" onEscape={onEscape} />);
    rerender(
      <>
        <Layer name="outer" onEscape={onEscape} />
        <Layer name="inner" onEscape={onEscape} />
      </>
    );

    fireEvent.keyDown(document.body, { key: 'Escape' });

    expect(onEscape.mock.calls).toEqual([['inner']]);
  });

  it('hands Escape back to the outer overlay once the inner one is gone', () => {
    const onEscape = vi.fn();
    const { rerender } = render(<Layer name="outer" onEscape={onEscape} />);
    rerender(
      <>
        <Layer name="outer" onEscape={onEscape} />
        <Layer name="inner" onEscape={onEscape} />
      </>
    );
    rerender(<Layer name="outer" onEscape={onEscape} />);

    fireEvent.keyDown(document.body, { key: 'Escape' });

    expect(onEscape.mock.calls).toEqual([['outer']]);
  });

  it('does not react to an Escape that was already handled', () => {
    const onEscape = vi.fn();
    render(<Layer name="only" onEscape={onEscape} />);
    const consume = (event: KeyboardEvent) => event.preventDefault();
    window.addEventListener('keydown', consume, true);

    fireEvent.keyDown(document.body, { key: 'Escape' });
    window.removeEventListener('keydown', consume, true);

    expect(onEscape).not.toHaveBeenCalled();
  });
});
