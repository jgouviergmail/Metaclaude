/**
 * Whether a run can be rewound, and with what.
 *
 * A rewind overwrites the operator's working tree with an older copy of it, so
 * every refusal here is a case where going ahead would either destroy work or
 * claim to have restored something it did not. Kept as a pure function so those
 * cases are pinned by tests rather than by reading the kernel.
 *
 * The refusals are worded for the person who pressed the button. "Cannot
 * rewind" is true and useless; "checkpointing was off for this workspace" tells
 * them what to change so the *next* run is recoverable, which is the only thing
 * they can act on once the files are already gone.
 */

import type { Run, Session } from '@metaclaude/shared';

export type RewindPlan =
  | { ok: true; claudeSessionId: string; rewindPoint: string }
  | { ok: false; reason: string };

/** Statuses where the CLI may still be writing to the workspace. */
const IN_FLIGHT = new Set<Run['status']>(['queued', 'running', 'waiting_approval']);

export function planRewind(run: Run, session: Session): RewindPlan {
  if (IN_FLIGHT.has(run.status)) {
    return {
      ok: false,
      reason: 'This run is still going. Stop it first, then rewind.',
    };
  }

  if (!run.rewindPoint) {
    return {
      ok: false,
      reason:
        'This run has no checkpoint to restore. File checkpointing was off for this workspace when it ran — turn it on in the workspace settings and later runs can be rewound.',
    };
  }

  if (!session.claudeSessionId) {
    return {
      ok: false,
      reason: 'This session was never registered with the Claude CLI, so it has no checkpoints.',
    };
  }

  return { ok: true, claudeSessionId: session.claudeSessionId, rewindPoint: run.rewindPoint };
}
