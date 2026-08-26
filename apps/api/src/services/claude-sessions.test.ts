/**
 * The CLI's own sessions, listed and adopted.
 *
 * The listing comes from the SDK's `listSessions` — the CLI's transcript
 * store, not Metaclaude's tables — so the fake stands in for the SDK and the
 * database is real: what is under test is the join between the two worlds,
 * and the guards on crossing it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultWorkspaceSettings, SessionRepo, WorkspaceRepo } from '../kernel/repositories.js';
import { migrate, openDatabase, type Db } from '../db/index.js';
import { ClaudeSessions, ClaudeSessionsError } from './claude-sessions.js';

let db: Db;
let workspaces: WorkspaceRepo;
let sessions: SessionRepo;

const listed = [
  {
    sessionId: 'cli-old',
    summary: 'Refactor the parser',
    lastModified: 1_000,
    firstPrompt: 'refactor the parser to a pratt design',
    cwd: '/srv/metaclaude/workspaces/alpha',
  },
  {
    sessionId: 'cli-new',
    summary: 'Fix flaky tests',
    lastModified: 5_000,
    gitBranch: 'main',
    cwd: '/srv/metaclaude/workspaces/alpha',
  },
];

function makeService(overrides: Partial<ConstructorParameters<typeof ClaudeSessions>[0]> = {}) {
  return new ClaudeSessions({
    list: async () => listed,
    workspaces,
    sessions,
    ...overrides,
  });
}

function seedWorkspace(slug = 'alpha') {
  return workspaces.create({
    name: slug,
    slug,
    description: '',
    path: `/srv/metaclaude/workspaces/${slug}`,
    color: '#6366f1',
    icon: 'folder',
    settings: defaultWorkspaceSettings(),
  });
}

beforeEach(() => {
  db = openDatabase({ path: ':memory:' });
  migrate(db);
  workspaces = new WorkspaceRepo(db);
  sessions = new SessionRepo(db);
});

afterEach(() => db.close());

describe('listing', () => {
  it('returns the CLI sessions for a workspace, newest first, normalised to the contract', async () => {
    const workspace = seedWorkspace();
    const result = await makeService().listForWorkspace(workspace.id);

    expect(result.map((s) => s.sessionId)).toEqual(['cli-new', 'cli-old']);
    expect(result[1]).toMatchObject({
      summary: 'Refactor the parser',
      firstPrompt: 'refactor the parser to a pratt design',
      gitBranch: null,
      adoptedBy: null,
    });
  });

  it('marks the sessions Metaclaude already owns, so the UI offers open instead of adopt', async () => {
    const workspace = seedWorkspace();
    const mine = sessions.create({
      workspaceId: workspace.id,
      model: 'default',
      effort: null,
      permissionMode: 'default',
    });
    sessions.setClaudeSessionId(mine.id, 'cli-old');

    const result = await makeService().listForWorkspace(workspace.id);
    expect(result.find((s) => s.sessionId === 'cli-old')?.adoptedBy).toBe(mine.id);
    expect(result.find((s) => s.sessionId === 'cli-new')?.adoptedBy).toBeNull();
  });

  it('refuses an unknown workspace', async () => {
    await expect(makeService().listForWorkspace('ws_nope')).rejects.toThrow(ClaudeSessionsError);
  });
});

describe('adoption', () => {
  it('binds a listed CLI session to a fresh Metaclaude session carrying the workspace defaults', async () => {
    const workspace = seedWorkspace();
    const session = await makeService().adopt(workspace.id, 'cli-new');

    expect(session.workspaceId).toBe(workspace.id);
    expect(session.claudeSessionId).toBe('cli-new');
    // The CLI's own summary names the thread in the sidebar.
    expect(session.title).toBe('Fix flaky tests');
    expect(sessions.get(session.id)?.claudeSessionId).toBe('cli-new');
  });

  it('refuses a CLI session id the CLI did not list for this workspace', async () => {
    // The id is the only thing the client sends; trusting it would let a
    // caller bind a session from any directory the CLI has ever seen.
    const workspace = seedWorkspace();
    await expect(makeService().adopt(workspace.id, 'cli-elsewhere')).rejects.toThrow(
      /did not list/i,
    );
  });

  it('refuses a second adoption of the same CLI session', async () => {
    const workspace = seedWorkspace();
    const service = makeService();
    await service.adopt(workspace.id, 'cli-new');

    await expect(service.adopt(workspace.id, 'cli-new')).rejects.toThrow(/already/i);
  });

  it('gives exactly one session to two concurrent adoptions of the same id', async () => {
    // The CLI listing is awaited between the adopted-check and the write, so
    // both requests can hold a pre-write snapshot — the same shape as the
    // login races. The check must be re-read beside the write, where nothing
    // can interleave.
    const workspace = seedWorkspace();
    const service = makeService();

    const outcomes = await Promise.allSettled([
      service.adopt(workspace.id, 'cli-new'),
      service.adopt(workspace.id, 'cli-new'),
    ]);

    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(sessions.list(workspace.id)).toHaveLength(1);
  });
});
