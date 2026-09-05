/**
 * The steward — the rules behind Metaclaude's own tools.
 *
 * Half real, like the kernel fixture: the database, the repositories, the
 * memory store and the audit log are genuine, because what is worth proving
 * is what the facade writes and under whose name. The kernel, the scheduler,
 * the advisor and the approvals are fakes that record what they were asked.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { ApprovalRequest, Automation, AdvisorProposal, Run, RunPolicy } from '@metaclaude/shared';
import { migrate, openDatabase, type Db } from '../db/index.js';
import { RunRepo, SessionRepo, TranscriptRepo, WorkspaceRepo, defaultWorkspaceSettings } from '../kernel/repositories.js';
import { HashingEmbedder } from '../learning/embeddings.js';
import { MemoryStore } from '../learning/memory.js';
import { listInsights, setInsightStatus } from '../learning/reflexion.js';
import { AuditLog } from '../security/audit.js';
import {
  CONVERSATION_TITLE,
  REACH_SETTINGS,
  STEWARD_SESSION_TITLE,
  Steward,
  StewardError,
  type StewardDeps,
} from './steward.js';

const NOW = 1_800_000_000_000;
const ACTOR = { runId: 'run_steward', sessionId: 'ses_steward' };

const POLICY: RunPolicy = {
  model: 'default',
  effort: null,
  permissionMode: 'default',
  thinking: 'adaptive',
  thinkingBudgetTokens: null,
  agentName: null,
  ultracode: false,
  source: 'workspace',
};

let db: Db;
let workspaces: WorkspaceRepo;
let sessions: SessionRepo;
let runs: RunRepo;
let transcript: TranscriptRepo;
let memory: MemoryStore;
let audit: AuditLog;
let systemId: string;
let projectId: string;
let steward: Steward;

/** What the fakes were asked, so a test asserts the request rather than the echo. */
let asked: {
  submits: unknown[];
  delegations: unknown[];
  interrupted: string[];
  settings: unknown[];
  automations: Map<string, Automation>;
  created: unknown[];
  fired: string[];
  proposals: Map<string, AdvisorProposal>;
  decided: unknown[];
  pending: ApprovalRequest[];
  busySessions: Set<string>;
};

const automation = (id: string, patch: Partial<Automation> = {}): Automation => ({
  id,
  workspaceId: projectId,
  name: `Auto ${id}`,
  description: '',
  prompt: 'do the thing',
  trigger: { type: 'manual' },
  policy: { model: 'default', effort: null, permissionMode: 'dontAsk' } as Automation['policy'],
  continuous: false,
  sessionId: null,
  maxConsecutiveFailures: 3,
  consecutiveFailures: 0,
  enabled: true,
  lastRunAt: null,
  lastStatus: null,
  nextRunAt: null,
  runCount: 0,
  createdAt: NOW,
  updatedAt: NOW,
  ...patch,
} as Automation);

const proposal = (id: string): AdvisorProposal => ({
  id,
  workspaceId: projectId,
  runId: null,
  kind: 'skill',
  name: `Proposal ${id}`,
  summary: 'a summary',
  rationale: 'because',
  payload: {},
  status: 'pending',
  createdAt: NOW,
  decidedAt: null,
  decidedBy: null,
} as AdvisorProposal);

const approval = (id: string, risk: ApprovalRequest['risk'], runId = 'run_other'): ApprovalRequest => ({
  id,
  runId,
  sessionId: 'ses_other',
  workspaceId: projectId,
  toolUseId: `tu_${id}`,
  toolName: 'Bash',
  input: {},
  summary: 'rm -rf build',
  risk,
  reason: 'a shell command',
  createdAt: NOW,
  expiresAt: NOW + 600_000,
});

function makeSteward(overrides: Partial<StewardDeps> = {}): Steward {
  return new Steward({
    version: '9.9.9',
    systemWorkspaceId: () => systemId,
    workspaces,
    sessions,
    runs,
    transcript,
    memory,
    insights: {
      list: (options) => listInsights(db, options),
      setStatus: (id, status) => setInsightStatus(db, id, status),
    },
    automations: {
      list: (workspaceId) =>
        [...asked.automations.values()].filter((entry) => !workspaceId || entry.workspaceId === workspaceId),
      get: (id) => asked.automations.get(id) ?? null,
      create: (input) => {
        asked.created.push(input);
        const created = automation(`auto_${asked.created.length}`, {
          workspaceId: input.workspaceId,
          name: input.name,
          enabled: input.enabled ?? true,
        });
        asked.automations.set(created.id, created);
        return created;
      },
      update: (id, patch) => {
        const current = asked.automations.get(id);
        if (!current) return null;
        const next = { ...current, ...patch } as Automation;
        asked.automations.set(id, next);
        return next;
      },
      fire: async (id) => {
        asked.fired.push(id);
        return 'ses_fired';
      },
    },
    proposals: {
      list: (workspaceId, status) =>
        [...asked.proposals.values()].filter(
          (entry) => entry.status === status && (!workspaceId || entry.workspaceId === workspaceId),
        ),
      get: (id) => asked.proposals.get(id) ?? null,
      accept: (id, username) => {
        const next = { ...asked.proposals.get(id)!, status: 'accepted' as const, decidedBy: username };
        asked.proposals.set(id, next);
        return { proposal: next, appliedId: null };
      },
      dismiss: (id, username) => {
        const next = { ...asked.proposals.get(id)!, status: 'dismissed' as const, decidedBy: username };
        asked.proposals.set(id, next);
        return next;
      },
    },
    approvals: {
      listPending: () => asked.pending,
      decide: (decision, actor) => {
        asked.decided.push({ decision, actor });
        return asked.pending.some((entry) => entry.id === decision.approvalId);
      },
    },
    settings: {
      all: () => [{ key: 'language', value: 'fr' } as never],
      set: (key, value, actor) => {
        asked.settings.push({ key, value, actor });
      },
    },
    doctor: { run: async () => ({ status: 'ok', checks: [], version: '9.9.9', ranAt: NOW }) },
    analytics: { summary: () => ({ totalRuns: 0 }) as never },
    audit,
    registry: {
      listSkills: () => [],
      listAgents: () => [],
      listMcpServers: () =>
        [
          {
            id: 'mcp_1',
            workspaceId: projectId,
            name: 'github',
            transport: 'stdio',
            enabled: true,
            status: 'ok',
            lastError: null,
            authType: 'none',
            envKeys: ['GITHUB_TOKEN'],
            // Never on the real record — planted so the projection is caught
            // the day it starts spreading the row instead of naming fields.
            env: { GITHUB_TOKEN: 'SECRET_VALUE' },
          },
        ] as never,
    },
    updates: null,
    retrieval: () => ({
      embedder: 'hash-v1:512', family: 'hash', state: 'ready', semantic: false,
      pending: { memories: 0, documents: 0, exemplars: 0 },
    }),
    kernel: {
      submit: async (options) => {
        asked.submits.push(options);
        return { id: 'run_new', status: 'queued', sessionId: options.sessionId } as Run;
      },
      delegate: async (input) => {
        asked.delegations.push(input);
        return { runId: 'run_delegated', sessionId: 'ses_delegated', status: 'succeeded', finalText: '42', error: null };
      },
      activeCount: 1,
      queuedCount: 2,
      hasActiveRunForSession: (id) => asked.busySessions.has(id),
      interrupt: (sessionId) => {
        asked.interrupted.push(sessionId);
        return true;
      },
    },
    sessionMaxEvents: 3,
    now: () => NOW,
    ...overrides,
  });
}

function seedRun(input: { workspaceId: string; sessionId: string; status: Run['status']; costUsd?: number; startedAt?: number }): Run {
  const run = runs.create({
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    prompt: 'do something useful with a long enough prompt to be excerpted somewhere',
    policy: POLICY,
    triggeredBy: 'user',
  });
  db.prepare('UPDATE runs SET status = ?, started_at = ?, usage = ? WHERE id = ?').run(
    input.status,
    input.startedAt ?? NOW - 3600_000,
    JSON.stringify({ inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: input.costUsd ?? 0.5, durationMs: 1000, turns: 1 }),
    run.id,
  );
  return runs.get(run.id)!;
}

beforeEach(async () => {
  db = openDatabase({ path: ':memory:' });
  migrate(db);
  workspaces = new WorkspaceRepo(db);
  sessions = new SessionRepo(db);
  runs = new RunRepo(db);
  transcript = new TranscriptRepo(db);
  memory = new MemoryStore(db, new HashingEmbedder());
  audit = new AuditLog(db);

  const settings = defaultWorkspaceSettings();
  systemId = workspaces.create({
    name: 'Metaclaude', slug: 'metaclaude', description: '', path: '/srv/w/metaclaude',
    color: '#0f766e', icon: 'bot', settings,
  }).id;
  projectId = workspaces.create({
    name: 'Project', slug: 'project', description: 'a project', path: '/srv/w/project',
    color: '#6366f1', icon: 'folder', settings,
  }).id;

  asked = {
    submits: [], delegations: [], interrupted: [], settings: [],
    automations: new Map([['auto_a', automation('auto_a')], ['auto_b', automation('auto_b', { enabled: false, workspaceId: systemId })]]),
    created: [], fired: [],
    proposals: new Map([['prop_a', proposal('prop_a')]]),
    decided: [],
    pending: [approval('ap_low', 'low'), approval('ap_high', 'high'), approval('ap_mine', 'low', ACTOR.runId)],
    busySessions: new Set(),
  };
  steward = makeSteward();
});

/* -------------------------------------------------------------------------- */
/* Ring 1                                                                      */
/* -------------------------------------------------------------------------- */

describe('reading', () => {
  it('summarises the deployment, counting only the last day of runs', () => {
    const session = sessions.create({ workspaceId: projectId, model: 'default', effort: null, permissionMode: 'default' });
    seedRun({ workspaceId: projectId, sessionId: session.id, status: 'succeeded', costUsd: 0.25 });
    seedRun({ workspaceId: projectId, sessionId: session.id, status: 'failed', costUsd: 0.25 });
    seedRun({ workspaceId: projectId, sessionId: session.id, status: 'succeeded', costUsd: 9, startedAt: NOW - 3 * 24 * 3600_000 });

    const overview = steward.overview();

    expect(overview).toMatchObject({
      version: '9.9.9',
      systemWorkspaceId: systemId,
      workspaces: 2,
      activeRuns: 1,
      queuedRuns: 2,
      pendingApprovals: 3,
      last24h: { runs: 2, failed: 1, costUsd: 0.5 },
      pendingProposals: 1,
      automations: 1,
    });
  });

  /**
   * What retrieval *is* here is a fact of the deployment, not of the tool:
   * the steward reads it from the overview rather than assume, and the note
   * is the sentence it should repeat.
   */
  it('says whether memory search matches words or meaning, in words it can repeat', () => {
    expect(steward.overview().retrieval).toMatchObject({ embedder: 'hash-v1:512', semantic: false });
    expect(steward.overview().retrieval.note).toMatch(/words, not meaning/);

    const loaded = makeSteward({
      retrieval: () => ({
        embedder: 'st:Xenova/bge-m3', family: 'st', state: 'ready', semantic: true,
        pending: { memories: 0, documents: 0, exemplars: 0 },
      }),
    });
    expect(loaded.overview().retrieval.note).toMatch(/matches meaning/);

    const failed = makeSteward({
      retrieval: () => ({
        embedder: 'st:Xenova/bge-m3', family: 'st', state: 'lexical-only', semantic: false,
        pending: { memories: 2, documents: 0, exemplars: 0 },
      }),
    });
    expect(failed.overview().retrieval.note).toMatch(/did not load/);
  });

  it('lists workspaces marking its own, and finds one by slug or by id', () => {
    const listed = steward.workspaces();
    expect(listed.find((entry) => entry.id === systemId)?.isSystem).toBe(true);
    expect(listed.find((entry) => entry.id === projectId)?.isSystem).toBe(false);

    expect(steward.workspace('project').id).toBe(projectId);
    expect(steward.workspace(projectId).slug).toBe('project');
    expect(() => steward.workspace('nowhere')).toThrow(StewardError);
  });

  it('filters runs by workspace and status, and shows one run with its tools and answer', () => {
    const session = sessions.create({ workspaceId: projectId, model: 'default', effort: null, permissionMode: 'default' });
    const ok = seedRun({ workspaceId: projectId, sessionId: session.id, status: 'succeeded' });
    seedRun({ workspaceId: projectId, sessionId: session.id, status: 'failed' });
    transcript.append(session.id, {
      kind: 'tool_call', id: 'ev_1', runId: ok.id, at: NOW, toolUseId: 'tu_1', name: 'Read',
      input: {}, status: 'ok', result: null, resultIsError: false, durationMs: 5,
    });
    transcript.append(session.id, { kind: 'assistant_text', id: 'ev_2', runId: ok.id, at: NOW, text: 'All good.', streaming: false });

    expect(steward.runs({ workspace: 'project', status: 'failed' })).toHaveLength(1);
    expect(steward.runs({ workspace: 'metaclaude' })).toHaveLength(0);
    // The status filter looks past the limit: the one failure sits behind
    // the most recent run, and asking for one failed run must still find it.
    expect(steward.runs({ workspace: 'project', status: 'failed', limit: 1 })).toHaveLength(1);

    const detail = steward.run(ok.id);
    expect(detail.toolCalls).toEqual([{ name: 'Read', status: 'ok' }]);
    expect(detail.finalText).toBe('All good.');
    expect(detail.eventCount).toBe(2);
  });

  it('browses the global tier alone when asked, and searches semantically', async () => {
    await memory.remember({ workspaceId: null, kind: 'semantic', title: 'Deploy is a button', content: 'Updates apply from the interface.' });
    await memory.remember({ workspaceId: projectId, kind: 'semantic', title: 'Project uses pnpm', content: 'Install with pnpm.' });

    expect(steward.memories({ workspace: 'global' }).map((entry) => entry.scope)).toEqual(['global']);
    expect(steward.memories({ workspace: 'project' })).toHaveLength(2);

    const hits = await steward.memorySearch('pnpm install', { workspace: 'project' });
    expect(hits[0]?.title).toBe('Project uses pnpm');
    expect(typeof hits[0]?.score).toBe('number');
  });

  /**
   * The projection names its fields; it never spreads a row. A record that
   * grows a value field one day must not start leaking through the tool.
   */
  it('never lets a secret value through the library, whatever the record carries', () => {
    const text = JSON.stringify(steward.library());

    expect(text).toContain('GITHUB_TOKEN');
    expect(text).not.toContain('SECRET_VALUE');
  });
});

/* -------------------------------------------------------------------------- */
/* Ring 2                                                                      */
/* -------------------------------------------------------------------------- */

describe('writing, under its own name', () => {
  it('creates and edits memories, and the audit log names the run', async () => {
    const created = await steward.memoryWrite(ACTOR, {
      workspace: 'project', kind: 'procedural', title: 'Release', content: 'bump, push, wait for CI',
    });
    const edited = await steward.memoryWrite(ACTOR, { id: created.id, patch: { pinned: true } });

    expect(edited.pinned).toBe(true);
    const actors = new Set(audit.list({ limit: 10 }).map((entry) => entry.actor));
    expect(actors).toEqual(new Set(['metaclaude:run_steward']));
    expect(audit.list({ action: 'steward.memory.update' })[0]?.detail).toBe('pinned');
  });

  it('moves a memory between tiers', async () => {
    const created = await steward.memoryWrite(ACTOR, {
      workspace: 'project', kind: 'semantic', title: 'Everyone uses pnpm', content: 'pnpm everywhere',
    });

    const promoted = await steward.memoryScope(ACTOR, { id: created.id, workspace: 'global' });
    expect(promoted.scope).toBe('global');
    expect(promoted.moved).toBe(true);

    const confined = await steward.memoryScope(ACTOR, { id: created.id, workspace: 'project' });
    expect(confined.scope).toBe(projectId);
    await expect(steward.memoryScope(ACTOR, { id: 'mem_missing', workspace: 'global' })).rejects.toThrow(StewardError);
  });

  it('decides insights and proposals, signing the proposal as the run', () => {
    db.prepare(
      `INSERT INTO insights (id, workspace_id, run_id, kind, title, body, confidence, status, payload, created_at)
       VALUES ('ins_1', ?, NULL, 'lesson', 'Lesson', 'body', 0.8, 'new', NULL, ?)`,
    ).run(projectId, NOW);

    expect(steward.insightStatus(ACTOR, 'ins_1', 'accepted')).toEqual({ id: 'ins_1', status: 'accepted' });
    expect(listInsights(db, { status: 'accepted' })).toHaveLength(1);
    expect(() => steward.insightStatus(ACTOR, 'ins_missing', 'accepted')).toThrow(StewardError);

    const accepted = steward.proposalDecide(ACTOR, 'prop_a', 'accept');
    expect(accepted.status).toBe('accepted');
    expect(asked.proposals.get('prop_a')?.decidedBy).toBe('metaclaude:run_steward');
  });

  it('pauses, creates — disabled unless asked — and fires automations', async () => {
    expect(steward.automationToggle(ACTOR, 'auto_a', false).enabled).toBe(false);

    const quiet = steward.automationCreate(ACTOR, {
      workspace: 'project', name: 'Nightly', prompt: 'review', trigger: { type: 'cron', expression: '0 3 * * *' },
    });
    const live = steward.automationCreate(ACTOR, {
      workspace: 'project', name: 'Hourly', prompt: 'check', trigger: { type: 'interval', everyMs: 3_600_000 }, enabled: true,
    });
    expect(quiet.enabled).toBe(false);
    expect(live.enabled).toBe(true);
    expect((asked.created[0] as { workspaceId: string }).workspaceId).toBe(projectId);

    expect(await steward.automationFire(ACTOR, 'auto_a')).toEqual({ id: 'auto_a', sessionId: 'ses_fired' });
    expect(audit.list({ action: 'steward.automation.fire' })).toHaveLength(1);
  });

  it('archives a session, and refuses one that does not exist', () => {
    const session = sessions.create({ workspaceId: projectId, model: 'default', effort: null, permissionMode: 'default' });

    expect(steward.sessionUpdate(ACTOR, session.id, { archived: true, title: 'Done' })).toMatchObject({ archived: true, title: 'Done' });
    expect(() => steward.sessionUpdate(ACTOR, 'ses_missing', { pinned: true })).toThrow(StewardError);
  });

  it('passes a setting change through with the run as actor', () => {
    steward.settingSet(ACTOR, 'logLevel', 'debug');

    expect(asked.settings).toEqual([{ key: 'logLevel', value: 'debug', actor: 'metaclaude:run_steward' }]);
  });
});

describe('approvals on the operator’s behalf', () => {
  it('denies anything, allows low and medium risk, and signs as the run', () => {
    expect(steward.approvalDecide(ACTOR, 'ap_high', false, 'looks destructive')).toMatchObject({ approved: false });
    expect(steward.approvalDecide(ACTOR, 'ap_low', true)).toMatchObject({ approved: true, risk: 'low' });

    const [deny, allow] = asked.decided as Array<{ decision: { reason?: string }; actor: { username: string } }>;
    expect(deny?.decision.reason).toBe('looks destructive');
    expect(allow?.actor.username).toBe('metaclaude:run_steward');
  });

  it('never allows a high-risk call, and never touches its own cards', () => {
    expect(() => steward.approvalDecide(ACTOR, 'ap_high', true)).toThrow(/operator's decision/);
    expect(() => steward.approvalDecide(ACTOR, 'ap_mine', false)).toThrow(/own approval/);
    expect(() => steward.approvalDecide(ACTOR, 'ap_gone', true)).toThrow(StewardError);
    expect(asked.decided).toHaveLength(0);
  });
});

describe('what stays the operator’s', () => {
  it('renames a workspace and changes ordinary settings', () => {
    const updated = steward.workspaceUpdate(ACTOR, 'project', { name: 'Projet', settings: { language: 'fr' } });

    expect(updated.name).toBe('Projet');
    expect(updated.settings.language).toBe('fr');
    expect(audit.list({ action: 'steward.workspace.update' })[0]?.detail).toBe('name, language');
  });

  it('validates the settings it is handed like the route does, and strips what it does not know', () => {
    const before = workspaces.getBySlug('project')!.settings;

    expect(() =>
      steward.workspaceUpdate(ACTOR, 'project', { settings: { defaultModel: 123 } as never }),
    ).toThrow(/Invalid settings: defaultModel/);
    expect(workspaces.getBySlug('project')!.settings).toEqual(before);

    steward.workspaceUpdate(ACTOR, 'project', { settings: { unknownKey: 'x', language: 'en' } as never });
    const after = workspaces.getBySlug('project')!.settings as Record<string, unknown>;
    expect(after.language).toBe('en');
    expect('unknownKey' in after).toBe(false);
  });

  it.each(REACH_SETTINGS)('refuses to touch %s on any workspace, its own included', (key) => {
    for (const ref of ['project', 'metaclaude']) {
      const before = workspaces.getBySlug(ref)!.settings;
      expect(() =>
        steward.workspaceUpdate(ACTOR, ref, { settings: { [key]: key === 'defaultPermissionMode' ? 'auto' : ['x'] } as never }),
      ).toThrow(/widens or narrows/);
      expect(workspaces.getBySlug(ref)!.settings).toEqual(before);
    }
  });
});

describe('the conversation', () => {
  it('starts in a standing session of the system workspace, as the operator, unawaited', async () => {
    const first = await steward.converse({ prompt: 'How are we doing?' });
    const second = await steward.converse({ prompt: 'And the failures?', attachmentIds: ['att_1'] });

    expect(first.status).toBe('started');
    expect(second.sessionId).toBe(first.sessionId);
    const session = sessions.get(first.sessionId)!;
    expect(session.workspaceId).toBe(systemId);
    expect(session.title).toBe(CONVERSATION_TITLE);
    expect(asked.submits).toEqual([
      { sessionId: first.sessionId, prompt: 'How are we doing?', triggeredBy: 'user', awaited: false },
      { sessionId: first.sessionId, prompt: 'And the failures?', triggeredBy: 'user', awaited: false, attachmentIds: ['att_1'] },
    ]);
  });

  it('reports a busy conversation rather than opening a second one beside it', async () => {
    const first = await steward.converse({ prompt: 'one' });
    asked.busySessions.add(first.sessionId);

    const result = await steward.converse({ prompt: 'two' });

    expect(result).toEqual({ status: 'busy', workspaceId: systemId, sessionId: first.sessionId });
    expect(asked.submits).toHaveLength(1);
    expect(steward.conversation()).toMatchObject({ workspaceId: systemId, running: true });
  });

  it('rotates to a fresh session at the event ceiling, and reports the newest', async () => {
    const first = await steward.converse({ prompt: 'one' });
    const filler = seedRun({ workspaceId: systemId, sessionId: first.sessionId, status: 'succeeded' });
    for (let index = 0; index < 3; index += 1) {
      transcript.append(first.sessionId, { kind: 'assistant_text', id: `cv_${index}`, runId: filler.id, at: NOW + index, text: 'x', streaming: false });
    }

    const second = await steward.converse({ prompt: 'two' });

    expect(second.sessionId).not.toBe(first.sessionId);
    expect(steward.conversation().session?.id).toBe(second.sessionId);
  });

  it('answers plainly when there is no conversation yet, or no system workspace', () => {
    expect(steward.conversation()).toEqual({ workspaceId: systemId, session: null, running: false, lastRun: null });

    const orphan = makeSteward({ systemWorkspaceId: () => null });
    expect(orphan.conversation().workspaceId).toBeNull();
    return expect(orphan.converse({ prompt: 'hi' })).rejects.toThrow(/not ready/);
  });
});

describe('running other workspaces', () => {
  it('asks a workspace and waits, as a delegation from the system workspace', async () => {
    const answer = await steward.runAsk(ACTOR, 'project', 'What is the state of the build?');

    expect(answer).toMatchObject({ runId: 'run_delegated', status: 'succeeded', answer: '42' });
    expect(asked.delegations).toEqual([
      { fromWorkspaceId: systemId, fromTriggeredBy: 'user', target: 'project', prompt: 'What is the state of the build?' },
    ]);
    expect(audit.list({ action: 'steward.run.ask' })).toHaveLength(1);
  });

  it('refuses to ask or start itself', async () => {
    await expect(steward.runAsk(ACTOR, 'metaclaude', 'hi')).rejects.toThrow(/your own workspace/);
    await expect(steward.runStart(ACTOR, systemId, 'hi')).rejects.toThrow(/your own workspace/);
    expect(asked.submits).toHaveLength(0);
  });

  /**
   * One standing session per workspace, rotated like the gateway's: reused
   * while idle and under the event ceiling, a new one beside it otherwise.
   */
  it('starts a run in a standing session it reuses, rotates and never awaits', async () => {
    const first = await steward.runStart(ACTOR, 'project', 'tidy the backlog');
    const second = await steward.runStart(ACTOR, 'project', 'and again');
    expect(second.sessionId).toBe(first.sessionId);
    expect(sessions.get(first.sessionId)?.title).toBe(STEWARD_SESSION_TITLE);

    asked.busySessions.add(first.sessionId);
    const third = await steward.runStart(ACTOR, 'project', 'while busy');
    expect(third.sessionId).not.toBe(first.sessionId);

    asked.busySessions.clear();
    const filler = seedRun({ workspaceId: projectId, sessionId: first.sessionId, status: 'succeeded' });
    for (let index = 0; index < 3; index += 1) {
      transcript.append(first.sessionId, { kind: 'assistant_text', id: `ev_${index}`, runId: filler.id, at: NOW, text: 'x', streaming: false });
    }
    // Both standing sessions unavailable — one busy, one full — so a fifth
    // session is the only correct answer; reusing the full one is the bug.
    asked.busySessions.add(third.sessionId);
    const fourth = await steward.runStart(ACTOR, 'project', 'when full');
    expect(fourth.sessionId).not.toBe(first.sessionId);
    expect(fourth.sessionId).not.toBe(third.sessionId);

    for (const submit of asked.submits as Array<{ awaited: boolean; triggeredBy: string }>) {
      expect(submit.awaited).toBe(false);
      expect(submit.triggeredBy).toBe('delegation');
    }
  });

  it('interrupts another run by its session, never itself', () => {
    const session = sessions.create({ workspaceId: projectId, model: 'default', effort: null, permissionMode: 'default' });
    const run = seedRun({ workspaceId: projectId, sessionId: session.id, status: 'running' });

    expect(steward.runInterrupt(ACTOR, run.id)).toEqual({ runId: run.id, interrupted: true });
    expect(asked.interrupted).toEqual([session.id]);

    const own = sessions.create({ workspaceId: systemId, model: 'default', effort: null, permissionMode: 'default' });
    const self = seedRun({ workspaceId: systemId, sessionId: own.id, status: 'running' });
    expect(() => steward.runInterrupt({ runId: self.id, sessionId: own.id }, self.id)).toThrow(/interrupt yourself/);
    expect(asked.interrupted).toEqual([session.id]);
  });
});
