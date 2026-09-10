/**
 * Loop 4 — are the instructions right?
 *
 * The three loops that came before change what a run is *told* (memory), what
 * serves it (the bandit) and what is remembered afterwards (reflexion). None
 * of them has ever touched the instructions themselves: a workspace's standing
 * prompt, a skill's description, a subagent's prompt, an automation's script.
 * Those are written once and then left alone however often the runs show them
 * to be wrong.
 *
 * This module is the evidence half of closing that gap. It assembles a window
 * of what actually happened in a workspace, and computes — in code, with no
 * model anywhere near it — the recurrences worth putting to one. The
 * arbitration lives beside it in `improvement-arbiter.ts`; the rules that
 * bound what the arbiter's answer may become live in `improvement-review.ts`.
 *
 * The split is the whole design, and it is the shape the memory gate measured
 * its way into: **the facts in code, the judgement to a model, the decision to
 * a person.** Asking a model to notice that something happened three times is
 * asking it to count, which it does badly and unverifiably; asking it whether
 * three counted occurrences mean the description is wrong is a question worth
 * a model call.
 */

import type { Run, RevisionFinding, RevisionReview, TranscriptEvent } from '@metaclaude/shared';
import { bareToolName } from '@metaclaude/shared';
import type { Db } from '../db/index.js';
import { parseJson } from '../db/index.js';
import { excerpt, finalAnswer } from '../kernel/transcript-view.js';

/* -------------------------------------------------------------------------- */
/* The numbers                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Runs a workspace must have produced since its last review before another is
 * worth the call.
 *
 * Eight, because the busiest workspace of the deployment this was measured on
 * produced thirty-four runs in eight days and the quietest two. A pass over
 * three runs cannot tell a habit from an afternoon.
 */
export const REVIEW_MIN_RUNS = 8;

/** And a week between passes, so a refusal is not re-asked against the same runs. */
export const REVIEW_MIN_DAYS = 7;

/**
 * The most runs one window carries.
 *
 * Forty at ~1.8 kB each is ~72 kB of prompt, which is a few cents on the cheap
 * model and well inside its context. The cap matters more for what it says
 * than for what it saves: a window is *a period of work*, and a pass that read
 * six months of it would be answering a different question.
 */
export const WINDOW_MAX_RUNS = 40;

/** What one run is worth in the prompt. */
export const RUN_EXCERPT = 1800;

/**
 * The most of a target's own text an arbiter is shown — and the ceiling above
 * which it is not revised at all.
 *
 * `ARBITER_EXCERPT` in the consolidation pass, for the same reason and with
 * more force: the answer *becomes* the surviving text, so judging a longer
 * instruction on a prefix would fold its tail away into a rewrite derived from
 * that prefix, approved by an operator shown the same prefix. Twelve thousand
 * is above the longest instruction measured in production (6 656) and below
 * the schema's own ceiling, so a text that does not fit is refused rather than
 * cut.
 */
export const TARGET_MAX_CHARS = 12_000;

/**
 * What the instruction texts may cost, in characters, all together.
 *
 * Every individual text was capped from the first day — `TARGET_MAX_CHARS`,
 * with anything longer shown in part and refused as a target. The *number* of
 * them was not, and that is the half that bites: one row per workspace, two
 * per enabled skill, two per enabled subagent and one per automation, so a
 * deployment with forty skills spends four hundred thousand characters on this
 * section alone. That is roughly a hundred thousand tokens on top of the
 * window, every week, per workspace — and past the model's context it is not
 * an expensive pass but a pass that fails for good, weekly, with nothing on
 * screen but a row saying the call died.
 *
 * Sixty thousand is about the size of the window beside it (forty runs at
 * `RUN_EXCERPT`), which makes the whole prompt comfortably under forty
 * thousand tokens on the cheapest model.
 */
export const TARGETS_MAX_CHARS = 60_000;

/* ---- what makes a recurrence a recurrence -------------------------------- */

/** Distinct runs a thing must happen in before it stops being an incident. */
export const OBSERVATION_MIN_RUNS = 3;
/** …spread over this many distinct days, so one bad afternoon is not a habit. */
export const OBSERVATION_MIN_DAYS = 2;

/**
 * Runs an extension must have been *offered* to, in this window, before never
 * being used says anything about its description.
 *
 * Deliberately a blunt count, and deliberately not a relevance test. The
 * obvious refinement — only count runs the extension was plausibly *for*,
 * by cosine between its description and the prompt — was written and then
 * rejected: every floor in `retrieval.ts` is a *measurement*, of retrieval,
 * and reusing one for a question nobody has measured is how a number comes to
 * mean two different things. Worse, it would mean two different things on two
 * deployments: under the hashing family a cosine carries no meaning at all,
 * and a host that cannot spare a gigabyte still ships it. So the rule is one
 * anybody can check — twelve of at most forty runs, spanning two days — and
 * what it costs is patience with a skill written for a rare job.
 */
export const UNUSED_MIN_RUNS = 12;

/** Failed invocations, as a share of invocations, before a subagent is indicted. */
export const FAILURE_RATE = 0.5;

/** A workspace's instructions are called crowded past this share of the schema's ceiling. */
export const INSTRUCTIONS_CROWDED_RATIO = 0.7;
/** The schema's own ceiling for `systemPromptAppend`, mirrored so the ratio means something. */
export const INSTRUCTIONS_MAX = 20_000;

/* -------------------------------------------------------------------------- */
/* The window                                                                  */
/* -------------------------------------------------------------------------- */

/** One extension's story in one run, as the window carries it. */
export interface WindowExtension {
  kind: 'skill' | 'agent';
  extensionId: string | null;
  name: string;
  available: boolean;
  invoked: number;
  failed: number;
}

/** One run, compressed to what a reader of the window needs. */
export interface WindowRun {
  id: string;
  sessionId: string;
  at: number;
  status: Run['status'];
  triggeredBy: Run['triggeredBy'];
  category: string | null;
  prompt: string;
  error: string | null;
  answer: string | null;
  /** The automation whose session this is, when it is one. */
  automationId: string | null;
  tools: Array<{ name: string; calls: number; errors: number }>;
  extensions: WindowExtension[];
  turns: number;
  durationMs: number;
}

export interface EvidenceWindow {
  workspaceId: string;
  from: number;
  to: number;
  runs: WindowRun[];
  /** Runs finished since the cursor but outside the cap, so the count is honest. */
  omitted: number;
}

interface RunRow {
  id: string;
  session_id: string;
  status: string;
  triggered_by: string;
  category: string | null;
  prompt: string;
  error: string | null;
  usage: string;
  finished_at: number;
  automation_id: string | null;
}

/**
 * The runs a review should read, oldest first.
 *
 * Oldest first because a window is a story: an instruction that was changed
 * halfway through it should be read against the runs that followed, and a
 * reader given the reverse order has to reconstruct the sequence.
 *
 * Interrupted runs are left out. An operator who stops a run has said nothing
 * about the instructions — the same reasoning that keeps the classifier from
 * learning a category from one, and that scores an interruption neutrally in
 * the reward.
 */
export function buildWindow(
  db: Db,
  workspaceId: string,
  options: { since: number; until?: number; limit?: number } = { since: 0 },
): EvidenceWindow {
  const until = options.until ?? Date.now();
  const limit = Math.min(options.limit ?? WINDOW_MAX_RUNS, WINDOW_MAX_RUNS);

  const total =
    db
      .prepare<[string, number, number], { n: number }>(
        `SELECT COUNT(*) AS n FROM runs
          WHERE workspace_id = ? AND finished_at IS NOT NULL
            AND finished_at > ? AND finished_at <= ? AND status != 'interrupted'`,
      )
      .get(workspaceId, options.since, until)?.n ?? 0;

  // The newest `limit`, then reversed: taking the oldest would answer with the
  // start of a long backlog and never reach what is happening now.
  const rows = db
    .prepare<[string, number, number, number], RunRow>(
      `SELECT r.id, r.session_id, r.status, r.triggered_by, r.category, r.prompt, r.error,
              r.usage, r.finished_at,
              (SELECT a.id FROM automations a WHERE a.session_id = r.session_id) AS automation_id
         FROM runs r
        WHERE r.workspace_id = ? AND r.finished_at IS NOT NULL
          AND r.finished_at > ? AND r.finished_at <= ? AND r.status != 'interrupted'
        ORDER BY r.finished_at DESC, r.rowid DESC
        LIMIT ?`,
    )
    .all(workspaceId, options.since, until, limit);
  rows.reverse();

  if (rows.length === 0) {
    return { workspaceId, from: options.since, to: until, runs: [], omitted: 0 };
  }

  const ids = rows.map((row) => row.id);
  const events = eventsByRun(db, ids);
  const extensions = extensionsByRun(db, ids);

  const runs = rows.map((row) => {
    const own = events.get(row.id) ?? [];
    const usage = parseJson<{ turns?: number; durationMs?: number }>(row.usage, {});
    return {
      id: row.id,
      sessionId: row.session_id,
      at: row.finished_at,
      status: row.status as Run['status'],
      triggeredBy: row.triggered_by as Run['triggeredBy'],
      category: row.category,
      prompt: excerpt(row.prompt.replace(/\s+/g, ' ').trim(), RUN_EXCERPT / 3),
      error: row.error,
      answer: finalAnswer(own, RUN_EXCERPT / 2),
      automationId: row.automation_id,
      tools: toolUse(own),
      extensions: extensions.get(row.id) ?? [],
      turns: usage.turns ?? 0,
      durationMs: usage.durationMs ?? 0,
    } satisfies WindowRun;
  });

  return {
    workspaceId,
    from: rows[0]?.finished_at ?? options.since,
    to: until,
    runs,
    omitted: Math.max(0, total - rows.length),
  };
}

/** Every run's events in one query — forty separate reads would be forty parses. */
function eventsByRun(db: Db, ids: readonly string[]): Map<string, TranscriptEvent[]> {
  const placeholders = ids.map(() => '?').join(',');
  const rows = db
    .prepare<string[], { run_id: string; payload: string }>(
      `SELECT run_id, payload FROM transcript_events
        WHERE run_id IN (${placeholders}) AND kind IN ('tool_call', 'assistant_text')
        ORDER BY run_id, seq ASC`,
    )
    .all(...ids);

  const out = new Map<string, TranscriptEvent[]>();
  for (const row of rows) {
    const list = out.get(row.run_id) ?? [];
    list.push(JSON.parse(row.payload) as TranscriptEvent);
    out.set(row.run_id, list);
  }
  return out;
}

function extensionsByRun(db: Db, ids: readonly string[]): Map<string, WindowExtension[]> {
  const placeholders = ids.map(() => '?').join(',');
  const rows = db
    .prepare<
      string[],
      { run_id: string; kind: string; name: string; extension_id: string | null; available: number; invoked: number; failed: number }
    >(
      `SELECT run_id, kind, name, extension_id, available, invoked, failed
         FROM run_extension_usages WHERE run_id IN (${placeholders})`,
    )
    .all(...ids);

  const out = new Map<string, WindowExtension[]>();
  for (const row of rows) {
    const list = out.get(row.run_id) ?? [];
    list.push({
      kind: row.kind as 'skill' | 'agent',
      extensionId: row.extension_id,
      name: row.name,
      available: row.available === 1,
      invoked: row.invoked,
      failed: row.failed,
    });
    out.set(row.run_id, list);
  }
  return out;
}

/** Tools a run called, by bare name, with how many came back an error. */
function toolUse(events: readonly TranscriptEvent[]): WindowRun['tools'] {
  const counts = new Map<string, { calls: number; errors: number }>();
  for (const event of events) {
    if (event.kind !== 'tool_call') continue;
    const name = bareToolName(event.name);
    const entry = counts.get(name) ?? { calls: 0, errors: 0 };
    entry.calls += 1;
    if (event.resultIsError || event.status === 'error' || event.status === 'denied') entry.errors += 1;
    counts.set(name, entry);
  }
  return [...counts].map(([name, entry]) => ({ name, ...entry }));
}

/* -------------------------------------------------------------------------- */
/* Observations — computed, never asked                                        */
/* -------------------------------------------------------------------------- */

/** A day, for the "spread over N days" half of every threshold. */
const dayOf = (at: number): number => Math.floor(at / 86_400_000);

/**
 * What the window shows, before any model sees it.
 *
 * Each observation states a count and the runs behind it, so the arbiter is
 * asked to judge a fact rather than to notice one. That division is the
 * lesson the memory gate paid for: four rules had to sit *after* the model
 * there because it would not apply them itself, and "this happened three
 * times" is precisely the kind of rule a model will assert without checking.
 *
 * Every observation carries `runIds`, and every one of those is a run *in the
 * window* — which is what lets the rules downstream drop a revision whose
 * evidence the arbiter invented.
 */
export function observe(
  window: EvidenceWindow,
  context: { instructionsLength?: number } = {},
): RevisionFinding[] {
  if (window.runs.length === 0) return [];
  const found: RevisionFinding[] = [];

  found.push(...unusedExtensions(window));
  found.push(...failingSubagents(window));
  found.push(...failingTools(window));
  found.push(...driftingAutomations(window));
  found.push(...crowdedInstructions(window, context.instructionsLength));

  return found;
}

/** Enough distinct runs, over enough distinct days, to be a habit. */
function recurs(runIds: readonly string[], days: ReadonlySet<number>, minRuns = OBSERVATION_MIN_RUNS): boolean {
  return runIds.length >= minRuns && days.size >= OBSERVATION_MIN_DAYS;
}

/**
 * Extensions carried into run after run and never once reached for.
 *
 * The first question this whole loop was built to ask. Measured on production:
 * five skills and five subagents enabled, sixty-three runs, not one
 * invocation — and a skill's *description* is what the CLI reads when deciding
 * whether to open it, so an unused one is usually a description written as a
 * summary where it should be a trigger condition.
 */
function unusedExtensions(window: EvidenceWindow): RevisionFinding[] {
  const seen = new Map<string, { name: string; kind: string; runIds: string[]; days: Set<number>; invoked: number }>();
  for (const run of window.runs) {
    for (const extension of run.extensions) {
      if (!extension.available || !extension.extensionId) continue;
      const key = `${extension.kind}:${extension.extensionId}`;
      const entry = seen.get(key) ?? { name: extension.name, kind: extension.kind, runIds: [], days: new Set<number>(), invoked: 0 };
      entry.runIds.push(run.id);
      entry.days.add(dayOf(run.at));
      entry.invoked += extension.invoked;
      seen.set(key, entry);
    }
  }

  const out: RevisionFinding[] = [];
  for (const [key, entry] of seen) {
    if (entry.invoked > 0) continue;
    if (!recurs(entry.runIds, entry.days, UNUSED_MIN_RUNS)) continue;
    out.push({
      key: `unused-extension:${key}`,
      kind: 'unused-extension',
      summary:
        `The ${entry.kind === 'skill' ? 'skill' : 'subagent'} “${entry.name}” was available to ` +
        `${entry.runIds.length} of these runs and never invoked once.`,
      runIds: entry.runIds.slice(0, 20),
    });
  }
  return out;
}

/** Subagents that are reached for and then do not work. */
function failingSubagents(window: EvidenceWindow): RevisionFinding[] {
  const seen = new Map<string, { name: string; runIds: string[]; days: Set<number>; invoked: number; failed: number }>();
  for (const run of window.runs) {
    for (const extension of run.extensions) {
      if (extension.kind !== 'agent' || extension.invoked === 0 || !extension.extensionId) continue;
      const entry = seen.get(extension.extensionId) ?? {
        name: extension.name,
        runIds: [],
        days: new Set<number>(),
        invoked: 0,
        failed: 0,
      };
      entry.runIds.push(run.id);
      entry.days.add(dayOf(run.at));
      entry.invoked += extension.invoked;
      entry.failed += extension.failed;
      seen.set(extension.extensionId, entry);
    }
  }

  const out: RevisionFinding[] = [];
  for (const [id, entry] of seen) {
    if (entry.failed === 0 || entry.failed / entry.invoked < FAILURE_RATE) continue;
    if (!recurs(entry.runIds, entry.days)) continue;
    out.push({
      key: `failing-subagent:${id}`,
      kind: 'extension-errors',
      summary:
        `The subagent “${entry.name}” was delegated to ${entry.invoked} time(s) across ` +
        `${entry.runIds.length} runs and failed ${entry.failed} of them.`,
      runIds: entry.runIds.slice(0, 20),
    });
  }
  return out;
}

/**
 * One tool going wrong again and again.
 *
 * Not a revision on its own — a failing tool is usually a tool, not a
 * sentence — but it is the context under which an instruction may be missing:
 * "always pass an absolute path here" is a rule an operator would have written
 * if they had known. So it is offered to the arbiter as a fact, and the rules
 * downstream still require a revision to change something.
 */
function failingTools(window: EvidenceWindow): RevisionFinding[] {
  const seen = new Map<string, { runIds: string[]; days: Set<number>; errors: number }>();
  for (const run of window.runs) {
    for (const tool of run.tools) {
      if (tool.errors === 0) continue;
      const entry = seen.get(tool.name) ?? { runIds: [], days: new Set<number>(), errors: 0 };
      entry.runIds.push(run.id);
      entry.days.add(dayOf(run.at));
      entry.errors += tool.errors;
      seen.set(tool.name, entry);
    }
  }

  const out: RevisionFinding[] = [];
  for (const [name, entry] of seen) {
    if (!recurs(entry.runIds, entry.days)) continue;
    out.push({
      key: `tool-errors:${name}`,
      kind: 'tool-errors',
      summary: `${name} returned an error in ${entry.runIds.length} of these runs (${entry.errors} calls in all).`,
      runIds: entry.runIds.slice(0, 20),
    });
  }
  return out;
}

/**
 * An automation whose firings have started costing more than they used to.
 *
 * Automations are the only runs with a genuine statistic behind them — the
 * same prompt, over and over — which is what makes a change in their shape
 * meaningful where the same change across a person's varied requests would be
 * noise. Measured on production: one automation had fired nine times with one
 * prompt while the busiest workspace's thirty-four runs were thirty-four
 * different requests.
 */
function driftingAutomations(window: EvidenceWindow): RevisionFinding[] {
  const seen = new Map<string, { runIds: string[]; days: Set<number>; failed: number }>();
  for (const run of window.runs) {
    if (!run.automationId) continue;
    const entry = seen.get(run.automationId) ?? { runIds: [], days: new Set<number>(), failed: 0 };
    entry.runIds.push(run.id);
    entry.days.add(dayOf(run.at));
    if (run.status === 'failed') entry.failed += 1;
    seen.set(run.automationId, entry);
  }

  const out: RevisionFinding[] = [];
  for (const [id, entry] of seen) {
    if (!recurs(entry.runIds, entry.days)) continue;
    if (entry.failed === 0) continue;
    out.push({
      key: `automation-failing:${id}`,
      kind: 'automation-drift',
      summary: `An automation fired ${entry.runIds.length} time(s) here and ${entry.failed} of them failed.`,
      runIds: entry.runIds.slice(0, 20),
    });
  }
  return out;
}

/**
 * Instructions that have grown until they compete with themselves.
 *
 * The same reasoning as the doctor's warning past ten standing conventions:
 * every run of the workspace carries this text in its cached prefix, and a
 * list of rules long enough has started to contradict itself. Unlike the
 * others this needs no window at all — it is a fact about the text — but it
 * belongs here so the arbiter sees it beside the runs it shapes.
 */
function crowdedInstructions(window: EvidenceWindow, length: number | undefined): RevisionFinding[] {
  if (length === undefined || length < INSTRUCTIONS_MAX * INSTRUCTIONS_CROWDED_RATIO) return [];
  return [
    {
      key: 'instructions-crowded',
      kind: 'instructions-oversize',
      summary:
        `This workspace's standing instructions are ${length} characters, past ` +
        `${Math.round(INSTRUCTIONS_CROWDED_RATIO * 100)}% of what the field holds. Every run carries all of it.`,
      // A fact about the text, not about any run — and saying so is better
      // than attaching runs that do not demonstrate it.
      runIds: window.runs.slice(-1).map((run) => run.id),
    },
  ];
}

/* -------------------------------------------------------------------------- */
/* The review log                                                              */
/* -------------------------------------------------------------------------- */

/**
 * One completed pass, recorded whether or not it proposed anything.
 *
 * The `reflected_at` lesson, applied before it could be learned twice: four
 * outcomes are otherwise indistinguishable and every one renders as an empty
 * screen — the window was not ready, the pass found nothing, the rules dropped
 * everything, the model call died. Three of those are correct and one is a
 * defect.
 *
 * It is also the cursor. The newest row for a workspace says how far the last
 * pass read, so no second table holds a copy of something these rows already
 * say — a stored derived value is right only until its input moves.
 */
export function recordReview(db: Db, review: RevisionReview): void {
  db.prepare(
    `INSERT INTO revision_reviews
       (id, workspace_id, at, window_from, window_to, runs_examined, observations, findings,
        proposed, dropped, model, duration_ms, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    review.id,
    review.workspaceId,
    review.at,
    review.windowFrom,
    review.windowTo,
    review.runsExamined,
    JSON.stringify(review.observations),
    JSON.stringify(review.findings),
    review.proposed,
    JSON.stringify(review.dropped),
    review.model,
    review.durationMs,
    review.error,
  );
}

interface ReviewRow {
  id: string;
  workspace_id: string;
  at: number;
  window_from: number;
  window_to: number;
  runs_examined: number;
  observations: string;
  findings: string;
  proposed: number;
  dropped: string;
  model: string | null;
  duration_ms: number;
  error: string | null;
}

const toReview = (row: ReviewRow): RevisionReview => ({
  id: row.id,
  workspaceId: row.workspace_id,
  at: row.at,
  windowFrom: row.window_from,
  windowTo: row.window_to,
  runsExamined: row.runs_examined,
  observations: parseJson<RevisionFinding[]>(row.observations, []),
  findings: parseJson<RevisionFinding[]>(row.findings, []),
  proposed: row.proposed,
  dropped: parseJson<RevisionReview['dropped']>(row.dropped, []),
  model: row.model,
  durationMs: row.duration_ms,
  error: row.error,
});

/** A workspace's reviews, newest first. */
export function listReviews(db: Db, workspaceId: string, limit = 20): RevisionReview[] {
  return db
    .prepare<[string, number], ReviewRow>(
      // `rowid` breaks the tie: two reviews recorded in one millisecond are
      // possible on a catch-up, and `at` alone is then not a total order — the
      // same reasoning as the audit chain's ordering.
      'SELECT * FROM revision_reviews WHERE workspace_id = ? ORDER BY at DESC, rowid DESC LIMIT ?',
    )
    .all(workspaceId, Math.min(limit, 200))
    .map(toReview);
}

/** The most recent pass over this workspace, or null if there has never been one. */
export function lastReview(db: Db, workspaceId: string): RevisionReview | null {
  return listReviews(db, workspaceId, 1)[0] ?? null;
}

/**
 * How far the last *completed* pass read.
 *
 * A pass that died does not move the cursor: its runs were never judged, and
 * advancing past them would lose them for good. Same discipline as leaving a
 * run unmarked when the reflexion gate throws — the set that needs retrying is
 * exactly the set nothing has finished with.
 */
export function reviewCursor(db: Db, workspaceId: string): number {
  return (
    db
      .prepare<[string], { at: number }>(
        'SELECT MAX(window_to) AS at FROM revision_reviews WHERE workspace_id = ? AND error IS NULL',
      )
      .get(workspaceId)?.at ?? 0
  );
}

/** Why a workspace is not being reviewed right now, or null when it is due. */
export type NotDue = 'opted-out' | 'too-soon' | 'too-few-runs' | 'no-runs';

/**
 * Whether this workspace has earned another pass.
 *
 * Both halves matter and they fail differently. Too few runs means there is
 * not enough to see a habit in; too soon means the operator has already been
 * asked about almost these runs, and asking again is how a refusal turns into
 * nagging.
 */
export interface ReviewDue {
  due: boolean;
  /** Why not, when not. */
  reason?: NotDue;
  /** Where the next window starts. */
  since: number;
  /** Runs finished since the cursor. Always counted — see below. */
  fresh: number;
  /**
   * Whether the run floor is met, independently of the reasons above.
   *
   * Separate because the reasons are ordered and the *first* one wins, so a
   * workspace that has opted out reports `opted-out` and says nothing about
   * whether it has the traffic. A caller that waives the opt-in — the button —
   * would then be told "you may proceed" about a window of two runs, promise a
   * pass, and watch it skip silently. That is the shape of a feature nobody
   * trusts, so the floor is answered on its own terms.
   */
  enoughRuns: boolean;
}

export function reviewDue(
  db: Db,
  workspace: { id: string; settings: { improvementAuto: boolean } },
  now: number,
): ReviewDue {
  const since = reviewCursor(db, workspace.id);
  const fresh =
    db
      .prepare<[string, number], { n: number }>(
        `SELECT COUNT(*) AS n FROM runs
          WHERE workspace_id = ? AND finished_at IS NOT NULL AND finished_at > ?
            AND status != 'interrupted'`,
      )
      .get(workspace.id, since)?.n ?? 0;
  const enoughRuns = fresh >= REVIEW_MIN_RUNS;
  const base = { since, fresh, enoughRuns };

  if (!workspace.settings.improvementAuto) return { due: false, reason: 'opted-out', ...base };

  const last = lastReview(db, workspace.id);
  if (last && now - last.at < REVIEW_MIN_DAYS * 86_400_000) {
    return { due: false, reason: 'too-soon', ...base };
  }
  if (fresh === 0) return { due: false, reason: 'no-runs', ...base };
  if (!enoughRuns) return { due: false, reason: 'too-few-runs', ...base };
  return { due: true, ...base };
}

/** Drop reviews past the retention horizon; the janitor's sweep calls it. */
export function pruneReviews(db: Db, retentionDays: number, now: number = Date.now()): number {
  return db
    .prepare('DELETE FROM revision_reviews WHERE at < ?')
    .run(now - retentionDays * 86_400_000).changes;
}
