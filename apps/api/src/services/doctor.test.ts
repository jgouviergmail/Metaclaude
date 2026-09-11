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
import { Doctor, NEGLECTED_WARN_AT, type DoctorDeps } from './doctor.js';

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
    offeredCliTools: async () => ['Bash', 'Read', 'ToolSearch'],
    disabledCliTools: () => [],
    reachOut: async () => ({ ok: true, detail: 'HTTP 405 in 12 ms' }),
    credential: () => ({ mode: 'oauth', endsAt: null }),
    embeddings: () => ({ requested: 'hash', active: 'hash-v1:512', dimension: 512, state: 'ready', lastError: null, pending: { memories: 0, documents: 0, exemplars: 0 } }),
    knowledgeFileExists: () => true,
    pdfEngine: () => 'poppler-22.12.0',
    activeRuns: () => 1,
    queuedRuns: () => 0,
    publicUrl: () => 'https://metaclaude.example.com',
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
      'network',
      'public-url',
      'claude-cli',
      'cli-tools',
      'retrieval',
      'knowledge-files',
      'memory',
      'reflexion',
      'extensions',
      'runs',
      'automations',
    ]);
    expect(report.checks.every((check) => check.status === 'ok')).toBe(true);
  });
});

/**
 * A document whose original is gone still answers every search — its text is
 * in the database. What it cannot do is be downloaded or re-extracted, and
 * nothing else in the product would ever say so.
 */
describe('the knowledge-files check', () => {
  const document = (id: string, sha: string | null): void => {
    db.prepare(
      `INSERT INTO documents (id, workspace_id, title, content, content_hash, enabled,
         chunk_count, embedding_model, created_at, updated_at, source_name, source_mime, source_sha256)
       VALUES (?, NULL, ?, 'x', ?, 1, 0, '', 0, 0, ?, 'application/pdf', ?)`,
    ).run(id, id, id, sha ? `${id}.pdf` : null, sha);
  };

  it('is ok when every original is where it should be', async () => {
    document('bail', 'hash-1');
    document('collé', null);

    const report = await makeDoctor().run();
    const check = report.checks.find((one) => one.name === 'knowledge-files')!;

    expect(check.status).toBe('ok');
    expect(check.summary).toMatch(/1 (document|original)/);
  });

  it('is ok, and says so plainly, when no document came from a file at all', async () => {
    document('collé', null);
    const check = (await makeDoctor().run()).checks.find((one) => one.name === 'knowledge-files')!;
    expect(check.status).toBe('ok');
  });

  it('warns and names the documents whose originals are missing', async () => {
    document('bail', 'hash-1');
    document('assurance', 'hash-2');
    document('collé', null);

    const check = (await makeDoctor({ knowledgeFileExists: () => false }).run()).checks.find(
      (one) => one.name === 'knowledge-files',
    )!;

    expect(check.status).toBe('warn');
    expect(check.summary).toContain('2');
    expect(check.detail).toContain('bail');
    expect(check.detail).toContain('assurance');
    // The pasted document is not a missing file and must not be listed as one.
    expect(check.detail).not.toContain('collé');
  });

  it('bounds the list, so a lost volume does not print the whole library', async () => {
    for (let index = 0; index < 30; index += 1) document(`doc-${index}`, `hash-${index}`);

    const check = (await makeDoctor({ knowledgeFileExists: () => false }).run()).checks.find(
      (one) => one.name === 'knowledge-files',
    )!;

    expect(check.summary).toContain('30');
    expect(check.detail!.split(', ').length).toBeLessThanOrEqual(11);
    expect(check.detail).toMatch(/more|…/);
  });

  it('names the PDF engine, and warns when it is the fallback', async () => {
    // The fallback reads a PDF differently — it leaves a typesetter's
    // hyphenation in place — so which engine is answering is a fact an
    // operator has to be able to see.
    const withPoppler = (await makeDoctor().run()).checks.find(
      (one) => one.name === 'knowledge-files',
    )!;
    expect(withPoppler.detail).toContain('poppler-22.12.0');

    const without = (await makeDoctor({ pdfEngine: () => null }).run()).checks.find(
      (one) => one.name === 'knowledge-files',
    )!;
    expect(without.status).toBe('warn');
    expect(without.detail).toMatch(/poppler-utils/);
  });
});

/**
 * The deduplication scan compares a write against the newest
 * `DUPLICATE_SCAN_LIMIT` rows in its scope. Past that the oldest stop being
 * compared and duplicates accumulate again — silently, because nothing fails.
 * The doctor is where a silent ceiling becomes visible: an operator reads this
 * screen, and nobody reads a log line.
 */
describe('the memory check', () => {
  function fill(workspaceId: string | null, count: number, from = 0): void {
    const insert = db.prepare(
      `INSERT INTO memories (id, workspace_id, kind, title, content, confidence, created_at, updated_at)
       VALUES (?, ?, 'semantic', ?, ?, 0.7, ?, ?)`,
    );
    for (let i = from; i < from + count; i += 1) {
      insert.run(`mem_${workspaceId ?? 'g'}_${i}`, workspaceId, `t${i}`, `c${i}`, NOW, NOW);
    }
  }

  it('counts the corpus by tier', async () => {
    db.prepare(
      `INSERT INTO workspaces (id, name, slug, path, created_at, updated_at)
       VALUES ('ws_a', 'A', 'a', '/tmp/a', ?, ?)`,
    ).run(NOW, NOW);
    fill(null, 3);
    fill('ws_a', 5);

    const check = (await makeDoctor().run()).checks.find((c) => c.name === 'memory')!;

    expect(check.status).toBe('ok');
    expect(check.summary).toContain('8');
    expect(check.summary).toContain('3 global');
  });

  it('is content with an empty corpus', async () => {
    const check = (await makeDoctor().run()).checks.find((c) => c.name === 'memory')!;

    expect(check.status).toBe('ok');
    expect(check.summary).toContain('No memories');
  });

  it('warns once a scope approaches the deduplication ceiling', async () => {
    fill(null, 1900);

    const check = (await makeDoctor().run()).checks.find((c) => c.name === 'memory')!;

    expect(check.status).toBe('warn');
    expect(check.detail).toContain('2000');
  });

  /**
   * The shelves. A standing convention is injected into every run of its
   * scope, so a scope past ten of them is warned about; what the janitor
   * will do about retired rows and never-recalled volatile facts is said in
   * the detail rather than counted as a problem.
   */
  it('warns past ten standing conventions in one scope, and tells what the janitor will do', async () => {
    db.prepare(
      `INSERT INTO workspaces (id, name, slug, path, created_at, updated_at)
       VALUES ('ws_a', 'A', 'a', '/tmp/a', ?, ?)`,
    ).run(NOW, NOW);
    fill('ws_a', 5);
    db.prepare("UPDATE memories SET shelf = 'standing' WHERE id IN ('mem_ws_a_0','mem_ws_a_1')").run();
    db.prepare("UPDATE memories SET retired_at = ? WHERE id = 'mem_ws_a_2'").run(NOW);
    db.prepare("UPDATE memories SET shelf = 'volatile', created_at = ? WHERE id = 'mem_ws_a_3'").run(NOW - 40 * 86_400_000);

    const calm = (await makeDoctor().run()).checks.find((c) => c.name === 'memory')!;
    expect(calm.status).toBe('ok');
    expect(calm.detail).toContain('1 retired');
    expect(calm.detail).toContain('1 volatile fact older than a month');

    fill('ws_a', 11, 10);
    db.prepare("UPDATE memories SET shelf = 'standing' WHERE workspace_id = 'ws_a' AND id LIKE 'mem_ws_a_1_'").run();
    db.prepare("UPDATE memories SET shelf = 'standing' WHERE id = 'mem_ws_a_20'").run();

    const loud = (await makeDoctor().run()).checks.find((c) => c.name === 'memory')!;
    expect(loud.status).toBe('warn');
    expect(loud.summary).toMatch(/standing conventions/);
    expect(loud.detail).toContain('injected into every run');
  });

  it('names the workspace whose scope is the crowded one', async () => {
    db.prepare(
      `INSERT INTO workspaces (id, name, slug, path, created_at, updated_at)
       VALUES ('ws_a', 'Crowded', 'crowded', '/tmp/a', ?, ?)`,
    ).run(NOW, NOW);
    fill('ws_a', 1900);

    const check = (await makeDoctor().run()).checks.find((c) => c.name === 'memory')!;

    expect(check.status).toBe('warn');
    expect(check.summary).toContain('Crowded');
  });

  /**
   * A workspace's scan is its own rows *plus* the global tier, because that is
   * what `findNearDuplicate` compares against. Counting the workspace alone
   * would report headroom that does not exist.
   */
  it('counts the global tier against a workspace’s own ceiling', async () => {
    db.prepare(
      `INSERT INTO workspaces (id, name, slug, path, created_at, updated_at)
       VALUES ('ws_a', 'A', 'a', '/tmp/a', ?, ?)`,
    ).run(NOW, NOW);
    fill(null, 1000);
    fill('ws_a', 900);

    const check = (await makeDoctor().run()).checks.find((c) => c.name === 'memory')!;

    expect(check.status).toBe('warn');
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

    const unauth = await makeDoctor({ credential: () => ({ mode: 'none', endsAt: null }) }).run();
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
      embeddings: () => ({ requested: 'hash', active: 'hash-v1:512', dimension: 512, state: 'ready', lastError: null, pending: { memories: 0, documents: 0, exemplars: 0 } }),
    }).run();
    const check = report.checks.find((c) => c.name === 'retrieval')!;

    expect(check.status).toBe('ok');
    expect(check.summary).toContain('hash-v1:512');
    expect(check.detail).toMatch(/matches words, not meaning/i);
  });

  it('warns when the requested model did not load, names the reason, and counts what waits', async () => {
    // By decision there is no fallback to hashing: the provider keeps its
    // own id, writes nothing, and this is where a person learns why.
    const report = await makeDoctor({
      embeddings: () => ({
        requested: 'local', active: 'st:Xenova/bge-m3', dimension: 0, state: 'lexical-only',
        lastError: "Cannot find package '@huggingface/transformers'",
        pending: { memories: 3, documents: 1, exemplars: 0 },
      }),
    }).run();
    const check = report.checks.find((c) => c.name === 'retrieval')!;

    expect(check.status).toBe('warn');
    expect(check.summary).toContain('"local"');
    expect(check.summary).toMatch(/lexical-only/);
    expect(check.detail).toContain('Cannot find package');
    expect(check.detail).toMatch(/4 vectors \(3 memories, 1 documents, 0 exemplars\)/);
    // A warning must lift the whole report out of 'ok', or it is decoration.
    expect(report.status).not.toBe('ok');
  });

  it('warns, more gently, while the model is still loading', async () => {
    const report = await makeDoctor({
      embeddings: () => ({
        requested: 'local', active: 'st:Xenova/bge-m3', dimension: 0, state: 'loading', lastError: null,
        pending: { memories: 0, documents: 0, exemplars: 0 },
      }),
    }).run();
    const check = report.checks.find((c) => c.name === 'retrieval')!;

    expect(check.status).toBe('warn');
    expect(check.summary).toMatch(/loading/);
    expect(check.detail).toMatch(/re-indexed automatically/);
  });

  it('is plainly ok when a real sentence-transformer is running', async () => {
    const report = await makeDoctor({
      embeddings: () => ({ requested: 'local', active: 'st:Xenova/all-MiniLM-L6-v2', dimension: 384, state: 'ready', lastError: null, pending: { memories: 0, documents: 0, exemplars: 0 } }),
    }).run();
    const check = report.checks.find((c) => c.name === 'retrieval')!;

    expect(check.status).toBe('ok');
    expect(check.summary).toContain('384d');
    expect(check.detail).toMatch(/shares no words/i);
  });
});

/**
 * Whether this container can reach the internet at all.
 *
 * The check exists because of a question the product could not answer about
 * itself. `WebFetch` is executed *by the CLI*, inside this container, so it
 * needs egress; `WebSearch` runs upstream and needs only the Anthropic API.
 * When either comes back empty the operator has three candidates — the model
 * refused, the tool was not permitted, or nothing here can leave the box — and
 * only the third is a deployment fault. Nothing distinguished them: the app is
 * on a Docker network that has been misconfigured before, and the whole
 * product failed every run while the stack reported healthy.
 *
 * A probe, not a promise: reachability is not "web search works", and the
 * summary says which of the two it measured.
 */
describe('the network check', () => {
  it('is ok when the probe gets out', async () => {
    const doctor = makeDoctor({ reachOut: async () => ({ ok: true, detail: 'HTTP 405 in 42 ms' }) });
    const report = await doctor.run();
    const check = report.checks.find((entry) => entry.name === 'network')!;

    expect(check.status).toBe('ok');
    expect(check.detail).toBe('HTTP 405 in 42 ms');
  });

  /**
   * A failure here is `fail`, not `warn`: with no egress the CLI cannot reach
   * the API, `git clone` cannot resolve a remote and no HTTP MCP server
   * connects. Nothing the product does works, so the report must not read as
   * a healthy system with a note.
   */
  it('fails, rather than warns, when nothing can leave the container', async () => {
    const doctor = makeDoctor({
      reachOut: async () => ({ ok: false, detail: 'getaddrinfo ENOTFOUND api.anthropic.com' }),
    });
    const report = await doctor.run();
    const check = report.checks.find((entry) => entry.name === 'network')!;

    expect(check.status).toBe('fail');
    expect(check.detail).toContain('ENOTFOUND');
    expect(report.status).toBe('fail');
  });

  it('reports the probe throwing as the check failing, never as a broken report', async () => {
    const doctor = makeDoctor({
      reachOut: async () => {
        throw new Error('socket hang up');
      },
    });
    const report = await doctor.run();

    expect(report.checks.find((entry) => entry.name === 'network')?.status).toBe('fail');
    // Every other check still ran.
    expect(report.checks.length).toBeGreaterThan(5);
  });
});

/**
 * The credential the deployment actually runs on, and when it stops.
 *
 * Found on a live server: no token in the vault, `CLAUDE_CODE_OAUTH_TOKEN`
 * empty, and every run working — because the CLI's own account sign-in sits in
 * the home volume. That is a supported mode, and the doctor rightly called it
 * `ok`. What nothing said was that the sign-in ends on a fixed date twenty-four
 * days out: the refresh token is fixed-term, proven by two backups a day apart
 * where the access token's expiry moved and this one did not.
 *
 * So `ok` was true and useless. A credential with a known end date deserves the
 * same treatment as a backup that has quietly stopped: say it before it bites,
 * not after.
 */
describe('the credential check counts the days', () => {
  const DAY = 86_400_000;

  const withCredential = (over: Partial<{ mode: string; endsAt: number | null }>) =>
    makeDoctor({ credential: () => ({ mode: 'subscription', endsAt: null, ...over }) });

  const check = async (doctor: ReturnType<typeof makeDoctor>) =>
    (await doctor.run()).checks.find((entry) => entry.name === 'claude-cli')!;

  it('stays ok when the sign-in has months left', async () => {
    const entry = await check(withCredential({ endsAt: NOW + 60 * DAY }));
    expect(entry.status).toBe('ok');
    expect(entry.detail).toMatch(/subscription/);
  });

  it('warns once the end is close, and says how long is left', async () => {
    const entry = await check(withCredential({ endsAt: NOW + 9 * DAY }));
    expect(entry.status).toBe('warn');
    expect(entry.summary).toMatch(/9 days/);
    // "The credential in use", not "the sign-in": the date handed in is the
    // end of whatever actually applies, which may be a paired token. Naming
    // the sign-in there was an alarm about a credential nobody was using —
    // an owner on a token, with a lapsed sign-in behind it, was told every
    // run would fail to authenticate while every run worked.
    expect(entry.summary).toMatch(/credential in use/i);
    expect(entry.summary).not.toMatch(/sign(-| )in/i);
  });

  it('fails once it has passed, because every run will', async () => {
    const entry = await check(withCredential({ endsAt: NOW - DAY }));
    expect(entry.status).toBe('fail');
  });

  /**
   * A pasted setup token has no end date this process can read, and an older
   * CLI writes none. Unknown is not "expiring", and inventing a warning for it
   * would be the boot warning's mistake — an alarm that is always on.
   */
  it('says nothing about a credential whose end it cannot know', async () => {
    const entry = await check(withCredential({ endsAt: null }));
    expect(entry.status).toBe('ok');
  });

  it('still warns when there is no credential at all', async () => {
    const entry = await check(withCredential({ mode: 'none' }));
    expect(entry.status).toBe('warn');
    expect(entry.summary).toMatch(/no credential/i);
  });
});

/**
 * The address this deployment answers on.
 *
 * Found from use: an external agent pointed at the MCP gateway was told this
 * deployment had no public address configured, and nothing on any screen said
 * so beforehand — the setting is written by hand, two features refuse without
 * it, and both refusals read as a broken feature until you know which line of
 * `.env` is missing.
 */
describe('the public address', () => {
  const check = async (publicUrl: string | null) =>
    (await makeDoctor({ publicUrl: () => publicUrl }).run()).checks.find(
      (entry) => entry.name === 'public-url',
    )!;

  it('says where the deployment answers when it is set', async () => {
    const entry = await check('https://metaclaude.example.com');
    expect(entry.status).toBe('ok');
    expect(entry.summary).toMatch(/metaclaude\.example\.com/);
  });

  /** A warning, not a failure: everything that does not hand out an address works. */
  it('warns when it is unset, and names both features that refuse', async () => {
    const entry = await check(null);
    expect(entry.status).toBe('warn');
    expect(entry.detail).toMatch(/METACLAUDE_PUBLIC_URL/);
    expect(entry.detail).toMatch(/redirect URI/i);
    expect(entry.detail).toMatch(/gateway/i);
  });

  it('does not fail the whole report on its own', async () => {
    const report = await makeDoctor({ publicUrl: () => null }).run();
    expect(report.status).not.toBe('fail');
  });
});


/**
 * The check that would have spoken on the first failure.
 *
 * Reflexion is out-of-band: a failure is logged at warn and dropped, so that
 * nothing disturbs the run the operator is watching. Nothing else could report
 * it, and ten consecutive turn-ceiling failures went unseen for a day —
 * eighteen successful runs, not one memory, and a Memory page that looks
 * exactly like a quiet week.
 */
describe('the reflexion check', () => {
  const seedRun = (id: string, over: { finishedAt?: number; status?: string; reflectedAt?: number } = {}) => {
    db.prepare(
      "INSERT INTO workspaces (id, name, slug, path, created_at, updated_at) VALUES ('ws_1','W','w','/tmp/w',0,0) ON CONFLICT DO NOTHING",
    ).run();
    db.prepare(
      "INSERT INTO sessions (id, workspace_id, created_at, updated_at, last_activity_at) VALUES ('ses_1','ws_1',0,0,0) ON CONFLICT DO NOTHING",
    ).run();
    db.prepare(
      'INSERT INTO runs (id, session_id, workspace_id, prompt, status, started_at, finished_at, reflected_at) VALUES (?,?,?,?,?,?,?,?)',
    ).run(
      id,
      'ses_1',
      'ws_1',
      'p',
      over.status ?? 'succeeded',
      0,
      over.finishedAt ?? NOW - 60 * 60 * 1000,
      over.reflectedAt ?? null,
    );
  };
  const check = async () => (await makeDoctor().run()).checks.find((entry) => entry.name === 'reflexion');

  it('is quiet when every finished run has been considered', async () => {
    seedRun('run_1', { reflectedAt: NOW });
    expect((await check())?.status).toBe('ok');
  });

  it('warns, and says how many, when runs were never considered', async () => {
    seedRun('run_1');
    seedRun('run_2');

    const result = await check();
    expect(result?.status).toBe('warn');
    expect(result?.summary).toContain('2 finished runs');
    expect(result?.detail).toContain('Catch up');
  });

  it('leaves a run whose pass may still be in flight alone', async () => {
    // Reflexion starts when the run ends and takes seconds; without the grace
    // this check would be amber for a minute after every single run.
    seedRun('run_1', { finishedAt: NOW - 1000 });
    expect((await check())?.status).toBe('ok');
  });

  it('ignores an interrupted run, which the pass declines by design', async () => {
    seedRun('run_1', { status: 'interrupted' });
    expect((await check())?.status).toBe('ok');
  });
});


/**
 * Ten extensions mounted and not one ever invoked.
 *
 * That was the production deployment on 2026-09-10, and nothing anywhere could
 * say so — `skills.use_count` was displayed on two screens and incremented by
 * no code path at all, so it read zero whether an extension was working
 * perfectly or had never been opened in its life. A description that never
 * fires is dead weight in every prompt that carries it, and it is the operator
 * who has to rewrite it, so it is the operator who has to be told.
 */
describe('the extensions check', () => {
  const seedRun = (id: string) => {
    db.prepare(
      "INSERT INTO workspaces (id, name, slug, path, created_at, updated_at) VALUES ('ws_1','W','w','/tmp/w',0,0) ON CONFLICT DO NOTHING",
    ).run();
    db.prepare(
      "INSERT INTO sessions (id, workspace_id, created_at, updated_at, last_activity_at) VALUES ('ses_1','ws_1',0,0,0) ON CONFLICT DO NOTHING",
    ).run();
    db.prepare(
      "INSERT INTO runs (id, session_id, workspace_id, prompt, status, started_at, finished_at) VALUES (?,'ses_1','ws_1','p','succeeded',0,?)",
    ).run(id, NOW);
  };

  const offer = (runId: string, over: { name?: string; id?: string; invoked?: number } = {}) => {
    db.prepare(
      `INSERT INTO run_extension_usages (run_id, kind, name, extension_id, available, invoked, failed, at)
       VALUES (?, 'skill', ?, ?, 1, ?, 0, ?)`,
    ).run(runId, over.name ?? 'review-migrations', over.id ?? 'skl_1', over.invoked ?? 0, NOW);
  };

  const check = async () => (await makeDoctor().run()).checks.find((entry) => entry.name === 'extensions');

  it('is quiet when nothing has been offered yet', async () => {
    expect((await check())?.status).toBe('ok');
  });

  it('is quiet below the threshold', async () => {
    for (let index = 0; index < NEGLECTED_WARN_AT - 1; index += 1) {
      seedRun(`run_${index}`);
      offer(`run_${index}`);
    }
    expect((await check())?.status).toBe('ok');
  });

  it('names an extension carried into run after run and never once used', async () => {
    for (let index = 0; index < NEGLECTED_WARN_AT; index += 1) {
      seedRun(`run_${index}`);
      offer(`run_${index}`);
    }

    const result = await check();
    expect(result?.status).toBe('warn');
    expect(result?.summary).toContain('review-migrations');
  });

  it('goes quiet again the moment one run reaches for it', async () => {
    for (let index = 0; index < NEGLECTED_WARN_AT; index += 1) {
      seedRun(`run_${index}`);
      offer(`run_${index}`, { invoked: index === 0 ? 1 : 0 });
    }
    expect((await check())?.status).toBe('ok');
  });

  it('says how many when several are neglected', async () => {
    for (let index = 0; index < NEGLECTED_WARN_AT; index += 1) {
      seedRun(`run_${index}`);
      offer(`run_${index}`);
      offer(`run_${index}`, { name: 'postmortem', id: 'skl_2' });
    }

    const result = await check();
    expect(result?.status).toBe('warn');
    expect(result?.detail).toContain('postmortem');
  });
});

/**
 * The one check whose subject is invisible everywhere else.
 *
 * The CLI keeps most tool schemas out of the prompt and hands them over
 * through `ToolSearch` when something needs one. It turns that off by itself
 * — an unrecognised `ANTHROPIC_BASE_URL`, a model on its unsupported list, the
 * tool disallowed — and the only symptom is the bill: measured against CLI
 * 2.1.267, the in-window system-tool figure goes from 23,543 tokens to 39,045
 * on every run. Nothing else here can see it.
 */
describe('the deferred-tools check', () => {
  it('passes when the CLI is still loading tools on demand', async () => {
    const report = await makeDoctor().run();
    const check = report.checks.find((entry) => entry.name === 'cli-tools');

    expect(check?.status).toBe('ok');
    expect(check?.summary).toContain('on demand');
  });

  it('warns, with the cost, when ToolSearch is gone', async () => {
    const report = await makeDoctor({
      offeredCliTools: async () => ['Bash', 'Read'],
    }).run();
    const check = report.checks.find((entry) => entry.name === 'cli-tools');

    expect(check?.status).toBe('warn');
    expect(check?.summary).toContain('15k');
  });

  /**
   * "No tools" is never true of a CLI, so an empty list can only mean the
   * question failed. Reporting it as a finding about tool search would be a
   * measure that returns zero when it means "I could not look" — the failure
   * mode `measure-chrome.mjs` shipped once already.
   */
  it('says it could not measure rather than reporting a finding', async () => {
    for (const offeredCliTools of [
      async () => null,
      async () => [],
    ] as DoctorDeps['offeredCliTools'][]) {
      const report = await makeDoctor({ offeredCliTools }).run();
      const check = report.checks.find((entry) => entry.name === 'cli-tools');

      expect(check?.status).toBe('warn');
      expect(check?.summary).toMatch(/could not be asked|nothing here could be measured/);
      expect(check?.summary).not.toContain('15k');
    }
  });

  it('counts what the deployment has switched off', async () => {
    const report = await makeDoctor({
      disabledCliTools: () => ['Artifact', 'CronCreate'],
    }).run();

    expect(report.checks.find((entry) => entry.name === 'cli-tools')?.detail).toContain('2 switched off');
  });
});
