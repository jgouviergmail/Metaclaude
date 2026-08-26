/**
 * The marketplace list — the store's shelf.
 *
 * What matters: the catalogue's failure text is shown verbatim (a broken
 * source that renders as nothing is indistinguishable from an empty one), and
 * the enable switch reports the marketplace so disabling can sever its
 * plugins server-side.
 */

import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Marketplace, MarketplaceCatalogue } from '@metaclaude/shared';
import { renderWithProviders as render } from '@/test/render';
import { MarketplaceList } from './MarketplaceList';

const marketplace = (over: Partial<Marketplace> = {}): Marketplace => ({
  id: 'mkt_1',
  name: 'anthropic-tools',
  source: { source: 'github', repo: 'anthropics/claude-plugins' },
  enabled: true,
  createdAt: 1_000,
  ...over,
});

const catalogue = (over: Partial<MarketplaceCatalogue> = {}): MarketplaceCatalogue => ({
  marketplaceId: 'mkt_1',
  name: 'anthropic-tools',
  fetchedAt: 2_000,
  plugins: [
    { name: 'formatter', description: 'Formats things', version: '1.0.0', author: null },
  ],
  error: null,
  ...over,
});

describe('MarketplaceList', () => {
  it('shows the source and the catalogue plugins', () => {
    render(
      <MarketplaceList
        marketplaces={[marketplace()]}
        catalogues={{ mkt_1: catalogue() }}
        onToggle={vi.fn()}
        onRemove={vi.fn()}
      />,
    );

    expect(screen.getByText('anthropic-tools')).toBeDefined();
    expect(screen.getByText('anthropics/claude-plugins')).toBeDefined();
    expect(screen.getByText('formatter')).toBeDefined();
    expect(screen.getByText('Formats things')).toBeDefined();
  });

  it('shows a broken catalogue as its error text, verbatim', () => {
    render(
      <MarketplaceList
        marketplaces={[marketplace()]}
        catalogues={{ mkt_1: catalogue({ plugins: [], error: '403 rate limited' }) }}
        onToggle={vi.fn()}
        onRemove={vi.fn()}
      />,
    );

    expect(screen.getByText(/403 rate limited/)).toBeDefined();
  });

  it('reports the marketplace when its switch is toggled', () => {
    const onToggle = vi.fn();
    const mkt = marketplace();
    render(
      <MarketplaceList
        marketplaces={[mkt]}
        catalogues={{}}
        onToggle={onToggle}
        onRemove={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('switch', { name: /anthropic-tools/i }));
    expect(onToggle).toHaveBeenCalledWith(mkt);
  });
});
