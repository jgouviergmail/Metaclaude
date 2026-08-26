/**
 * The Help screen, rendered against the real guide on disk.
 *
 * No fixture corpus: the chapters these tests read are the chapters the user
 * reads, so a guide that stops loading — or a chapter whose heading breaks —
 * fails here rather than shipping as an empty Help screen.
 */

import { screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { APP_VERSION } from '@metaclaude/shared';
import { renderWithProviders } from '@/test/render';
import { HelpPage } from './HelpPage';

describe('HelpPage', () => {
  it('lists every chapter and renders the first one from the real corpus', async () => {
    renderWithProviders(<HelpPage />);

    const nav = await screen.findByRole('navigation', { name: /guide chapters/i });
    expect(nav.querySelectorAll('button').length).toBeGreaterThanOrEqual(9);

    // The opening chapter's own words, sanitised and on screen.
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Getting started' })).toBeTruthy();
    });
  });

  it('search narrows to the chapters that answer, and opens one', async () => {
    renderWithProviders(<HelpPage />);
    await screen.findByRole('heading', { name: 'Getting started' });

    fireEvent.change(screen.getByLabelText(/search the guide/i), {
      target: { value: 'recovery codes' },
    });

    // Both chapters that discuss recovery codes surface; picking one opens it.
    const results = await screen.findAllByText(/recovery code/i);
    expect(results.length).toBeGreaterThan(0);

    const hit = screen
      .getAllByRole('button')
      .find((button) => /settings and security/i.test(button.textContent ?? ''));
    expect(hit).toBeTruthy();
    fireEvent.click(hit as HTMLElement);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Settings and security' })).toBeTruthy();
    });
  });

  it("the What's new tab renders the changelog with the running version", async () => {
    renderWithProviders(<HelpPage />);
    await screen.findByRole('heading', { name: 'Getting started' });

    // Radix activates a tab on mousedown, not on click — the same event a
    // real pointer sends first.
    const tabButton = screen.getByRole('tab', { name: /what's new/i });
    fireEvent.mouseDown(tabButton);
    fireEvent.click(tabButton);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /changelog/i })).toBeTruthy();
    });
    // The subtitle states the running version; the changelog must know it too —
    // the check.sh guard enforces the same agreement at release time. Asserted
    // against APP_VERSION itself, not a literal: a version bump must not turn
    // this test into a lie about an older release.
    const version = APP_VERSION.replace(/\./g, '\\.');
    expect(screen.getAllByText(new RegExp(version)).length).toBeGreaterThanOrEqual(2);
  });
});
