/**
 * Rendering a component the way the application renders it.
 *
 * `main.tsx` establishes three providers around everything: React Query, the
 * router, and the tooltip provider. A component that reaches for any of them
 * throws when rendered bare — `Switch` does, through `Tooltip` — so a test that
 * calls RTL's `render` directly is not testing the component, it is testing the
 * component minus its context.
 *
 * Keeping the stack here rather than in each test file means the two stay in
 * step: a provider added to `main.tsx` is added once here and every existing
 * test keeps passing for the right reason.
 *
 * The query defaults deliberately differ from production in the two ways that
 * make tests lie: retries turn a deliberate 500 into a slow pass, and the 30s
 * poll leaves a timer running after the case ends.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderOptions, type RenderResult } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { TooltipProvider } from '@/components/ui/primitives';
import { I18nProvider } from '@/lib/i18n';

export interface RenderWithProvidersOptions extends Omit<RenderOptions, 'wrapper'> {
  /** Initial history entries, for a component that reads the route. */
  route?: string;
  /** Supply your own client to seed the cache or assert on it afterwards. */
  queryClient?: QueryClient;
}

export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchInterval: false, refetchOnWindowFocus: false, staleTime: 0 },
      mutations: { retry: false },
    },
  });
}

/**
 * Render with the French catalogue in force, deterministically.
 *
 * Setting `mc-lang` and rendering is not enough on its own: the provider
 * fetches the dictionary with a dynamic `import()`, so the first assertion
 * races a chunk load. `setup.ts` widened `asyncUtilTimeout` to five seconds for
 * exactly this, and a heavily loaded run still lost the race — a suite where
 * three packages compile at once spent 155 s inside `import`. Awaiting the
 * module here puts it in the ESM cache *before* the render, which removes the
 * timing from the question rather than giving it more room.
 *
 * `setup.ts` clears the key after each case, so a test that switches language
 * cannot leak it into the next one.
 */
export async function renderInFrench(
  ui: ReactElement,
  options: RenderWithProvidersOptions = {},
): Promise<RenderResult & { queryClient: QueryClient }> {
  await import('@/locales/fr');
  window.localStorage.setItem('mc-lang', 'fr');
  return renderWithProviders(ui, options);
}

export function renderWithProviders(
  ui: ReactElement,
  { route = '/', queryClient = createTestQueryClient(), ...options }: RenderWithProvidersOptions = {},
): RenderResult & { queryClient: QueryClient } {
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <MemoryRouter initialEntries={[route]}>
          <TooltipProvider>{children}</TooltipProvider>
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>
  );

  return { ...render(ui, { wrapper: Wrapper, ...options }), queryClient };
}
