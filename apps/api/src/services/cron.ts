/**
 * Cron expression parsing and next-fire computation.
 *
 * Written rather than imported: the scheduler needs to compute the *next* fire
 * time from an arbitrary instant (for catch-up after downtime and for showing
 * "next run" in the UI), and most small cron libraries only offer a callback
 * timer. Pure functions are also far easier to test exhaustively.
 *
 * Supported syntax — standard 5-field cron:
 *
 *   ┌───── minute        0-59
 *   │ ┌─── hour          0-23
 *   │ │ ┌─ day of month  1-31
 *   │ │ │ ┌ month        1-12 or JAN-DEC
 *   │ │ │ │ ┌ day of week 0-6 (Sunday = 0) or SUN-SAT
 *   * * * * *
 *
 * Each field accepts `*`, a value, `a-b` ranges, `a,b,c` lists and `x/n` steps.
 * Named shortcuts (`@hourly`, `@daily`, `@weekly`, `@monthly`, `@yearly`) are
 * also accepted.
 */

export class CronError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CronError';
  }
}

export interface CronSchedule {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  /** True when both day fields are restricted, which cron treats as OR. */
  bothDayFieldsRestricted: boolean;
  expression: string;
}

const SHORTCUTS: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

const MONTH_NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const DAY_NAMES: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

/** Parse an expression into explicit sets. Throws `CronError` on bad syntax. */
export function parseCron(expression: string): CronSchedule {
  const raw = expression.trim().toLowerCase();
  const normalised = SHORTCUTS[raw] ?? raw;

  const fields = normalised.split(/\s+/);
  if (fields.length !== 5) {
    throw new CronError(
      `A cron expression needs 5 fields (minute hour day month weekday), got ${fields.length}.`,
    );
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [
    string, string, string, string, string,
  ];

  const schedule: CronSchedule = {
    minutes: parseField(minute, 0, 59, 'minute'),
    hours: parseField(hour, 0, 23, 'hour'),
    daysOfMonth: parseField(dayOfMonth, 1, 31, 'day of month'),
    months: parseField(month, 1, 12, 'month', MONTH_NAMES),
    // Both 0 and 7 mean Sunday; normalise 7 → 0 after parsing.
    daysOfWeek: normaliseWeekdays(parseField(dayOfWeek, 0, 7, 'day of week', DAY_NAMES)),
    bothDayFieldsRestricted: dayOfMonth !== '*' && dayOfWeek !== '*',
    expression: normalised,
  };

  return schedule;
}

function normaliseWeekdays(days: Set<number>): Set<number> {
  const result = new Set<number>();
  for (const day of days) result.add(day === 7 ? 0 : day);
  return result;
}

function parseField(
  field: string,
  min: number,
  max: number,
  label: string,
  names?: Record<string, number>,
): Set<number> {
  const values = new Set<number>();

  for (const part of field.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) throw new CronError(`Empty ${label} field.`);

    // Step syntax: `<range>/<step>`
    const [rangePart, stepPart] = trimmed.split('/');
    let step = 1;
    if (stepPart !== undefined) {
      step = Number(stepPart);
      if (!Number.isInteger(step) || step < 1) {
        throw new CronError(`Invalid step "${stepPart}" in the ${label} field.`);
      }
    }

    let start: number;
    let end: number;

    if (rangePart === '*' || rangePart === undefined) {
      start = min;
      end = max;
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-');
      start = resolveValue(a, min, max, label, names);
      end = resolveValue(b, min, max, label, names);
      if (start > end) throw new CronError(`Inverted range "${rangePart}" in the ${label} field.`);
    } else {
      start = resolveValue(rangePart, min, max, label, names);
      // A bare value with a step means "from here to the end of the range",
      // which is how `5/15` behaves in Vixie cron.
      end = stepPart !== undefined ? max : start;
    }

    for (let value = start; value <= end; value += step) values.add(value);
  }

  if (values.size === 0) throw new CronError(`The ${label} field matches nothing.`);
  return values;
}

function resolveValue(
  token: string | undefined,
  min: number,
  max: number,
  label: string,
  names?: Record<string, number>,
): number {
  if (token === undefined || token === '') throw new CronError(`Missing value in the ${label} field.`);

  const named = names?.[token];
  const value = named ?? Number(token);

  if (!Number.isInteger(value) || value < min || value > max) {
    throw new CronError(`"${token}" is out of range for the ${label} field (${min}-${max}).`);
  }
  return value;
}

/**
 * Next fire time strictly after `from`.
 *
 * Iterates minute by minute, bounded to four years so an impossible expression
 * such as `0 0 30 2 *` (30 February) terminates with `null` instead of looping.
 * Minute granularity keeps the implementation obviously correct, and at ~2.1M
 * iterations worst case it still completes in well under a second.
 */
export function nextFireTime(schedule: CronSchedule, from: number = Date.now()): number | null {
  const cursor = new Date(from);
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);

  const limit = from + 4 * 366 * 86_400_000;

  while (cursor.getTime() <= limit) {
    if (matches(schedule, cursor)) return cursor.getTime();

    // Skip a whole day when the date cannot match, rather than 1440 minutes.
    if (!matchesDate(schedule, cursor)) {
      cursor.setDate(cursor.getDate() + 1);
      cursor.setHours(0, 0, 0, 0);
      continue;
    }
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return null;
}

function matchesDate(schedule: CronSchedule, date: Date): boolean {
  if (!schedule.months.has(date.getMonth() + 1)) return false;

  const dayOfMonthMatches = schedule.daysOfMonth.has(date.getDate());
  const dayOfWeekMatches = schedule.daysOfWeek.has(date.getDay());

  // Vixie cron semantics: when both day fields are restricted the entry fires
  // when *either* matches, not both.
  return schedule.bothDayFieldsRestricted
    ? dayOfMonthMatches || dayOfWeekMatches
    : dayOfMonthMatches && dayOfWeekMatches;
}

function matches(schedule: CronSchedule, date: Date): boolean {
  return (
    schedule.minutes.has(date.getMinutes()) &&
    schedule.hours.has(date.getHours()) &&
    matchesDate(schedule, date)
  );
}

/** Validate an expression without keeping the result. */
export function isValidCron(expression: string): boolean {
  try {
    parseCron(expression);
    return true;
  } catch {
    return false;
  }
}

/** Human-readable rendering for the automations list. */
export function describeCron(expression: string): string {
  let schedule: CronSchedule;
  try {
    schedule = parseCron(expression);
  } catch {
    return expression;
  }

  const everyMinute = schedule.minutes.size === 60;
  const everyHour = schedule.hours.size === 24;
  const everyDay = schedule.daysOfMonth.size === 31 && schedule.daysOfWeek.size === 7;
  const everyMonth = schedule.months.size === 12;

  if (everyMinute && everyHour && everyDay && everyMonth) return 'Every minute';
  if (everyHour && everyDay && everyMonth && schedule.minutes.size === 1) {
    return `Hourly at :${pad(first(schedule.minutes))}`;
  }
  if (everyDay && everyMonth && schedule.hours.size === 1 && schedule.minutes.size === 1) {
    return `Daily at ${pad(first(schedule.hours))}:${pad(first(schedule.minutes))}`;
  }
  if (
    everyMonth &&
    schedule.daysOfMonth.size === 31 &&
    schedule.daysOfWeek.size < 7 &&
    schedule.hours.size === 1 &&
    schedule.minutes.size === 1
  ) {
    const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const days = [...schedule.daysOfWeek].sort().map((d) => names[d]).join(', ');
    return `${days} at ${pad(first(schedule.hours))}:${pad(first(schedule.minutes))}`;
  }
  return `Cron: ${schedule.expression}`;
}

const first = (set: Set<number>): number => [...set].sort((a, b) => a - b)[0] ?? 0;
const pad = (value: number): string => String(value).padStart(2, '0');
