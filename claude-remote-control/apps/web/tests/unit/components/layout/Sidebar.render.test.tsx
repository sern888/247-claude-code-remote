import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Sidebar } from '@/components/layout/Sidebar';

const machine = {
  id: 'm1',
  name: 'Mac-mini',
  type: 'localhost' as const,
  status: 'online' as const,
  sessionCount: 1,
};

function renderSidebar(overrides: Record<string, unknown> = {}) {
  return render(
    <Sidebar
      machines={[machine]}
      projects={[]}
      collapsed={false}
      onToggle={vi.fn()}
      onAddMachine={vi.fn()}
      {...overrides}
    />
  );
}

describe('Sidebar DOM nesting', () => {
  it('does not nest a button inside another button', () => {
    const { container } = renderSidebar();
    const nested = container.querySelectorAll('button button');
    expect(nested.length).toBe(0);
  });

  it('does not log validateDOMNesting errors', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderSidebar();
    const nestingErrors = errorSpy.mock.calls.filter((args) =>
      String(args[0]).includes('validateDOMNesting')
    );
    errorSpy.mockRestore();
    expect(nestingErrors).toHaveLength(0);
  });

  it('calls onAddMachine without collapsing the Machines section', () => {
    const onAddMachine = vi.fn();
    renderSidebar({ onAddMachine });

    fireEvent.click(screen.getByLabelText('Add machine'));

    expect(onAddMachine).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Mac-mini')).toBeTruthy();
  });

  it('toggles the Machines section when the header is clicked', () => {
    renderSidebar();
    const header = screen.getByText('Machines').closest('button')!;
    expect(header.getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(header);

    expect(header.getAttribute('aria-expanded')).toBe('false');
  });
});
