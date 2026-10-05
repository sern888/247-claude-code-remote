import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, createEvent } from '@testing-library/react';
import { AppHeader } from '@/components/layout/AppHeader';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock('@/lib/auth-client', () => ({
  authClient: { getSession: mocks.getSession, signOut: mocks.signOut },
}));

const MENU_BUTTON = 'User menu for Ada Lovelace';

async function renderWithOpenMenu(props: Partial<Parameters<typeof AppHeader>[0]> = {}) {
  const utils = render(<AppHeader {...props} />);
  fireEvent.click(await screen.findByRole('button', { name: MENU_BUTTON }));
  return utils;
}

function menuIsOpen() {
  return screen.getByRole('button', { name: MENU_BUTTON }).getAttribute('aria-expanded') === 'true';
}

describe('AppHeader user menu', () => {
  beforeEach(() => {
    mocks.getSession.mockReset().mockResolvedValue({
      data: { user: { name: 'Ada Lovelace', email: 'ada@example.com' } },
    });
    mocks.signOut.mockReset().mockResolvedValue(undefined);
  });

  it('opens with the working entries only', async () => {
    await renderWithOpenMenu();

    expect(menuIsOpen()).toBe(true);
    expect(screen.getByRole('button', { name: 'Notifications' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Profile' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Settings' })).toBeNull();
  });

  it('closes when Escape is pressed anywhere in the document', async () => {
    await renderWithOpenMenu();

    fireEvent.keyDown(document.body, { key: 'Escape' });

    await waitFor(() => expect(menuIsOpen()).toBe(false));
  });

  it('consumes the Escape key so page shortcuts do not also react', async () => {
    await renderWithOpenMenu();
    const pageShortcut = vi.fn();
    window.addEventListener('keydown', pageShortcut);
    const escape = createEvent.keyDown(document.body, { key: 'Escape' });

    fireEvent(document.body, escape);
    window.removeEventListener('keydown', pageShortcut);

    expect(escape.defaultPrevented).toBe(true);
    expect(pageShortcut).not.toHaveBeenCalled();
  });

  it('leaves Escape alone while the menu is closed', async () => {
    render(<AppHeader />);
    await screen.findByRole('button', { name: MENU_BUTTON });
    const escape = createEvent.keyDown(document.body, { key: 'Escape' });

    fireEvent(document.body, escape);

    expect(escape.defaultPrevented).toBe(false);
  });

  it('does not expose the click-away backdrop as a focusable button', async () => {
    await renderWithOpenMenu();

    expect(screen.queryByRole('button', { name: 'Close menu' })).toBeNull();
  });

  it('opens the notification settings from the menu', async () => {
    const onOpenNotificationSettings = vi.fn();
    await renderWithOpenMenu({ isMobile: true, onOpenNotificationSettings });

    fireEvent.click(screen.getByRole('button', { name: 'Notifications' }));

    expect(onOpenNotificationSettings).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(menuIsOpen()).toBe(false));
  });
});
