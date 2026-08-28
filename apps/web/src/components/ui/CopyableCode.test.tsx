/**
 * A value with a copy button — TOTP secrets, pairing links, shell commands.
 *
 * Small, but it is how a recovery code or a 2FA secret leaves the screen, so
 * what matters is that the confirmation means the copy actually happened: a
 * tick shown on a failed clipboard write is worse than no tick at all, since
 * the user walks away believing they have the secret.
 */

import { act, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/render';

import { CopyableCode } from './CopyableCode';

const { copyToClipboard } = vi.hoisted(() => ({ copyToClipboard: vi.fn() }));

vi.mock('@/lib/utils', async () => ({
  ...(await vi.importActual<typeof import('@/lib/utils')>('@/lib/utils')),
  copyToClipboard,
}));

const ticked = () => document.querySelector('.lucide-check') !== null;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  copyToClipboard.mockResolvedValue(true);
});

afterEach(() => vi.useRealTimers());

describe('showing the value', () => {
  it('renders it verbatim, so a secret can be read as well as copied', () => {
    renderWithProviders(<CopyableCode value="JBSWY3DPEHPK3PXP" />);
    expect(screen.getByText('JBSWY3DPEHPK3PXP')).toBeDefined();
  });

  it('names the button for a screen reader, and takes a caller’s wording', () => {
    const { rerender } = renderWithProviders(<CopyableCode value="abc" />);
    expect(screen.getByRole('button', { name: 'Copy' })).toBeDefined();

    rerender(<CopyableCode value="abc" label="Copy the pairing link" />);
    expect(screen.getByRole('button', { name: 'Copy the pairing link' })).toBeDefined();
  });
});

describe('copying', () => {
  it('hands the exact value to the clipboard', async () => {
    renderWithProviders(<CopyableCode value="JBSWY3DPEHPK3PXP" />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(copyToClipboard).toHaveBeenCalledWith('JBSWY3DPEHPK3PXP');
  });

  it('confirms with a tick, then returns to the copy affordance', async () => {
    renderWithProviders(<CopyableCode value="abc" />);
    expect(ticked()).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await act(async () => undefined);
    expect(ticked()).toBe(true);

    // The tick is a confirmation, not a state: it must clear so the control
    // can be used again without the user wondering whether it did anything.
    await act(async () => {
      vi.advanceTimersByTime(1700);
    });
    expect(ticked()).toBe(false);
  });

  it('does not claim success when the clipboard refused', async () => {
    // Clipboard writes genuinely fail — an insecure context, a denied
    // permission — and a tick there sends the user away believing they hold
    // a recovery code they never copied.
    copyToClipboard.mockResolvedValue(false);
    renderWithProviders(<CopyableCode value="abc" />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await act(async () => undefined);
    expect(ticked()).toBe(false);
  });
});
