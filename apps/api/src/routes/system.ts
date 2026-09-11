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
  SetCliSkillsRequest,
  SetCliToolsRequest,
  SetRuntimeSettingRequest,
  TOOL_SEARCH_TOOL,
  reviewDeniedToolNames,
  reviewToolNames,
  type CliSkillsReport,
  type CliToolsReport,
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
   * The guided flows — the CLI's own OAuth exchanges, run by the server, so
   * neither needs a shell. `kind` chooses which: a `setup-token` pairing,
   * sealed in the vault, or an account sign-in, installed in the CLI's own
   * store. Owner-only like the credential itself. What goes back to the
   * browser is a sign-in URL and, at the end, the same status the credential
   * routes return; no token ever does.
   */
  app.post('/api/claude/pairing', async (request, reply) => {
    const user = requireOwner(request);
    const input = ClaudePairingBeginInput.parse(request.body ?? {});
    const start = context.claudePairing.begin(input.account, input.kind);
    context.audit.record({
      actor: user.username,
      // Two different credentials in two different places: the trail says
      // which one was being obtained, not merely that a flow was started.
      action: input.kind === 'account' ? 'claude.signin.start' : 'claude.pairing.start',
      target: input.account,
      outcome: 'success',
      ipAddress: request.ip,
    });
    return reply.send(start);
  });

  app.post('/api/claude/pairing/code', async (request, reply) => {
    const user = requireOwner(request);
    const input = ClaudePairingCodeInput.parse(request.body);
    // Read before the exchange clears it: the attempt is gone by the time the
    // status comes back, and the trail has to name what was installed.
    const kind = context.claudePairing.status().kind;
    const status = await context.claudePairing.complete(input.code);
    context.audit.record({
      actor: user.username,
      action: kind === 'account' ? 'claude.signin.renew' : 'claude.credential.set',
      target: status.mode,
      outcome: 'success',
      ipAddress: request.ip,
      /*
       * Never the value; something true about what was installed.
       *
       * The hint identifies a stored token, and a renewed sign-in has no hint
       * because nothing is injected for it — so reading the hint there would
       * put the *paired token's* last four characters on a line about the
       * sign-in, which is a different credential entirely. The plan is what
       * the renewal actually established.
       */
      detail:
        kind === 'account'
          ? (status.cliLogin?.subscriptionType ?? 'account')
          : (status.hint ?? ''),
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

  /* --------------------------- The CLI's tools -------------------------- */

  /** Why `ToolSearch` may not be refused, in the words the vetting uses. */
  const toolSearchLock = reviewDeniedToolNames([TOOL_SEARCH_TOOL]).rejected[0]?.reason ?? null;

  /**
   * What the CLI brings, and what this deployment refuses of it.
   *
   * Two sources joined, and neither is the whole answer. The *offered* half
   * comes from the CLI's own opening frame, read in the data directory so it
   * describes the built-ins rather than any workspace's skills and servers —
   * a list written down here would be wrong on the next platform (`PowerShell`
   * on Windows against `Bash` elsewhere) and on the next CLI bump. The
   * *refused* half comes from the deployment's stored list, which has to be
   * shown even for a tool the CLI no longer offers: otherwise that row is
   * unclearable and the stored set accumulates names nobody can see.
   *
   * Owner-only, like the other configuration surfaces: this is the shape of
   * the agent every workspace runs, and three of the tools it can close reach
   * outside Metaclaude entirely.
   */
  const cliToolsReport = (): CliToolsReport => {
    /*
     * From the store the runs feed, not from a probe — and the first version
     * probed. The CLI names its tools only on its `system/init` frame, and
     * emits that frame only with the first user message; a probe that sends
     * none listens for ever, which is what production showed as "the CLI could
     * not be asked" under a Skills section that had answered fine (that one
     * rides a control request). Every run sends a prompt, so every run is the
     * measurement, and the screen says when it was taken.
     */
    const seen = context.cliTools.offered();
    const offered = new Set(seen.tools);
    const disabled = new Set(context.cliTools.disabled());
    const names = [...new Set([...offered, ...disabled])].sort();

    return {
      tools: names.map((name) => ({
        name,
        disabled: disabled.has(name),
        offered: offered.has(name),
        locked: name === TOOL_SEARCH_TOOL ? toolSearchLock : null,
      })),
      source: context.cliTools.source(),
      probed: offered.size > 0,
      seenAt: seen.seenAt,
    };
  };

  app.get('/api/system/cli-tools', async (request, reply) => {
    requireOwner(request);
    return reply.send(cliToolsReport());
  });

  app.put('/api/system/cli-tools', async (request, reply) => {
    const actor = requireOwner(request);
    const parsed = SetCliToolsRequest.safeParse(request.body);
    if (!parsed.success) {
      throw new HttpError(400, parsed.error.issues[0]?.message ?? 'Invalid request.');
    }

    /*
     * Vetted *before* anything is written, which is not where the first
     * version put it.
     *
     * Refusing with the reason rather than dropping the entry silently is the
     * easy half: an operator who ticked `ToolSearch` is owed the sentence
     * explaining why the box will not stay ticked. The half that has to be
     * right is the order. Storing first and undoing afterwards looks
     * equivalent and is not — the undo hands the deployment back its
     * *default*, so a 400 on one bad name would have thrown away a list the
     * operator had built. It read as correct because the obvious test starts
     * from the default, where clearing is a no-op.
     */
    const review =
      parsed.data.disabled === null
        ? { allowed: [], rejected: [] }
        : reviewDeniedToolNames(parsed.data.disabled);
    const first = review.rejected[0];
    if (first) throw new HttpError(400, `"${first.name}" ${first.reason}.`);

    const stored = context.cliTools.set(parsed.data.disabled);

    context.audit.record({
      actor: actor.username,
      action: 'system.cliTools',
      target: `${stored.allowed.length} tool(s)`,
      ipAddress: requestIp(context, request),
      detail: parsed.data.disabled === null ? 'cleared' : stored.allowed.join(', '),
    });
    return reply.send(cliToolsReport());
  });

  /* -------------------------- The CLI's skills -------------------------- */

  /**
   * The CLI's own skills, governed the way the operator's are.
   *
   * Same two-source join as the tools above, with one thing added: reading the
   * CLI here is also how the run path learns what exists. A run cannot spawn a
   * probe of its own, and the enumerated payload it sends once something is
   * chosen has to name every *other* skill `off` — so the list the CLI was last
   * seen to ship is written down each time this screen looks, and an empty
   * answer is refused rather than remembered.
   */
  const cliSkillsReport = async (): Promise<CliSkillsReport> => {
    const shipped = await context.builtInSkills.get(context.config.dataDir);
    // Same rule as the tools: no CLI ships no skills, so empty means "could
    // not look", whatever the reason it came back that way.
    const probed = shipped.length > 0;
    if (probed) context.cliSkills.rememberKnown(shipped.map((skill) => skill.name));

    const cost = new Map(shipped.map((skill) => [skill.name, skill.tokens]));
    const enabled = new Set(context.cliSkills.enabled());
    // What is shown when the CLI could not be asked is what it was last seen
    // to ship, so a chosen skill stays clearable — and every row then says it
    // is not known to be offered, which is the truth.
    const names = [
      ...new Set([...(probed ? cost.keys() : context.cliSkills.known()), ...enabled]),
    ].sort();

    return {
      skills: names.map((name) => ({
        name,
        enabled: enabled.has(name),
        offered: cost.has(name),
        tokens: cost.get(name) ?? null,
      })),
      source: context.cliSkills.source(),
      probed,
    };
  };

  app.get('/api/system/cli-skills', async (request, reply) => {
    requireOwner(request);
    return reply.send(await cliSkillsReport());
  });

  app.put('/api/system/cli-skills', async (request, reply) => {
    const actor = requireOwner(request);
    const parsed = SetCliSkillsRequest.safeParse(request.body);
    if (!parsed.success) {
      throw new HttpError(400, parsed.error.issues[0]?.message ?? 'Invalid request.');
    }

    // Vetted before anything is written, for the reason the tools route says:
    // the alternative undoes onto the *default*, which throws away a choice.
    if (parsed.data.enabled !== null) {
      const first = reviewToolNames(parsed.data.enabled).rejected[0];
      if (first) throw new HttpError(400, `"${first.name}" ${first.reason}.`);
    }

    const enabled = context.cliSkills.setEnabled(parsed.data.enabled);

    context.audit.record({
      actor: actor.username,
      action: 'system.cliSkills',
      target: `${enabled.length} skill(s)`,
      ipAddress: requestIp(context, request),
      detail: parsed.data.enabled === null ? 'cleared' : enabled.join(', '),
    });
    return reply.send(await cliSkillsReport());
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

  /**
   * The CLI's version, and whether npm has a newer one.
   *
   * A reading only. The CLI is pinned into the image and the container refuses
   * to change it three ways over — non-root process, root-owned directory,
   * read-only filesystem — so there is no honest update to trigger here;
   * moving it means raising the pin and shipping a release. What this answers
   * is the thing an operator could not otherwise know.
   */
  app.get('/api/system/claude-cli', async (request, reply) => {
    requireOwner(request);
    const query = request.query as { refresh?: string };
    return reply.send(await context.claudeCliUpdate.check({ force: query.refresh === 'true' }));
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
