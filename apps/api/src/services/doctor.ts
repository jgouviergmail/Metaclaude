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

const GB = 1024 ** 3;
/** Below this, writes are at risk soon; below the floor, now. */
const DISK_WARN_BYTES = 2 * GB;
const DISK_FAIL_BYTES = 0.5 * GB;

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
  credentialMode: () => string;
  activeRuns: () => number;
  queuedRuns: () => number;
  now?: () => number;
}

const WORST: Record<DoctorCheck['status'], number> = { ok: 0, warn: 1, fail: 2 };

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
    await examine('claude-cli', () => this.claudeCli());
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
    const label = `${(free / GB).toFixed(1)} GB free at ${path}`;
    if (free < DISK_FAIL_BYTES) {
      return { name, status: 'fail', summary: 'Disk space is critically low.', detail: label };
    }
    if (free < DISK_WARN_BYTES) {
      return { name, status: 'warn', summary: 'Disk space is getting low.', detail: label };
    }
    return { name, status: 'ok', summary: label, detail: null };
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
    const mode = this.deps.credentialMode();
    if (mode === 'none') {
      return {
        name: 'claude-cli',
        status: 'warn',
        summary: 'The CLI is present but no credential is paired — runs will fail to authenticate.',
        detail: version,
      };
    }
    return { name: 'claude-cli', status: 'ok', summary: version, detail: `auth: ${mode}` };
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
