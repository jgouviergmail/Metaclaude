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
import { interpolate, Trans, useI18n, usePlural, useT } from './i18n';

vi.mock('@/locales/fr', () => ({
  fr: {
    'Sign in': 'Se connecter',
    'Sent to {n} devices.': 'Envoyé à {n} appareils.',
    '{n} consecutive failure': '{n} échec consécutif',
    '{n} consecutive failures': '{n} échecs consécutifs',
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

/**
 * `plural` — the counted sentence, as two whole keys.
 *
 * The reason it is not an `n === 1` ternary at the call site is the one thing
 * worth pinning: English pluralises at 0, French does not. A ternary written
 * in English says "0 échecs consécutifs" in French, silently, forever.
 */
function Counter({ n }: { n: number }) {
  const plural = usePlural();
  const { lang, setLang } = useI18n();
  return (
    <div>
      <p data-testid="count">
        {plural(n, '{n} consecutive failure', '{n} consecutive failures')}
      </p>
      <p data-testid="extra">{plural(n, '{n} of {total} thing', '{n} of {total} things', { total: 9 })}</p>
      <button type="button" onClick={() => void setLang(lang === 'en' ? 'fr' : 'en')}>
        switch
      </button>
    </div>
  );
}

describe('plural', () => {
  it('picks the singular for one and the plural for the rest, in English', () => {
    const { unmount } = renderWithProviders(<Counter n={1} />);
    expect(screen.getByTestId('count').textContent).toBe('1 consecutive failure');
    unmount();

    renderWithProviders(<Counter n={0} />);
    expect(screen.getByTestId('count').textContent).toBe('0 consecutive failures');
  });

  it('keeps the singular at zero in French, where English does not', async () => {
    renderWithProviders(<Counter n={0} />);
    act(() => screen.getByText('switch').click());

    // The whole point: 'échecs consécutifs' here would be wrong French, and a
    // ternary at the call site produces exactly that.
    expect(await screen.findByText('0 échec consécutif')).toBeTruthy();
  });

  it('translates both forms, not just the singular', async () => {
    renderWithProviders(<Counter n={3} />);
    act(() => screen.getByText('switch').click());

    expect(await screen.findByText('3 échecs consécutifs')).toBeTruthy();
  });

  it('supplies {n} and passes the caller’s other variables through', () => {
    renderWithProviders(<Counter n={2} />);
    expect(screen.getByTestId('extra').textContent).toBe('2 of 9 things');
  });
});

/**
 * `Trans` — a translated sentence with elements inside it.
 *
 * The sentences left in English were exactly the ones carrying a `<code>` or a
 * `<Link>`: `interpolate` substitutes strings, and splitting them into
 * `t('The last update')` plus a hard-coded tail translates three words and
 * leaves the rest in an order French would not use.
 */
describe('Trans', () => {
  it('substitutes nodes where the placeholders are, keeping the text around them', () => {
    renderWithProviders(
      <Trans
        template="Everything under {path} is erased."
        values={{ path: <code>/srv/ws/alpha</code> }}
      />,
    );

    expect(screen.getByText('/srv/ws/alpha').tagName).toBe('CODE');
    expect(document.body.textContent).toBe('Everything under /srv/ws/alpha is erased.');
  });

  it('handles several placeholders, and one at either end', () => {
    renderWithProviders(
      <Trans
        template="{a} then {b}"
        values={{ a: <b>first</b>, b: <i>second</i> }}
      />,
    );

    expect(document.body.textContent).toBe('first then second');
  });

  it('leaves an unknown placeholder visible rather than dropping it', () => {
    // The same rule `interpolate` follows: a missing translation should read
    // oddly, never silently lose the path it was meant to show.
    renderWithProviders(<Trans template="Under {path} and {other}" values={{ path: <code>/x</code> }} />);

    expect(document.body.textContent).toBe('Under /x and {other}');
  });

  it('renders a template with no placeholders unchanged', () => {
    renderWithProviders(<Trans template="Nothing to substitute." values={{}} />);

    expect(document.body.textContent).toBe('Nothing to substitute.');
  });

  it('accepts a value that is not an element', () => {
    renderWithProviders(<Trans template="{n} left" values={{ n: 3 }} />);

    expect(document.body.textContent).toBe('3 left');
  });
});
