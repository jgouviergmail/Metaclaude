/**
 * System routes — health, analytics, audit, and Claude CLI status.
 */

import { execFile } from 'node:child_process';
import { statfs } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { App } from '../http/types.js';
import { APP_VERSION, ClaudeCredentialInput, type SystemHealth } from '@metaclaude/shared';
import type { AppContext } from '../context.js';
import { requireOwner } from '../http/guards.js';
import { queryIntOr, spreadInt, spreadTimestamp } from '../http/query.js';

const execFileAsync = promisify(execFile);

/** Cached CLI probe — spawning a process on every health poll would be wasteful. */
let cliProbe: { at: number; version: string | null } | null = null;
const CLI_PROBE_TTL_MS = 60_000;

async function probeClaudeCli(binPath: string | null): Promise<string | null> {
  if (cliProbe && Date.now() - cliProbe.at < CLI_PROBE_TTL_MS) return cliProbe.version;

  try {
    const { stdout } = await execFileAsync(binPath ?? 'claude', ['--version'], { timeout: 10_000 });
    const version = stdout.trim().split('\n')[0] ?? null;
    cliProbe = { at: Date.now(), version };
    return version;
  } catch {
    cliProbe = { at: Date.now(), version: null };
    return null;
  }
}

export function registerSystemRoutes(app: App, context: AppContext): void {
  /**
   * Liveness endpoint. Public and deliberately uninformative — it exists for
   * the container healthcheck, not for humans.
   */
  app.get('/api/health', async (_request, reply) => {
    return reply.send({ status: 'ok', version: APP_VERSION });
  });

  app.get('/api/system', async (_request, reply) => {
    const version = await probeClaudeCli(context.config.claude.binPath);
    const credential = context.claudeCredentials.status();

    let diskFreeBytes = 0;
    try {
      const stats = await statfs(context.config.dataDir);
      diskFreeBytes = Number(stats.bavail) * Number(stats.bsize);
    } catch {
      // statfs is unavailable on some filesystems; report zero rather than fail.
    }

    const health: SystemHealth = {
      version: APP_VERSION,
      uptimeMs: Date.now() - context.startedAt,
      claudeCli: {
        available: version !== null,
        version,
        // Asked of the credential service, not of the boot-time config: a
        // credential paired from the interface since startup is the one that
        // will actually be used, and reporting the stale config value would
        // tell the owner their pairing had not worked.
        authenticated: credential.mode !== 'none',
        authMode: credential.mode,
        authSource: credential.source,
        authHint: credential.hint,
      },
      activeRuns: context.kernel.activeCount,
      queuedRuns: context.kernel.queuedCount,
      memoryCount: context.memory.count(),
      embeddingProvider: context.embedder.id,
      diskFreeBytes,
      rssBytes: process.memoryUsage().rss,
    };
    return reply.send(health);
  });

  /* ------------------------- Claude credentials ------------------------- */

  /**
   * Pairing from the interface.
   *
   * Owner-only, and deliberately write-only: there is no route that returns the
   * credential. The status carries a four-character hint, which is enough to
   * confirm *which* token is in use and useless to anyone who intercepts it.
   */
  app.get('/api/claude/credential', async (request, reply) => {
    requireOwner(request);
    return reply.send(context.claudeCredentials.status());
  });

  app.put('/api/claude/credential', async (request, reply) => {
    const user = requireOwner(request);
    const input = ClaudeCredentialInput.parse(request.body);
    const status = context.claudeCredentials.save(input.value);
    context.audit.record({
      actor: user.username,
      action: 'claude.credential.set',
      target: status.mode,
      outcome: 'success',
      ipAddress: request.ip,
      // The value never reaches the audit log; the hint identifies it.
      detail: status.hint ?? '',
    });
    return reply.send(status);
  });

  app.delete('/api/claude/credential', async (request, reply) => {
    const user = requireOwner(request);
    const status = context.claudeCredentials.clear();
    context.audit.record({
      actor: user.username,
      action: 'claude.credential.clear',
      target: status.mode,
      outcome: 'success',
      ipAddress: request.ip,
    });
    return reply.send(status);
  });

  /* ------------------------------ Analytics ----------------------------- */

  app.get<{
    Querystring: { workspaceId?: string; days?: string; granularity?: string };
  }>('/api/analytics', async (request, reply) => {
    const days = queryIntOr(request.query.days, { min: 1, max: 365 }, 30);
    const since = Date.now() - days * 86_400_000;
    const granularity =
      request.query.granularity === 'hour'
        ? 'hour'
        : request.query.granularity === 'week'
          ? 'week'
          : 'day';

    const scope = request.query.workspaceId ? { workspaceId: request.query.workspaceId } : {};
    return reply.send({
      summary: context.analytics.summary({ ...scope, since }),
      series: context.analytics.series({ ...scope, since, granularity }),
    });
  });

  /* -------------------------------- Audit ------------------------------- */

  app.get<{ Querystring: { limit?: string; before?: string; action?: string } }>(
    '/api/audit',
    async (request, reply) => {
      // The audit log records who did what; only an owner may read it.
      requireOwner(request);
      return reply.send({
        entries: context.audit.list({
          ...spreadInt('limit', request.query.limit, { min: 1, max: 500 }),
          ...spreadTimestamp('before', request.query.before),
          ...(request.query.action ? { action: request.query.action } : {}),
        }),
      });
    },
  );

  app.get('/api/audit/verify', async (request, reply) => {
    requireOwner(request);
    return reply.send(context.audit.verifyChain());
  });

  /**
   * The doctor — every self-check the system knows how to run, in one
   * read-only report. Owner-only like the audit verification beside it: the
   * findings name paths, versions and failing secret slots.
   */
  app.get('/api/system/doctor', async (request, reply) => {
    requireOwner(request);
    return reply.send(await context.doctor.run());
  });

  /**
   * The informational half of guarded self-update: is a newer release
   * published? Applying one stays the tag-driven, health-gated deploy
   * pipeline — no route can trigger it.
   */
  app.get('/api/system/update-check', async (request, reply) => {
    requireOwner(request);
    if (!context.updateChecker) {
      return reply.send({ disabled: true });
    }
    const query = request.query as { refresh?: string };
    return reply.send(await context.updateChecker.check({ force: query.refresh === 'true' }));
  });
}
