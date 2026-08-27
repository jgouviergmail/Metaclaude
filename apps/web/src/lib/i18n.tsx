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
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

export type Lang = 'en' | 'fr';

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

interface I18nContextValue {
  lang: Lang;
  setLang: (lang: Lang) => Promise<void>;
  t: (text: string, vars?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(defaultLang);
  const [dict, setDict] = useState<Dict | null>(null);

  const loadDict = useCallback(async (next: Lang): Promise<Dict | null> => {
    if (next !== 'fr') return null;
    const { fr } = await import('@/locales/fr');
    return fr;
  }, []);

  const setLang = useCallback(
    async (next: Lang) => {
      const nextDict = await loadDict(next).catch(() => null);
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

  const value = useMemo(() => ({ lang, setLang, t }), [lang, setLang, t]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext);
  if (!context) throw new Error('useI18n must be used inside I18nProvider');
  return context;
}

/** The everyday hook: `const t = useT()` then `t('Sign in')`. */
export function useT(): I18nContextValue['t'] {
  return useI18n().t;
}
