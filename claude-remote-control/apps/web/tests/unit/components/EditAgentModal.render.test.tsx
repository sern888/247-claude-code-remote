import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, createEvent } from '@testing-library/react';
import { EditAgentModal } from '@/components/EditAgentModal';

function renderModal(overrides: Partial<Parameters<typeof EditAgentModal>[0]> = {}) {
  const props = {
    open: true,
    onClose: vi.fn(),
    agentId: 'm1',
    agentName: 'Mac mini',
    agentColor: undefined,
    onSave: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  render(<EditAgentModal {...props} />);
  return props;
}

describe('EditAgentModal', () => {
  it('is a modal dialog with an accessible title', () => {
    renderModal();

    const dialog = screen.getByRole('dialog', { name: 'Edit Machine' });

    expect(dialog.getAttribute('aria-modal')).toBe('true');
  });

  it('associates the name label with its input', () => {
    renderModal();

    const input = screen.getByLabelText('Machine Name') as HTMLInputElement;

    expect(input.tagName).toBe('INPUT');
    expect(input.value).toBe('Mac mini');
  });

  it('names the close button and the colour choices', () => {
    const { onClose } = renderModal();

    expect(screen.getByRole('group', { name: 'Color' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'No color' }).getAttribute('aria-pressed')).toBe(
      'true'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close edit machine dialog' }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape and consumes the key', () => {
    const { onClose } = renderModal();
    const escape = createEvent.keyDown(document.body, { key: 'Escape' });

    fireEvent(document.body, escape);

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(escape.defaultPrevented).toBe(true);
  });

  it('saves the trimmed name and the picked colour', async () => {
    const { onSave, onClose } = renderModal();

    fireEvent.change(screen.getByLabelText('Machine Name'), { target: { value: '  Studio  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Blue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith('m1', { name: 'Studio', color: '#3b82f6' });
  });

  it('shows the error and stays open when saving fails', async () => {
    const { onClose } = renderModal({
      onSave: vi.fn().mockRejectedValue(new Error('Server said no')),
    });

    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    expect(await screen.findByText('Server said no')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });
});
