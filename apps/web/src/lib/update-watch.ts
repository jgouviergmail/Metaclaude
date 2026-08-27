/**
 * When may the Updates card reload the page?
 *
 * Only on a success it watched happen. status.json survives across deploys,
 * so "succeeded" alone may be last week's news — reloading on it would put
 * every visit to the Settings screen one poll away from an unprompted
 * refresh. Pure on purpose: the transition rule is the part worth pinning,
 * free of timers and query machinery.
 */

import type { UpdateApplyStatus } from '@metaclaude/shared';

export interface UpdateWatch {
  sawInFlight: boolean;
  reload: boolean;
}

export function nextUpdateWatch(
  previous: UpdateWatch,
  state: UpdateApplyStatus['state'] | undefined,
): UpdateWatch {
  if (state === 'requested' || state === 'running') {
    return { sawInFlight: true, reload: false };
  }
  if (state === 'succeeded' && previous.sawInFlight) {
    return { sawInFlight: false, reload: true };
  }
  return { sawInFlight: previous.sawInFlight, reload: false };
}
