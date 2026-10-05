import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SessionListPanel, type SessionListItem } from '@/components/layout/SessionListPanel';

const session: SessionListItem = {
  id: 's1',
  name: 'fair-fox-44',
  project: 'demo-project',
  status: 'working',
  updatedAt: new Date(),
  createdAt: new Date(),
  machineId: 'm1',
};

function renderPanel(overrides: Record<string, unknown> = {}) {
  return render(
    <SessionListPanel
      sessions={[session]}
      selectedSessionId={null}
      onSelectSession={vi.fn()}
      onKillSession={vi.fn()}
      onArchiveSession={vi.fn()}
      {...overrides}
    />
  );
}

// The Archive/Kill actions only mount while the card is hovered.
function hoverCard() {
  fireEvent.mouseEnter(screen.getByText(session.name));
}

describe('SessionListPanel DOM nesting', () => {
  it('does not nest the action buttons inside the session card button', () => {
    const { container } = renderPanel();
    hoverCard();

    expect(screen.getByLabelText(`Archive session ${session.name}`)).toBeTruthy();
    expect(container.querySelectorAll('button button').length).toBe(0);
  });

  it('selects the session when the card is clicked', () => {
    const onSelectSession = vi.fn();
    renderPanel({ onSelectSession });

    fireEvent.click(screen.getByText(session.name));

    expect(onSelectSession).toHaveBeenCalledTimes(1);
    expect(onSelectSession).toHaveBeenCalledWith(session);
  });

  it('archives without selecting the session', () => {
    const onSelectSession = vi.fn();
    const onArchiveSession = vi.fn();
    renderPanel({ onSelectSession, onArchiveSession });
    hoverCard();

    fireEvent.click(screen.getByLabelText(`Archive session ${session.name}`));

    expect(onArchiveSession).toHaveBeenCalledWith(session);
    expect(onSelectSession).not.toHaveBeenCalled();
  });

  it('kills without selecting the session', () => {
    const onSelectSession = vi.fn();
    const onKillSession = vi.fn();
    renderPanel({ onSelectSession, onKillSession });
    hoverCard();

    fireEvent.click(screen.getByLabelText(`Kill session ${session.name}`));

    expect(onKillSession).toHaveBeenCalledWith(session);
    expect(onSelectSession).not.toHaveBeenCalled();
  });
});

describe('SessionListPanel actions without hover', () => {
  it('renders the Archive and Kill buttons even when the card is not hovered', () => {
    renderPanel();

    expect(screen.getByRole('button', { name: `Archive session ${session.name}` })).toBeTruthy();
    expect(screen.getByRole('button', { name: `Kill session ${session.name}` })).toBeTruthy();
  });

  it('lets a keyboard user focus and activate an action without hovering', () => {
    const onKillSession = vi.fn();
    renderPanel({ onKillSession });
    const killButton = screen.getByRole('button', { name: `Kill session ${session.name}` });

    killButton.focus();
    fireEvent.click(killButton);

    expect(document.activeElement).toBe(killButton);
    expect(onKillSession).toHaveBeenCalledWith(session);
  });

  it('reveals the actions on hover and when focus is inside the card', () => {
    renderPanel();
    const actions = screen.getByRole('button', { name: `Kill session ${session.name}` })
      .parentElement as HTMLElement;

    expect(actions.className).toContain('opacity-0');
    expect(actions.className).toContain('group-hover:opacity-100');
    expect(actions.className).toContain('group-focus-within:opacity-100');
    expect(actions.closest('.group')).not.toBeNull();
  });

  it('renders no action container when no action is available', () => {
    renderPanel({ onKillSession: undefined, onArchiveSession: undefined });

    expect(screen.queryByRole('button', { name: /Kill session/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Archive session/ })).toBeNull();
  });
});

describe('SessionListPanel ordering', () => {
  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);
  const older: SessionListItem = { ...session, id: 'old', name: 'older', updatedAt: minutesAgo(2) };
  const newer: SessionListItem = { ...session, id: 'new', name: 'newer', updatedAt: minutesAgo(1) };

  it('lists the most recently updated session first', () => {
    renderPanel({ sessions: [older, newer] });

    const names = screen.getAllByText(/^(older|newer)$/).map((node) => node.textContent);

    expect(names).toEqual(['newer', 'older']);
  });

  it('does not reorder the array it was given', () => {
    const sessions = [older, newer];

    renderPanel({ sessions });

    expect(sessions).toEqual([older, newer]);
  });
});

describe('SessionListPanel search and empty states', () => {
  const other: SessionListItem = { ...session, id: 's2', name: 'calm-owl-7', project: 'docs-site' };

  it('filters sessions by name or project and can be cleared', () => {
    renderPanel({ sessions: [session, other] });
    const search = screen.getByPlaceholderText('Search sessions...');

    fireEvent.change(search, { target: { value: 'DOCS' } });
    expect(screen.queryByText(session.name)).toBeNull();
    expect(screen.getByText(other.name)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(screen.getByText(session.name)).toBeTruthy();
    expect(screen.getByText(other.name)).toBeTruthy();
  });

  it('tells apart "no sessions yet" from "no match"', () => {
    const { unmount } = renderPanel({ sessions: [] });
    expect(screen.getByText('No sessions yet')).toBeTruthy();
    unmount();

    renderPanel();
    fireEvent.change(screen.getByPlaceholderText('Search sessions...'), {
      target: { value: 'nothing-like-this' },
    });
    expect(screen.getByText('No sessions found')).toBeTruthy();
  });

  it('groups older sessions under their date and shows the cost when known', () => {
    const lastYear: SessionListItem = {
      ...session,
      id: 's3',
      name: 'old-timer',
      updatedAt: new Date(2020, 0, 15, 9, 30),
      model: 'opus',
      cost: 1.5,
    };

    renderPanel({ sessions: [session, lastYear] });

    expect(screen.getByText('Today')).toBeTruthy();
    expect(screen.getByText('Jan 15')).toBeTruthy();
    expect(screen.getByText('$1.50')).toBeTruthy();
  });

  it('offers a New Session button only when a handler is given', () => {
    const onNewSession = vi.fn();
    const { unmount } = renderPanel({ onNewSession });
    fireEvent.click(screen.getByRole('button', { name: 'New Session' }));
    expect(onNewSession).toHaveBeenCalledTimes(1);
    unmount();

    renderPanel();
    expect(screen.queryByRole('button', { name: 'New Session' })).toBeNull();
  });
});
