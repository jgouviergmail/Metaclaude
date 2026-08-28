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

const NOW = 100 * 3_600_000; // an arbitrary "now", far enough from zero for ages to subtract

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
    embeddings: () => ({ requested: 'hash', active: 'hash-v1:512', dimension: 512 }),
    activeRuns: () => 1,
    queuedRuns: () => 0,
    readBackupMarker: async () =>
      JSON.stringify({ at: NOW - 3_600_000, archive: 'metaclaude-backup-x.tar.gz' }),
    now: () => NOW,
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
      'backup',
      'claude-cli',
      'retrieval',
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

  it('warns when no backup has ever been recorded', async () => {
    const report = await makeDoctor({ readBackupMarker: async () => null }).run();
    const check = report.checks.find((entry) => entry.name === 'backup');

    expect(check?.status).toBe('warn');
    expect(check?.summary).toMatch(/no backup/i);
    expect(report.status).toBe('warn');
  });

  it('warns when the last backup is older than the timer could explain', async () => {
    // The daily timer plus its randomised delay can stretch the gap to 25h;
    // 27h means at least one scheduled run did not happen.
    const report = await makeDoctor({
      readBackupMarker: async () =>
        JSON.stringify({ at: NOW - 27 * 3_600_000, archive: 'metaclaude-backup-old.tar.gz' }),
    }).run();
    const check = report.checks.find((entry) => entry.name === 'backup');

    expect(check?.status).toBe('warn');
    expect(check?.summary).toMatch(/27 hours/);
    expect(check?.detail).toContain('metaclaude-backup-old.tar.gz');
  });

  it('accepts a fresh backup and names the archive', async () => {
    const report = await makeDoctor().run();
    const check = report.checks.find((entry) => entry.name === 'backup');

    expect(check?.status).toBe('ok');
    expect(check?.summary).toMatch(/1 hour/);
    expect(check?.detail).toContain('metaclaude-backup-x.tar.gz');
  });

  // The archives moved off the system disk and onto a volume the container
  // does not mount, so nothing inside the app can measure it. The backup
  // script writes what it saw into the marker; these three pin that the doctor
  // reads it, and that a marker written before the field existed still passes.
  it('warns when the volume holding the archives is filling up', async () => {
    const report = await makeDoctor({
      readBackupMarker: async () =>
        JSON.stringify({
          at: NOW - 3_600_000,
          archive: 'metaclaude-backup-x.tar.gz',
          freeBytes: 1.5 * GB,
        }),
    }).run();
    const check = report.checks.find((entry) => entry.name === 'backup');

    expect(check?.status).toBe('warn');
    expect(check?.summary).toMatch(/room/i);
    expect(check?.detail).toContain('1.5 GB free');
  });

  // A full volume is the *cause* of a backup that stopped happening, so it is
  // the more useful sentence even when the archive is also stale.
  it('fails on a critically low volume and says that rather than the age', async () => {
    const report = await makeDoctor({
      readBackupMarker: async () =>
        JSON.stringify({
          at: NOW - 30 * 3_600_000,
          archive: 'metaclaude-backup-old.tar.gz',
          freeBytes: 0.2 * GB,
        }),
    }).run();
    const check = report.checks.find((entry) => entry.name === 'backup');

    expect(check?.status).toBe('fail');
    expect(check?.summary).toMatch(/room/i);
    expect(check?.detail).toContain('0.2 GB free');
  });

  // Two shapes mean "not measured", and neither may be read as zero: a marker
  // written before the field existed, and one written on a host where `df`
  // declined to answer. A sentinel number here would report a healthy volume
  // as critically full, which is why the script writes null rather than -1.
  it.each([
    ['written before the free-space field existed', { at: NOW - 3_600_000, archive: 'a.tar.gz' }],
    ['where free space could not be measured', { at: NOW - 3_600_000, archive: 'a.tar.gz', freeBytes: null }],
  ])('accepts a marker %s', async (_label, marker) => {
    const report = await makeDoctor({ readBackupMarker: async () => JSON.stringify(marker) }).run();

    expect(report.checks.find((entry) => entry.name === 'backup')?.status).toBe('ok');
  });

  it('warns rather than trusting a marker it cannot parse', async () => {
    const garbage = await makeDoctor({ readBackupMarker: async () => 'not json' }).run();
    expect(garbage.checks.find((entry) => entry.name === 'backup')?.status).toBe('warn');

    const wrongShape = await makeDoctor({
      readBackupMarker: async () => JSON.stringify({ archive: 'x' }),
    }).run();
    expect(wrongShape.checks.find((entry) => entry.name === 'backup')?.status).toBe('warn');
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

describe('the retrieval check', () => {
  it('names the embedder actually running, and calls the hashing one word-matching', async () => {
    const report = await makeDoctor({
      embeddings: () => ({ requested: 'hash', active: 'hash-v1:512', dimension: 512 }),
    }).run();
    const check = report.checks.find((c) => c.name === 'retrieval')!;

    expect(check.status).toBe('ok');
    expect(check.summary).toContain('hash-v1:512');
    expect(check.detail).toMatch(/matches words, not meaning/i);
  });

  it('warns when the requested provider is not the one that answered', async () => {
    // Today this divergence is one boot log line nobody reads, while the
    // difference is a library that understands a rephrased question versus
    // one that does not.
    const report = await makeDoctor({
      embeddings: () => ({ requested: 'local', active: 'hash-v1:512', dimension: 512 }),
    }).run();
    const check = report.checks.find((c) => c.name === 'retrieval')!;

    expect(check.status).toBe('warn');
    expect(check.summary).toContain('"local"');
    expect(check.detail).toMatch(/re-index/i);
    // A warning must lift the whole report out of 'ok', or it is decoration.
    expect(report.status).not.toBe('ok');
  });

  it('is plainly ok when a real sentence-transformer is running', async () => {
    const report = await makeDoctor({
      embeddings: () => ({ requested: 'local', active: 'st:Xenova/all-MiniLM-L6-v2', dimension: 384 }),
    }).run();
    const check = report.checks.find((c) => c.name === 'retrieval')!;

    expect(check.status).toBe('ok');
    expect(check.summary).toContain('384d');
    expect(check.detail).toMatch(/shares no words/i);
  });
});
