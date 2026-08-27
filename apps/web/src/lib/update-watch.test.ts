/**
 * The reload rule: a success is only worth a reload if this page watched
 * the deploy happen. A stale success must never refresh someone's screen.
 */

import { describe, expect, it } from 'vitest';
import { nextUpdateWatch, type UpdateWatch } from './update-watch.js';

const idle: UpdateWatch = { sawInFlight: false, reload: false };

describe('nextUpdateWatch', () => {
  it('never reloads on a success it did not watch', () => {
    expect(nextUpdateWatch(idle, 'succeeded')).toEqual({ sawInFlight: false, reload: false });
  });

  it('reloads exactly once after watching the deploy go through', () => {
    let watch = idle;
    watch = nextUpdateWatch(watch, 'requested');
    watch = nextUpdateWatch(watch, 'running');
    expect(watch).toEqual({ sawInFlight: true, reload: false });

    watch = nextUpdateWatch(watch, 'succeeded');
    expect(watch.reload).toBe(true);
    // The next poll of the same succeeded state must not reload again.
    expect(nextUpdateWatch(watch, 'succeeded').reload).toBe(false);
  });

  it('a failure clears nothing — a retry that succeeds still reloads', () => {
    let watch = nextUpdateWatch(idle, 'running');
    watch = nextUpdateWatch(watch, 'failed');
    expect(watch.reload).toBe(false);
    watch = nextUpdateWatch(watch, 'running');
    expect(nextUpdateWatch(watch, 'succeeded').reload).toBe(true);
  });
});
