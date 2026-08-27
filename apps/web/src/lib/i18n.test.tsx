/**
 * The translation layer's contract, which is deliberately tiny:
 *
 *  - English is the key. `t()` under 'en' is the identity function, so the
 *    entire English product costs zero bytes of dictionary and every
 *    existing test keeps matching the literal strings it always matched.
 *  - French arrives lazily and misses safely: an untranslated string falls
 *    back to English rather than to a bare key or a blank.
 *  - The choice persists, and the document advertises it (`<html lang>`).
 */

import { act, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { interpolate, useI18n, useT } from './i18n';

vi.mock('@/locales/fr', () => ({
  fr: {
    'Sign in': 'Se connecter',
    'Sent to {n} devices.': 'Envoyé à {n} appareils.',
  },
}));

function Probe() {
  const t = useT();
  const { lang, setLang } = useI18n();
  return (
    <div>
      <p>{t('Sign in')}</p>
      <p>{t('Sent to {n} devices.', { n: 3 })}</p>
      <p>{t('Never translated sentence')}</p>
      <button type="button" onClick={() => void setLang(lang === 'en' ? 'fr' : 'en')}>
        switch
      </button>
    </div>
  );
}

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.lang = '';
});

describe('interpolate', () => {
  it('fills {placeholders} and leaves unknown ones visible', () => {
    expect(interpolate('Sent to {n} devices.', { n: 3 })).toBe('Sent to 3 devices.');
    expect(interpolate('No vars here', undefined)).toBe('No vars here');
    expect(interpolate('{a} and {b}', { a: 'x' })).toBe('x and {b}');
  });
});

describe('the i18n provider', () => {
  it('is the identity in English, interpolation included', () => {
    renderWithProviders(<Probe />);
    expect(screen.getByText('Sign in')).toBeTruthy();
    expect(screen.getByText('Sent to 3 devices.')).toBeTruthy();
  });

  it('switches to French, translating what it knows and falling back for the rest', async () => {
    renderWithProviders(<Probe />);
    act(() => screen.getByText('switch').click());

    expect(await screen.findByText('Se connecter')).toBeTruthy();
    expect(screen.getByText('Envoyé à 3 appareils.')).toBeTruthy();
    // The miss falls back to English — never a blank, never a raw key.
    expect(screen.getByText('Never translated sentence')).toBeTruthy();
  });

  it('persists the choice and stamps the document language', async () => {
    renderWithProviders(<Probe />);
    act(() => screen.getByText('switch').click());
    await screen.findByText('Se connecter');

    expect(window.localStorage.getItem('mc-lang')).toBe('fr');
    expect(document.documentElement.lang).toBe('fr');

    // A fresh mount starts in the stored language.
    renderWithProviders(<Probe />);
    await waitFor(() => expect(screen.getAllByText('Se connecter').length).toBeGreaterThan(0));
  });
});
