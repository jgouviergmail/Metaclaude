/**
 * The proposal tools, driven the way a run would drive them — against the
 * real advisor service, so the handler mapping (tool args → payload) is what
 * is under test, not a mirror of it.
 */

import type { Workspace } from '@metaclaude/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase, type Db } from '../db/index.js';
import { LibraryService } from '../library/service.js';
import { AdvisorService } from '../services/advisor.js';
import { BoardService } from '../services/board.js';
import { Registry } from '../services/registry.js';
import { Scheduler } from '../services/scheduler.js';
import { Vault } from '../security/vault.js';
import { EventBus } from './bus.js';
import type { Kernel } from './kernel.js';
import { defaultWorkspaceSettings, RunRepo, SessionRepo, WorkspaceRepo } from './repositories.js';
import { buildAdvisorServer, createAdvisorHandlers } from './advisor-tools.js';

let db: Db;
let advisor: AdvisorService;
let workspace: Workspace;
let handlers: ReturnType<typeof createAdvisorHandlers>;

beforeEach(() => {
  db = openDatabase({ path: ':memory:' });
  migrate(db);
  const workspaces = new WorkspaceRepo(db);
  const sessions = new SessionRepo(db);
  const registry = new Registry(db, new Vault(db, Buffer.alloc(32, 7)), () => {});
  workspace = workspaces.create({
    name: 'Alpha',
    slug: 'alpha',
    description: '',
    path: '/tmp/alpha',
    color: '#6366f1',
    icon: 'folder',
    settings: defaultWorkspaceSettings(),
  });
  advisor = new AdvisorService({
    db,
    workspaces,
    sessions,
    runs: new RunRepo(db),
    registry,
    scheduler: new Scheduler({
      db,
      bus: new EventBus(),
      kernel: { submit: async () => ({}) } as unknown as Kernel,
      sessions,
      workspaces,
      log: () => {},
    }),
    library: new LibraryService(registry),
    board: { list: (workspaceId) => new BoardService(db).list({ workspaceId }) },
    submit: async () => {
      throw new Error('the tools never submit');
    },
    log: () => {},
  });
  handlers = createAdvisorHandlers(advisor, { workspaceId: workspace.id, runId: 'run_1' });
});

afterEach(() => {
  db.close();
});

describe('the handlers', () => {
  it('automation: created disabled, and the receipt says so', () => {
    const receipt = handlers.automation({
      name: 'Nightly triage',
      description: '',
      prompt: 'Triage.',
      trigger: { type: 'cron', expression: '0 6 * * *' },
      rationale: 'Happens by hand today.',
    });
    expect(receipt.enabled).toBe(false);
    expect(receipt.note).toContain('disabled');
  });

  it('skill: files an inbox row scoped to this run and workspace', () => {
    const receipt = handlers.skill({
      name: 'release-ritual',
      description: 'Use when releasing.',
      body: '# Release',
      category: 'engineering',
      rationale: 'Releases drift.',
    });
    expect(receipt.status).toBe('pending');

    const proposal = advisor.list(workspace.id)[0];
    expect(proposal?.runId).toBe('run_1');
    expect(proposal?.payload).toMatchObject({ category: 'engineering' });
  });

  it('mcp: the allowlist refusal surfaces as the thrown message', () => {
    expect(() =>
      handlers.mcp({
        name: 'mystery',
        summary: 'A server from a blog post',
        transport: 'http',
        url: 'https://mcp.mystery.example/mcp',
        publisher: 'Mystery Corp',
        rationale: 'The web said so.',
      }),
    ).toThrowError(/allowlist/);
  });

  it('plugin: the source rides in the payload for the operator to verify', () => {
    handlers.plugin({
      name: 'reviewer-pack',
      summary: 'Bundled review skills',
      source: 'example/reviewer-pack',
      rationale: 'Recreated by hand in two workspaces.',
    });
    expect(advisor.list(workspace.id)[0]?.payload).toMatchObject({
      source: 'example/reviewer-pack',
    });
  });
});

describe('the server wrapper', () => {
  it('names the server metaclaude_advisor', () => {
    const server = buildAdvisorServer(advisor, { workspaceId: workspace.id, runId: 'run_1' });
    expect(server.name).toBe('metaclaude_advisor');
    expect(server.type).toBe('sdk');
  });
});
