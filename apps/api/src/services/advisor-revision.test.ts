/**
 * Revisions: proposing a rewrite of a text that is already in force, applying
 * it, and taking it back.
 *
 * Kept apart from `advisor.test.ts` because the two answer different
 * questions. That file is about graduated autonomy — what the advisor may
 * create directly and what has to wait in the inbox. This one is about the
 * kind that creates nothing: what stops a proposal being applied against text
 * that has moved, what stops the same refused idea coming back next week, and
 * what makes an applied revision reversible in fact rather than in principle.
 */

import type { Workspace } from '@metaclaude/shared';
import { REVISABLE_FIELDS, RevisionTargetKind } from '@metaclaude/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate, openDatabase, type Db } from '../db/index.js';
import { EventBus } from '../kernel/bus.js';
import type { Kernel } from '../kernel/kernel.js';
import { defaultWorkspaceSettings, RunRepo, SessionRepo, WorkspaceRepo } from '../kernel/repositories.js';
import { LibraryService } from '../library/service.js';
import { Vault } from '../security/vault.js';
import { AdvisorError, AdvisorService, PROPOSAL_PAGE, REVISION_COOLDOWN_DAYS } from './advisor.js';
import { BoardService } from './board.js';
import { Registry } from './registry.js';
import { Scheduler } from './scheduler.js';
import { textFingerprint } from '../learning/revision.js';

let db: Db;
let workspaces: WorkspaceRepo;
let registry: Registry;
let scheduler: Scheduler;
let advisor: AdvisorService;
let workspace: Workspace;

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
    description: 'The test bench',
    path: '/tmp/alpha',
    color: '#6366f1',
    icon: 'folder',
    settings: { ...defaultWorkspaceSettings(), systemPromptAppend: 'Always answer in French.' },
  });

  advisor = new AdvisorService({
    db,
    workspaces,
    sessions,
    runs: new RunRepo(db),
    registry,
    scheduler,
    library: new LibraryService(registry),
    board: { list: (workspaceId) => new BoardService(db).list({ workspaceId }) },
    submit: (async () => ({})) as never,
    log: noop,
  });
});

afterEach(() => {
  db.close();
});

/* -------------------------------------------------------------------------- */

const propose = (over: Record<string, unknown> = {}) =>
  advisor.proposeRevision({
    workspaceId: workspace.id,
    runId: null,
    target: { kind: 'workspace', id: workspace.id, name: 'Alpha', workspaceId: workspace.id },
    field: 'systemPromptAppend',
    after: 'Always answer in French.\nCite the file you read a claim from.',
    rationale: 'Four runs stated a version without saying where it came from.',
    ...over,
  });

const skill = () =>
  registry.upsertSkill({
    workspaceId: workspace.id,
    name: 'review-migrations',
    description: 'Reviews migrations.',
    body: '# Review\n\nStep one.',
  });

describe('proposing a revision', () => {
  it('files it in the inbox with the diff and the text it replaces', () => {
    const proposal = propose();

    expect(proposal.kind).toBe('revision');
    expect(proposal.status).toBe('pending');
    const payload = proposal.payload as Record<string, unknown>;
    expect(payload.before).toBe('Always answer in French.');
    expect(payload.diff).toContain('+Cite the file you read a claim from.');
    expect(payload.beforeFingerprint).toBe(textFingerprint('Always answer in French.'));
  });

  /**
   * A revision that changes nothing is not a revision. The model is capable of
   * proposing the text it was shown — measured on the memory gate, which
   * needed four rules after the model for the same reason — and a card whose
   * diff is empty is one an operator cannot act on either way.
   */
  it('refuses a rewrite identical to what is already there', () => {
    expect(() => propose({ after: 'Always answer in French.' })).toThrow(AdvisorError);
  });

  it('refuses a rewrite that differs only in trailing whitespace', () => {
    expect(() => propose({ after: 'Always answer in French.  \n' })).toThrow(AdvisorError);
  });

  it('refuses a field the target does not have', () => {
    expect(() => propose({ field: 'body' })).toThrow(AdvisorError);
  });

  it('refuses a target that does not exist', () => {
    expect(() =>
      propose({ target: { kind: 'skill', id: 'skl_nope', name: 'gone', workspaceId: null } , field: 'description' }),
    ).toThrow(AdvisorError);
  });

  /**
   * One pending proposal per target and field. A second pass a week later that
   * reaches the same conclusion must not stack two cards proposing two
   * different rewrites of one text, of which applying either leaves the other
   * drawn against a text that no longer exists.
   */
  it('refuses a second pending proposal for the same text', () => {
    propose();
    expect(() => propose({ after: 'Always answer in French.\nSomething else.' })).toThrow(AdvisorError);
  });

  it('allows a proposal for a different field of the same target', () => {
    const one = skill();
    advisor.proposeRevision({
      workspaceId: workspace.id,
      runId: null,
      target: { kind: 'skill', id: one.id, name: one.name, workspaceId: null },
      field: 'description',
      after: 'Use when reviewing a database migration before it ships.',
      rationale: 'Never invoked.',
    });

    expect(() =>
      advisor.proposeRevision({
        workspaceId: workspace.id,
        runId: null,
        target: { kind: 'skill', id: one.id, name: one.name, workspaceId: null },
        field: 'body',
        after: '# Review\n\nStep one.\nStep two.',
        rationale: 'Missing a step.',
      }),
    ).not.toThrow();
  });

  it('allows a new proposal once the first was decided', () => {
    const first = propose();
    advisor.dismiss(first.id, 'jgo');

    // Dismissed, so the *cooldown* is what refuses it now, not the duplicate
    // rule — and the cooldown is tested on its own below.
    expect(() => propose({ after: 'Always answer in French.\nAnd cite.' })).toThrow(/recently/i);
  });
});

describe('the cooldown after a refusal', () => {
  it('refuses the same target for a fortnight after a dismissal', () => {
    const first = propose();
    advisor.dismiss(first.id, 'jgo');

    expect(() => propose({ after: 'Always answer in French.\nAnother idea.' })).toThrow(AdvisorError);
  });

  it('lets it be proposed again once the cooldown has passed', () => {
    const first = propose();
    advisor.dismiss(first.id, 'jgo');
    db.prepare('UPDATE advisor_proposals SET decided_at = ? WHERE id = ?').run(
      Date.now() - (REVISION_COOLDOWN_DAYS + 1) * 86_400_000,
      first.id,
    );

    expect(() => propose({ after: 'Always answer in French.\nAnother idea.' })).not.toThrow();
  });

  /**
   * The operator answered the *finding*, not the wording, so a later pass has
   * to be told which findings have already been refused — otherwise it spends
   * a model call rediscovering one and the rules throw the answer away.
   */
  it('reports which findings were refused, so a later pass is not asked again', () => {
    const first = advisor.proposeRevision({
      workspaceId: workspace.id,
      runId: null,
      target: { kind: 'workspace', id: workspace.id, name: 'Alpha', workspaceId: workspace.id },
      field: 'systemPromptAppend',
      after: 'Always answer in French.\nCite sources.',
      rationale: 'r',
      findings: [{ key: 'uncited-claims', kind: 'tool-errors', summary: 's', runIds: ['run_1'] }],
    });
    advisor.dismiss(first.id, 'jgo');

    expect(advisor.refusedFindings(workspace.id)).toContain('uncited-claims');
  });

  it('forgets a refused finding once its cooldown has passed', () => {
    const first = advisor.proposeRevision({
      workspaceId: workspace.id,
      runId: null,
      target: { kind: 'workspace', id: workspace.id, name: 'Alpha', workspaceId: workspace.id },
      field: 'systemPromptAppend',
      after: 'Always answer in French.\nCite sources.',
      rationale: 'r',
      findings: [{ key: 'uncited-claims', kind: 'tool-errors', summary: 's', runIds: ['run_1'] }],
    });
    advisor.dismiss(first.id, 'jgo');
    db.prepare('UPDATE advisor_proposals SET decided_at = ? WHERE id = ?').run(
      Date.now() - (REVISION_COOLDOWN_DAYS + 1) * 86_400_000,
      first.id,
    );

    expect(advisor.refusedFindings(workspace.id)).toEqual([]);
  });
});

describe('accepting a revision', () => {
  it('writes the new text into the workspace', () => {
    const proposal = propose();

    advisor.accept(proposal.id, 'jgo');

    expect(workspaces.get(workspace.id)?.settings.systemPromptAppend).toBe(
      'Always answer in French.\nCite the file you read a claim from.',
    );
  });

  it('leaves every other setting of that workspace alone', () => {
    const before = workspaces.get(workspace.id)?.settings;
    const proposal = propose();

    advisor.accept(proposal.id, 'jgo');

    const after = workspaces.get(workspace.id)?.settings;
    expect({ ...after, systemPromptAppend: '' }).toEqual({ ...before, systemPromptAppend: '' });
  });

  it('writes a skill description without touching its body', () => {
    const one = skill();
    const proposal = advisor.proposeRevision({
      workspaceId: workspace.id,
      runId: null,
      target: { kind: 'skill', id: one.id, name: one.name, workspaceId: null },
      field: 'description',
      after: 'Use when reviewing a database migration before it ships.',
      rationale: 'Never invoked.',
    });

    advisor.accept(proposal.id, 'jgo');

    const updated = registry.getSkill(one.id);
    expect(updated?.description).toBe('Use when reviewing a database migration before it ships.');
    expect(updated?.body).toBe('# Review\n\nStep one.');
  });

  /**
   * A skill reaching two workspaces must still reach two workspaces after its
   * description is rewritten. `upsertSkill` takes a whole record, so an
   * apply that rebuilt one from the payload would silently narrow the reach —
   * the same shape as the `.partial()` trap, and invisible on the card.
   */
  it('leaves a skill’s reach exactly as it was', () => {
    const one = skill();
    registry.setReach('skills', one.id, { global: true, workspaceIds: [] });
    const proposal = advisor.proposeRevision({
      workspaceId: workspace.id,
      runId: null,
      target: { kind: 'skill', id: one.id, name: one.name, workspaceId: null },
      field: 'description',
      after: 'Use when reviewing a migration.',
      rationale: 'r',
    });

    advisor.accept(proposal.id, 'jgo');

    expect(registry.getSkill(one.id)?.isGlobal).toBe(true);
  });

  it('leaves a skill enabled or disabled as it found it', () => {
    const one = registry.upsertSkill({
      workspaceId: workspace.id,
      name: 'quiet-one',
      description: 'd',
      body: 'b',
      enabled: false,
    });
    const proposal = advisor.proposeRevision({
      workspaceId: workspace.id,
      runId: null,
      target: { kind: 'skill', id: one.id, name: one.name, workspaceId: null },
      field: 'description',
      after: 'Use when the thing happens.',
      rationale: 'r',
    });

    advisor.accept(proposal.id, 'jgo');

    expect(registry.getSkill(one.id)?.enabled).toBe(false);
  });

  it('writes a subagent prompt without touching its tools or model', () => {
    const agent = registry.upsertAgent({
      workspaceId: workspace.id,
      name: 'reviewer',
      description: 'd',
      prompt: 'Review things.',
      tools: ['Read'],
      model: 'haiku',
    });
    const proposal = advisor.proposeRevision({
      workspaceId: workspace.id,
      runId: null,
      target: { kind: 'agent', id: agent.id, name: agent.name, workspaceId: null },
      field: 'prompt',
      after: 'Review things. Say which file each finding is in.',
      rationale: 'r',
    });

    advisor.accept(proposal.id, 'jgo');

    const updated = registry.getAgent(agent.id);
    expect(updated?.prompt).toBe('Review things. Say which file each finding is in.');
    expect(updated?.tools).toEqual(['Read']);
    expect(updated?.model).toBe('haiku');
  });

  it('writes an automation prompt without touching its schedule', () => {
    const automation = scheduler.create({
      workspaceId: workspace.id,
      name: 'Morning',
      prompt: 'Review the day.',
      trigger: { type: 'cron', expression: '0 8 * * *' },
      enabled: false,
    });
    const proposal = advisor.proposeRevision({
      workspaceId: workspace.id,
      runId: null,
      target: { kind: 'automation', id: automation.id, name: automation.name, workspaceId: workspace.id },
      field: 'prompt',
      after: 'Review the day. End with what needs the operator.',
      rationale: 'r',
    });

    advisor.accept(proposal.id, 'jgo');

    const updated = scheduler.get(automation.id);
    expect(updated?.prompt).toBe('Review the day. End with what needs the operator.');
    expect(updated?.trigger).toEqual({ type: 'cron', expression: '0 8 * * *' });
    expect(updated?.maxConsecutiveFailures).toBe(3);
  });

  /**
   * The consolidation rule, for the consolidation reason: a proposal drawn
   * against text that has since moved would silently delete an edit nobody
   * ever saw. The operator's own edit always wins.
   */
  it('refuses to apply when the text has changed since it was drawn', () => {
    const proposal = propose();
    workspaces.update(workspace.id, { settings: { systemPromptAppend: 'Answer in English.' } });

    expect(() => advisor.accept(proposal.id, 'jgo')).toThrow(/changed since/i);
  });

  it('refuses to apply when the target has been deleted since', () => {
    const one = skill();
    const proposal = advisor.proposeRevision({
      workspaceId: workspace.id,
      runId: null,
      target: { kind: 'skill', id: one.id, name: one.name, workspaceId: null },
      field: 'description',
      after: 'Use when reviewing a migration.',
      rationale: 'r',
    });
    registry.deleteSkill(one.id);

    expect(() => advisor.accept(proposal.id, 'jgo')).toThrow(AdvisorError);
  });

  it('refuses a second acceptance', () => {
    const proposal = propose();
    advisor.accept(proposal.id, 'jgo');

    expect(() => advisor.accept(proposal.id, 'jgo')).toThrow(/already/i);
  });
});

describe('taking a revision back', () => {
  it('restores the text the revision replaced', () => {
    const proposal = propose();
    advisor.accept(proposal.id, 'jgo');

    advisor.revert(proposal.id, 'jgo');

    expect(workspaces.get(workspace.id)?.settings.systemPromptAppend).toBe('Always answer in French.');
  });

  it('records that it was taken back, so the card can say so', () => {
    const proposal = propose();
    advisor.accept(proposal.id, 'jgo');

    const reverted = advisor.revert(proposal.id, 'jgo');

    expect((reverted.payload as Record<string, unknown>).revertedAt).toBeGreaterThan(0);
  });

  /**
   * Undoing is only safe while what stands is what this revision wrote. An
   * operator who has edited the text since would otherwise lose that edit to a
   * button labelled "undo", which is the worst possible place to lose one.
   */
  it('refuses when the text has been edited since it was applied', () => {
    const proposal = propose();
    advisor.accept(proposal.id, 'jgo');
    workspaces.update(workspace.id, { settings: { systemPromptAppend: 'Something the operator wrote.' } });

    expect(() => advisor.revert(proposal.id, 'jgo')).toThrow(/changed since/i);
  });

  it('refuses to take back what was never applied', () => {
    const proposal = propose();

    expect(() => advisor.revert(proposal.id, 'jgo')).toThrow(AdvisorError);
  });

  it('refuses to take the same one back twice', () => {
    const proposal = propose();
    advisor.accept(proposal.id, 'jgo');
    advisor.revert(proposal.id, 'jgo');

    expect(() => advisor.revert(proposal.id, 'jgo')).toThrow(AdvisorError);
  });

  /**
   * Taking a revision back is the strongest thing an operator can say about
   * it, so it silences the finding at least as firmly as a dismissal does.
   */
  it('starts the cooldown, like a refusal', () => {
    const proposal = propose();
    advisor.accept(proposal.id, 'jgo');
    advisor.revert(proposal.id, 'jgo');

    expect(() => propose({ after: 'Always answer in French.\nAnother idea.' })).toThrow(AdvisorError);
  });
});

describe('what the inbox lists', () => {
  it('lists an applied revision so it can be taken back', () => {
    const proposal = propose();
    advisor.accept(proposal.id, 'jgo');

    expect(advisor.list(workspace.id, 'accepted').map((entry) => entry.id)).toContain(proposal.id);
  });

  /**
   * Derived from the enum rather than written out: a fifth target kind added
   * and forgotten here would otherwise be a revision nothing can apply, which
   * fails at the moment an operator presses Accept rather than at build time.
   */
  it('can apply every target kind the contract declares', () => {
    for (const kind of RevisionTargetKind.options) {
      expect(REVISABLE_FIELDS[kind].length).toBeGreaterThan(0);
      expect(advisor.canApply(kind)).toBe(true);
    }
  });
});

/**
 * The listing is bounded.
 *
 * It was not while only `pending` was ever asked for — that set is drained by
 * definition. `accepted` is not: it only grows, the Dashboard reads it on every
 * load now, and each row carries a whole revision payload with its diff. An
 * unbounded read would send a year of them to the browser to draw the three
 * that still have an undo.
 */
describe('listing proposals', () => {
  const many = (count: number) => {
    for (let index = 0; index < count; index += 1) {
      db.prepare(
        `INSERT INTO advisor_proposals (id, workspace_id, run_id, kind, name, summary, rationale, payload, status, created_at)
         VALUES (?, ?, NULL, 'revision', ?, 's', 'r', '{}', 'accepted', ?)`,
      ).run(`prp_${index}`, workspace.id, `n_${index}`, index);
    }
  };

  it('stops at the page size', () => {
    many(PROPOSAL_PAGE + 20);

    expect(advisor.list(workspace.id, 'accepted')).toHaveLength(PROPOSAL_PAGE);
    expect(advisor.list(undefined, 'accepted')).toHaveLength(PROPOSAL_PAGE);
  });

  it('keeps the newest, since those are the ones still worth deciding', () => {
    many(PROPOSAL_PAGE + 5);

    const listed = advisor.list(workspace.id, 'accepted');
    expect(listed[0]?.name).toBe(`n_${PROPOSAL_PAGE + 4}`);
  });

  it('honours a smaller page when one is asked for', () => {
    many(10);

    expect(advisor.list(workspace.id, 'accepted', 3)).toHaveLength(3);
  });
});

/*
 * Whose instructions may a workspace rewrite?
 *
 * `advisor_propose_revision` takes a target **id** straight from a model's
 * arguments, and the surface that resolves it looks records up by id alone.
 * Nothing tied the two together, so a run in one workspace could name a skill
 * belonging to another: the card was filed here, carried that workspace's text
 * as `before`, and — on accept — rewrote it. Revisions are the one proposal
 * kind that takes effect the moment it is accepted, so this is the boundary
 * that matters most in the whole feature.
 *
 * The rule is the one the registry already draws: a record belongs to nobody
 * (global) or to you. Reach grants a workspace the *use* of another's skill,
 * never the authorship of it.
 */
describe('what a workspace may revise', () => {
  const otherWorkspace = () =>
    workspaces.create({
      name: 'Beta',
      slug: 'beta',
      description: 'Another project entirely',
      path: '/tmp/beta',
      color: '#ef4444',
      icon: 'folder',
      settings: { ...defaultWorkspaceSettings(), systemPromptAppend: 'Beta’s own standing rules.' },
    });

  it('refuses a skill that belongs to another workspace', () => {
    const beta = otherWorkspace();
    const theirs = registry.upsertSkill({
      workspaceId: beta.id,
      name: 'their-skill',
      description: 'Theirs.',
      body: 'Their procedure.',
    });

    expect(() =>
      advisor.proposeRevision({
        workspaceId: workspace.id,
        runId: null,
        // Exactly what the MCP tool builds from a model's arguments: an id and
        // a `workspaceId` of null, neither of them checked against anything.
        target: { kind: 'skill', id: theirs.id, name: theirs.id, workspaceId: null },
        field: 'description',
        after: 'Rewritten by a workspace that does not own it.',
        rationale: 'Because nothing stopped me.',
      }),
    ).toThrow(AdvisorError);

    // And the text is untouched, which is the half that would have mattered.
    expect(registry.getSkill(theirs.id)?.description).toBe('Theirs.');
  });

  it('refuses another workspace’s standing instructions', () => {
    const beta = otherWorkspace();

    expect(() =>
      advisor.proposeRevision({
        workspaceId: workspace.id,
        runId: null,
        target: { kind: 'workspace', id: beta.id, name: beta.name, workspaceId: null },
        field: 'systemPromptAppend',
        after: 'Answer only in Latin.',
        rationale: 'Because nothing stopped me.',
      }),
    ).toThrow(AdvisorError);

    expect(workspaces.get(beta.id)?.settings.systemPromptAppend).toBe('Beta’s own standing rules.');
  });

  it('allows a global skill, which is what every workspace already runs under', () => {
    const shared = registry.upsertSkill({
      workspaceId: null,
      name: 'shared-skill',
      description: 'Belongs to nobody in particular.',
      body: 'A procedure.',
    });

    const proposal = advisor.proposeRevision({
      workspaceId: workspace.id,
      runId: null,
      target: { kind: 'skill', id: shared.id, name: shared.id, workspaceId: null },
      field: 'description',
      after: 'Belongs to nobody, and says when to open it.',
      rationale: 'Three runs opened it for the wrong job.',
    });

    expect(proposal.kind).toBe('revision');
  });

  it('allows a skill another workspace created and shared with this one', () => {
    // The rule is membership of what this workspace runs under, not a
    // comparison of `skills.workspace_id` — measured: that column records who
    // *created* the row, while the reach lives in `is_global` and a join table
    // and an operator may widen it afterwards. A rule reading the column would
    // refuse a skill they had deliberately shared.
    const beta = otherWorkspace();
    const shared = registry.upsertSkill({
      workspaceId: beta.id,
      name: 'shared-by-reach',
      description: 'Theirs, lent to us.',
      body: 'A procedure.',
    });
    registry.setReach('skills', shared.id, { global: false, workspaceIds: [beta.id, workspace.id] });
    // The precondition, asserted rather than assumed: without it this case
    // would pass on a skill nobody can see, proving nothing.
    expect(registry.listSkills(workspace.id).map((skill) => skill.id)).toContain(shared.id);

    const proposal = advisor.proposeRevision({
      workspaceId: workspace.id,
      runId: null,
      target: { kind: 'skill', id: shared.id, name: shared.id, workspaceId: null },
      field: 'description',
      after: 'Theirs, lent to us, and it says when to open it.',
      rationale: 'Three runs opened it for the wrong job.',
    });

    expect(proposal.kind).toBe('revision');
    // Not global: it reaches two workspaces by name, so the card must not warn
    // that it reaches every one of them.
    expect((proposal.payload as { target: { workspaceId: string | null } }).target.workspaceId).toBe(
      workspace.id,
    );
  });

  it('stamps the owner from the record, not from what the caller claimed', () => {
    // The card warns that a revision reaches every workspace, and it decides
    // that from `target.workspaceId`. Taking the caller's word for it made the
    // warning appear on every skill revision ever proposed — including one
    // attached to this workspace alone — and a warning that is always on is a
    // warning nobody reads.
    const mine = registry.upsertSkill({
      workspaceId: workspace.id,
      name: 'mine-alone',
      description: 'Reviews migrations.',
      body: `# Review`,
    });

    const proposal = advisor.proposeRevision({
      workspaceId: workspace.id,
      runId: null,
      target: { kind: 'skill', id: mine.id, name: 'a name it made up', workspaceId: null },
      field: 'description',
      after: 'Reviews migrations before a release, when one is being cut.',
      rationale: 'Three runs opened it for the wrong job.',
    });

    const payload = proposal.payload as { target: { workspaceId: string | null; name: string } };
    expect(payload.target.workspaceId).toBe(workspace.id);
    // The name is read from the record for the same reason, and always was.
    expect(payload.target.name).toBe('mine-alone');
  });

  it('stamps null for a genuinely global record', () => {
    const shared = registry.upsertSkill({
      workspaceId: null,
      name: 'shared-two',
      description: 'Belongs to nobody in particular.',
      body: 'A procedure.',
    });

    const proposal = advisor.proposeRevision({
      workspaceId: workspace.id,
      runId: null,
      target: { kind: 'skill', id: shared.id, name: shared.id, workspaceId: workspace.id },
      field: 'description',
      after: 'Belongs to nobody, and says when to open it.',
      rationale: 'Three runs opened it for the wrong job.',
    });

    const payload = proposal.payload as { target: { workspaceId: string | null } };
    expect(payload.target.workspaceId).toBeNull();
  });
});

/*
 * An edit, not a rewrite — on the tool's door too.
 *
 * The review pass has dropped a wholesale replacement since the first day.
 * `advisor_propose_revision`, mounted into ordinary runs, was told the same
 * thing in prose and held to it by nothing — and prose is not a rule. What it
 * produces is a card whose diff is a wall of green the operator cannot read,
 * and the diff is the entire reason this proposal kind is safe to accept.
 */
describe('a rewrite is not an edit', () => {
  const longSkill = () =>
    registry.upsertSkill({
      workspaceId: workspace.id,
      name: 'long-procedure',
      description: 'A long one.',
      body: Array.from({ length: 40 }, (_, index) => `Step ${index}.`).join('\n'),
    });

  it('refuses a proposal that replaces most of the text', () => {
    const skill = longSkill();

    expect(() =>
      advisor.proposeRevision({
        workspaceId: workspace.id,
        runId: null,
        target: { kind: 'skill', id: skill.id, name: skill.name, workspaceId: null },
        field: 'body',
        after: Array.from({ length: 40 }, (_, index) => `Completely different ${index}.`).join('\n'),
        rationale: 'I preferred my own wording.',
      }),
    ).toThrow(AdvisorError);
  });

  it('accepts a small edit to the same long text', () => {
    const skill = longSkill();
    const edited = skill.body.replace('Step 7.', 'Step 7, but only when a release is being cut.');

    expect(
      advisor.proposeRevision({
        workspaceId: workspace.id,
        runId: null,
        target: { kind: 'skill', id: skill.id, name: skill.name, workspaceId: null },
        field: 'body',
        after: edited,
        rationale: 'Three runs ran step seven when they should not have.',
      }).kind,
    ).toBe('revision');
  });

  it('still allows a one-line description to be replaced outright', () => {
    // The rule's own exception, and the most valuable edit the pass makes:
    // turning a summary into a trigger condition is a hundred per cent of a
    // one-line text by any measure.
    const skill = registry.upsertSkill({
      workspaceId: workspace.id,
      name: 'one-liner',
      description: 'Reviews migrations.',
      body: 'A procedure.',
    });

    expect(
      advisor.proposeRevision({
        workspaceId: workspace.id,
        runId: null,
        target: { kind: 'skill', id: skill.id, name: skill.name, workspaceId: null },
        field: 'description',
        after: 'Use when reviewing a database migration before it ships.',
        rationale: 'It was offered to fourteen runs and opened by none.',
      }).kind,
    ).toBe('revision');
  });
});
