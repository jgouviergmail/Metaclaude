/**
 * Translation, sized to this product: two languages, one operator.
 *
 * The English string IS the key (the gettext pattern). That one decision
 * does most of the work: the English product costs zero bytes of
 * dictionary, a missing translation falls back to something a person can
 * read rather than a raw key, and every existing test keeps matching the
 * literal strings the components always carried. The French dictionary is
 * a plain object loaded with a dynamic `import()` the first time it is
 * needed, so the entry chunk never pays for it.
 *
 * Module-level constants (nav entries, step lists) keep English labels as
 * *data* and translate at render time with `t(entry.label)` — a constant
 * evaluated at import time must never bake a language in.
 */

import {
  createContext,
  Fragment,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { currentLang, publishLang, type Lang } from './lang';

export type { Lang };

const STORAGE_KEY = 'mc-lang';

type Dict = Record<string, string>;

/** Fill `{placeholders}`; an unknown one stays visible rather than vanishing. */
export function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole,
  );
}

function storedLang(): Lang | null {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value === 'fr' || value === 'en' ? value : null;
  } catch {
    return null;
  }
}

function defaultLang(): Lang {
  return storedLang() ?? (navigator.language?.toLowerCase().startsWith('fr') ? 'fr' : 'en');
}

/**
 * Which of the two forms a count takes.
 *
 * English pluralises everything but 1; French keeps the singular for 0 as well
 * ("0 échec consécutif"). That one-language difference is the whole reason this
 * lives here rather than as a `n === 1` ternary at each call site: the ternary
 * is written in English and silently stays English once the sentence is
 * translated.
 */
function isPlural(lang: Lang, count: number): boolean {
  return lang === 'fr' ? Math.abs(count) >= 2 : count !== 1;
}

interface I18nContextValue {
  lang: Lang;
  setLang: (lang: Lang) => Promise<void>;
  t: (text: string, vars?: Record<string, string | number>) => string;
  /**
   * A counted sentence, as two whole catalogue keys.
   *
   * Both forms are translated in full — `'{n} run'` and `'{n} runs'` — because
   * a language that inflects the noun cannot be served by gluing an `s` onto
   * the singular, and `'{n} run(s)'` reads as a form to fill in rather than a
   * sentence. `{n}` is supplied; anything else comes from `vars`.
   */
  plural: (
    count: number,
    one: string,
    other: string,
    vars?: Record<string, string | number>,
  ) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  // Published during the initialiser, so a date formatted in the very first
  // render already reads the stored choice rather than the default.
  const [lang, setLangState] = useState<Lang>(() => {
    const initial = defaultLang();
    publishLang(initial);
    return initial;
  });
  const [dict, setDict] = useState<Dict | null>(null);

  const loadDict = useCallback(async (next: Lang): Promise<Dict | null> => {
    if (next !== 'fr') return null;
    const { fr } = await import('@/locales/fr');
    return fr;
  }, []);

  const setLang = useCallback(
    async (next: Lang) => {
      const nextDict = await loadDict(next).catch(() => null);
      // Before the state update, so the render it triggers already formats
      // dates in the language it is about to show. See lib/lang.ts.
      publishLang(next);
      setDict(nextDict);
      setLangState(next);
      try {
        window.localStorage.setItem(STORAGE_KEY, next);
      } catch {
        /* a blocked storage loses persistence, never the switch */
      }
    },
    [loadDict],
  );

  // A stored (or browser-default) French start needs its dictionary fetched.
  useEffect(() => {
    if (lang === 'fr' && dict === null) {
      void loadDict('fr')
        .then(setDict)
        .catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once for the initial language
  }, []);

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const t = useCallback(
    (text: string, vars?: Record<string, string | number>) =>
      interpolate((lang === 'fr' && dict?.[text]) || text, vars),
    [lang, dict],
  );

  const plural = useCallback(
    (
      count: number,
      one: string,
      other: string,
      vars?: Record<string, string | number>,
    ) => t(isPlural(lang, count) ? other : one, { n: count, ...vars }),
    [lang, t],
  );

  const value = useMemo(() => ({ lang, setLang, t, plural }), [lang, setLang, t, plural]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext);
  if (!context) throw new Error('useI18n must be used inside I18nProvider');
  return context;
}

/**
 * `t` as a value, for the handful of helpers that are not components.
 *
 * A plain function — `sessionTitle(session)`, `describeUserAgent(ua)` — cannot
 * call a hook, so it takes the translator as an argument instead of pretending
 * to be a component. Anything that merely *returns* a key ("Good morning") does
 * not need this: the caller translates.
 */
export type TranslateFn = I18nContextValue['t'];

/** Its counted sibling, for the same reason. */
export type PluralFn = I18nContextValue['plural'];

/** The everyday hook: `const t = useT()` then `t('Sign in')`. */
export function useT(): I18nContextValue['t'] {
  return useI18n().t;
}

/** Its counted sibling: `const plural = usePlural()` then `plural(n, '{n} run', '{n} runs')`. */
export function usePlural(): I18nContextValue['plural'] {
  return useI18n().plural;
}

/**
 * A translated sentence with elements inside it.
 *
 * `interpolate` substitutes strings, which covers most of the catalogue and
 * none of the sentences that carry a `<code>`, a `<Link>` or a number in a
 * different weight. Those were the ones left in English — not because nobody
 * got to them, but because splitting a sentence into `t('The last update')`
 * plus a hard-coded tail translates the first three words and leaves the rest
 * as it was, in an order French would not use anyway.
 *
 * So the placeholder stays in the template and the *node* is substituted here:
 *
 *   <Trans template={t('Everything under {path} is erased.')}
 *          values={{ path: <code>{workspace.path}</code> }} />
 *
 * The template arrives already translated — `t()` with no variables returns it
 * with the `{name}` markers intact — so this needs no access to the catalogue
 * and stays a pure function of its props. A placeholder with no value is left
 * as written rather than dropped: a missing translation should read oddly, not
 * silently lose a path.
 */
export function Trans({
  template,
  values,
}: {
  template: string;
  values: Record<string, ReactNode>;
}): ReactNode {
  const parts = template.split(/(\{\w+\})/g);
  return (
    <>
      {parts.map((part, index) => {
        const name = /^\{(\w+)\}$/.exec(part)?.[1];
        const value = name !== undefined ? values[name] : undefined;
        // eslint-disable-next-line react/no-array-index-key -- the split is
        // positional and stable for a given template; there is no other key.
        return <Fragment key={index}>{name !== undefined && name in values ? value : part}</Fragment>;
      })}
    </>
  );
}
