import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ConnectionGuide } from '@/components/ConnectionGuide';

describe('ConnectionGuide', () => {
  it('does not describe Tailscale Funnel as private', () => {
    const { container } = render(<ConnectionGuide />);

    expect(container.textContent).not.toMatch(/secure and private/i);
  });

  it('warns that a Funnel URL is public and recommends tailnet-only access', () => {
    render(<ConnectionGuide />);

    const funnelCard = screen.getByRole('heading', { name: 'Tailscale Funnel' }).closest('div')
      ?.parentElement as HTMLElement;

    expect(funnelCard.textContent).toMatch(/public URL/i);
    expect(funnelCard.textContent).toMatch(/anyone who has the URL can open a terminal/i);
    expect(funnelCard.textContent).toMatch(/tailscale serve/);
  });
});
