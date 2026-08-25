import { describe, expect, it } from 'vitest';
import type { CronSchedule } from './cron.js';
import { CronError, describeCron, isValidCron, nextFireTime, parseCron } from './cron.js';

/**
 * `cron.ts` computes with the *local* `Date` accessors (`getHours`,
 * `getDate`, …), so every expectation here is built with `new Date(y, m, d, …)`
 * — also local — and compared as epoch milliseconds. That keeps the suite
 * correct under any `TZ`.
 */
const at = (y: number, m: number, d: number, h = 0, min = 0): number =>
  new Date(y, m, d, h, min).getTime();

const sorted = (values: Set<number>): number[] => [...values].sort((a, b) => a - b);

const next = (expression: string, from: number): number | null =>
  nextFireTime(parseCron(expression), from);

function expectRejected(expression: string, fragment?: string): void {
  expect(() => parseCron(expression), `"${expression}" must be rejected`).toThrow(CronError);
  if (fragment !== undefined) expect(() => parseCron(expression)).toThrow(fragment);
  expect(isValidCron(expression)).toBe(false);
}

/* -------------------------------------------------------------------------- */
/* parseCron                                                                   */
/* -------------------------------------------------------------------------- */

describe('parseCron — field syntax', () => {
  it('expands `*` to the full range of every field', () => {
    const schedule = parseCron('* * * * *');
    expect(schedule.minutes.size).toBe(60);
    expect(sorted(schedule.minutes)[0]).toBe(0);
    expect(sorted(schedule.minutes)[59]).toBe(59);
    expect(schedule.hours.size).toBe(24);
    expect(sorted(schedule.daysOfMonth)).toEqual(
      Array.from({ length: 31 }, (_, i) => i + 1),
    );
    expect(sorted(schedule.months)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    // 0-7 collapses to 0-6 once Sunday is normalised.
    expect(sorted(schedule.daysOfWeek)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(schedule.bothDayFieldsRestricted).toBe(false);
    expect(schedule.expression).toBe('* * * * *');
  });

  it('accepts single values in every field', () => {
    const schedule = parseCron('7 13 24 6 3');
    expect(sorted(schedule.minutes)).toEqual([7]);
    expect(sorted(schedule.hours)).toEqual([13]);
    expect(sorted(schedule.daysOfMonth)).toEqual([24]);
    expect(sorted(schedule.months)).toEqual([6]);
    expect(sorted(schedule.daysOfWeek)).toEqual([3]);
    expect(schedule.bothDayFieldsRestricted).toBe(true);
  });

  it('accepts the boundary values of every field', () => {
    expect(sorted(parseCron('0 0 1 1 0').minutes)).toEqual([0]);
    expect(sorted(parseCron('59 23 31 12 6').minutes)).toEqual([59]);
    expect(sorted(parseCron('59 23 31 12 6').hours)).toEqual([23]);
    expect(sorted(parseCron('59 23 31 12 6').daysOfMonth)).toEqual([31]);
    expect(sorted(parseCron('59 23 31 12 6').months)).toEqual([12]);
    expect(sorted(parseCron('59 23 31 12 6').daysOfWeek)).toEqual([6]);
  });

  it('expands ranges inclusively', () => {
    expect(sorted(parseCron('1-5 * * * *').minutes)).toEqual([1, 2, 3, 4, 5]);
    expect(sorted(parseCron('* 9-17 * * *').hours)).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect(sorted(parseCron('* * 1-3 * *').daysOfMonth)).toEqual([1, 2, 3]);
    // A one-element range is legal.
    expect(sorted(parseCron('4-4 * * * *').minutes)).toEqual([4]);
  });

  it('expands comma-separated lists, including lists of ranges', () => {
    expect(sorted(parseCron('1,3,5 * * * *').minutes)).toEqual([1, 3, 5]);
    expect(sorted(parseCron('0,30 * * * *').minutes)).toEqual([0, 30]);
    expect(sorted(parseCron('1-3,10,20-22 * * * *').minutes)).toEqual([1, 2, 3, 10, 20, 21, 22]);
    // Duplicates collapse into the set.
    expect(sorted(parseCron('5,5,5 * * * *').minutes)).toEqual([5]);
    // Whitespace after a comma is tolerated within a field only if the field is
    // not split by it — a bare `,` list must stay one token.
    expect(sorted(parseCron('1,2 * * * *').minutes)).toEqual([1, 2]);
  });

  it('expands `*/n` steps from the bottom of the range', () => {
    expect(sorted(parseCron('*/15 * * * *').minutes)).toEqual([0, 15, 30, 45]);
    expect(sorted(parseCron('*/20 * * * *').minutes)).toEqual([0, 20, 40]);
    expect(sorted(parseCron('* */6 * * *').hours)).toEqual([0, 6, 12, 18]);
    expect(sorted(parseCron('* * */10 * *').daysOfMonth)).toEqual([1, 11, 21, 31]);
    expect(sorted(parseCron('* * * */3 *').months)).toEqual([1, 4, 7, 10]);
    // A step of 1 is the identity.
    expect(parseCron('*/1 * * * *').minutes.size).toBe(60);
  });

  it('treats `value/step` as "from this value to the end of the range"', () => {
    expect(sorted(parseCron('5/15 * * * *').minutes)).toEqual([5, 20, 35, 50]);
    expect(sorted(parseCron('* 2/6 * * *').hours)).toEqual([2, 8, 14, 20]);
    // …whereas a bare value with no step stays a single value.
    expect(sorted(parseCron('5 * * * *').minutes)).toEqual([5]);
  });

  it('applies a step within an explicit range', () => {
    expect(sorted(parseCron('0-30/10 * * * *').minutes)).toEqual([0, 10, 20, 30]);
    expect(sorted(parseCron('* 9-17/4 * * *').hours)).toEqual([9, 13, 17]);
    // The step may overshoot the end; only the start survives.
    expect(sorted(parseCron('10-20/30 * * * *').minutes)).toEqual([10]);
  });

  it('accepts month names, case-insensitively, alone and in ranges', () => {
    expect(sorted(parseCron('0 0 1 jan *').months)).toEqual([1]);
    expect(sorted(parseCron('0 0 1 DEC *').months)).toEqual([12]);
    expect(sorted(parseCron('0 0 1 jan,jun,dec *').months)).toEqual([1, 6, 12]);
    expect(sorted(parseCron('0 0 1 mar-may *').months)).toEqual([3, 4, 5]);
    expect(sorted(parseCron('0 0 1 Feb *').months)).toEqual([2]);
    // Every name resolves to its number.
    const names = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    names.forEach((name, index) => {
      expect(sorted(parseCron(`0 0 1 ${name} *`).months)).toEqual([index + 1]);
    });
  });

  it('accepts day names, case-insensitively, alone and in ranges', () => {
    const names = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    names.forEach((name, index) => {
      expect(sorted(parseCron(`0 0 * * ${name}`).daysOfWeek)).toEqual([index]);
    });
    expect(sorted(parseCron('0 0 * * MON-FRI').daysOfWeek)).toEqual([1, 2, 3, 4, 5]);
    expect(sorted(parseCron('0 0 * * sat,sun').daysOfWeek)).toEqual([0, 6]);
  });

  it('normalises day-of-week 7 to 0 (Sunday)', () => {
    expect(sorted(parseCron('0 0 * * 7').daysOfWeek)).toEqual([0]);
    expect(sorted(parseCron('0 0 * * 0,7').daysOfWeek)).toEqual([0]);
    expect(sorted(parseCron('0 0 * * 5-7').daysOfWeek)).toEqual([0, 5, 6]);
    expect(sorted(parseCron('0 0 * * 1-7').daysOfWeek)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('flags both day fields as restricted only when neither is `*`', () => {
    expect(parseCron('0 0 13 * 5').bothDayFieldsRestricted).toBe(true);
    expect(parseCron('0 0 13 * *').bothDayFieldsRestricted).toBe(false);
    expect(parseCron('0 0 * * 5').bothDayFieldsRestricted).toBe(false);
    expect(parseCron('0 0 * * *').bothDayFieldsRestricted).toBe(false);
  });

  it('trims and lowercases before parsing', () => {
    expect(parseCron('   0 9 * * MON   ').expression).toBe('0 9 * * mon');
    expect(sorted(parseCron('   0 9 * * MON   ').daysOfWeek)).toEqual([1]);
    // Runs of whitespace between fields collapse.
    expect(parseCron('0    9  *   *  *').expression).toBe('0    9  *   *  *');
    expect(sorted(parseCron('0    9  *   *  *').hours)).toEqual([9]);
  });
});

describe('parseCron — shortcuts', () => {
  const cases: Array<[string, string]> = [
    ['@yearly', '0 0 1 1 *'],
    ['@annually', '0 0 1 1 *'],
    ['@monthly', '0 0 1 * *'],
    ['@weekly', '0 0 * * 0'],
    ['@daily', '0 0 * * *'],
    ['@midnight', '0 0 * * *'],
    ['@hourly', '0 * * * *'],
  ];

  it.each(cases)('expands %s to "%s"', (shortcut, expanded) => {
    const schedule = parseCron(shortcut);
    expect(schedule.expression).toBe(expanded);
    // The expansion parses to exactly the same sets as the literal form.
    const literal = parseCron(expanded);
    expect(sorted(schedule.minutes)).toEqual(sorted(literal.minutes));
    expect(sorted(schedule.hours)).toEqual(sorted(literal.hours));
    expect(sorted(schedule.daysOfMonth)).toEqual(sorted(literal.daysOfMonth));
    expect(sorted(schedule.months)).toEqual(sorted(literal.months));
    expect(sorted(schedule.daysOfWeek)).toEqual(sorted(literal.daysOfWeek));
  });

  it('accepts a shortcut with surrounding whitespace and in upper case', () => {
    expect(parseCron('  @DAILY  ').expression).toBe('0 0 * * *');
    expect(sorted(parseCron('@HOURLY').minutes)).toEqual([0]);
  });

  it('rejects an unknown shortcut', () => {
    expectRejected('@reboot');
    expectRejected('@every-minute');
  });
});

describe('parseCron — rejections', () => {
  it('rejects the wrong number of fields', () => {
    expectRejected('', 'needs 5 fields');
    expectRejected('   ', 'needs 5 fields');
    expectRejected('*', 'needs 5 fields');
    expectRejected('* *', 'needs 5 fields');
    expectRejected('* * * *', 'needs 5 fields');
    expectRejected('* * * * * *', 'needs 5 fields');
    expectRejected('0 0 * * * extra', 'needs 5 fields');
  });

  it('rejects values outside each field range', () => {
    expectRejected('60 * * * *', 'minute');
    expectRejected('99 * * * *', 'minute');
    expectRejected('* 24 * * *', 'hour');
    expectRejected('* * 0 * *', 'day of month');
    expectRejected('* * 32 * *', 'day of month');
    expectRejected('* * * 0 *', 'month');
    expectRejected('* * * 13 *', 'month');
    expectRejected('* * * * 8', 'day of week');
    // …and inside a list or a range, not just alone.
    expectRejected('1,2,60 * * * *');
    expectRejected('1-60 * * * *');
    expectRejected('* * * * 1-8');
  });

  it('rejects inverted ranges', () => {
    expectRejected('5-1 * * * *', 'Inverted range');
    expectRejected('* 20-9 * * *', 'Inverted range');
    expectRejected('0 0 * * fri-mon', 'Inverted range');
    expectRejected('0 0 * dec-jan *', 'Inverted range');
  });

  it('rejects a step that is zero, negative or not a number', () => {
    expectRejected('*/0 * * * *', 'Invalid step');
    expectRejected('*/-1 * * * *', 'Invalid step');
    expectRejected('*/abc * * * *', 'Invalid step');
    expectRejected('*/1.5 * * * *', 'Invalid step');
    expectRejected('*/ * * * *', 'Invalid step');
    expectRejected('0-30/0 * * * *', 'Invalid step');
  });

  it('rejects garbage tokens', () => {
    expectRejected('abc * * * *');
    expectRejected('* * * xyz *');
    expectRejected('* * * * funday');
    expectRejected('mon * * * *'); // day names are not valid in the minute field
    expectRejected('jan * * * *');
    expectRejected('1.5 * * * *');
    expectRejected('* * * * -');
    expectRejected('?? * * * *');
  });

  it('rejects empty and half-written parts', () => {
    expectRejected('1,,2 * * * *', 'Empty minute field');
    expectRejected(',1 * * * *', 'Empty minute field');
    expectRejected('1, * * * *', 'Empty minute field');
    expectRejected('1- * * * *', 'Missing value');
    expectRejected('-1 * * * *', 'Missing value');
    expectRejected('/5 * * * *', 'Missing value');
  });
});

/* -------------------------------------------------------------------------- */
/* nextFireTime                                                                */
/* -------------------------------------------------------------------------- */

describe('nextFireTime', () => {
  it('finds the next daily 09:00 later the same day', () => {
    expect(next('0 9 * * *', at(2024, 0, 15, 8, 30))).toBe(at(2024, 0, 15, 9, 0));
    expect(next('0 9 * * *', at(2024, 0, 15, 0, 0))).toBe(at(2024, 0, 15, 9, 0));
    expect(next('0 9 * * *', at(2024, 0, 15, 8, 59))).toBe(at(2024, 0, 15, 9, 0));
  });

  it('rolls a daily 09:00 over to tomorrow once the slot has passed', () => {
    expect(next('0 9 * * *', at(2024, 0, 15, 9, 1))).toBe(at(2024, 0, 16, 9, 0));
    expect(next('0 9 * * *', at(2024, 0, 15, 23, 59))).toBe(at(2024, 0, 16, 9, 0));
    // …and across a month boundary.
    expect(next('0 9 * * *', at(2024, 0, 31, 10, 0))).toBe(at(2024, 1, 1, 9, 0));
    // …and across a year boundary.
    expect(next('0 9 * * *', at(2024, 11, 31, 10, 0))).toBe(at(2025, 0, 1, 9, 0));
  });

  it('walks the quarter-hour grid of `*/15 * * * *`', () => {
    expect(next('*/15 * * * *', at(2024, 0, 15, 8, 7))).toBe(at(2024, 0, 15, 8, 15));
    expect(next('*/15 * * * *', at(2024, 0, 15, 8, 15))).toBe(at(2024, 0, 15, 8, 30));
    expect(next('*/15 * * * *', at(2024, 0, 15, 8, 45))).toBe(at(2024, 0, 15, 9, 0));
    expect(next('*/15 * * * *', at(2024, 0, 15, 23, 46))).toBe(at(2024, 0, 16, 0, 0));

    // Four consecutive firings, each 15 minutes apart.
    let cursor = at(2024, 0, 15, 8, 0);
    const fires: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      cursor = next('*/15 * * * *', cursor) as number;
      fires.push(cursor);
    }
    expect(fires).toEqual([
      at(2024, 0, 15, 8, 15),
      at(2024, 0, 15, 8, 30),
      at(2024, 0, 15, 8, 45),
      at(2024, 0, 15, 9, 0),
    ]);
  });

  it('finds the first of the next month for `0 0 1 * *`', () => {
    expect(next('0 0 1 * *', at(2024, 0, 15, 12, 0))).toBe(at(2024, 1, 1, 0, 0));
    expect(next('0 0 1 * *', at(2024, 0, 1, 0, 0))).toBe(at(2024, 1, 1, 0, 0));
    expect(next('0 0 1 * *', at(2024, 0, 1, 0, 1))).toBe(at(2024, 1, 1, 0, 0));
    // February has 29 days in 2024; the next first is still 1 March.
    expect(next('0 0 1 * *', at(2024, 1, 15, 0, 0))).toBe(at(2024, 2, 1, 0, 0));
    expect(next('0 0 1 * *', at(2024, 11, 2, 0, 0))).toBe(at(2025, 0, 1, 0, 0));
  });

  it('finds the next Monday 09:00 for `0 9 * * 1`', () => {
    // 15 Jan 2024 is a Monday, 10 Jan 2024 is a Wednesday.
    expect(new Date(at(2024, 0, 15)).getDay()).toBe(1);
    expect(next('0 9 * * 1', at(2024, 0, 10, 0, 0))).toBe(at(2024, 0, 15, 9, 0));
    expect(next('0 9 * * 1', at(2024, 0, 15, 8, 0))).toBe(at(2024, 0, 15, 9, 0));
    // Already past this Monday's slot → the following Monday.
    expect(next('0 9 * * 1', at(2024, 0, 15, 10, 0))).toBe(at(2024, 0, 22, 9, 0));
    expect(next('0 9 * * mon', at(2024, 0, 15, 10, 0))).toBe(at(2024, 0, 22, 9, 0));
  });

  it('is strictly after `from`, never equal to it', () => {
    for (const [expression, from] of [
      ['0 9 * * *', at(2024, 0, 15, 9, 0)],
      ['*/15 * * * *', at(2024, 0, 15, 8, 30)],
      ['0 0 1 * *', at(2024, 0, 1, 0, 0)],
      ['* * * * *', at(2024, 0, 15, 8, 30)],
    ] as Array<[string, number]>) {
      const fire = next(expression, from) as number;
      expect(fire, `${expression} must advance past its own fire time`).toBeGreaterThan(from);
    }
    expect(next('* * * * *', at(2024, 0, 15, 8, 30))).toBe(at(2024, 0, 15, 8, 31));
  });

  it('ignores sub-minute precision in `from`', () => {
    const withSeconds = new Date(2024, 0, 15, 8, 59, 45, 123).getTime();
    expect(next('0 9 * * *', withSeconds)).toBe(at(2024, 0, 15, 9, 0));
    // A `from` in the same minute as the fire time has already missed it.
    const justAfterNine = new Date(2024, 0, 15, 9, 0, 1).getTime();
    expect(next('0 9 * * *', justAfterNine)).toBe(at(2024, 0, 16, 9, 0));
  });

  it('returns a time with zero seconds and milliseconds', () => {
    const fire = new Date(next('*/15 * * * *', new Date(2024, 0, 15, 8, 7, 33, 456).getTime()) as number);
    expect(fire.getSeconds()).toBe(0);
    expect(fire.getMilliseconds()).toBe(0);
  });

  it('honours a restricted month', () => {
    // Only ever fires in February.
    expect(next('0 0 1 2 *', at(2024, 2, 1, 0, 0))).toBe(at(2025, 1, 1, 0, 0));
    expect(next('0 0 1 2 *', at(2024, 0, 1, 0, 0))).toBe(at(2024, 1, 1, 0, 0));
  });

  it('defaults `from` to now', () => {
    const before = Date.now();
    const fire = nextFireTime(parseCron('* * * * *')) as number;
    expect(fire).toBeGreaterThan(before);
    // The next minute boundary is at most 60s + the minute we are already in.
    expect(fire).toBeLessThanOrEqual(before + 120_000);
  });
});

describe('nextFireTime — Vixie OR semantics for the two day fields', () => {
  /**
   * `0 0 13 * 5` is "midnight on the 13th **or** on any Friday". In January
   * 2024 the 12th is a Friday and the 13th is a Saturday, which separates the
   * two clauses cleanly.
   */
  const expression = '0 0 13 * 5';

  it('fires on a Friday that is not the 13th', () => {
    expect(new Date(at(2024, 0, 12)).getDay()).toBe(5); // Friday
    expect(new Date(at(2024, 0, 12)).getDate()).toBe(12); // …and not the 13th
    expect(next(expression, at(2024, 0, 10, 0, 0))).toBe(at(2024, 0, 12, 0, 0));
  });

  it('fires on a 13th that is not a Friday', () => {
    expect(new Date(at(2024, 0, 13)).getDay()).toBe(6); // Saturday
    expect(next(expression, at(2024, 0, 12, 0, 0))).toBe(at(2024, 0, 13, 0, 0));
  });

  it('lists every January 2024 firing as the union of both clauses', () => {
    const fires: number[] = [];
    let cursor = at(2024, 0, 1, 0, 0) - 1;
    for (let i = 0; i < 6; i += 1) {
      cursor = next(expression, cursor) as number;
      if (new Date(cursor).getMonth() !== 0) break;
      fires.push(new Date(cursor).getDate());
    }
    // Fridays 5, 12, 19, 26 plus the 13th, in chronological order.
    expect(fires).toEqual([5, 12, 13, 19, 26]);
  });

  it('uses AND semantics when only one day field is restricted', () => {
    // Day-of-month only: never fires on the 12th.
    expect(next('0 0 13 * *', at(2024, 0, 10, 0, 0))).toBe(at(2024, 0, 13, 0, 0));
    // Day-of-week only: never fires on the 13th (a Saturday).
    expect(next('0 0 * * 5', at(2024, 0, 12, 0, 0))).toBe(at(2024, 0, 19, 0, 0));
  });

  it('still ANDs the month field against the OR of the day fields', () => {
    // 13th or Friday, but only in March. 1 March 2024 is a Friday.
    expect(new Date(at(2024, 2, 1)).getDay()).toBe(5);
    expect(next('0 0 13 3 5', at(2024, 0, 10, 0, 0))).toBe(at(2024, 2, 1, 0, 0));
  });
});

describe('nextFireTime — termination', () => {
  it('returns null for 30 February instead of looping, and does so quickly', () => {
    const schedule = parseCron('0 0 30 2 *');
    const started = Date.now();
    const fire = nextFireTime(schedule, at(2024, 0, 1, 0, 0));
    const elapsed = Date.now() - started;

    expect(fire).toBeNull();
    expect(elapsed).toBeLessThan(2000);
  });

  it('returns null for other impossible dates', () => {
    expect(next('0 0 31 2 *', at(2024, 0, 1, 0, 0))).toBeNull();
    expect(next('0 0 31 4 *', at(2024, 0, 1, 0, 0))).toBeNull(); // April has 30 days
    expect(next('0 0 31 6 *', at(2024, 0, 1, 0, 0))).toBeNull(); // June has 30 days
    expect(next('0 0 31 9,11 *', at(2024, 0, 1, 0, 0))).toBeNull(); // Sep + Nov
  });

  it('still finds a genuinely rare date inside the four-year search window', () => {
    // 29 February exists only in leap years; from March 2024 the next one is
    // 29 February 2028, ~1460 days out — just inside the 4 × 366 day bound.
    expect(next('0 0 29 2 *', at(2024, 2, 1, 0, 0))).toBe(at(2028, 1, 29, 0, 0));
    expect(next('0 0 29 2 *', at(2024, 0, 1, 0, 0))).toBe(at(2024, 1, 29, 0, 0));
  });

  /*
   * DST observations (documented, not asserted — the suite runs under whatever
   * `TZ` the host provides, and these are not regressions this change should
   * gate on). Verified by driving `nextFireTime` with `process.env.TZ` set:
   *
   *  1. A daily entry whose wall-clock time falls inside a spring-forward gap
   *     is skipped entirely for that day. In America/New_York, `30 2 * * *`
   *     goes straight from 2024-03-09 02:30 to 2024-03-11 02:30 — nothing on
   *     the 10th. Vixie cron runs such an entry once at the new local time.
   *  2. The same happens to midnight entries where midnight itself does not
   *     exist: in America/Santiago, `0 0 * * *` (i.e. `@daily`) skips
   *     2022-09-11 completely, so a daily automation silently misses a day.
   *  3. The fall-back direction is well behaved: a repeated local hour does
   *     *not* produce a duplicate firing, because each call must return a time
   *     strictly greater than `from`.
   */
});

/* -------------------------------------------------------------------------- */
/* isValidCron / describeCron                                                  */
/* -------------------------------------------------------------------------- */

describe('isValidCron', () => {
  it('accepts well-formed expressions', () => {
    for (const expression of [
      '* * * * *',
      '0 9 * * *',
      '*/15 * * * *',
      '5/15 * * * *',
      '0 0 1 * *',
      '30 9 * * 1-5',
      '0 0 * * sun',
      '0 0 1 jan *',
      '0 0 13 * 5',
      '@daily',
      '@weekly',
      '  @hourly  ',
      // Parses fine even though it can never fire.
      '0 0 30 2 *',
    ]) {
      expect(isValidCron(expression), `"${expression}" should be valid`).toBe(true);
    }
  });

  it('rejects malformed expressions', () => {
    for (const expression of [
      '',
      '   ',
      '* * * *',
      '* * * * * *',
      '60 * * * *',
      '* * 0 * *',
      '5-1 * * * *',
      '*/0 * * * *',
      'nonsense',
      '@reboot',
      '1,,2 * * * *',
    ]) {
      expect(isValidCron(expression), `"${expression}" should be invalid`).toBe(false);
    }
  });
});

describe('describeCron', () => {
  it('describes the every-minute schedule', () => {
    expect(describeCron('* * * * *')).toBe('Every minute');
    expect(describeCron('*/1 * * * *')).toBe('Every minute');
  });

  it('describes an hourly schedule with its minute', () => {
    expect(describeCron('0 * * * *')).toBe('Hourly at :00');
    expect(describeCron('@hourly')).toBe('Hourly at :00');
    expect(describeCron('30 * * * *')).toBe('Hourly at :30');
    expect(describeCron('7 * * * *')).toBe('Hourly at :07');
  });

  it('describes a daily schedule with its zero-padded time', () => {
    expect(describeCron('0 9 * * *')).toBe('Daily at 09:00');
    expect(describeCron('5 14 * * *')).toBe('Daily at 14:05');
    expect(describeCron('@daily')).toBe('Daily at 00:00');
    expect(describeCron('@midnight')).toBe('Daily at 00:00');
    expect(describeCron('0 0 * * *')).toBe('Daily at 00:00');
  });

  it('describes a weekday list by name, in week order', () => {
    expect(describeCron('30 9 * * 1-5')).toBe(
      'Monday, Tuesday, Wednesday, Thursday, Friday at 09:30',
    );
    expect(describeCron('0 0 * * 0')).toBe('Sunday at 00:00');
    expect(describeCron('@weekly')).toBe('Sunday at 00:00');
    expect(describeCron('0 18 * * 5')).toBe('Friday at 18:00');
    expect(describeCron('0 8 * * mon,wed,fri')).toBe('Monday, Wednesday, Friday at 08:00');
    // 7 is Sunday, so it renders as Sunday rather than an eighth day.
    expect(describeCron('0 8 * * 7')).toBe('Sunday at 08:00');
    expect(describeCron('0 8 * * 6,7')).toBe('Sunday, Saturday at 08:00');
  });

  it('falls back to the normalised expression for anything else', () => {
    expect(describeCron('0 0 1 * *')).toBe('Cron: 0 0 1 * *');
    expect(describeCron('@monthly')).toBe('Cron: 0 0 1 * *');
    expect(describeCron('@yearly')).toBe('Cron: 0 0 1 1 *');
    expect(describeCron('0 9 1-15 * *')).toBe('Cron: 0 9 1-15 * *');
    // Several hours in the day → not "daily at".
    expect(describeCron('0 9,17 * * *')).toBe('Cron: 0 9,17 * * *');
    // Several minutes in the hour → not "hourly at".
    expect(describeCron('0,30 * * * *')).toBe('Cron: 0,30 * * * *');
    // Restricted month.
    expect(describeCron('0 9 * jan *')).toBe('Cron: 0 9 * jan *');
    // Both day fields restricted.
    expect(describeCron('0 0 13 * 5')).toBe('Cron: 0 0 13 * 5');
  });

  it('returns the raw input unchanged when it cannot be parsed', () => {
    expect(describeCron('not a cron expression')).toBe('not a cron expression');
    expect(describeCron('60 * * * *')).toBe('60 * * * *');
    expect(describeCron('@reboot')).toBe('@reboot');
    expect(describeCron('')).toBe('');
  });
});

/* -------------------------------------------------------------------------- */
/* Cross-checks                                                                */
/* -------------------------------------------------------------------------- */

describe('the parsed schedule agrees with the fire times it produces', () => {
  const expressions = [
    '* * * * *',
    '0 9 * * *',
    '*/15 * * * *',
    '0 0 1 * *',
    '0 9 * * 1',
    '30 9 * * 1-5',
    '0 0 13 * 5',
    '0 12 1 jan *',
  ];

  it.each(expressions)('every firing of "%s" satisfies each field', (expression) => {
    const schedule: CronSchedule = parseCron(expression);
    let cursor = at(2024, 0, 1, 0, 0);

    for (let i = 0; i < 8; i += 1) {
      const fire = nextFireTime(schedule, cursor);
      if (fire === null) break;
      const date = new Date(fire);

      expect(schedule.minutes.has(date.getMinutes())).toBe(true);
      expect(schedule.hours.has(date.getHours())).toBe(true);
      expect(schedule.months.has(date.getMonth() + 1)).toBe(true);

      const dom = schedule.daysOfMonth.has(date.getDate());
      const dow = schedule.daysOfWeek.has(date.getDay());
      expect(schedule.bothDayFieldsRestricted ? dom || dow : dom && dow).toBe(true);

      expect(fire).toBeGreaterThan(cursor);
      cursor = fire;
    }
  });
});
