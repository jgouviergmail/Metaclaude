import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase, type Db } from '../db/index.js';
import { ModelAvailability } from './model-availability.js';

describe('ModelAvailability', () => {
  let db: Db;
  let availability: ModelAvailability;
  const now = Date.UTC(2026, 8, 8, 9, 0, 0);

  beforeEach(() => {
    db = openDatabase({ path: ':memory:' });
    migrate(db);
    availability = new ModelAvailability(db);
  });
  afterEach(() => db.close());

  it('holds a refused model until its window resets, then lets it go', () => {
    const resetsAt = now + 6 * 3_600_000;
    availability.block('fable', resetsAt, now);

    expect(availability.blocked(now)).toEqual(new Set(['fable']));
    expect(availability.blockedUntil('fable', now)).toBe(resetsAt);

    // A minute before, still held; a minute after, gone — no sweep needed.
    expect(availability.blocked(resetsAt - 60_000)).toEqual(new Set(['fable']));
    expect(availability.blocked(resetsAt + 60_000)).toEqual(new Set());
  });

  it('holds a refusal that named no reset time, but not forever', () => {
    // "We do not know when this frees up" must not become "never try it again".
    availability.block('fable', null, now, 3_600_000);
    expect(availability.blocked(now + 59 * 60_000)).toEqual(new Set(['fable']));
    expect(availability.blocked(now + 61 * 60_000)).toEqual(new Set());
  });

  it('never shortens a hold that is already longer', () => {
    // Two refusals inside one run: the second may carry no reset time, and it
    // must not undo what the first established.
    const weekly = now + 6 * 3_600_000;
    availability.block('fable', weekly, now);
    availability.block('fable', null, now, 60_000);
    expect(availability.blockedUntil('fable', now)).toBe(weekly);
  });

  it('survives a restart, because a weekly window outlives a deployment', () => {
    availability.block('fable', now + 6 * 3_600_000, now);
    // A second instance over the same database is what a redeploy looks like.
    expect(new ModelAvailability(db).blocked(now)).toEqual(new Set(['fable']));
  });

  it('releases a model when asked', () => {
    availability.block('fable', now + 3_600_000, now);
    availability.release('fable');
    expect(availability.blocked(now)).toEqual(new Set());
    expect(() => availability.release('never-blocked')).not.toThrow();
  });

  it('starts empty and never throws on a corrupted entry', () => {
    expect(availability.blocked(now)).toEqual(new Set());
    db.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)').run(
      'quota.blockedModels',
      '{"fable":"pas un nombre"}',
      now,
    );
    expect(availability.blocked(now)).toEqual(new Set());
  });
});
