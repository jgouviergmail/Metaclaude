/**
 * The layout primitives, tested for the contracts that were missing.
 *
 * Before these existed the app had a vocabulary of controls and none of
 * structure, so every screen invented its own. Measured on the tree they
 * replace: ten pages, four different maximum widths, three paddings and four
 * vertical rhythms, for one repeated shape. That is what made the interface
 * read as unstructured, and it is why `AgentsPage.tsx` reached 2584 lines.
 *
 * happy-dom has no layout, so nothing here can prove a page *looks* right —
 * `scripts/responsive.mjs` does that in a real browser at three widths and two
 * languages. What these tests hold is what a component can be held to: the
 * width lives in one place, a section owns its heading level, and a grid child
 * can shrink.
 */

import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithProviders as render } from '@/test/render';
import { Grid, Page, PageBody, Section } from './layout';

describe('Page', () => {
  it('owns the maximum width, so a screen never names its own', () => {
    render(<Page width="prose">contenu</Page>);
    const inner = screen.getByText('contenu');
    expect(inner.className).toContain('max-w-3xl');
    expect(inner.className).toContain('mx-auto');
  });

  it('gives each named width a different value, or the names mean nothing', () => {
    const widths = ['prose', 'list', 'standard', 'wide'] as const;
    const seen = new Set<string>();
    for (const width of widths) {
      const { unmount } = render(<Page width={width}>{width}</Page>);
      const found = screen
        .getByText(width)
        .className.split(' ')
        .find((token) => token.startsWith('max-w-'));
      expect(found, width).toBeTruthy();
      seen.add(found as string);
      unmount();
    }
    expect(seen.size).toBe(widths.length);
  });

  it('scrolls itself, because the page body never scrolls in this app', () => {
    // `body` is `overflow: hidden` — the shell owns the viewport and each pane
    // scrolls on its own. A Page that forgot this would simply be uncroppable.
    const { container } = render(<Page>contenu</Page>);
    expect((container.firstElementChild as HTMLElement).className).toContain('overflow-y-auto');
  });

  it('carries the density rhythm between its children, and can be told not to', () => {
    render(<Page>rythme</Page>);
    expect(screen.getByText('rythme').className).toContain('space-y-section');

    const { container } = render(
      <Page gap="none">
        <span>serré</span>
      </Page>,
    );
    expect(container.textContent).toContain('serré');
    expect(screen.getByText('serré').parentElement?.className).not.toContain('space-y-section');
  });

  it('exposes its bounded body alone, for a screen whose tabs must wrap both halves', () => {
    // Radix requires `Tabs.Root` to wrap the list and the panels, so a screen
    // with a sticky strip cannot put anything between its scroller and that
    // strip. It keeps its own scroller and wraps the panels in a PageBody —
    // and the width still lives in exactly one place.
    const { container } = render(
      <PageBody width="standard" gap="none">
        <span>panneaux</span>
      </PageBody>,
    );
    const body = container.firstElementChild as HTMLElement;
    expect(body.className).toContain('max-w-5xl');
    expect(body.className).not.toContain('overflow-y-auto');
  });

  it('uses the density gutter rather than a fixed padding', () => {
    render(<Page>gouttière</Page>);
    expect(screen.getByText('gouttière').className).toContain('p-gutter');
  });
});

describe('Section', () => {
  it('renders its title as a level-2 heading by default', () => {
    render(<Section title="Exécution">contenu</Section>);
    expect(screen.getByRole('heading', { name: 'Exécution', level: 2 })).toBeDefined();
  });

  it('steps the level down when it is genuinely nested', () => {
    render(
      <Section title="Exécution">
        <Section title="Plafonds" level={3}>
          contenu
        </Section>
      </Section>,
    );
    expect(screen.getByRole('heading', { name: 'Exécution', level: 2 })).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Plafonds', level: 3 })).toBeDefined();
  });

  it('names the region with its own title, so it can be jumped to', () => {
    render(<Section title="Conservation">contenu</Section>);
    expect(screen.getByRole('region', { name: 'Conservation' })).toBeDefined();
  });

  it('separates with a rule rather than enclosing in a box', () => {
    // The point of the redesign: 138 bordered boxes made every block the same
    // weight, so nothing led the eye. A section is a heading and a line.
    const { container } = render(<Section title="Exécution">contenu</Section>);
    const region = container.querySelector('section') as HTMLElement;
    expect(region.className).not.toContain('rounded-xl');
    expect(region.querySelector('header')?.className).toContain('border-b');
  });

  it('keeps an icon out of the heading, where it would join the name', () => {
    render(
      <Section title="Serveurs MCP" icon={<svg data-testid="icone" />}>
        contenu
      </Section>,
    );
    const heading = screen.getByRole('heading', { name: 'Serveurs MCP', level: 2 });
    expect(heading.querySelector('[data-testid="icone"]')).toBeNull();
    expect(screen.getByTestId('icone').closest('[aria-hidden="true"]')).not.toBeNull();
  });

  it('shows a description and actions when given them', () => {
    render(
      <Section title="Exécution" description="Prend effet au prochain run." actions={<button type="button">Ajouter</button>}>
        contenu
      </Section>,
    );
    expect(screen.getByText('Prend effet au prochain run.')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Ajouter' })).toBeDefined();
  });
});

describe('Grid', () => {
  it('lets its children shrink, which is the defect it exists to prevent', () => {
    // A grid item's `min-width` is `auto`: it refuses to go below its content's
    // minimum. On the dashboard that blew a card out to 542px — 697 in French —
    // inside a 358px column, with nothing scrollable to reach it.
    const { container } = render(
      <Grid cols={3}>
        <span>a</span>
      </Grid>,
    );
    const grid = container.firstElementChild as HTMLElement;
    expect(grid.className).toContain('[&>*]:min-w-0');
  });

  it('starts at one column and opens up at the breakpoint the caller names', () => {
    // The first version fixed the breakpoint per column count and matched none
    // of the ten hand-written grids: two charts want `xl`, two cards want `sm`.
    // How many columns is the layout's business; when they are worth having is
    // the content's, and only the caller knows that.
    const { container } = render(
      <Grid cols={3}>
        <span>a</span>
      </Grid>,
    );
    const grid = container.firstElementChild as HTMLElement;
    expect(grid.className).toContain('grid-cols-1');
    expect(grid.className).toContain('lg:grid-cols-3');
  });

  it('honours a different breakpoint without changing the column count', () => {
    const { container } = render(
      <Grid cols={2} from="xl">
        <span>a</span>
      </Grid>,
    );
    const grid = container.firstElementChild as HTMLElement;
    expect(grid.className).toContain('xl:grid-cols-2');
    expect(grid.className).not.toContain('lg:grid-cols');
  });

  it('uses the density rhythm for its gutter', () => {
    const { container } = render(
      <Grid cols={2}>
        <span>a</span>
      </Grid>,
    );
    expect((container.firstElementChild as HTMLElement).className).toContain('gap-');
  });
});
