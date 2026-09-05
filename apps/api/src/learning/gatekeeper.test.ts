/**
 * The memory gate.
 *
 * The model is a fake here; what is under test is everything the model is
 * not trusted with. The budgets per run and per day, the level-to-shelf
 * mapping, the confidence cap, a supersession bounded to a volatile neighbour
 * the model was shown, and the rule that an unreachable gate writes nothing
 * and loses nothing. Against the real store on an in-memory database, because
 * the supersession rule is the store's and the gate must obey it.
 */

import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase, type Db } from '../db/index.js';
import { HashingEmbedder } from './embeddings.js';
import {
  GATE_PER_DAY,
  GATE_PER_FAILED_RUN,
  GATE_PER_RUN,
  Gatekeeper,
  buildGatePrompt,
  readGateOutput,
  structuralLevel,
  type GateCall,
  type GateCandidate,
  type GateVerdict,
} from './gatekeeper.js';
import { MemoryStore } from './memory.js';

let db: Db;
let store: MemoryStore;
let asked: Parameters<GateCall>[0][];
let logged: Array<{ level: string; message: string }>;

const WS = 'ws_alpha';
const RUN = 'run_gate';

const candidate = (over: Partial<GateCandidate> = {}): GateCandidate => ({
  kind: 'semantic',
  title: 'Tests run with pnpm',
  content: 'This project runs its tests with pnpm test:run, never npm test.',
  confidence: 0.9,
  tags: ['lesson'],
  ...over,
});

const verdict = (over: Partial<GateVerdict> = {}): GateVerdict => ({
  candidate: 1,
  level: 'lesson',
  keep: true,
  supersedes: null,
  reason: 'a durable rule',
  without: 'it would run npm test and fail on the workspace protocol',
  ...over,
});

function gate(answer: (input: Parameters<GateCall>[0]) => GateVerdict[] | Promise<GateVerdict[]>, extra: { instructions?: string | null; now?: number } = {}) {
  return new Gatekeeper({
    memory: store,
    call: async (input) => {
      asked.push(input);
      return answer(input);
    },
    instructions: () => extra.instructions ?? null,
    language: () => 'en',
    log: (level, message) => logged.push({ level, message }),
    ...(extra.now !== undefined ? { now: () => extra.now as number } : {}),
  });
}

beforeEach(() => {
  db = openDatabase({ path: ':memory:' });
  migrate(db);
  const now = Date.now();
  db.prepare(
    `INSERT INTO workspaces (id, name, slug, path, created_at, updated_at) VALUES (?,?,?,?,?,?)`,
  ).run(WS, 'Alpha', 'alpha', '/tmp/alpha', now, now);
  db.prepare(
    `INSERT INTO sessions (id, workspace_id, created_at, updated_at, last_activity_at) VALUES (?,?,?,?,?)`,
  ).run('ses_1', WS, now, now, now);
  db.prepare(
    `INSERT INTO runs (id, session_id, workspace_id, prompt, status, started_at) VALUES (?,?,?,?,'succeeded',?)`,
  ).run(RUN, 'ses_1', WS, 'a prompt', now);
  store = new MemoryStore(db, new HashingEmbedder());
  asked = [];
  logged = [];
});

afterEach(() => db.close());

describe('what the gate does not ask the model', () => {
  it('asks nothing for zero candidates', async () => {
    expect(await gate(() => []).admit({ workspaceId: WS, runId: RUN, failed: false, candidates: [] })).toEqual([]);
    expect(asked).toHaveLength(0);
  });

  it('writes nothing and loses nothing when the model cannot be reached', async () => {
    const decisions = await gate(() => {
      throw new Error('offline');
    }).admit({ workspaceId: WS, runId: RUN, failed: false, candidates: [candidate(), candidate({ title: 'Second' })] });

    expect(decisions.map((d) => d.outcome)).toEqual(['unjudged', 'unjudged']);
    expect(store.count(WS)).toBe(0);
    expect(logged.some((entry) => entry.level === 'warn' && /nothing was written/.test(entry.message))).toBe(true);
  });

  it('treats a candidate the model did not answer for as unjudged, not as kept', async () => {
    const decisions = await gate(() => [verdict({ candidate: 2 })]).admit({
      workspaceId: WS, runId: RUN, failed: false, candidates: [candidate(), candidate({ title: 'Second' })],
    });
    expect(decisions[0]!.outcome).toBe('unjudged');
    expect(decisions[1]!.outcome).toBe('kept');
  });
});

describe('levels, shelves and the confidence cap', () => {
  it('keeps preference and lesson as durable, fact as volatile, and stores the rest nowhere', async () => {
    const candidates = [
      candidate({ title: 'Brief in French', kind: 'procedural' }),
      candidate({ title: 'Tests run with pnpm' }),
      candidate({ title: 'API port', content: 'The API listens on 8787.' }),
      candidate({ title: 'Form offers three triggers' }),
      candidate({ title: 'Ring rules', content: 'Ring 2 is reversible.' }),
      candidate({ title: 'Card premise was stale' }),
    ];
    const decisions = await gate(() => [
      verdict({ candidate: 1, level: 'preference' }),
      verdict({ candidate: 2, level: 'lesson' }),
      verdict({ candidate: 3, level: 'fact' }),
      verdict({ candidate: 4, level: 'state', keep: false }),
      verdict({ candidate: 5, level: 'redundant', keep: false }),
      verdict({ candidate: 6, level: 'episodic', keep: false }),
    ]).admit({ workspaceId: WS, runId: RUN, failed: true, candidates });

    expect(decisions.map((d) => d.outcome)).toEqual(['kept', 'kept', 'kept', 'skipped', 'skipped', 'skipped']);
    expect(decisions.slice(0, 3).map((d) => d.shelf)).toEqual(['durable', 'durable', 'volatile']);
    expect(store.count(WS)).toBe(3);
    const written = store.get(decisions[0]!.memoryId as string)!;
    expect(written.shelf).toBe('durable');
    expect(written.kind).toBe('procedural');
    expect(written.sourceRunId).toBe(RUN);
    // Below what the writer claimed, and never above the cap.
    expect(written.confidence).toBeCloseTo(Math.min(0.75, 0.9 * 0.85), 5);
  });

  /**
   * The counterfactual is the structural half of the level rubric: a keep
   * that cannot say what would go wrong without the note is a skip, whatever
   * the model called it. Measured on the bench: this is what turned "a
   * procedure, so a lesson" into "the instructions already say this".
   */
  it('treats a keep with no counterfactual as a skip', async () => {
    const decisions = await gate(() => [verdict({ without: '' }), verdict({ candidate: 2, without: 'too short' })]).admit({
      workspaceId: WS, runId: RUN, failed: false, candidates: [candidate(), candidate({ title: 'Second' })],
    });
    expect(decisions.map((d) => d.outcome)).toEqual(['skipped', 'skipped']);
    expect(decisions[0]!.reason).toMatch(/without saying what would go wrong/);
    expect(store.count(WS)).toBe(0);
  });

  /**
   * Two reclassifications a rule makes after the model, because the bench
   * showed the model would not: a note citing code is state, a note naming
   * one of the assistant's own tools is redundant. A preference is exempt —
   * the operator's rule may name a tool.
   */
  it('overrules a keep that cites code or names a described tool, and says so', async () => {
    const withTools = new Gatekeeper({
      memory: store,
      call: async () => [
        verdict({ candidate: 1, level: 'lesson' }),
        verdict({ candidate: 2, level: 'lesson' }),
        verdict({ candidate: 3, level: 'preference' }),
        verdict({ candidate: 4, level: 'fact' }),
      ],
      instructions: () => null,
      language: () => 'en',
      describedTools: () => ['system_doctor', 'system_memory_write'],
      log: () => {},
    });
    const decisions = await withTools.admit({
      workspaceId: WS, runId: RUN, failed: true,
      candidates: [
        candidate({ title: 'Where the hook lives', content: 'The hook is in context.ts:742, not push.ts.' }),
        candidate({ title: 'Quick health check', content: 'Call system_doctor before digging.' }),
        candidate({ title: 'Never write unasked', content: 'The operator asked: never call system_memory_write unprompted.' }),
        candidate({ title: 'Port', content: 'The API listens on 8787.' }),
      ],
    });

    expect(decisions.map((d) => [d.outcome, d.level])).toEqual([
      ['skipped', 'state'],
      ['skipped', 'redundant'],
      ['kept', 'preference'],
      ['kept', 'fact'],
    ]);
    expect(decisions[0]!.reason).toMatch(/cites a file or a line/);
    expect(decisions[1]!.reason).toMatch(/system_doctor, a tool described/);
    expect(store.count(WS)).toBe(2);
  });

  it('structuralLevel: paths with and without lines, identifiers, and word boundaries', () => {
    const tools = ['system_doctor', 'board_get'];
    const lesson = (content: string) => structuralLevel({ title: 'T', content }, 'lesson', tools)?.level ?? 'lesson';
    expect(lesson('See scheduler.ts:239-246 for the guard.')).toBe('state');
    expect(lesson('The schema lives in packages/shared/src/domain.ts.')).toBe('state');
    expect(lesson('Read docs/LEARNING.md first.')).toBe('state');
    expect(lesson('Run system_doctor first.')).toBe('redundant');
    expect(lesson('Use board_get, not board_list.')).toBe('redundant');
    // Not a tool name: a longer identifier that merely contains one.
    expect(lesson('The board_get_all helper is ours.')).toBe('lesson');
    // No reference at all: the verdict stands.
    expect(lesson('Build the shared package before the others.')).toBe('lesson');
    expect(lesson('The operator prefers briefs in French, e.g. 8.30am.')).toBe('lesson');
    // A preference that is the operator's is exempt whatever it names…
    expect(structuralLevel({ title: 'T', content: 'The operator asked: never call system_doctor twice.' }, 'preference', tools)).toBeNull();
    // …and one that mentions nobody is judged as a lesson, and then caught.
    expect(structuralLevel({ title: 'T', content: 'Write, Edit and Bash are forbidden here.' }, 'preference', ['Write'])?.level).toBe('redundant');
    expect(structuralLevel({ title: 'T', content: 'Keep answers short.' }, 'preference', tools)).toBeNull();
  });

  /**
   * `remember` folds a near-identical note into an existing row. The decision
   * then names that row and says so: the shelf asked for was not applied to
   * it, and the operator must not read the insight as "a new memory exists".
   */
  it('reports a keep that was folded into an existing memory as such, with that memory’s shelf', async () => {
    const { memory: existing } = await store.remember({
      workspaceId: WS, kind: 'semantic', title: 'Tests run with pnpm', content: 'This project runs its tests with pnpm test:run, never npm test.', shelf: 'durable',
    });

    const [decision] = await gate(() => [verdict({ level: 'fact' })]).admit({
      workspaceId: WS, runId: RUN, failed: false, candidates: [candidate()],
    });

    expect(decision!.outcome).toBe('kept');
    expect(decision!.memoryId).toBe(existing.id);
    expect(decision!.shelf).toBe('durable');
    expect(decision!.reason).toMatch(/folded into an existing memory/);
    expect(store.count(WS)).toBe(1);
  });

  it('ignores a verdict that says keep for a level that is never kept', async () => {
    const decisions = await gate(() => [verdict({ level: 'state', keep: true })]).admit({
      workspaceId: WS, runId: RUN, failed: false, candidates: [candidate()],
    });
    expect(decisions[0]!.outcome).toBe('skipped');
    expect(store.count(WS)).toBe(0);
  });
});

describe('budgets', () => {
  const four = [
    candidate({ title: 'Fact one', content: 'A fact.' }),
    candidate({ title: 'Fact two', content: 'Another fact.' }),
    candidate({ title: 'A convention', content: 'The operator wants briefs in French.' }),
    candidate({ title: 'A lesson', content: 'Build shared first.' }),
  ];
  const fourVerdicts = () => [
    verdict({ candidate: 1, level: 'fact' }),
    verdict({ candidate: 2, level: 'fact' }),
    verdict({ candidate: 3, level: 'preference' }),
    verdict({ candidate: 4, level: 'lesson' }),
  ];

  it('keeps at most GATE_PER_RUN, preferring a preference and a lesson over the facts that came first', async () => {
    const decisions = await gate(fourVerdicts).admit({ workspaceId: WS, runId: RUN, failed: false, candidates: four });

    expect(GATE_PER_RUN).toBe(2);
    expect(decisions.map((d) => d.outcome)).toEqual(['over-budget', 'over-budget', 'kept', 'kept']);
    expect(store.count(WS)).toBe(2);
  });

  it('allows one more on a failed run', async () => {
    const decisions = await gate(fourVerdicts).admit({ workspaceId: WS, runId: RUN, failed: true, candidates: four });

    expect(GATE_PER_FAILED_RUN).toBe(3);
    expect(decisions.filter((d) => d.outcome === 'kept')).toHaveLength(3);
    expect(decisions[1]!.outcome).toBe('over-budget');
  });

  it('counts the day’s machine writes against a rolling daily ceiling, and not the operator’s own', async () => {
    const now = Date.now();
    for (let i = 0; i < GATE_PER_DAY - 1; i += 1) {
      await store.remember({ workspaceId: WS, kind: 'semantic', title: `Earlier ${i}`, content: `Written by a run today ${i}.`, sourceRunId: RUN });
    }
    // The operator's write carries no run and does not count.
    await store.remember({ workspaceId: WS, kind: 'semantic', title: 'Mine', content: 'Written by hand.' });

    const decisions = await gate(fourVerdicts, { now }).admit({ workspaceId: WS, runId: RUN, failed: true, candidates: four });

    expect(decisions.filter((d) => d.outcome === 'kept')).toHaveLength(1);
    expect(decisions.filter((d) => d.outcome === 'over-budget')).toHaveLength(3);
    // Yesterday's writes are outside the window.
    db.prepare('UPDATE memories SET created_at = ? WHERE source_run_id IS NOT NULL').run(now - 25 * 3600_000);
    const later = await gate(fourVerdicts, { now }).admit({ workspaceId: WS, runId: RUN, failed: false, candidates: four });
    expect(later.filter((d) => d.outcome === 'kept')).toHaveLength(2);
  });
});

describe('supersession', () => {
  it('shows the model each candidate’s nearest memories, with their shelf and pinning', async () => {
    const { memory: near } = await store.remember({ workspaceId: WS, kind: 'semantic', title: 'Tests run with pnpm', content: 'This project runs its tests with pnpm test:run.', shelf: 'volatile' });
    await store.remember({ workspaceId: WS, kind: 'semantic', title: 'Unrelated', content: 'The garden needs pruning in March.' });
    await store.remember({ workspaceId: WS, kind: 'semantic', title: 'Also unrelated', content: 'The proxy pins its certificate.' });

    await gate(() => [verdict({ keep: false, level: 'redundant' })], { instructions: '# Rules\nNever delete.' }).admit({
      workspaceId: WS, runId: RUN, failed: false, candidates: [candidate()],
    });

    const input = asked[0]!;
    expect(input.neighbours.map((n) => n.id)).toContain(near.id);
    expect(input.neighbours.find((n) => n.id === near.id)).toMatchObject({ shelf: 'volatile', pinned: false });
    expect(input.instructions).toContain('Never delete.');
    expect(input.language).toBe('en');
  });

  it('retires a volatile neighbour the model named, pointing at the new memory', async () => {
    const { memory: old } = await store.remember({ workspaceId: WS, kind: 'semantic', title: 'Form triggers', content: 'The form offers cron, interval and manual triggers.', shelf: 'volatile' });
    await store.remember({ workspaceId: WS, kind: 'semantic', title: 'Filler', content: 'Backups land nightly.' });
    await store.remember({ workspaceId: WS, kind: 'semantic', title: 'Filler two', content: 'Deploys wait for a green pipeline.' });

    const [decision] = await gate(() => [verdict({ level: 'fact', supersedes: old.id })]).admit({
      workspaceId: WS, runId: RUN, failed: false,
      candidates: [candidate({ title: 'Form triggers', content: 'The form offers cron, interval, manual and event triggers.' })],
    });

    expect(decision!.outcome).toBe('superseded');
    expect(decision!.supersededId).toBe(old.id);
    expect(store.get(old.id)).toMatchObject({ supersededBy: decision!.memoryId });
    expect(store.get(old.id)!.retiredAt).not.toBeNull();
  });

  /**
   * The model was measured wanting to replace the operator's pinned
   * convention with a note derived from it. The store refuses a pinned or
   * durable loser and the gate keeps the new memory beside the old, logged.
   */
  it('keeps the new memory but refuses to retire a pinned, a durable or an unseen target', async () => {
    const { memory: pinned } = await store.remember({ workspaceId: WS, kind: 'procedural', title: 'Board convention', content: 'Requests go through the board.', shelf: 'volatile', pinned: true });
    const { memory: durable } = await store.remember({ workspaceId: WS, kind: 'semantic', title: 'Board rule', content: 'Requests go through the board, always.' });
    await store.remember({ workspaceId: WS, kind: 'semantic', title: 'Filler', content: 'Backups land nightly.' });

    const run = (supersedes: string) =>
      gate(() => [verdict({ level: 'lesson', supersedes })]).admit({
        workspaceId: WS, runId: RUN, failed: false,
        candidates: [candidate({ title: 'Board convention, restated', content: 'Requests go through the board rather than a conversation.' })],
      });

    for (const target of [pinned.id, durable.id, 'mem_invented']) {
      const [decision] = await run(target);
      expect(decision!.outcome).toBe('kept');
      expect(decision!.supersededId).toBeUndefined();
    }
    expect(store.get(pinned.id)!.retiredAt).toBeNull();
    expect(store.get(durable.id)!.retiredAt).toBeNull();
    expect(logged.some((entry) => /refused by the store/.test(entry.message))).toBe(true);
    expect(logged.some((entry) => /not shown/.test(entry.message))).toBe(true);
  });
});

describe('the prompt and the reader', () => {
  it('numbers the candidates, names the neighbours by id with their shelf, and quotes the instructions', () => {
    const prompt = buildGatePrompt({
      candidates: [candidate(), candidate({ title: 'Second note', kind: 'procedural' })],
      neighbours: [{ id: 'mem_1', title: 'Near', content: 'Near content.', shelf: 'volatile', pinned: true }],
      instructions: '# Standing\nBe brief.',
    });
    expect(prompt).toContain('## Standing instructions of this workspace (excerpt)');
    expect(prompt).toContain('Be brief.');
    expect(prompt).toContain('[mem_1] (volatile, pinned) Near');
    expect(prompt).toContain('### Note 1 (semantic)');
    expect(prompt).toContain('### Note 2 (procedural)');
    expect(buildGatePrompt({ candidates: [candidate()], neighbours: [], instructions: null })).toContain('(none)');
  });

  it('reads a well-formed answer and drops what the schema would not have produced', () => {
    expect(readGateOutput({})).toBeNull();
    expect(
      readGateOutput({
        verdicts: [
          { candidate: 1, level: 'fact', keep: true, supersedes: ' mem_9 ', reason: 'ok', without: 'it would guess the port' },
          { candidate: 'two', level: 'fact', keep: true, supersedes: null, reason: 'bad index' },
          { candidate: 3, level: 'opinion', keep: true, supersedes: null, reason: 'bad level' },
          { candidate: 4, level: 'state', keep: 'yes', supersedes: 7, reason: 5 },
        ],
      }),
    ).toEqual([
      { candidate: 1, level: 'fact', keep: true, supersedes: 'mem_9', reason: 'ok', without: 'it would guess the port' },
      { candidate: 4, level: 'state', keep: false, supersedes: null, reason: '' },
    ]);
  });
});
