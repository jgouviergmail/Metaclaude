/**
 * Vitest setup for the component tests.
 *
 * React Testing Library unmounts between cases through an `afterEach` hook it
 * registers itself — but only when Vitest runs with `globals: true`, which this
 * project does not. Without it, every `render` stacks another copy in the same
 * document and the *second* test that queries by role fails with "found multiple
 * elements", pointing at the query rather than at the leak.
 *
 * Registering it here rather than per file means a new test file gets the
 * behaviour by existing.
 */

import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

/**
 * How long `findBy*` and `waitFor` may wait.
 *
 * RTL's default is one second, which measures a state update — and several
 * screens here wait on something else entirely: a dynamic `import()`. The Help
 * page pulls eleven guide chapters through `import.meta.glob`, and the French
 * catalogue is a lazy chunk of its own. On an idle machine both land in
 * milliseconds; when the three packages' suites run at once they sometimes do
 * not, and the case fails on an assertion that would have passed a moment
 * later.
 *
 * Two different files failed that way, once each, in full runs and never in an
 * isolated one. That is the signature of a timeout rather than of a defect, and
 * a flaky suite is worse than a slow one: it teaches everyone to re-run instead
 * of to read. Only patience is widened — nothing about what is asserted
 * changes, and a genuinely broken screen still fails, five seconds later.
 */
configure({ asyncUtilTimeout: 5_000 });

afterEach(() => {
  cleanup();
  // A case that switched to French must not decide the language of the next
  // one. `renderInFrench` writes this key; clearing it here means no test has
  // to remember a `finally`, and forgetting one cannot make a later case pass
  // or fail for a reason it never states.
  try {
    window.localStorage.removeItem('mc-lang');
  } catch {
    /* a blocked storage never held the key in the first place */
  }
});
