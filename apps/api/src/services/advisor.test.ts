/**
 * The advisor, simulated at service level: a fake kernel submit stands where
 * the CLI would run, and the test plays the tool calls the run would make —
 * so the graduated autonomy (direct-but-disabled automations, inbox for the
 * rest, the publisher allowlist) is exercised against the real database,
 * registry and scheduler.
 */

import type { EffortLevel, Run, Workspace } from '@metaclaude/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate, openDatabase, type Db } from '../db/index.js';
import { EventBus } from '../kernel/bus.js';
import type { Kernel } from '../kernel/kernel.js';
import { defaultWorkspaceSettings, RunRepo, SessionRepo, WorkspaceRepo } from '../kernel/repositories.js';
import { LibraryService } from '../library/service.js';
import { Vault } from '../security/vault.js';
import { AdvisorError, AdvisorService, ADVISOR_AUTO_INTERVAL_MS } from './advisor.js';
import { BoardService } from './board.js';
import { Registry } from './registry.js';
import { Scheduler } from './scheduler.js';

let db: Db;
let workspaces: WorkspaceRepo;
let sessions: SessionRepo;
let registry: Registry;
let scheduler: Scheduler;
let advisor: AdvisorService;
let workspace: Workspace;
let submit: ReturnType<typeof vi.fn>;
/** The collaborators, kept so a case can rebuild the service with one changed. */
let advisorDeps: ConstructorParameters<typeof AdvisorService>[0];

const noop = () => {
  /* no-op logger */
};

beforeEach(() => {
  db = openDatabase({ path: ':memory:' });
  migrate(db);
  workspaces = new WorkspaceRepo(db);
  sessions = new SessionRepo(db);
  registry = new Registry(db, new Vault(db, Buffer.alloc(32, 7)), noop);
  scheduler = new Scheduler({
    db,
    bus: new EventBus(),
    kernel: { submit: async () => ({}) } as unknown as Kernel,
    sessions,
    workspaces,
    // Nothing here fires an automation, so no preamble is ever composed.
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
    settings: defaultWorkspaceSettings(),
  });

  submit = vi.fn(async (input: { sessionId: string }) => {
    return { id: 'run_test', sessionId: input.sessionId, status: 'queued' } as unknown as Run;
  });

  advisorDeps = {
    db,
    workspaces,
    sessions,
    runs: new RunRepo(db),
    registry,
    scheduler,
    library: new LibraryService(registry),
    board: { list: (workspaceId) => new BoardService(db).list({ workspaceId }) },
    submit: submit as never,
    log: noop,
  };
  advisor = new AdvisorService(advisorDeps);
});

afterEach(() => {
  db.close();
});

const skillInput = (name = 'release-ritual') => ({
  workspaceId: workspace.id,
  runId: 'run_1',
  kind: 'skill' as const,
  name,
  summary: 'A release checklist',
  rationale: 'Releases here keep missing the changelog step.',
  payload: {
    name,
    description: 'Use when cutting a release.',
    body: '# Release ritual\n\nDone when: the tag exists.',
  },
});

describe('the inbox', () => {
  it('files a proposal pending, and refuses the same idea twice', () => {
    const proposal = advisor.propose(skillInput());
    expect(proposal.status).toBe('pending');
    expect(advisor.list(workspace.id).map((entry) => entry.id)).toContain(proposal.id);

    expect(() => advisor.propose(skillInput())).toThrowError(/already exists/);
  });

  it('refuses to propose what the registry already has', () => {
    registry.upsertSkill({
      workspaceId: null,
      name: 'release-ritual',
      description: 'already here',
      body: 'x',
    });
    expect(() => advisor.propose(skillInput())).toThrowError(/already exists/);
  });

  it('refuses a malformed payload at the door', () => {
    expect(() =>
      advisor.propose({ ...skillInput(), payload: { name: 'x' } }),
    ).toThrowError(AdvisorError);
  });
});

describe('the publisher allowlist', () => {
  const mcp = (payload: Record<string, unknown>) => ({
    workspaceId: workspace.id,
    runId: null,
    kind: 'mcp' as const,
    name: 'proposed-server',
    summary: 'A server',
    rationale: 'Would connect the tracker.',
    payload: { name: 'proposed-server', publisher: 'Someone', ...payload },
  });

  it('admits a stdio package under a trusted npm scope', () => {
    const proposal = advisor.propose(
      mcp({ transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] }),
    );
    expect(proposal.kind).toBe('mcp');
  });

  it('refuses a stdio package from nowhere', () => {
    expect(() =>
      advisor.propose(mcp({ transport: 'stdio', command: 'npx', args: ['-y', 'totally-great-mcp'] })),
    ).toThrowError(/trusted publisher/);
  });

  it('admits a trusted host and its subdomains, but not a lookalike suffix', () => {
    expect(() =>
      advisor.propose(mcp({ transport: 'http', url: 'https://mcp.linear.app/mcp' })),
    ).not.toThrow();
    // A different pending name so the dedup guard is not what refuses.
    expect(() =>
      advisor.propose({
        ...mcp({ transport: 'http', url: 'https://mcp.linear.app.evil.example/mcp' }),
        name: 'lookalike',
      }),
    ).toThrowError(/allowlist/);
  });
});

describe('automations', () => {
  it('creates them directly but disabled, rationale on the record', () => {
    const automation = advisor.proposeAutomation({
      workspaceId: workspace.id,
      name: 'Nightly triage',
      description: 'Reads new issues.',
      prompt: 'Triage the tracker.',
      trigger: { type: 'cron', expression: '0 6 * * *' },
      rationale: 'Triage happened by hand six times this month.',
    });
    expect(automation.enabled).toBe(false);
    expect(automation.nextRunAt).toBeNull();
    expect(automation.description).toContain('Proposed by the advisor');

    const listed = scheduler.list(workspace.id).find((entry) => entry.id === automation.id);
    expect(listed?.enabled).toBe(false);
  });

  it('refuses to stack a namesake automation', () => {
    const input = {
      workspaceId: workspace.id,
      name: 'Nightly triage',
      description: '',
      prompt: 'Triage.',
      trigger: { type: 'cron', expression: '0 6 * * *' } as const,
      rationale: 'Repeated by hand.',
    };
    advisor.proposeAutomation(input);
    expect(() => advisor.proposeAutomation(input)).toThrowError(/already exists/);
  });
});

describe('deciding', () => {
  it('accept writes a disabled global skill and marks the row', () => {
    const proposal = advisor.propose(skillInput());
    const { proposal: decided, appliedId } = advisor.accept(proposal.id, 'admin');

    expect(decided.status).toBe('accepted');
    expect(decided.decidedBy).toBe('admin');
    expect(appliedId).not.toBeNull();
    const skill = registry.listSkills(null).find((entry) => entry.name === 'release-ritual');
    expect(skill?.enabled).toBe(false);
    expect(skill?.workspaceId).toBeNull();

    expect(() => advisor.accept(proposal.id, 'admin')).toThrowError(/already/);
  });

  it('accept on an mcp proposal writes a disabled server with no secrets', () => {
    const proposal = advisor.propose({
      workspaceId: workspace.id,
      runId: null,
      kind: 'mcp',
      name: 'linear',
      summary: 'Linear MCP',
      rationale: 'The board mirrors Linear tickets by hand today.',
      payload: {
        name: 'linear',
        transport: 'http',
        url: 'https://mcp.linear.app/mcp',
        publisher: 'Linear',
      },
    });
    const { appliedId } = advisor.accept(proposal.id, 'admin');
    const server = registry.listMcpServers(null).find((entry) => entry.id === appliedId);
    expect(server?.enabled).toBe(false);
    expect(server?.envKeys).toEqual([]);
  });

  it('accept on a plugin records the decision without creating anything', () => {
    const proposal = advisor.propose({
      workspaceId: workspace.id,
      runId: null,
      kind: 'plugin',
      name: 'reviewer-pack',
      summary: 'A review plugin',
      rationale: 'Bundles the review skills this workspace re-creates.',
      payload: { name: 'reviewer-pack', source: 'example/reviewer-pack' },
    });
    const { proposal: decided, appliedId } = advisor.accept(proposal.id, 'admin');
    expect(decided.status).toBe('accepted');
    expect(appliedId).toBeNull();
  });

  it('dismiss closes the row without touching the registry', () => {
    const proposal = advisor.propose(skillInput());
    const decided = advisor.dismiss(proposal.id, 'admin');
    expect(decided.status).toBe('dismissed');
    expect(registry.listSkills(null)).toHaveLength(0);
  });
});

describe('the run', () => {
  it('submits the dossier into a persistent Advisor session, pinned to auto', async () => {
    const run = await advisor.ask(workspace.id);
    expect(run.sessionId).toBeDefined();

    expect(submit).toHaveBeenCalledTimes(1);
    const input = submit.mock.calls[0]?.[0] as {
      sessionId: string;
      prompt: string;
      overrides: { permissionMode: string };
    };
    expect(input.overrides.permissionMode).toBe('auto');
    expect(input.prompt).toContain('"Alpha"');
    expect(input.prompt).toContain('## Board');
    expect(input.prompt).toContain('library shelf');
    expect(sessions.get(input.sessionId)?.title).toBe('Advisor');

    // The second ask continues the same session — context accumulates.
    await advisor.ask(workspace.id);
    expect(submit.mock.calls[1]?.[0]).toMatchObject({ sessionId: input.sessionId });
  });

  it('names pending proposals in the dossier so they are not re-proposed', () => {
    advisor.propose(skillInput());
    const dossier = advisor.composeDossier(workspaces.get(workspace.id) as Workspace);
    expect(dossier).toContain('do not propose these again');
    expect(dossier).toContain('skill release-ritual');
  });
});

describe('the daily sweep', () => {
  it('visits only opted-in workspaces, at most once a day', async () => {
    await advisor.sweep();
    expect(submit).not.toHaveBeenCalled();

    workspaces.update(workspace.id, {
      settings: { ...workspace.settings, advisorAuto: true },
    });

    const now = Date.now();
    await advisor.sweep(now);
    expect(submit).toHaveBeenCalledTimes(1);

    // Same day: quiet.
    await advisor.sweep(now + 60_000);
    expect(submit).toHaveBeenCalledTimes(1);

    // The next day: it goes again.
    await advisor.sweep(now + ADVISOR_AUTO_INTERVAL_MS + 60_000);
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it('a workspace that refuses does not stop the tour', async () => {
    workspaces.update(workspace.id, {
      settings: { ...workspace.settings, advisorAuto: true },
    });
    const other = workspaces.create({
      name: 'Beta',
      slug: 'beta',
      description: '',
      path: '/tmp/beta',
      color: '#6366f1',
      icon: 'folder',
      settings: { ...defaultWorkspaceSettings(), advisorAuto: true },
    });

    submit.mockRejectedValueOnce(new Error('a run is already in flight'));
    await advisor.sweep();
    // One of the two failed; both were still visited, in whatever order.
    expect(submit).toHaveBeenCalledTimes(2);
    const prompts = submit.mock.calls.map((call) => (call[0] as { prompt: string }).prompt);
    expect(prompts.some((prompt) => prompt.includes(`"${other.name}"`))).toBe(true);
    expect(prompts.some((prompt) => prompt.includes('"Alpha"'))).toBe(true);
  });
});

/*
 * The sixth learning phase, and the only one that is not a structured call.
 *
 * The advisor's judgement is an ordinary run through the kernel, so what an
 * operator pins for it has to ride the submit's overrides — and it must be
 * independent of the workspace's own default model, which is the thing they
 * chose for the work rather than for the machine commenting on it. Nothing
 * else in the suite can see that: `ask()` is the only place it is decided.
 */
describe('what the advisor itself is served', () => {
  const withPolicy = (model: string | null, effort: EffortLevel | null) =>
    new AdvisorService({ ...advisorDeps, policy: () => ({ model, effort }) });

  it('leaves the session as it is when nothing is pinned', async () => {
    await withPolicy(null, null).ask(workspace.id);
    const overrides = submit.mock.calls[0]?.[0]?.overrides as Record<string, unknown>;
    // Absence, not null: `model: null` reaches the kernel as an explicit choice
    // of nothing, where absent means the session's own model.
    expect(overrides).not.toHaveProperty('model');
    expect(overrides).not.toHaveProperty('effort');
    expect(overrides.permissionMode).toBe('auto');
  });

  it('overrides the run when the operator has pinned a model and an effort', async () => {
    await withPolicy('fable', 'high').ask(workspace.id);
    expect(submit.mock.calls[0]?.[0]?.overrides).toMatchObject({
      permissionMode: 'auto',
      model: 'fable',
      effort: 'high',
    });
  });

  it('is independent of the workspace default', async () => {
    // The session is created from the workspace's default, and the pin has to
    // win over it — otherwise pinning the advisor would do nothing at all for
    // every workspace that already had a model of its own.
    workspaces.update(workspace.id, {
      settings: { ...workspace.settings, defaultModel: 'opus' },
    });
    await withPolicy('haiku', null).ask(workspace.id);
    expect(submit.mock.calls[0]?.[0]?.overrides).toMatchObject({ model: 'haiku' });
  });

  it('reads the setting at the moment of the ask, not at construction', async () => {
    let model: string | null = null;
    // Built once, exactly as `context.ts` builds it: at boot.
    const service = new AdvisorService({ ...advisorDeps, policy: () => ({ model, effort: null }) });
    await service.ask(workspace.id);
    model = 'sonnet';
    await service.ask(workspace.id);
    expect(submit.mock.calls[0]?.[0]?.overrides).not.toHaveProperty('model');
    expect(submit.mock.calls.at(-1)?.[0]?.overrides).toMatchObject({ model: 'sonnet' });
  });
});
