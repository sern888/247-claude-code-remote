import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NotificationSettingsPanel } from '@/components/NotificationSettingsPanel';

const mocks = vi.hoisted(() => ({
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  previewSound: vi.fn(),
}));

vi.mock('@/hooks/usePushNotifications', () => ({
  usePushNotifications: () => ({
    isSupported: true,
    isSubscribed: false,
    permission: 'default',
    isLoading: false,
    error: null,
    subscribe: mocks.subscribe,
    unsubscribe: mocks.unsubscribe,
  }),
}));

vi.mock('@/hooks/useSoundNotifications', () => ({
  useSoundNotifications: () => ({ previewSound: mocks.previewSound }),
}));

function renderWithSoundList() {
  const utils = render(<NotificationSettingsPanel />);
  fireEvent.click(screen.getByRole('switch', { name: 'Sound Notifications' }));
  return utils;
}

describe('NotificationSettingsPanel', () => {
  beforeEach(() => {
    window.localStorage.clear();
    mocks.subscribe.mockReset();
    mocks.unsubscribe.mockReset();
    mocks.previewSound.mockReset().mockResolvedValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('gives both switches an accessible name', () => {
    render(<NotificationSettingsPanel />);

    expect(screen.getByRole('switch', { name: 'Browser Notifications' })).toBeTruthy();
    expect(screen.getByRole('switch', { name: 'Sound Notifications' })).toBeTruthy();
  });

  it('subscribes to push only when the user clicks the switch', () => {
    render(<NotificationSettingsPanel />);
    expect(mocks.subscribe).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('switch', { name: 'Browser Notifications' }));

    expect(mocks.subscribe).toHaveBeenCalledTimes(1);
  });

  it('does not nest the preview button inside the sound button', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { container } = renderWithSoundList();

    expect(screen.getByRole('button', { name: 'Preview Bell sound' })).toBeTruthy();
    expect(container.querySelectorAll('button button')).toHaveLength(0);
    const nestingErrors = errorSpy.mock.calls.filter((args) =>
      /cannot be a descendant|validateDOMNesting/.test(String(args[0]))
    );
    expect(nestingErrors).toHaveLength(0);
  });

  it('labels the sound list as a group', () => {
    renderWithSoundList();

    expect(screen.getByRole('group', { name: 'Choose a sound' })).toBeTruthy();
  });

  it('selects a sound when its name is clicked', () => {
    renderWithSoundList();
    const bell = screen.getByRole('button', { name: 'Bell' });
    expect(bell.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(bell);

    expect(screen.getByRole('button', { name: 'Bell' }).getAttribute('aria-pressed')).toBe('true');
    expect(mocks.previewSound).not.toHaveBeenCalled();
  });

  it('previews a sound without selecting it', () => {
    renderWithSoundList();

    fireEvent.click(screen.getByRole('button', { name: 'Preview Bell sound' }));

    expect(mocks.previewSound).toHaveBeenCalledWith('/sounds/bell.mp3');
    expect(screen.getByRole('button', { name: 'Bell' }).getAttribute('aria-pressed')).toBe('false');
  });
});
