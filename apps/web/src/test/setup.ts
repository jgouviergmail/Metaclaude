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

import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
});
