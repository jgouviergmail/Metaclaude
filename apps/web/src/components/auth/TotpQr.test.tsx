/**
 * The enrolment QR code.
 *
 * Scanning is how everyone actually enrols an authenticator; the setup key
 * stays alongside as the fallback. The encoding runs entirely in the page —
 * CSP forbids an external image service, and an otpauth URI is a secret, so
 * shipping it to one would be wrong even if CSP allowed it.
 */

import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { TotpQr } from './TotpQr';

const URI = 'otpauth://totp/Metaclaude:owner?secret=JBSWY3DPEHPK3PXP&issuer=Metaclaude';

describe('TotpQr', () => {
  it('renders a scannable image with an accessible name', () => {
    renderWithProviders(<TotpQr uri={URI} />);
    const figure = screen.getByRole('img', { name: /authenticator/i });
    expect(figure.querySelector('path')?.getAttribute('d')).toBeTruthy();
  });

  it('encodes the URI it was given, not a constant', () => {
    const { unmount } = renderWithProviders(<TotpQr uri={URI} />);
    const first = screen.getByRole('img').querySelector('path')?.getAttribute('d');
    unmount();

    renderWithProviders(<TotpQr uri={`${URI}-autre`} />);
    const second = screen.getByRole('img').querySelector('path')?.getAttribute('d');

    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
  });

  it('stays dark-on-light in both themes, because a camera does not have a theme', () => {
    // The one deliberate exemption from the token rule: `text-ink` inverts in
    // dark mode, and near-white modules on the white quiet zone would not scan
    // at all. Both colours are explicit — dark modules, light ground — so the
    // theme cannot break the scan.
    renderWithProviders(<TotpQr uri={URI} />);
    const figure = screen.getByRole('img');
    expect(figure.className).toContain('bg-white');
    const fill = figure.querySelector('path')?.getAttribute('fill') ?? '';
    expect(fill).toMatch(/^#[0-3]/);
  });
});
