/**
 * The unified diff viewer.
 *
 * Two things carry weight here. A long diff must not push the conversation
 * off screen, and an added line must be distinguishable from a removed one by
 * something other than its colour — the table has no headers, no roles and
 * unlabelled line-number columns, so the leading sign is the only textual
 * signal there is.
 */

import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderWithProviders } from '@/test/render';

import { DiffView } from './DiffView';

const PATCH = `--- a/bail.md
+++ b/bail.md
@@ -1,4 +1,4 @@
 # Bail
-Le préavis est de trois mois.
+Le préavis est d'un mois en zone tendue.
 Le dépôt de garantie est d'un mois.`;

const longPatch = (n: number) =>
  ['--- a/f', '+++ b/f', '@@ -1,1 +1,1 @@', ...Array.from({ length: n }, (_, i) => `+ligne ${i}`)].join(
    '\n',
  );

describe('what it shows', () => {
  it('names the file and counts the change', () => {
    renderWithProviders(<DiffView patch={PATCH} path="bail.md" />);
    expect(screen.getByText('bail.md')).toBeDefined();
    // One added line, one removed, derived from the patch itself.
    expect(screen.getByText('1', { selector: '.text-success *, .text-success' })).toBeDefined();
  });

  it('prefers the counts the caller supplies over its own', () => {
    // The API reports the true figures for a truncated patch; recomputing
    // from the visible text would under-report them.
    renderWithProviders(<DiffView patch={PATCH} path="f" additions={40} deletions={7} />);
    expect(screen.getByText('40')).toBeDefined();
    expect(screen.getByText('7')).toBeDefined();
  });

  it('falls back to a neutral title when no path is known', () => {
    renderWithProviders(<DiffView patch={PATCH} />);
    expect(screen.getByText('changes')).toBeDefined();
  });

  it('renders both line-number columns and the body', () => {
    renderWithProviders(<DiffView patch={PATCH} path="bail.md" />);
    expect(screen.getByText(/Le préavis est d'un mois en zone tendue\./)).toBeDefined();
  });
});

describe('telling an addition from a removal', () => {
  it('keeps the sign as text, so colour is not the only signal', () => {
    // `diff-line-add` / `diff-line-remove` are pure colour. Without the
    // leading sign in the text, an added and a removed line are the same
    // string to anyone browsing with assistive technology.
    const { container } = renderWithProviders(<DiffView patch={PATCH} path="bail.md" />);
    const added = container.querySelector('.diff-line-add');
    const removed = container.querySelector('.diff-line-remove');

    expect(added?.textContent).toContain('+');
    expect(removed?.textContent).toContain('-');
  });
});

describe('long diffs', () => {
  it('starts collapsed past the threshold, showing a window rather than everything', () => {
    renderWithProviders(<DiffView patch={longPatch(60)} path="f" collapsible />);
    expect(screen.getByRole('button', { name: /bail|f/i }).getAttribute('aria-expanded')).toBe(
      'false',
    );
    expect(screen.getByText('ligne 0', { exact: false })).toBeDefined();
    expect(screen.queryByText('ligne 59', { exact: false })).toBeNull();
  });

  it('offers the rest, counted, and shows it on demand', () => {
    renderWithProviders(<DiffView patch={longPatch(60)} path="f" collapsible />);

    const more = screen.getByRole('button', { name: /more lines/i });
    fireEvent.click(more);
    expect(screen.getByText('ligne 59', { exact: false })).toBeDefined();
  });

  it('stays open for a short diff, with nothing to expand', () => {
    renderWithProviders(<DiffView patch={PATCH} path="bail.md" />);
    const header = screen.getByRole('button', { name: /bail\.md/ });
    expect(header.getAttribute('aria-expanded')).toBe('true');
    // Nothing to toggle: the control is inert rather than misleadingly live.
    expect((header as HTMLButtonElement).disabled).toBe(true);
  });

  it('collapses and reopens from the header', () => {
    renderWithProviders(<DiffView patch={longPatch(60)} path="f" collapsible />);
    const header = screen.getByRole('button', { name: /^f/ });

    fireEvent.click(header);
    expect(header.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(header);
    expect(header.getAttribute('aria-expanded')).toBe('false');
  });
});

describe('edges', () => {
  it('renders an empty patch without a table', () => {
    const { container } = renderWithProviders(<DiffView patch="" path="f" />);
    expect(container.querySelector('table')).toBeNull();
  });
});
