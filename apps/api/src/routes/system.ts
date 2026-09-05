/**
 * System routes — health, analytics, audit, and Claude CLI status.
 */

import { execFile } from 'node:child_process';
import { readFile, statfs } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { promisify } from 'node:util';
import { HostMetrics } from '../services/host-metrics.js';
import type { App } from '../http/types.js';
import {
  APP_VERSION,
  ClaudeCredentialInput,
  ClaudePairingBeginInput,
  ClaudePairingCodeInput,
  PushSubscriptionInput,
  RuntimeSettingKey,
  SetRuntimeSettingRequest,
  type PushStatus,
  type SystemHealth,
} from '@metaclaude/shared';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { HttpError, requestIp, requireOperator, requireOwner } from '../http/guards.js';
import { serverTimezone } from '../services/cron.js';
import { RuntimeSettingsError } from '../services/runtime-settings.js';
import { queryIntOr, spreadInt, spreadTimestamp } from '../http/query.js';

const execFileAsync = promisify(execFile);

/** Cached CLI probe — spawning a process on every health poll would be wasteful. */
let cliProbe: { at: number; version: string | null } | null = null;
const CLI_PROBE_TTL_MS = 60_000;

/**
 * One instance for the process, because CPU usage is a rate: it is the
 * difference between this read and the last one, so the sample has to outlive
 * the request that took it. Module-level for the same reason `cliProbe` is —
 * the judgement all lives in the class, which is tested on its own.
 */
const hostMetrics = new HostMetrics({
  readFile: async (path) => {
    try {
      return await readFile(path, 'utf8');
    } catch {
      // Absent on macOS and Windows, and absent inside a container without
      // cgroup v2. Not an error: a figure nobody can measure.
      return null;
    }
  },
  statfs: async (path) => {
    const stats = await statfs(path);
    return {
      freeBytes: Number(stats.bavail) * Number(stats.bsize),
      totalBytes: Number(stats.blocks) * Number(stats.bsize),
    };
  },
  rss: () => process.memoryUsage().rss,
  cpuCount: () => availableParallelism(),
  now: () => Date.now(),
});

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

    const resources = await hostMetrics.read(context.config.dataDir);

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
      retrieval: context.retrieval(),
      systemWorkspaceId: context.systemWorkspace.id(),
      timezone: serverTimezone(),
      resources,
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

  /* ------------------------------ Web push ------------------------------ */

  /**
   * Operator-level: anyone who can watch runs and decide approvals may be
   * notified about them. The endpoint host lands in the audit trail — a new
   * device receiving the deployment's notifications is worth a line — but
   * never the full endpoint, which is capability-shaped.
   */
  app.get('/api/push', async (request, reply) => {
    requireOperator(request);
    const status: PushStatus = {
      publicKey: context.push.publicKey(),
      devices: context.push.devices(),
    };
    return reply.send(status);
  });

  app.post('/api/push/subscriptions', async (request, reply) => {
    const user = requireOperator(request);
    const input = PushSubscriptionInput.parse(request.body);
    context.push.subscribe(user.id, input);
    context.audit.record({
      actor: user.username,
      action: 'push.subscribe',
      target: new URL(input.endpoint).host,
      outcome: 'success',
      ipAddress: request.ip,
    });
    return reply.status(201).send({ devices: context.push.devices() });
  });

  app.delete('/api/push/subscriptions', async (request, reply) => {
    const user = requireOperator(request);
    const query = request.query as { endpoint?: string };
    if (!query.endpoint) throw new HttpError(400, 'Name the endpoint to remove.');
    const removed = context.push.unsubscribe(user.id, query.endpoint);
    if (removed) {
      context.audit.record({
        actor: user.username,
        action: 'push.unsubscribe',
        target: new URL(query.endpoint).host,
        outcome: 'success',
        ipAddress: request.ip,
      });
    }
    return reply.send({ removed, devices: context.push.devices() });
  });

  /** Ring the caller's own devices, so "did it work?" has a button. */
  app.post('/api/push/test', async (request, reply) => {
    requireOperator(request);
    const outcome = await context.push.notify(
      { title: 'Metaclaude', body: 'Push notifications are working.', url: '/', tag: 'push-test' },
      { ttlSeconds: 60, urgency: 'normal' },
    );
    return reply.send(outcome);
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
   * The operational settings an owner may change without a restart.
   *
   * Owner-only, and the list is closed: the service refuses any key that is
   * not in its own catalogue, so this route cannot be talked into writing a
   * security setting by a hand-made request. The security tier is not merely
   * absent from the form — it is absent from the surface.
   */
  app.get('/api/system/settings', async (request, reply) => {
    requireOwner(request);
    return reply.send({ settings: context.runtimeSettings.all() });
  });

  app.put<{ Params: { key: string } }>('/api/system/settings/:key', async (request, reply) => {
    const actor = requireOwner(request);
    const parsed = SetRuntimeSettingRequest.safeParse(request.body);
    if (!parsed.success) {
      throw new HttpError(400, parsed.error.issues[0]?.message ?? 'Invalid request.');
    }
    const key = RuntimeSettingKey.safeParse(request.params.key);
    if (!key.success) throw new HttpError(404, 'No such setting.');

    try {
      // `null` is how the form says "back to the environment", which is a
      // different act from writing a value and deserves the same route.
      if (parsed.data.value === null) context.runtimeSettings.clear(key.data);
      else context.runtimeSettings.set(key.data, parsed.data.value, actor.username);
    } catch (error) {
      if (error instanceof RuntimeSettingsError) throw new HttpError(400, error.message);
      throw error;
    }

    context.audit.record({
      actor: actor.username,
      action: 'system.setting',
      target: key.data,
      ipAddress: requestIp(context, request),
      detail: parsed.data.value === null ? 'cleared' : String(parsed.data.value),
    });
    return reply.send({ settings: context.runtimeSettings.all() });
  });

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
