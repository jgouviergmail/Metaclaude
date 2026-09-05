/**
 * The doctor — the system examining itself, read-only.
 *
 * Guarded autonomy starts with self-knowledge that changes nothing: every
 * check here reads and reports, and acting on a finding stays a human
 * decision (or, later, a proposal routed through the same commit → CI →
 * health-gated deploy path as any other change — see docs/ROADMAP.md).
 *
 * Each probe is isolated: a check whose probe throws becomes that check
 * failing with the error text, never a broken examination. The report's
 * status is the worst of its checks, so one field is actionable and the rest
 * is evidence.
 */

import type { DoctorCheck, DoctorReport } from '@metaclaude/shared';
import { APP_VERSION } from '@metaclaude/shared';
import type { Db } from '../db/index.js';
import { DUPLICATE_SCAN_LIMIT } from '../learning/memory.js';

const GB = 1024 ** 3;
/** Below this, writes are at risk soon; below the floor, now. */
const DISK_WARN_BYTES = 2 * GB;
const DISK_FAIL_BYTES = 0.5 * GB;

const HOUR = 3_600_000;
/**
 * The host's backup timer runs daily with up to an hour of randomised delay,
 * so 25 hours is the longest gap a working timer can produce. Anything past
 * 26 means a scheduled backup did not happen.
 */
const BACKUP_STALE_MS = 26 * HOUR;

/**
 * How long before a Claude sign-in ends the doctor starts saying so.
 *
 * Two weeks: long enough to notice on a screen somebody opens weekly, short
 * enough that the warning still means "do this soon" rather than becoming
 * furniture.
 */
const CREDENTIAL_WARN_DAYS = 14;

/**
 * Scope size at which the deduplication ceiling starts being worth mentioning.
 *
 * Below the ceiling on purpose: a corpus reports the problem while there is
 * still room to act, rather than once duplicates are already going unnoticed.
 */
const DEDUPLICATION_WARN_AT = Math.round(DUPLICATE_SCAN_LIMIT * 0.9);

export interface DoctorDeps {
  db: Db;
  audit: {
    verifyChain(): { ok: true; entries: number } | { ok: false; brokenAt: string; entries: number };
  };
  vault: { selfTest(): { total: number; failed: string[] } };
  dataDir: string;
  workspacesDir: string;
  /** Free bytes at a path. Injected: statfs answers differ per machine. */
  diskFree: (path: string) => Promise<number>;
  /** The CLI's version string, or null when it cannot be spawned. */
  cliVersion: () => Promise<string | null>;
  /**
   * Raw content of the marker `deploy/bin/metaclaude-backup` writes into the
   * data volume after each completed archive, or null when there is none.
   * Injected as text, not as a path: the judgement about what the content
   * means belongs here, where it is testable.
   */
  readBackupMarker: () => Promise<string | null>;
  /**
   * One outbound HTTPS request, or why it failed.
   *
   * Injected rather than performed here for the reason every other probe is:
   * the repository's tests must not touch the network, and the judgement about
   * what the result *means* is what belongs in this file and is worth testing.
   */
  reachOut: () => Promise<{ ok: boolean; detail: string }>;
  /**
   * What the deployment authenticates with, and when that stops being true.
   *
   * The mode alone was not enough. A server running on the CLI's own sign-in
   * reported `ok` and `auth: subscription` — both correct — while the sign-in
   * itself was twenty-four days from a fixed expiry that nothing counted down.
   */
  credential: () => { mode: string; signInEndsAt: number | null };
  /**
   * What retrieval is *actually* running with, versus what was configured.
   *
   * These differ silently today: `METACLAUDE_EMBEDDINGS=local` falls back to
   * the hashing embedder whenever the optional model package or its download
   * is unavailable, and the only trace is one log line at boot. Since the
   * provider is the difference between a library that understands a rephrased
   * question and one that only matches words, the divergence has to be
   * visible where an operator looks for problems.
   */
  embeddings: () => {
    requested: string;
    active: string;
    dimension: number;
    /** ready, loading, or lexical-only: what the provider is doing, not only its name. */
    state: 'ready' | 'loading' | 'lexical-only';
    lastError: string | null;
    /** Rows written pending or under another provider, waiting for a rebuild. */
    pending: { memories: number; documents: number; exemplars: number };
  };
  activeRuns: () => number;
  queuedRuns: () => number;
  now?: () => number;
}

const WORST: Record<DoctorCheck['status'], number> = { ok: 0, warn: 1, fail: 2 };

/**
 * One judgement over free space, shared by the two disk checks and the backup
 * one, so a figure that is "getting low" on the data volume does not read as
 * healthy on the volume holding the archives. The backup case cannot call
 * `diskFree` itself: the archives live on a volume the container does not
 * mount, so the only measurement available is the one the backup script took
 * and wrote into its marker.
 */
function judgeFreeSpace(free: number): DoctorCheck['status'] {
  if (free < DISK_FAIL_BYTES) return 'fail';
  if (free < DISK_WARN_BYTES) return 'warn';
  return 'ok';
}

function formatFree(free: number): string {
  return `${(free / GB).toFixed(1)} GB free`;
}

export class Doctor {
  constructor(private readonly deps: DoctorDeps) {}

  async run(): Promise<DoctorReport> {
    const checks: DoctorCheck[] = [];

    /** Run one probe; a throw becomes that check failing, not a broken report. */
    const examine = async (name: string, probe: () => Promise<DoctorCheck> | DoctorCheck) => {
      try {
        checks.push(await probe());
      } catch (error) {
        checks.push({
          name,
          status: 'fail',
          summary: 'The check itself could not run.',
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    };

    await examine('database', () => this.database());
    await examine('audit', () => this.audit());
    await examine('vault', () => this.vault());
    await examine('disk:data', () => this.disk('disk:data', this.deps.dataDir));
    await examine('disk:workspaces', () => this.disk('disk:workspaces', this.deps.workspacesDir));
    await examine('backup', () => this.backup());
    await examine('network', () => this.network());
    await examine('claude-cli', () => this.claudeCli());
    await examine('retrieval', () => this.retrieval());
    await examine('memory', () => this.memory());
    await examine('runs', () => this.runs());
    await examine('automations', () => this.automations());

    const status = checks.reduce<DoctorCheck['status']>(
      (worst, check) => (WORST[check.status] > WORST[worst] ? check.status : worst),
      'ok',
    );

    return { status, checks, version: APP_VERSION, ranAt: this.deps.now?.() ?? Date.now() };
  }

  private database(): DoctorCheck {
    const rows = this.deps.db.pragma('quick_check') as Array<{ quick_check: string }>;
    const verdict = rows[0]?.quick_check ?? 'no answer';
    return verdict === 'ok'
      ? { name: 'database', status: 'ok', summary: 'SQLite reports the file intact.', detail: null }
      : {
          name: 'database',
          status: 'fail',
          summary: 'SQLite found problems with the database file.',
          detail: rows.map((row) => row.quick_check).join('; '),
        };
  }

  private audit(): DoctorCheck {
    const result = this.deps.audit.verifyChain();
    return result.ok
      ? {
          name: 'audit',
          status: 'ok',
          summary: `The audit chain is intact across ${result.entries} entries.`,
          detail: null,
        }
      : {
          name: 'audit',
          status: 'fail',
          summary: 'The audit chain is broken — an entry was edited, removed or reordered.',
          detail: `first broken entry: ${result.brokenAt}`,
        };
  }

  private vault(): DoctorCheck {
    const result = this.deps.vault.selfTest();
    if (result.failed.length > 0) {
      return {
        name: 'vault',
        status: 'fail',
        summary:
          'Some secrets cannot be decrypted — almost always a changed METACLAUDE_MASTER_KEY.',
        detail: result.failed.join(', '),
      };
    }
    return {
      name: 'vault',
      status: 'ok',
      summary:
        result.total === 0
          ? 'The vault is empty and working.'
          : `All ${result.total} stored secrets decrypt.`,
      detail: null,
    };
  }

  private async disk(name: string, path: string): Promise<DoctorCheck> {
    const free = await this.deps.diskFree(path);
    const label = `${formatFree(free)} at ${path}`;
    const verdict = judgeFreeSpace(free);
    if (verdict === 'fail') {
      return { name, status: 'fail', summary: 'Disk space is critically low.', detail: label };
    }
    if (verdict === 'warn') {
      return { name, status: 'warn', summary: 'Disk space is getting low.', detail: label };
    }
    return { name, status: 'ok', summary: label, detail: null };
  }

  private async backup(): Promise<DoctorCheck> {
    const raw = await this.deps.readBackupMarker();
    if (raw === null) {
      return {
        name: 'backup',
        status: 'warn',
        summary:
          'No backup has ever been recorded — a disk failure today loses everything.',
        detail:
          'install-app.sh sets up a nightly metaclaude-backup timer; its first run writes the marker this check reads.',
      };
    }

    let marker: { at?: unknown; archive?: unknown; freeBytes?: unknown };
    try {
      marker = JSON.parse(raw) as { at?: unknown; archive?: unknown; freeBytes?: unknown };
    } catch {
      marker = {};
    }
    if (typeof marker.at !== 'number' || !Number.isFinite(marker.at)) {
      return {
        name: 'backup',
        status: 'warn',
        summary: 'The backup marker exists but cannot be read — the last backup may not have completed.',
        detail: raw.slice(0, 200),
      };
    }

    const now = this.deps.now?.() ?? Date.now();
    const age = Math.max(0, now - marker.at);
    const hours = Math.round(age / HOUR);
    const archive = typeof marker.archive === 'string' ? marker.archive : 'unnamed archive';

    // Space before age, and deliberately: a volume with no room left is why a
    // nightly backup stops happening, so it is the sentence that leads to the
    // fix. Absent from markers written before the field existed, which is the
    // ordinary case on a host that has not re-run install-app.sh — silence
    // there means "not measured", never "measured as zero".
    const free = typeof marker.freeBytes === 'number' && Number.isFinite(marker.freeBytes)
      ? marker.freeBytes
      : null;
    if (free !== null) {
      const verdict = judgeFreeSpace(free);
      if (verdict !== 'ok') {
        return {
          name: 'backup',
          status: verdict,
          summary:
            verdict === 'fail'
              ? 'The volume holding the backups has no room left — the next one will not be written.'
              : 'The volume holding the backups is running out of room.',
          detail: `${formatFree(free)} where the archives are kept · ${archive}`,
        };
      }
    }

    if (age > BACKUP_STALE_MS) {
      return {
        name: 'backup',
        status: 'warn',
        summary: `The last backup finished ${hours} hours ago — the nightly timer is not keeping up.`,
        detail: archive,
      };
    }
    return {
      name: 'backup',
      status: 'ok',
      summary: `Last backup ${hours <= 1 ? '1 hour' : `${hours} hours`} ago.`,
      detail: archive,
    };
  }

  /**
   * Which embedder retrieval is running on, and whether that is what was
   * asked for.
   *
   * A warning rather than a failure when they diverge: the hashing embedder
   * works, and a deployment running on it is degraded, not broken. What it
   * cannot do is bridge a question to an answer that shares no words with it
   * — measured at 0% recall on such queries — so the summary says which
   * regime this deployment is in rather than only naming a string.
   */
  private retrieval(): DoctorCheck {
    const { requested, active, dimension, state, lastError, pending } = this.deps.embeddings();
    const waiting = pending.memories + pending.documents + pending.exemplars;
    const waitingNote =
      waiting > 0
        ? ` ${waiting} vector${waiting === 1 ? '' : 's'} (${pending.memories} memories, ${pending.documents} documents, ${pending.exemplars} exemplars) await a rebuild.`
        : '';

    if (active.startsWith('hash')) {
      return {
        name: 'retrieval',
        status: 'ok',
        summary: `${active} (${dimension}d)`,
        detail:
          'The built-in hashing embedder: no download, no network — and no semantics. Retrieval matches words, not meaning.' +
          waitingNote,
      };
    }

    if (state === 'loading') {
      return {
        name: 'retrieval',
        status: 'warn',
        summary: `${active} is loading; retrieval is lexical-only meanwhile.`,
        detail:
          'The model is still coming up. Until it does, memory and knowledge search match words only and every ' +
          'new memory is stored pending — they are re-indexed automatically once the model answers.' +
          waitingNote,
      };
    }

    if (state === 'lexical-only') {
      return {
        name: 'retrieval',
        status: 'warn',
        summary: `"${requested}" embeddings were requested; the model did not load, so retrieval is lexical-only.`,
        detail:
          `${active} could not be loaded${lastError ? ` (${lastError})` : ''}. Retrieval matches words rather than ` +
          'meaning: a question phrased differently from its answer will find nothing, and every memory written ' +
          'meanwhile is stored pending. Ship the model with the image (the runtime never downloads), or switch the ' +
          'embeddings setting to hash; either way the stale rows are re-indexed automatically.' +
          waitingNote,
      };
    }

    return {
      name: 'retrieval',
      status: 'ok',
      summary: `${active} (${dimension}d)`,
      detail:
        'A sentence-transformer: retrieval bridges a question to an answer that shares no words with it.' +
        waitingNote,
    };
  }

  /**
   * Whether anything in this container can reach the internet.
   *
   * `fail` rather than `warn`, because with no egress nothing the product does
   * works: the CLI cannot call the API, `git clone` cannot resolve a remote,
   * and no HTTP MCP server connects. The stack has come up healthy in exactly
   * that state before — the app container was left on an `internal: true`
   * network — and every run failed with an error that pointed nowhere near it.
   *
   * What it does *not* claim is that web search works. `WebSearch` runs
   * upstream and `WebFetch` runs here, so this probe speaks for the second and
   * for the API connection both of them ultimately need; the summary says so
   * rather than letting the check be read as a guarantee it cannot give.
   */
  private async network(): Promise<DoctorCheck> {
    const { ok, detail } = await this.deps.reachOut();
    return ok
      ? {
          name: 'network',
          status: 'ok',
          summary: 'This container can reach the internet.',
          detail,
        }
      : {
          name: 'network',
          status: 'fail',
          summary: 'Nothing can leave this container — no runs, no clones, no HTTP MCP server.',
          detail,
        };
  }

  private async claudeCli(): Promise<DoctorCheck> {
    const version = await this.deps.cliVersion();
    if (version === null) {
      return {
        name: 'claude-cli',
        status: 'fail',
        summary: 'The Claude CLI cannot be spawned — nothing can run.',
        detail: null,
      };
    }
    const { mode, signInEndsAt } = this.deps.credential();
    if (mode === 'none') {
      return {
        name: 'claude-cli',
        status: 'warn',
        summary: 'The CLI is present but no credential is paired — runs will fail to authenticate.',
        detail: version,
      };
    }

    /*
     * A credential with a known end date is worth saying out loud before it
     * bites, exactly like a backup that has quietly stopped.
     *
     * Only when the end is *known*: a pasted setup token carries no expiry
     * this process can read, and neither does an older CLI's store. Inventing
     * a warning for "unknown" would repeat the boot warning's mistake — an
     * alarm that is always on is an alarm nobody reads.
     */
    if (signInEndsAt !== null) {
      const left = signInEndsAt - (this.deps.now?.() ?? Date.now());
      if (left <= 0) {
        return {
          name: 'claude-cli',
          status: 'fail',
          summary: 'The Claude sign-in has expired — every run will fail to authenticate.',
          detail: `${version} · auth: ${mode}`,
        };
      }
      const days = Math.ceil(left / 86_400_000);
      if (days <= CREDENTIAL_WARN_DAYS) {
        return {
          name: 'claude-cli',
          status: 'warn',
          summary: `The Claude sign-in ends in ${days} ${days === 1 ? 'day' : 'days'}; renew it before runs start failing.`,
          detail: `${version} · auth: ${mode}`,
        };
      }
    }
    return { name: 'claude-cli', status: 'ok', summary: version, detail: `auth: ${mode}` };
  }

  /**
   * The shape of the memory corpus, and whether deduplication still sees all
   * of it.
   *
   * `findNearDuplicate` compares a write against the newest
   * `DUPLICATE_SCAN_LIMIT` rows *in its scope*, and a workspace's scope is its
   * own rows plus the global tier — that is what the query does, so that is
   * what is counted here. Past the ceiling the oldest rows stop being compared
   * and duplicates start accumulating again, with nothing failing and nothing
   * logged. A ceiling nobody can see is the failure this check exists for.
   */
  private memory(): DoctorCheck {
    const globals =
      this.deps.db
        .prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM memories WHERE workspace_id IS NULL')
        .get()?.n ?? 0;
    const scoped =
      this.deps.db
        .prepare<[], { n: number }>(
          'SELECT COUNT(*) AS n FROM memories WHERE workspace_id IS NOT NULL',
        )
        .get()?.n ?? 0;

    if (globals + scoped === 0) {
      return {
        name: 'memory',
        status: 'ok',
        summary: 'No memories yet.',
        detail: 'The reflexion pass writes them as runs finish; you can also write one by hand.',
      };
    }

    // Every scope's scan size, worst first. The global tier's own scan is just
    // itself; a workspace's is its rows plus the globals it inherits.
    const perWorkspace = this.deps.db
      .prepare<[], { name: string; n: number }>(
        `SELECT w.name AS name, COUNT(m.id) AS n
           FROM workspaces w JOIN memories m ON m.workspace_id = w.id
          GROUP BY w.id ORDER BY n DESC`,
      )
      .all();
    const crowded = perWorkspace
      .map((row) => ({ name: row.name, scan: row.n + globals }))
      .concat({ name: 'the global tier', scan: globals })
      .sort((a, b) => b.scan - a.scan)[0];

    const summary =
      `${globals + scoped} memories — ${globals} global, ${scoped} in ${perWorkspace.length} ` +
      `workspace${perWorkspace.length === 1 ? '' : 's'}.`;

    if (crowded && crowded.scan >= DEDUPLICATION_WARN_AT) {
      return {
        name: 'memory',
        status: 'warn',
        summary: `${summary} ${crowded.name} is the largest scope, at ${crowded.scan}.`,
        detail:
          `A write is only compared against the newest ${DUPLICATE_SCAN_LIMIT} memories in its scope, ` +
          'so past that duplicates stop being caught and the corpus starts repeating itself. ' +
          'Consolidate from the Memory screen, or delete what is no longer true.',
      };
    }

    return { name: 'memory', status: 'ok', summary, detail: null };
  }

  private runs(): DoctorCheck {
    const active = this.deps.activeRuns();
    const queued = this.deps.queuedRuns();
    return {
      name: 'runs',
      status: 'ok',
      summary: `${active} active, ${queued} queued.`,
      detail: null,
    };
  }

  private automations(): DoctorCheck {
    // The failure guard disables a runaway loop and nothing else says so
    // loudly; an automation that silently stopped is the doctor's business.
    const rows = this.deps.db
      .prepare<[], { name: string }>(
        `SELECT name FROM automations
         WHERE enabled = 0 AND consecutive_failures >= max_consecutive_failures`,
      )
      .all();
    if (rows.length > 0) {
      return {
        name: 'automations',
        status: 'warn',
        summary: `${rows.length} automation${rows.length === 1 ? ' was' : 's were'} switched off by the failure guard.`,
        detail: rows.map((row) => row.name).join(', '),
      };
    }
    return { name: 'automations', status: 'ok', summary: 'No automation is stuck.', detail: null };
  }
}
