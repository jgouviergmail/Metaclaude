/**
 * Per-workspace plugin enablement.
 *
 * The subtle case is the orphan: a plugin enabled here whose marketplace has
 * since been disabled or removed. The supervisor silently drops it from the
 * run, so if this list hid it too, nothing anywhere would show why the plugin
 * stopped working — it must stay visible, marked, and switch-off-able.
 */

import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders as render } from '@/test/render';
import { MarketplacePluginToggles } from './MarketplacePluginToggles';

const available = [
  { key: 'formatter@tools', description: 'Formats things' },
  { key: 'reviewer@tools', description: null },
];

describe('MarketplacePluginToggles', () => {
  it('renders a switch per available plugin, reflecting the workspace state', () => {
    render(
      <MarketplacePluginToggles
        available={available}
        enabled={{ 'formatter@tools': true }}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByRole('switch', { name: /formatter@tools/ }).getAttribute('aria-checked')).toBe(
      'true',
    );
    expect(screen.getByRole('switch', { name: /reviewer@tools/ }).getAttribute('aria-checked')).toBe(
      'false',
    );
  });

  it('reports the key and the next state on toggle', () => {
    const onChange = vi.fn();
    render(<MarketplacePluginToggles available={available} enabled={{}} onChange={onChange} />);

    fireEvent.click(screen.getByRole('switch', { name: /formatter@tools/ }));
    expect(onChange).toHaveBeenCalledWith('formatter@tools', true);
  });

  it('keeps an enabled plugin visible when its marketplace is gone, marked as such', () => {
    render(
      <MarketplacePluginToggles
        available={available}
        enabled={{ 'legacy@removed-market': true }}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByRole('switch', { name: /legacy@removed-market/ })).toBeDefined();
    expect(screen.getByText(/source missing/i)).toBeDefined();
  });
});
