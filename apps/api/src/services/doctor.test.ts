/**
 * The doctor — the system examining itself.
 *
 * The database, audit chain and vault are real against in-memory SQLite; the
 * environment probes (disk, CLI) are injected. What is under test is the
 * judgement: which findings escalate, and that one broken probe degrades one
 * check rather than the whole examination.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../security/audit.js';
import { Vault } from '../security/vault.js';
import { migrate, openDatabase, type Db } from '../db/index.js';
import { Doctor, type DoctorDeps } from './doctor.js';

let db: Db;
let audit: AuditLog;
let vault: Vault;

const GB = 1024 ** 3;

function makeDoctor(overrides: Partial<DoctorDeps> = {}) {
  return new Doctor({
    db,
    audit,
    vault,
    dataDir: '/var/lib/metaclaude',
    workspacesDir: '/srv/metaclaude/workspaces',
    diskFree: async () => 50 * GB,
    cliVersion: async () => '2.1.246 (Claude Code)',
    credentialMode: () => 'oauth',
    activeRuns: () => 1,
    queuedRuns: () => 0,
    now: () => 1_000,
    ...overrides,
  });
}

beforeEach(() => {
  db = openDatabase({ path: ':memory:' });
  migrate(db);
  audit = new AuditLog(db);
  vault = new Vault(db, Buffer.alloc(32, 7));
});

afterEach(() => db.close());

describe('a healthy system', () => {
  it('reports every check ok, and the report inherits it', async () => {
    audit.record({ actor: 'owner', action: 'login' });
    vault.set('mcp:github', 'token', 'secret-value');

    const report = await makeDoctor().run();

    expect(report.status).toBe('ok');
    expect(report.checks.map((check) => check.name)).toEqual([
      'database',
      'audit',
      'vault',
      'disk:data',
      'disk:workspaces',
      'claude-cli',
      'runs',
      'automations',
    ]);
    expect(report.checks.every((check) => check.status === 'ok')).toBe(true);
  });
});

describe('escalations', () => {
  it('fails the audit check when the chain is broken, naming the entry', async () => {
    audit.record({ actor: 'owner', action: 'login' });
    audit.record({ actor: 'owner', action: 'workspace.create' });
    // Tamper directly, as an attacker with database access would.
    db.prepare("UPDATE audit_log SET action = 'nothing.happened' WHERE action = 'login'").run();

    const report = await makeDoctor().run();
    const check = report.checks.find((entry) => entry.name === 'audit');

    expect(check?.status).toBe('fail');
    expect(report.status).toBe('fail');
    expect(check?.detail).toMatch(/aud_/);
  });

  it('fails the vault check when a slot cannot decrypt, naming the slots', async () => {
    vault.set('mcp:github', 'token', 'secret-value');
    db.prepare("UPDATE secrets SET ciphertext = X'00'").run();

    const report = await makeDoctor().run();
    const check = report.checks.find((entry) => entry.name === 'vault');

    expect(check?.status).toBe('fail');
    expect(check?.detail).toContain('mcp:github/token');
  });

  it('warns then fails as disk space shrinks', async () => {
    const warn = await makeDoctor({ diskFree: async () => 1 * GB }).run();
    expect(warn.checks.find((entry) => entry.name === 'disk:data')?.status).toBe('warn');
    expect(warn.status).toBe('warn');

    const fail = await makeDoctor({ diskFree: async () => 0.2 * GB }).run();
    expect(fail.checks.find((entry) => entry.name === 'disk:data')?.status).toBe('fail');
  });

  it('fails when the CLI is unreachable and warns when it is unauthenticated', async () => {
    const gone = await makeDoctor({ cliVersion: async () => null }).run();
    expect(gone.checks.find((entry) => entry.name === 'claude-cli')?.status).toBe('fail');

    const unauth = await makeDoctor({ credentialMode: () => 'none' }).run();
    expect(unauth.checks.find((entry) => entry.name === 'claude-cli')?.status).toBe('warn');
  });

  it('warns about automations the failure guard has switched off, by name', async () => {
    const workspace = db
      .prepare(
        `INSERT INTO workspaces (id, name, slug, description, path, color, icon, settings, created_at, updated_at)
         VALUES ('ws_1', 'w', 'w', '', '/srv/metaclaude/workspaces/w', '#000000', 'folder', '{}', 0, 0)`,
      )
      .run();
    void workspace;
    db.prepare(
      `INSERT INTO automations (id, workspace_id, name, prompt, trigger, max_consecutive_failures,
                                consecutive_failures, enabled, created_at, updated_at)
       VALUES ('aut_1', 'ws_1', 'nightly-digest', 'p', '{}', 3, 3, 0, 0, 0)`,
    ).run();

    const report = await makeDoctor().run();
    const check = report.checks.find((entry) => entry.name === 'automations');

    expect(check?.status).toBe('warn');
    expect(check?.detail).toContain('nightly-digest');
  });
});

describe('a broken probe', () => {
  it('degrades its own check to fail and leaves the rest standing', async () => {
    const report = await makeDoctor({
      diskFree: async () => {
        throw new Error('statfs EACCES');
      },
    }).run();

    expect(report.checks.find((entry) => entry.name === 'disk:data')?.status).toBe('fail');
    expect(report.checks.find((entry) => entry.name === 'disk:data')?.detail).toContain('EACCES');
    expect(report.checks.find((entry) => entry.name === 'database')?.status).toBe('ok');
  });
});
