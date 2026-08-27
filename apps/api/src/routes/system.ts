/**
 * System routes — health, analytics, audit, and Claude CLI status.
 */

import { execFile } from 'node:child_process';
import { statfs } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { App } from '../http/types.js';
import {
  APP_VERSION,
  ClaudeCredentialInput,
  ClaudePairingBeginInput,
  ClaudePairingCodeInput,
  type SystemHealth,
} from '@metaclaude/shared';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { HttpError, requestIp, requireOwner } from '../http/guards.js';
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

  /**
   * Guided pairing — the `setup-token` OAuth exchange run by the server, so
   * the whole flow fits on a phone. Owner-only like the credential itself.
   * What goes back to the browser is a sign-in URL and, at the end, the same
   * status the credential routes return; the token never does.
   */
  app.post('/api/claude/pairing', async (request, reply) => {
    const user = requireOwner(request);
    const input = ClaudePairingBeginInput.parse(request.body ?? {});
    const start = context.claudePairing.begin(input.account);
    context.audit.record({
      actor: user.username,
      action: 'claude.pairing.start',
      target: input.account,
      outcome: 'success',
      ipAddress: request.ip,
    });
    return reply.send(start);
  });

  app.post('/api/claude/pairing/code', async (request, reply) => {
    const user = requireOwner(request);
    const input = ClaudePairingCodeInput.parse(request.body);
    const status = await context.claudePairing.complete(input.code);
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

  app.delete('/api/claude/pairing', async (request, reply) => {
    requireOwner(request);
    context.claudePairing.cancel();
    return reply.send(context.claudePairing.status());
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
  /**
   * The morning brief — what happened, what needs a human. Owner-only for
   * the same reason as the doctor it embeds.
   */
  app.get('/api/brief', async (request, reply) => {
    requireOwner(request);
    return reply.send(await context.brief.generate());
  });

  app.get('/api/system/update-check', async (request, reply) => {
    requireOwner(request);
    if (!context.updateChecker) {
      return reply.send({ disabled: true });
    }
    const query = request.query as { refresh?: string };
    return reply.send(await context.updateChecker.check({ force: query.refresh === 'true' }));
  });

  app.get('/api/system/update-apply', async (request, reply) => {
    requireOwner(request);
    return reply.send(await context.updateApplier.status());
  });

  app.post('/api/system/update-apply', async (request, reply) => {
    const actor = requireOwner(request);
    const parsed = z.object({ version: z.string().min(1).max(64) }).safeParse(request.body);
    if (!parsed.success) throw new HttpError(400, 'Which version? Pass { version: "vX.Y.Z" }.');

    await context.updateApplier.request(parsed.data.version, actor.username);
    context.audit.record({
      actor: actor.username,
      action: 'system.update_apply',
      target: parsed.data.version,
      ipAddress: requestIp(context, request),
    });
    // 202: the host updater takes it from here — this container is about to
    // be replaced mid-flight, which is the success path, not an error.
    return reply.status(202).send({ ok: true });
  });
}
