/**
 * The rules that sit between a model's answer and an instruction in force, and
 * the pass that runs them.
 *
 * Every rule here exists because the memory gate measured that a prompt cannot
 * enforce its own: four rules had to sit *after* the model there, and the
 * arbiter's prompt asks for exactly the discipline these check. So the fake
 * arbiter in this file is deliberately badly behaved — it cites runs that are
 * not in the window, rests rewrites on findings it named once, rewrites whole
 * prompts when asked for edits, and proposes the text it was shown. A fake
 * that answered well would prove that the rules run, never that they hold.
 */

import type { RevisionFinding, Workspace } from '@metaclaude/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate, openDatabase, type Db } from '../db/index.js';
import { EventBus } from '../kernel/bus.js';
import type { Kernel } from '../kernel/kernel.js';
import { defaultWorkspaceSettings, RunRepo, SessionRepo, WorkspaceRepo } from '../kernel/repositories.js';
import { LibraryService } from '../library/service.js';
import { Vault } from '../security/vault.js';
import { AdvisorService } from '../services/advisor.js';
import { BoardService } from '../services/board.js';
import { Registry } from '../services/registry.js';
import { Scheduler } from '../services/scheduler.js';
import type { ArbiterOutput, ArbiterTarget } from './improvement-arbiter.js';
import { STRUCTURED_DEFAULT_MODEL } from './structured-call.js';
import { listReviews, OBSERVATION_MIN_RUNS, REVIEW_MIN_RUNS, UNUSED_MIN_RUNS } from './improvement.js';
import { recordExtensionUsage } from './extension-usage.js';
import {
  applyRules,
  collectTargets,
  collectTargetsWithBudget,
  TARGETS_MAX_CHARS,
  ImprovementReviewer,
  MAX_CHANGED_RATIO,
  PROPOSALS_PER_REVIEW,
  QUOTA_CEILING,
} from './improvement-review.js';

let db: Db;
let workspaces: WorkspaceRepo;
let registry: Registry;
let scheduler: Scheduler;
let advisor: AdvisorService;
let workspace: Workspace;
let answer: ArbiterOutput;
let arbiterCalls: number;

const DAY = 86_400_000;
const START = 1_700_000_000_000;
const noop = () => {
  /* no-op logger */
};

beforeEach(() => {
  db = openDatabase({ path: ':memory:' });
  migrate(db);
  workspaces = new WorkspaceRepo(db);
  const sessions = new SessionRepo(db);
  registry = new Registry(db, new Vault(db, Buffer.alloc(32, 7)), noop);
  scheduler = new Scheduler({
    db,
    bus: new EventBus(),
    kernel: { submit: async () => ({}) } as unknown as Kernel,
    sessions,
    workspaces,
    finalAnswer: () => null,
    log: noop,
  });
  workspace = workspaces.create({
    name: 'Alpha',
    slug: 'alpha',
    description: 'bench',
    path: '/tmp/alpha',
    color: '#6366f1',
    icon: 'folder',
    settings: {
      ...defaultWorkspaceSettings(),
      improvementAuto: true,
      systemPromptAppend: 'Answer in French.\nBe brief.',
    },
  });
  advisor = new AdvisorService({
    db,
    workspaces,
    sessions,
    runs: new RunRepo(db),
    registry,
    scheduler,
    library: new LibraryService(registry),
    board: { list: (id) => new BoardService(db).list({ workspaceId: id }) },
    submit: (async () => ({})) as never,
    log: noop,
  });
  answer = { findings: [], revisions: [] };
  arbiterCalls = 0;
});

function reviewer(over: Partial<ConstructorParameters<typeof ImprovementReviewer>[0]> = {}) {
  return new ImprovementReviewer({
    db,
    workspaces,
    registry,
    automations: scheduler,
    advisor,
    arbiter: async () => {
      arbiterCalls += 1;
      return answer;
    },
    language: () => null,
    log: noop,
    // Late enough that a seeded window of one run per day fits inside it: a
    // clock that cut the fixture short is what made the first version of the
    // proposal test fail against perfectly good rules.
    now: () => START + 60 * DAY,
    ...over,
  });
}

let runCount = 0;
function seedRun(over: { at?: number; status?: string; id?: string } = {}): string {
  runCount += 1;
  const id = over.id ?? `run_${runCount}`;
  db.prepare(
    `INSERT OR IGNORE INTO sessions (id, workspace_id, title, status, model, permission_mode, created_at, updated_at, last_activity_at)
     VALUES ('ses_1', ?, 'S', 'idle', 'sonnet', 'default', 1, 1, 1)`,
  ).run(workspace.id);
  db.prepare(
    `INSERT INTO runs (id, session_id, workspace_id, prompt, status, triggered_by, usage, started_at, finished_at)
     VALUES (?, 'ses_1', ?, 'do a thing', ?, 'user', '{"turns":3}', ?, ?)`,
  ).run(id, workspace.id, over.status ?? 'succeeded', over.at ?? START, over.at ?? START);
  return id;
}

/** Enough runs, over enough days, that a pass is due and observations exist. */
function seedWindow(count = REVIEW_MIN_RUNS + 6): string[] {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    ids.push(seedRun({ at: START + index * DAY }));
  }
  return ids;
}

const skill = () =>
  registry.upsertSkill({
    workspaceId: workspace.id,
    name: 'review-migrations',
    description: 'Reviews migrations.',
    body: '# Review\n\nStep one.',
  });

/* -------------------------------------------------------------------------- */

describe('collectTargets', () => {
  it('always offers the workspace’s own instructions', () => {
    const targets = collectTargets({ registry, automations: scheduler }, workspace);

    expect(targets[0]).toMatchObject({ kind: 'workspace', field: 'systemPromptAppend', whole: true });
  });

  it('offers both fields of an enabled skill and neither of a disabled one', () => {
    const live = skill();
    registry.upsertSkill({ workspaceId: workspace.id, name: 'quiet', description: 'd', body: 'b', enabled: false });

    const fields = collectTargets({ registry, automations: scheduler }, workspace)
      .filter((target) => target.kind === 'skill')
      .map((target) => `${target.name}:${target.field}`);
    expect(fields).toEqual([`${live.name}:description`, `${live.name}:body`]);
  });

  it('offers a disabled automation too, since its prompt is still a text', () => {
    scheduler.create({
      workspaceId: workspace.id,
      name: 'Morning',
      prompt: 'Review the day.',
      trigger: { type: 'manual' },
      enabled: false,
    });

    expect(
      collectTargets({ registry, automations: scheduler }, workspace).filter((t) => t.kind === 'automation'),
    ).toHaveLength(1);
  });

  /**
   * A model can only decide about what it was shown. The consolidation pass
   * learned it when judging a long memory on a prefix folded its tail away
   * into a note derived from that prefix.
   */
  it('shows a text too long to judge in part, and marks it unrevisable', () => {
    registry.upsertSkill({
      workspaceId: workspace.id,
      name: 'enormous',
      description: 'd',
      body: 'x'.repeat(50_000),
    });

    const body = collectTargets({ registry, automations: scheduler }, workspace).find(
      (target) => target.name === 'enormous' && target.field === 'body',
    );
    expect(body?.whole).toBe(false);
    expect(body?.text.length).toBeLessThan(50_000);
  });

  /*
   * How many of them, and how long.
   *
   * This list is read straight into a model prompt, so unbounded means an
   * unbounded bill and — past the context window — a pass that fails every
   * week, for good, with nothing on screen but a row saying the call died.
   * Every individual text was capped from the first day; the *number* of them
   * was not, and a workspace with forty skills is not unusual.
   *
   * Whether a workspace may rewrite what it is shown is a different question,
   * answered by the service: this list is `listSkills(workspace.id)`, which is
   * the reach, so everything in it is something this workspace runs under.
   */
  it('spends a bounded number of characters, however many extensions there are', () => {
    // Forty skills of ten thousand characters is four hundred thousand — about
    // a hundred thousand tokens — on top of the window, every week, for a
    // workspace nobody would call unusual.
    for (let index = 0; index < 40; index += 1) {
      registry.upsertSkill({
        workspaceId: workspace.id,
        name: `filler-${index}`,
        description: `Filler ${index}.`,
        body: 'x'.repeat(10_000),
      });
    }

    const targets = collectTargets({ registry, automations: scheduler }, workspace);
    const spent = targets.reduce((total, target) => total + target.text.length, 0);
    expect(spent).toBeLessThanOrEqual(TARGETS_MAX_CHARS);
    // And the one text that reaches every run of this workspace is never the
    // one dropped to make room.
    expect(targets[0]).toMatchObject({ kind: 'workspace' });
  });

  it('spends what the operator set rather than what shipped', () => {
    for (let index = 0; index < 40; index += 1) {
      registry.upsertSkill({
        workspaceId: workspace.id,
        name: `filler-${index}`,
        description: `Filler ${index}.`,
        body: 'x'.repeat(10_000),
      });
    }

    const tight = collectTargetsWithBudget(
      { registry, automations: scheduler },
      workspace,
      20_000,
    );
    const generous = collectTargetsWithBudget(
      { registry, automations: scheduler },
      workspace,
      200_000,
    );

    expect(tight.targets.reduce((n, t) => n + t.text.length, 0)).toBeLessThanOrEqual(20_000);
    expect(generous.targets.length).toBeGreaterThan(tight.targets.length);
    expect(tight.omitted).toBeGreaterThan(generous.omitted);
  });

  it('says how many it could not show, so the model does not propose creating them', () => {
    for (let index = 0; index < 40; index += 1) {
      registry.upsertSkill({
        workspaceId: workspace.id,
        name: `filler-${index}`,
        description: `Filler ${index}.`,
        body: 'x'.repeat(10_000),
      });
    }

    const { targets, omitted } = collectTargetsWithBudget({ registry, automations: scheduler }, workspace);
    expect(omitted).toBeGreaterThan(0);
    expect(targets.length).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------- */

describe('applyRules', () => {
  const target = (over: Partial<ArbiterTarget> = {}): ArbiterTarget => ({
    kind: 'skill',
    id: 'skl_1',
    name: 'review-migrations',
    field: 'description',
    text: 'Reviews migrations.',
    whole: true,
    note: '',
    ...over,
  });

  const finding = (over: Partial<RevisionFinding> = {}): RevisionFinding => ({
    key: 'unused-extension:skill:skl_1',
    kind: 'unused-extension',
    summary: 'never used',
    runIds: ['r1', 'r2', 'r3'],
    ...over,
  });

  const window = (ids: string[] = ['r1', 'r2', 'r3']) =>
    ({
      workspaceId: workspace.id,
      from: 0,
      to: 1,
      omitted: 0,
      runs: ids.map((id) => ({ id, sessionId: 'ses_1' })),
    }) as never;

  const run = (over: Record<string, unknown> = {}) =>
    applyRules({
      revisions: [
        {
          target: 1,
          after: 'Use when reviewing a database migration before it ships.',
          rationale: 'r',
          findingKeys: ['unused-extension:skill:skl_1'],
        },
      ],
      targets: [target()],
      findings: [],
      observations: [finding()],
      window: window(),
      refusedKeys: [],
      ...over,
    });

  it('keeps a well-grounded, minimal edit', () => {
    const { kept, dropped } = run();

    expect(kept).toHaveLength(1);
    expect(dropped).toEqual([]);
  });

  it('drops a revision naming a target that was never shown', () => {
    const { kept, dropped } = run({
      revisions: [{ target: 9, after: 'x', rationale: 'r', findingKeys: ['unused-extension:skill:skl_1'] }],
    });

    expect(kept).toEqual([]);
    expect(dropped[0]?.reason).toMatch(/not shown/);
  });

  it('drops a revision of a text that was shown only in part', () => {
    const { kept, dropped } = run({ targets: [target({ whole: false })] });

    expect(kept).toEqual([]);
    expect(dropped[0]?.reason).toMatch(/too long/);
  });

  it('drops a rewrite identical to what is there', () => {
    const { kept, dropped } = run({
      revisions: [{ target: 1, after: 'Reviews migrations.', rationale: 'r', findingKeys: ['unused-extension:skill:skl_1'] }],
    });

    expect(kept).toEqual([]);
    expect(dropped[0]?.reason).toMatch(/already there/);
  });

  /**
   * The rule this whole pass would be dangerous without: an answer that
   * replaces the operator's instructions wholesale with the model's own idea
   * of good ones is a different act from an edit, and reads on the card as a
   * wall of green.
   */
  it('drops a rewrite that changes most of the text', () => {
    const before = Array.from({ length: 20 }, (_, index) => `rule ${index}`).join('\n');
    const after = Array.from({ length: 20 }, (_, index) => `NEW ${index}`).join('\n');
    const { kept, dropped } = run({
      targets: [target({ field: 'body', text: before })],
      revisions: [{ target: 1, after, rationale: 'r', findingKeys: ['unused-extension:skill:skl_1'] }],
    });

    expect(kept).toEqual([]);
    expect(dropped[0]?.reason).toMatch(/rewrite/);
    expect(MAX_CHANGED_RATIO).toBeLessThan(1);
  });

  it('keeps an edit just under the ceiling', () => {
    const before = Array.from({ length: 20 }, (_, index) => `rule ${index}`).join('\n');
    const after = before.split('\n').map((line, index) => (index < 5 ? `CHANGED ${index}` : line)).join('\n');
    const { kept } = run({
      targets: [target({ field: 'body', text: before })],
      revisions: [{ target: 1, after, rationale: 'r', findingKeys: ['unused-extension:skill:skl_1'] }],
    });

    expect(kept).toHaveLength(1);
  });

  it('lets a text be written from nothing, which is not a rewrite', () => {
    const { kept } = run({
      targets: [target({ kind: 'workspace', field: 'systemPromptAppend', text: '' })],
      revisions: [{ target: 1, after: 'Cite what you read.', rationale: 'r', findingKeys: ['unused-extension:skill:skl_1'] }],
    });

    expect(kept).toHaveLength(1);
  });

  /* ---- the evidence rules ---- */

  it('drops a revision that cites nothing', () => {
    const { kept, dropped } = run({
      revisions: [{ target: 1, after: 'Use when a migration ships.', rationale: 'r', findingKeys: [] }],
    });

    expect(kept).toEqual([]);
    expect(dropped[0]?.reason).toMatch(/cites no finding/);
  });

  it('drops a revision citing a finding that does not exist', () => {
    const { kept, dropped } = run({
      revisions: [{ target: 1, after: 'Use when a migration ships.', rationale: 'r', findingKeys: ['invented'] }],
    });

    expect(kept).toEqual([]);
    expect(dropped[0]?.reason).toMatch(/cites no finding/);
  });

  /**
   * The arbiter's own findings count, which is the point of letting it have
   * any — but only when they name enough runs the window actually holds.
   */
  it('accepts the arbiter’s own finding when it is properly grounded', () => {
    const { kept } = run({
      observations: [],
      findings: [finding({ key: 'mine', kind: 'observed' })],
      revisions: [{ target: 1, after: 'Use when a migration ships.', rationale: 'r', findingKeys: ['mine'] }],
    });

    expect(kept).toHaveLength(1);
  });

  it('drops one whose finding names too few runs', () => {
    const { kept, dropped } = run({
      observations: [],
      findings: [finding({ key: 'mine', runIds: ['r1'] })],
      revisions: [{ target: 1, after: 'Use when a migration ships.', rationale: 'r', findingKeys: ['mine'] }],
    });

    expect(kept).toEqual([]);
    expect(dropped[0]?.reason).toMatch(new RegExp(`${OBSERVATION_MIN_RUNS} runs`));
  });

  /**
   * A model asked for evidence will supply plausible-looking run ids. Only the
   * ones the window actually holds are counted, so an invented citation is the
   * same as no citation.
   */
  it('does not count runs the window does not hold', () => {
    const { kept, dropped } = run({
      observations: [],
      findings: [finding({ key: 'mine', runIds: ['r1', 'invented_a', 'invented_b'] })],
      revisions: [{ target: 1, after: 'Use when a migration ships.', rationale: 'r', findingKeys: ['mine'] }],
    });

    expect(kept).toEqual([]);
    expect(dropped[0]?.reason).toMatch(/names 3 runs/);
  });

  /**
   * A counted fact wins over the model's restatement of it. Otherwise an
   * arbiter could weaken a threshold simply by describing it differently under
   * the same key.
   */
  it('takes the counted version of a key the arbiter also used', () => {
    const { kept } = run({
      findings: [finding({ runIds: ['r1'] })],
      observations: [finding({ runIds: ['r1', 'r2', 'r3'] })],
    });

    expect(kept).toHaveLength(1);
  });

  it('drops one resting on a finding the operator already refused', () => {
    const { kept, dropped } = run({ refusedKeys: ['unused-extension:skill:skl_1'] });

    expect(kept).toEqual([]);
    expect(dropped[0]?.reason).toMatch(/already refused/);
  });

  /* ---- the shape rules ---- */

  it('refuses a second rewrite of one text in the same pass', () => {
    const { kept, dropped } = run({
      revisions: [
        { target: 1, after: 'Use when a migration ships.', rationale: 'r', findingKeys: ['unused-extension:skill:skl_1'] },
        { target: 1, after: 'Use when a migration is reviewed.', rationale: 'r', findingKeys: ['unused-extension:skill:skl_1'] },
      ],
    });

    expect(kept).toHaveLength(1);
    expect(dropped[0]?.reason).toMatch(/second rewrite/);
  });

  it('stops at the per-pass ceiling', () => {
    const targets = Array.from({ length: PROPOSALS_PER_REVIEW + 2 }, (_, index) =>
      target({ id: `skl_${index}`, name: `skill-${index}` }),
    );
    const { kept } = run({
      targets,
      revisions: targets.map((_, index) => ({
        target: index + 1,
        after: 'Use when a migration ships.',
        rationale: 'r',
        findingKeys: ['unused-extension:skill:skl_1'],
      })),
    });

    expect(kept).toHaveLength(PROPOSALS_PER_REVIEW);
  });

  it('drops a field the target does not have', () => {
    const { kept, dropped } = run({ targets: [target({ kind: 'automation', field: 'description' })] });

    expect(kept).toEqual([]);
    expect(dropped[0]?.reason).toMatch(/has no description/);
  });
});

/* -------------------------------------------------------------------------- */

describe('the pass', () => {
  it('does nothing for a workspace that opted out', async () => {
    workspaces.update(workspace.id, { settings: { improvementAuto: false } });
    seedWindow();

    expect(await reviewer().review(workspace.id)).toMatchObject({ status: 'skipped', reason: 'opted-out' });
    expect(arbiterCalls).toBe(0);
  });

  it('reviews an opted-out workspace when the operator asks', async () => {
    workspaces.update(workspace.id, { settings: { improvementAuto: false } });
    seedWindow();

    expect(await reviewer().review(workspace.id, { force: true })).toMatchObject({ status: 'reviewed' });
    expect(arbiterCalls).toBe(1);
  });

  /**
   * Forcing waives the opt-in and the clock, never the floor. A pass over two
   * runs would be answering a question nobody can answer from two runs, and
   * the button should not be able to ask it.
   */
  it('still refuses to review a window with almost nothing in it', async () => {
    seedRun({ at: START });

    expect(await reviewer().review(workspace.id, { force: true })).toMatchObject({
      status: 'skipped',
      reason: 'too-few-runs',
    });
    expect(arbiterCalls).toBe(0);
  });

  it('records a pass that proposed nothing, which is the common answer', async () => {
    seedWindow();

    const result = await reviewer().review(workspace.id);

    expect(result).toMatchObject({ status: 'reviewed', proposed: 0 });
    const [review] = listReviews(db, workspace.id);
    expect(review).toMatchObject({ proposed: 0, error: null });
    expect(review?.runsExamined).toBeGreaterThanOrEqual(REVIEW_MIN_RUNS);
  });

  it('files a proposal the rules accept, with its evidence', async () => {
    const one = skill();
    const ids = seedWindow(UNUSED_MIN_RUNS + 2);
    for (const id of ids) {
      recordExtensionUsage(db, id, [
        { kind: 'skill', extensionId: one.id, name: one.name, available: true, invoked: 0, failed: 0 },
      ]);
    }
    answer = {
      findings: [],
      revisions: [
        {
          target: 2, // the skill's description; target 1 is the workspace
          after: 'Use when reviewing a database migration before it ships.',
          rationale: 'It is offered constantly and never opened.',
          findingKeys: [`unused-extension:skill:${one.id}`],
        },
      ],
    };

    const result = await reviewer().review(workspace.id);

    expect(result.proposed).toBe(1);
    const [proposal] = advisor.list(workspace.id, 'pending');
    const payload = proposal?.payload as { after: string; evidence: unknown[]; diff: string };
    expect(payload.after).toBe('Use when reviewing a database migration before it ships.');
    expect(payload.evidence.length).toBeGreaterThanOrEqual(OBSERVATION_MIN_RUNS);
    expect(payload.diff).toContain('+Use when reviewing');
  });

  /**
   * A pass that dies leaves a row saying so — which is the whole reason every
   * pass is recorded. Without it, "nothing needed changing" and "the call
   * died" are the same empty screen, and that cost a deployment a day of lost
   * memory before `reflected_at` existed.
   */
  it('records a pass whose arbiter died, and does not move the cursor', async () => {
    seedWindow();
    const failing = reviewer({
      arbiter: async () => {
        throw new Error('the instruction review answered with nothing usable');
      },
    });

    expect(await failing.review(workspace.id)).toMatchObject({ status: 'failed' });
    const [review] = listReviews(db, workspace.id);
    expect(review?.error).toMatch(/nothing usable/);

    // The cursor has not moved, so the same runs are still due.
    expect(await reviewer().review(workspace.id, { force: true })).toMatchObject({ status: 'reviewed' });
  });

  it('records what the rules refused, and why', async () => {
    seedWindow();
    answer = {
      findings: [],
      revisions: [{ target: 1, after: 'Something new entirely.', rationale: 'r', findingKeys: [] }],
    };

    await reviewer().review(workspace.id);

    expect(listReviews(db, workspace.id)[0]?.dropped[0]?.reason).toMatch(/cites no finding/);
  });

  it('does not review the same runs twice', async () => {
    seedWindow();
    await reviewer().review(workspace.id);

    const second = await reviewer({ now: () => START + 90 * DAY }).review(workspace.id);
    expect(second).toMatchObject({ status: 'skipped', reason: 'no-runs' });
  });

  it('reviews again once new runs have arrived and the week has passed', async () => {
    seedWindow();
    await reviewer().review(workspace.id);
    for (let index = 0; index < REVIEW_MIN_RUNS; index += 1) {
      seedRun({ at: START + (70 + index) * DAY });
    }

    expect(await reviewer({ now: () => START + 90 * DAY }).review(workspace.id)).toMatchObject({
      status: 'reviewed',
    });
  });
});

describe('the sweep', () => {
  it('passes over a workspace that opted out', async () => {
    workspaces.update(workspace.id, { settings: { improvementAuto: false } });
    seedWindow();

    expect(await reviewer().sweep()).toEqual({ reviewed: 0, proposed: 0 });
    expect(arbiterCalls).toBe(0);
  });

  it('reviews one that is due', async () => {
    seedWindow();

    expect(await reviewer().sweep()).toMatchObject({ reviewed: 1 });
  });

  /**
   * The autopilot's guard, with its reasoning intact: a background pass must
   * not spend the last of a window the operator is about to want.
   */
  it('waits when the quota window is nearly spent', async () => {
    seedWindow();

    expect(await reviewer({ quota: async () => QUOTA_CEILING + 0.01 }).sweep()).toEqual({
      reviewed: 0,
      proposed: 0,
    });
    expect(arbiterCalls).toBe(0);
  });

  it('proceeds when the quota is unknowable, as it is under an API key', async () => {
    seedWindow();

    expect(await reviewer({ quota: async () => null }).sweep()).toMatchObject({ reviewed: 1 });
  });

  it('proceeds when the quota is comfortable', async () => {
    seedWindow();

    expect(await reviewer({ quota: async () => 0.2 }).sweep()).toMatchObject({ reviewed: 1 });
  });

  /** One workspace's broken state must never cost the others their review. */
  it('carries on past a workspace that threw', async () => {
    seedWindow();
    const other = workspaces.create({
      name: 'Beta',
      slug: 'beta',
      description: '',
      path: '/tmp/beta',
      color: '#6366f1',
      icon: 'folder',
      settings: { ...defaultWorkspaceSettings(), improvementAuto: true },
    });
    db.prepare(
      `INSERT INTO sessions (id, workspace_id, title, status, model, permission_mode, created_at, updated_at, last_activity_at)
       VALUES ('ses_b', ?, 'S', 'idle', 'sonnet', 'default', 1, 1, 1)`,
    ).run(other.id);
    for (let index = 0; index < REVIEW_MIN_RUNS; index += 1) {
      db.prepare(
        `INSERT INTO runs (id, session_id, workspace_id, prompt, status, triggered_by, usage, started_at, finished_at)
         VALUES (?, 'ses_b', ?, 'p', 'succeeded', 'user', '{}', ?, ?)`,
      ).run(`run_b_${index}`, other.id, START + index * DAY, START + index * DAY);
    }

    const spy = vi.fn(async (input: { workspaceName: string }) => {
      arbiterCalls += 1;
      if (input.workspaceName === 'Alpha') throw new Error('boom');
      return answer;
    });

    expect(await reviewer({ arbiter: spy as never }).sweep()).toMatchObject({ reviewed: 1 });
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

/**
 * The half that closes the loop.
 *
 * A background pass that cannot say whether its own advice worked is one
 * nobody should take advice from — and it is the half of "what works and what
 * does not" an operator cannot see for themselves, because it needs the same
 * measurement repeated on the same terms. `recurred` is therefore the same
 * finding key coming back from the same deterministic observations, never a
 * second opinion about them.
 */
describe('following up on a revision that was applied', () => {
  /** Offer a skill to `runs` runs on distinct days, never invoked. */
  const neglect = (from: number, runs: number, skillId: string) => {
    const ids: string[] = [];
    for (let index = 0; index < runs; index += 1) {
      const id = seedRun({ at: from + index * DAY });
      recordExtensionUsage(db, id, [
        { kind: 'skill', extensionId: skillId, name: 'review-migrations', available: true, invoked: 0, failed: 0 },
      ]);
      ids.push(id);
    }
    return ids;
  };

  const applyRevision = (skillId: string, decidedAt: number) => {
    const proposal = advisor.proposeRevision({
      workspaceId: workspace.id,
      runId: null,
      target: { kind: 'skill', id: skillId, name: 'review-migrations', workspaceId: null },
      field: 'description',
      after: 'Use when reviewing a database migration before it ships.',
      rationale: 'r',
      findings: [
        { key: `unused-extension:skill:${skillId}`, kind: 'unused-extension', summary: 's', runIds: ['x'] },
      ],
    });
    advisor.accept(proposal.id, 'jgo');
    db.prepare('UPDATE advisor_proposals SET decided_at = ? WHERE id = ?').run(decidedAt, proposal.id);
    return proposal.id;
  };

  const followUpOf = (id: string) =>
    (advisor.get(id)?.payload as { followUp: { recurred: boolean } | null }).followUp;

  it('says the problem came back when it did', async () => {
    const one = skill();
    neglect(START, UNUSED_MIN_RUNS + 2, one.id);
    const proposalId = applyRevision(one.id, START - DAY);
    // A second window, entirely after the change, where it is still ignored.
    await reviewer().review(workspace.id, { force: true });

    expect(followUpOf(proposalId)).toMatchObject({ recurred: true });
  });

  it('says it did not come back when it did not', async () => {
    const one = skill();
    const proposalId = applyRevision(one.id, START - DAY);
    // Enough runs for a window, and the skill is used every time.
    for (let index = 0; index < REVIEW_MIN_RUNS + 2; index += 1) {
      const id = seedRun({ at: START + index * DAY });
      recordExtensionUsage(db, id, [
        { kind: 'skill', extensionId: one.id, name: 'review-migrations', available: true, invoked: 1, failed: 0 },
      ]);
    }

    await reviewer().review(workspace.id, { force: true });

    expect(followUpOf(proposalId)).toMatchObject({ recurred: false });
  });

  /**
   * A revision applied halfway through the window would be judged partly on
   * runs that predate it, which measures nothing. It waits for the next pass.
   */
  it('says nothing yet about one applied after the window began', async () => {
    const one = skill();
    neglect(START, UNUSED_MIN_RUNS + 2, one.id);
    const proposalId = applyRevision(one.id, START + 5 * DAY);

    await reviewer().review(workspace.id, { force: true });

    expect(followUpOf(proposalId)).toBeNull();
  });

  it('says nothing about one that was taken back', async () => {
    const one = skill();
    neglect(START, UNUSED_MIN_RUNS + 2, one.id);
    const proposalId = applyRevision(one.id, START - DAY);
    advisor.revert(proposalId, 'jgo');

    await reviewer().review(workspace.id, { force: true });

    expect(followUpOf(proposalId)).toBeNull();
  });

  /**
   * A reading taken at a moment. A second one over a later window would answer
   * a different question while looking like a correction of the first.
   */
  it('does not overwrite a follow-up already recorded', async () => {
    const one = skill();
    neglect(START, UNUSED_MIN_RUNS + 2, one.id);
    const proposalId = applyRevision(one.id, START - DAY);
    await reviewer().review(workspace.id, { force: true });
    const first = followUpOf(proposalId);

    for (let index = 0; index < REVIEW_MIN_RUNS + 2; index += 1) {
      const id = seedRun({ at: START + (70 + index) * DAY });
      recordExtensionUsage(db, id, [
        { kind: 'skill', extensionId: one.id, name: 'review-migrations', available: true, invoked: 1, failed: 0 },
      ]);
    }
    await reviewer({ now: () => START + 100 * DAY }).review(workspace.id, { force: true });

    expect(followUpOf(proposalId)).toEqual(first);
  });

  it('costs no extra model call', async () => {
    const one = skill();
    neglect(START, UNUSED_MIN_RUNS + 2, one.id);
    applyRevision(one.id, START - DAY);

    await reviewer().review(workspace.id, { force: true });

    expect(arbiterCalls).toBe(1);
  });
});

/**
 * One pass per workspace at a time.
 *
 * The daily sweep and the operator's button are two callers of one method and
 * a pass takes tens of seconds, so they can overlap. Two over the same window
 * read the same runs and reach the same conclusion; the service's duplicate
 * rule then refuses the second *proposal*, and the review row records that
 * refusal beside the first pass's success, which reads as a defect rather than
 * as two passes racing.
 */
describe('two passes over one workspace', () => {
  it('lets the first finish and turns the second away', async () => {
    seedWindow();
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = reviewer({
      arbiter: async () => {
        arbiterCalls += 1;
        await held;
        return answer;
      },
    });

    const first = slow.review(workspace.id, { force: true });
    await vi.waitFor(() => expect(arbiterCalls).toBe(1));

    expect(await slow.review(workspace.id, { force: true })).toMatchObject({
      status: 'skipped',
      reason: 'in-flight',
    });

    release();
    expect(await first).toMatchObject({ status: 'reviewed' });
    expect(arbiterCalls).toBe(1);
  });

  it('lets the next one run once the first has finished', async () => {
    seedWindow();
    const one = reviewer();
    await one.review(workspace.id, { force: true });

    expect(await one.review(workspace.id, { force: true })).not.toMatchObject({ reason: 'in-flight' });
  });

  /** A pass that threw must not leave the workspace locked out for ever. */
  it('releases the workspace even when the pass throws', async () => {
    seedWindow();
    const exploding = reviewer({
      arbiter: async () => {
        throw new Error('boom');
      },
    });

    await exploding.review(workspace.id, { force: true });

    expect(await exploding.review(workspace.id, { force: true })).not.toMatchObject({
      reason: 'in-flight',
    });
  });
});

/**
 * A weekly pass nobody hears about.
 *
 * The button's caller notifies from the route because it knows the outcome an
 * operator is waiting for; the sweep has nobody waiting, which is exactly why
 * it has to speak. And only when it proposed something: a weekly "nothing to
 * change" is the notification an operator turns off within a month, taking the
 * one that mattered with it.
 */
describe('what the sweep says out loud', () => {
  const skillOffered = () => {
    const one = skill();
    for (let index = 0; index < UNUSED_MIN_RUNS + 2; index += 1) {
      const id = seedRun({ at: START + index * DAY });
      recordExtensionUsage(db, id, [
        { kind: 'skill', extensionId: one.id, name: one.name, available: true, invoked: 0, failed: 0 },
      ]);
    }
    answer = {
      findings: [],
      revisions: [
        {
          target: 2,
          after: 'Use when reviewing a database migration before it ships.',
          rationale: 'r',
          findingKeys: [`unused-extension:skill:${one.id}`],
        },
      ],
    };
  };

  it('says so when it proposed something', async () => {
    skillOffered();
    const notify = vi.fn();

    await reviewer({ notify }).sweep();

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ proposed: 1, workspace: expect.objectContaining({ id: workspace.id }) }),
    );
  });

  it('stays quiet when it proposed nothing', async () => {
    seedWindow();
    const notify = vi.fn();

    await reviewer({ notify }).sweep();

    expect(notify).not.toHaveBeenCalled();
  });

  it('stays quiet when it never ran', async () => {
    workspaces.update(workspace.id, { settings: { improvementAuto: false } });
    seedWindow();
    const notify = vi.fn();

    await reviewer({ notify }).sweep();

    expect(notify).not.toHaveBeenCalled();
  });
});

/**
 * The review row says which model judged that window.
 *
 * A column that is always null is a column nobody can use — the `served_effort`
 * that was never built, in miniature. It is also the first thing anyone would
 * want when a week's proposals read badly.
 */
describe('what the review row records about itself', () => {
  it('names the model', async () => {
    seedWindow();

    await reviewer().review(workspace.id, { force: true });

    expect(listReviews(db, workspace.id)[0]?.model).toBe(STRUCTURED_DEFAULT_MODEL);
  });

  it('records the window it read and how long it took', async () => {
    seedWindow();

    await reviewer().review(workspace.id, { force: true });

    const [review] = listReviews(db, workspace.id);
    expect(review?.runsExamined).toBeGreaterThan(0);
    expect(review?.windowTo).toBeGreaterThan(review?.windowFrom ?? Infinity);
    expect(review?.durationMs).toBeGreaterThanOrEqual(0);
  });
});

/*
 * Which workspace is being reviewed right now.
 *
 * The reviewer has always refused a second pass over one workspace; what it
 * could not do was *say so* before starting, which is what a route needs to
 * answer 409 rather than 202 followed by a silent skip. Per workspace, because
 * two of them read disjoint runs and propose against disjoint texts.
 */
describe('busy', () => {
  it('is true for the workspace under review and false for another', async () => {
    const other = workspaces.create({
      name: 'Beta',
      slug: 'beta-busy',
      description: 'Another project',
      path: '/tmp/beta-busy',
      color: '#ef4444',
      icon: 'folder',
      settings: defaultWorkspaceSettings(),
    });
    for (let index = 0; index < 12; index += 1) seedRun({ at: START + index * DAY });

    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pass = reviewer({
      arbiter: async () => {
        await held;
        return { findings: [], revisions: [] };
      },
    });

    expect(pass.busy(workspace.id)).toBe(false);
    const running = pass.review(workspace.id, { force: true });
    expect(pass.busy(workspace.id)).toBe(true);
    expect(pass.busy(other.id)).toBe(false);

    release();
    await running;
    expect(pass.busy(workspace.id)).toBe(false);
  });
});

/*
 * The budget is read at the moment of the pass, not captured at boot.
 *
 * The reviewer is built once in `context.ts` and the setting is hot, so a
 * captured number would need a restart to change — which for a setting about
 * spend is the wrong answer, exactly as it is for the model each pass runs on.
 */
describe('the budget the pass actually spends', () => {
  it('follows the setting between two passes, with no restart', async () => {
    for (let index = 0; index < 12; index += 1) seedRun({ at: START + index * DAY });
    for (let index = 0; index < 40; index += 1) {
      registry.upsertSkill({
        workspaceId: workspace.id,
        name: `filler-${index}`,
        description: `Filler ${index}.`,
        body: 'x'.repeat(10_000),
      });
    }

    let budget = 200_000;
    // The clock has to advance between the two: a completed review moves the
    // cursor, so a second pass over the same instant has no runs to read and
    // skips — which would leave this case asserting on one call and proving
    // nothing about the second.
    let clock = START + 30 * DAY;
    const shown: number[] = [];
    const pass = reviewer({
      targetChars: () => budget,
      now: () => clock,
      arbiter: async (input) => {
        shown.push(input.targets.length);
        return { findings: [], revisions: [] };
      },
    });

    await pass.review(workspace.id, { force: true });

    for (let index = 0; index < 12; index += 1) {
      seedRun({ at: START + (31 + index) * DAY, id: `run_late_${index}` });
    }
    budget = 20_000;
    clock = START + 60 * DAY;
    await pass.review(workspace.id, { force: true });

    expect(shown).toHaveLength(2);
    expect(shown[1]).toBeLessThan(shown[0]!);
  });
});
