/**
 * Registry and automation routes — skills, agents, MCP servers, automations.
 */

import type { App } from '../http/types.js';
import { AutomationTrigger, EffortLevel, LibraryCategory, McpTransport, ModelSelector, PermissionMode } from '@metaclaude/shared';
import { z } from 'zod';
import { InstallPluginRequest, MarketplaceInput } from '@metaclaude/shared';
import type { AppContext } from '../context.js';
import {
  assertPermissionModeAllowed,
  HttpError,
  mustGetWorkspace,
  requestIp,
  requireOperator,
  requireOwner,
} from '../http/guards.js';
import { redactUrlCredentials } from '../security/audit.js';
import { describeServer } from '../services/mcp-probe.js';
import { buildMcpTransport } from '../services/mcp-transport.js';
import { McpOAuthError } from '../services/mcp-oauth.js';

export function registerRegistryRoutes(app: App, context: AppContext): void {
  /**
   * Scope resolution for the registry listings.
   *
   * `undefined` in the repository layer means "every scope"; `null` means
   * "global only". A missing query parameter must therefore *not* collapse to
   * `null`, or there would be no way to list everything — which is exactly what
   * a management screen needs.
   */
  const scopeQuery = z.object({
    workspaceId: z.string().optional(),
    scope: z.enum(['all', 'global']).optional(),
  });

  const resolveScope = (query: unknown): string | null | undefined => {
    const parsed = scopeQuery.safeParse(query);
    if (!parsed.success) return undefined;
    if (parsed.data.scope === 'all') return undefined;
    if (parsed.data.scope === 'global') return null;
    return parsed.data.workspaceId ?? null;
  };

  /**
   * Acting on many registry rows at once.
   *
   * Explicit ids rather than "everything in this scope", and that is the
   * safety property rather than a convenience: a workspace's listing includes
   * the global entries, so a server-side wildcard would let a workspace screen
   * delete the global library. The ids are what the operator was shown; the
   * scope is checked again underneath, so a caller cannot widen its own reach
   * by naming rows outside it.
   *
   * The cap is the payload's, not SQLite's: every id becomes a bound
   * parameter, and a statement with tens of thousands of them is a way to make
   * one request expensive. Five hundred is far above any real registry.
   */
  const BulkInput = z.object({
    action: z.enum(['enable', 'disable', 'delete']),
    ids: z.array(z.string().min(1).max(64)).min(1).max(500),
    workspaceId: z.string().nullable().optional(),
  });

  /** One audit entry carrying the count, not one per row. */
  const auditBulk = (
    request: Parameters<typeof requestIp>[1],
    actor: string,
    kind: 'skill' | 'agent',
    action: string,
    changed: number,
  ) =>
    context.audit.record({
      actor,
      action: `${kind}.bulk.${action}`,
      target: `${changed} ${kind}(s)`,
      ipAddress: requestIp(context, request),
      detail: String(changed),
    });

  /* -------------------------------- Skills ------------------------------ */

  app.get('/api/skills', async (request, reply) => {
    return reply.send({ skills: context.registry.listSkills(resolveScope(request.query)) });
  });

  const SkillInput = z.object({
    id: z.string().optional(),
    workspaceId: z.string().nullable().default(null),
    name: z.string().min(1).max(64),
    description: z.string().min(1).max(1024),
    body: z.string().max(200_000),
    category: LibraryCategory.optional(),
    enabled: z.boolean().default(true),
  });

  app.post('/api/skills', async (request, reply) => {
    const actor = requireOperator(request);
    const parsed = SkillInput.safeParse(request.body);
    if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? 'Invalid request.');

    const skill = context.registry.upsertSkill(parsed.data);
    context.audit.record({
      actor: actor.username,
      action: parsed.data.id ? 'skill.update' : 'skill.create',
      target: skill.id,
      ipAddress: requestIp(context, request),
      detail: skill.name,
    });
    return reply.status(parsed.data.id ? 200 : 201).send({ skill });
  });

  app.post('/api/skills/bulk', async (request, reply) => {
    const actor = requireOperator(request);
    const parsed = BulkInput.safeParse(request.body);
    if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? 'Invalid request.');

    const { action, ids } = parsed.data;
    // `undefined` when omitted is "every scope" — the same three-way
    // convention as the listings, and the reason this is not `?? null`.
    const scope = 'workspaceId' in parsed.data ? parsed.data.workspaceId : undefined;
    const changed =
      action === 'delete'
        ? context.registry.deleteSkills(ids, scope)
        : context.registry.setSkillsEnabled(ids, action === 'enable', scope);

    auditBulk(request, actor.username, 'skill', action, changed);
    return reply.send({ changed });
  });

  app.delete<{ Params: { id: string } }>('/api/skills/:id', async (request, reply) => {
    const actor = requireOperator(request);
    if (!context.registry.deleteSkill(request.params.id)) throw new HttpError(404, 'Skill not found.');

    context.audit.record({
      actor: actor.username,
      action: 'skill.delete',
      target: request.params.id,
      ipAddress: requestIp(context, request),
    });
    return reply.send({ ok: true });
  });

  /* -------------------------------- Agents ------------------------------ */

  app.get('/api/agents', async (request, reply) => {
    return reply.send({ agents: context.registry.listAgents(resolveScope(request.query)) });
  });

  const AgentInput = z.object({
    id: z.string().optional(),
    workspaceId: z.string().nullable().default(null),
    name: z.string().min(1).max(64),
    description: z.string().min(1).max(1024),
    prompt: z.string().min(1).max(100_000),
    tools: z.array(z.string().max(64)).max(64).nullable().default(null),
    model: ModelSelector.nullable().default(null),
    category: LibraryCategory.optional(),
    enabled: z.boolean().default(true),
  });

  app.post('/api/agents', async (request, reply) => {
    const actor = requireOperator(request);
    const parsed = AgentInput.safeParse(request.body);
    if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? 'Invalid request.');

    const agent = context.registry.upsertAgent({
      ...parsed.data,
      model: parsed.data.model === null ? null : String(parsed.data.model),
    });
    context.audit.record({
      actor: actor.username,
      action: parsed.data.id ? 'agent.update' : 'agent.create',
      target: agent.id,
      ipAddress: requestIp(context, request),
      detail: agent.name,
    });
    // The catalogue probe mounts what runs mount; a changed registry
    // makes its cached answer stale for up to a minute — exactly the window
    // an operator refreshes in after fixing a server. Drop it now.
    context.claudeCatalogue.invalidate();
    return reply.status(parsed.data.id ? 200 : 201).send({ agent });
  });

  app.post('/api/agents/bulk', async (request, reply) => {
    const actor = requireOperator(request);
    const parsed = BulkInput.safeParse(request.body);
    if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? 'Invalid request.');

    const { action, ids } = parsed.data;
    const scope = 'workspaceId' in parsed.data ? parsed.data.workspaceId : undefined;
    const changed =
      action === 'delete'
        ? context.registry.deleteAgents(ids, scope)
        : context.registry.setAgentsEnabled(ids, action === 'enable', scope);

    auditBulk(request, actor.username, 'agent', action, changed);
    // Agents are mounted into the catalogue probe, so a changed set makes its
    // cached answer stale — the same reason the single-agent route does this.
    // Skills need no equivalent: they are written to disk on every run
    // submission, so the next run picks up whatever the registry now says.
    context.claudeCatalogue.invalidate();
    return reply.send({ changed });
  });

  app.delete<{ Params: { id: string } }>('/api/agents/:id', async (request, reply) => {
    const actor = requireOperator(request);
    if (!context.registry.deleteAgent(request.params.id)) throw new HttpError(404, 'Agent not found.');

    context.audit.record({
      actor: actor.username,
      action: 'agent.delete',
      target: request.params.id,
      ipAddress: requestIp(context, request),
    });
    // The catalogue probe mounts what runs mount; a changed registry
    // makes its cached answer stale for up to a minute — exactly the window
    // an operator refreshes in after fixing a server. Drop it now.
    context.claudeCatalogue.invalidate();
    return reply.send({ ok: true });
  });

  /* ------------------------------- Library ------------------------------- */

  /**
   * The built-in shelf. Listing is read-only and free to any signed-in user —
   * it serves content the repository itself publishes. Installing writes a
   * *disabled* global record, which is a registry mutation like any other, so
   * it takes an operator and leaves an audit line.
   *
   * No catalogue invalidation here, deliberately: `resolve` filters on
   * `enabled`, and an install always writes `enabled: false`, so the mounted
   * set cannot have changed. Enabling later goes through POST /api/skills or
   * /api/agents, which invalidate.
   */
  app.get('/api/library', async (_request, reply) => {
    return reply.send({ entries: context.library.list() });
  });

  app.post('/api/library/install', async (request, reply) => {
    const actor = requireOperator(request);
    const parsed = z.object({ name: z.string().min(1).max(64) }).safeParse(request.body);
    if (!parsed.success) throw new HttpError(400, 'name is required.');

    const { entry, id } = context.library.install(parsed.data.name);
    context.audit.record({
      actor: actor.username,
      action: 'library.install',
      target: id,
      ipAddress: requestIp(context, request),
      detail: `${entry.kind} ${entry.name}`,
    });
    return reply.status(201).send({ id, entry: { ...entry, installed: true } });
  });

  /**
   * The connector directory — the same shelf, for MCP servers.
   *
   * Install is a registry mutation like the library's, so it takes an operator
   * and leaves an audit line. The line records the connector's name and never
   * the credential: the whole point of the vault is that a secret has exactly
   * one home, and an audit log read by anyone who can read the audit log is
   * not it.
   *
   * No catalogue invalidation, for the library's reason: `resolve` filters on
   * `enabled` and an install always writes disabled, so nothing mounted has
   * changed. Enabling goes through POST /api/mcp, which invalidates.
   */
  app.get('/api/connectors', async (_request, reply) => {
    return reply.send({ connectors: context.library.listConnectors() });
  });

  app.post('/api/connectors/install', async (request, reply) => {
    const actor = requireOperator(request);
    const parsed = z
      .object({ name: z.string().min(1).max(64), secret: z.string().max(8192).optional() })
      .safeParse(request.body);
    if (!parsed.success) throw new HttpError(400, 'name is required.');

    const { connector, id } = context.library.installConnector(parsed.data.name, parsed.data.secret);
    context.audit.record({
      actor: actor.username,
      action: 'connector.install',
      target: id,
      ipAddress: requestIp(context, request),
      detail: `${connector.publisher} ${connector.name}`,
    });
    return reply
      .status(201)
      .send({ id, connector: { ...connector, args: [...connector.args], installed: true } });
  });

  /* --------------------------------- MCP -------------------------------- */

  app.get('/api/mcp', async (request, reply) => {
    return reply.send({ servers: context.registry.listMcpServers(resolveScope(request.query)) });
  });

  const McpInput = z.object({
    id: z.string().optional(),
    workspaceId: z.string().nullable().default(null),
    name: z.string().min(1).max(64),
    transport: McpTransport,
    command: z.string().max(1024).nullable().default(null),
    args: z.array(z.string().max(1024)).max(64).default([]),
    url: z.string().max(2048).nullable().default(null),
    /**
     * Secret values; written to the vault and never returned by any endpoint.
     * Merged over what is stored, so omitting a key keeps its current value.
     */
    env: z.record(z.string().max(128), z.string().max(8192)).default({}),
    /** Secret keys to delete. Removing a credential must be deliberate. */
    removeEnvKeys: z.array(z.string().max(128)).max(64).default([]),
    /**
     * Header values. Sealed exactly like `env` — an HTTP MCP server
     * authenticates through `Authorization`, so these are credentials.
     */
    headers: z.record(z.string().max(128), z.string().max(2048)).default({}),
    /** Header names to delete. */
    removeHeaderKeys: z.array(z.string().max(128)).max(64).default([]),
    enabled: z.boolean().default(true),
  });

  app.post('/api/mcp', async (request, reply) => {
    const actor = requireOperator(request);
    const parsed = McpInput.safeParse(request.body);
    if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? 'Invalid request.');

    const server = context.registry.upsertMcpServer(parsed.data);
    context.audit.record({
      actor: actor.username,
      action: parsed.data.id ? 'mcp.update' : 'mcp.create',
      target: server.id,
      ipAddress: requestIp(context, request),
      // The env *keys* are safe to log; the values live only in the vault.
      detail: `${server.name} (${Object.keys(parsed.data.env).join(', ') || 'no secrets'})`,
    });
    // The catalogue probe mounts what runs mount; a changed registry
    // makes its cached answer stale for up to a minute — exactly the window
    // an operator refreshes in after fixing a server. Drop it now.
    context.claudeCatalogue.invalidate();
    return reply.status(parsed.data.id ? 200 : 201).send({ server });
  });

  /**
   * What one server says it offers, in its own words.
   *
   * Deliberately *not* a health check. The catalogue probe is the authority on
   * whether a server connects, because it mounts what a run mounts; this asks
   * one already-connected server for the text that probe does not carry
   * through — each tool's description, and the `instructions` string the
   * protocol has for "what this server is for".
   *
   * Measured against a real server: the CLI's status reports every tool
   * description as empty while the annotations arrive intact. The model does
   * receive them — they reach it through the tool list, and a server's
   * instructions reach it as an MCP instructions block — so this closes a gap
   * in what the *operator* can see, not in what the agent knows.
   *
   * Not cached: it spawns a process or opens a connection, so it happens when
   * an operator asks and never on a page load.
   */
  app.post<{ Params: { id: string } }>('/api/mcp/:id/describe', async (request, reply) => {
    requireOperator(request);
    const server = context.registry.getMcpServer(request.params.id);
    if (!server) throw new HttpError(404, 'Server not found.');

    const config = context.registry.mcpConfig(server);
    if (!config) {
      throw new HttpError(400, 'This server has no command or URL to connect to.');
    }

    try {
      const described = await describeServer(() => buildMcpTransport(config));
      // Kept, so it survives the page. Only the words are stored — what a run
      // would actually mount is still the catalogue's answer, and the card
      // prefers the live one wherever it has it.
      context.registry.saveDescription(server.id, {
        instructions: described.instructions,
        tools: described.tools,
      });
      return reply.send({ description: described });
    } catch (error) {
      // A description that cannot be fetched is not an outage: the server may
      // be perfectly usable and merely slow, or behind a credential this
      // process cannot see. Reported as a failed enrichment, never as a
      // verdict on the server.
      throw new HttpError(
        502,
        `Could not ask ${server.name}: ${(error as Error).message}`,
      );
    }
  });

  /* ------------------------------ MCP OAuth ------------------------------ */

  /**
   * Begin an authorization, returning the URL the operator's browser opens.
   *
   * Owner-only: it registers this deployment as a client with a third party
   * and results in a credential this server will hold and use on every run.
   *
   * The URL is returned rather than redirected to, so the caller is a normal
   * authenticated JSON request with its CSRF token — a 302 out of a POST would
   * put the whole flow behind whatever the browser decides about redirects.
   */
  app.post<{ Params: { id: string } }>('/api/mcp/:id/oauth/start', async (request, reply) => {
    const actor = requireOwner(request);
    const server = context.registry.getMcpServer(request.params.id);
    if (!server) throw new HttpError(404, 'Server not found.');
    if (server.transport === 'stdio') {
      throw new HttpError(400, 'A stdio server runs as a local process and has nothing to authorise.');
    }
    if (!context.config.publicUrl) {
      throw new HttpError(
        503,
        'This deployment has no public address configured, so an authorization server has nowhere to send the browser back. Set METACLAUDE_PUBLIC_URL and restart.',
      );
    }

    try {
      const begun = await context.mcpOAuth.begin(
        { ...server, oauthMetadata: context.registry.oauthMetadata(server.id) },
        actor.username,
      );
      // Recorded before the redirect: the callback has to find the client id
      // and the metadata again, and it arrives with no session of its own.
      context.registry.saveOAuthRegistration(server.id, {
        issuer: begun.metadata.issuer,
        metadata: JSON.stringify(begun.metadata),
        clientId: begun.clientId,
      });
      context.audit.record({
        actor: actor.username,
        action: 'mcp.oauth.start',
        target: server.name,
        ipAddress: requestIp(context, request),
      });
      return reply.send({ authorizeUrl: begun.authorizeUrl });
    } catch (error) {
      if (error instanceof McpOAuthError) throw new HttpError(error.status, error.message);
      throw error;
    }
  });

  /**
   * Where the authorization server sends the browser back.
   *
   * Deliberately outside the authenticated surface. Session cookies are
   * `SameSite=strict`, so a cross-site redirect carries none of them — the
   * `state` is the only credential this request has, and it is what authorises
   * it: single use, high entropy, ten-minute life, and bound at initiation to
   * the server, the actor and the issuer. Anything missing or stale is refused.
   *
   * It answers with a redirect rather than JSON because a person is looking at
   * it: the browser lands back on the screen they left.
   */
  app.get<{ Querystring: { code?: string; state?: string; iss?: string; error?: string } }>(
    '/api/mcp/oauth/callback',
    async (request, reply) => {
      const back = `${context.config.publicUrl ?? ''}/agents?tab=mcp`;
      const { code, state, iss, error } = request.query;

      // The provider refusing is a normal outcome, not an exception: the
      // operator declined, or the consent expired.
      if (error) {
        return reply.redirect(`${back}&oauth=refused`);
      }
      if (!code || !state) {
        return reply.redirect(`${back}&oauth=invalid`);
      }

      try {
        const done = await context.mcpOAuth.complete({ code, state, iss: iss ?? null });
        const server = context.registry.getMcpServer(done.serverId);
        context.audit.record({
          actor: done.actor,
          action: 'mcp.oauth.authorised',
          target: server?.name ?? done.serverId,
          ipAddress: requestIp(context, request),
        });
        return reply.redirect(`${back}&oauth=done`);
      } catch (caught) {
        // The reason is for the log, not the query string: it comes from a
        // third party and the browser would render it.
        context.log.warn(
          { message: (caught as Error).message },
          'an MCP OAuth callback could not be completed',
        );
        return reply.redirect(`${back}&oauth=failed`);
      }
    },
  );

  /** Forget an authorization: the tokens, the client secret and the registration. */
  app.post<{ Params: { id: string } }>('/api/mcp/:id/oauth/revoke', async (request, reply) => {
    const actor = requireOwner(request);
    const server = context.registry.getMcpServer(request.params.id);
    if (!server) throw new HttpError(404, 'Server not found.');

    context.mcpOAuth.revoke(server.id);
    context.audit.record({
      actor: actor.username,
      action: 'mcp.oauth.revoked',
      target: server.name,
      ipAddress: requestIp(context, request),
    });
    return reply.send({ ok: true });
  });

  app.delete<{ Params: { id: string } }>('/api/mcp/:id', async (request, reply) => {
    const actor = requireOperator(request);
    if (!context.registry.deleteMcpServer(request.params.id)) {
      throw new HttpError(404, 'MCP server not found.');
    }
    context.audit.record({
      actor: actor.username,
      action: 'mcp.delete',
      target: request.params.id,
      ipAddress: requestIp(context, request),
    });
    // The catalogue probe mounts what runs mount; a changed registry
    // makes its cached answer stale for up to a minute — exactly the window
    // an operator refreshes in after fixing a server. Drop it now.
    context.claudeCatalogue.invalidate();
    return reply.send({ ok: true });
  });

  /* ------------------------------ Automations --------------------------- */

  app.get<{ Querystring: { workspaceId?: string } }>('/api/automations', async (request, reply) => {
    return reply.send({ automations: context.scheduler.list(request.query.workspaceId) });
  });

  const AutomationPolicy = z.object({
    model: ModelSelector.default('default'),
    effort: EffortLevel.nullable().default(null),
    permissionMode: PermissionMode.default('default'),
    agentName: z.string().max(64).nullable().default(null),
    maxTurns: z.number().int().min(1).max(500).nullable().default(null),
  });

  const AutomationInput = z.object({
    workspaceId: z.string().min(1),
    name: z.string().min(1).max(120),
    description: z.string().max(2000).default(''),
    prompt: z.string().min(1).max(100_000),
    trigger: AutomationTrigger,
    policy: AutomationPolicy.partial().optional(),
    continuous: z.boolean().default(false),
    maxConsecutiveFailures: z.number().int().min(0).max(100).default(3),
    enabled: z.boolean().default(true),
  });

  app.post('/api/automations', async (request, reply) => {
    const actor = requireOperator(request);
    const parsed = AutomationInput.safeParse(request.body);
    if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? 'Invalid request.');

    // An unattended loop in bypass mode is the single most dangerous
    // configuration this system can be put into.
    assertPermissionModeAllowed(context, parsed.data.policy?.permissionMode);

    const automation = context.scheduler.create({
      ...parsed.data,
      ...(parsed.data.policy
        ? { policy: { ...parsed.data.policy, model: parsed.data.policy.model } }
        : {}),
    });
    context.audit.record({
      actor: actor.username,
      action: 'automation.create',
      target: automation.id,
      ipAddress: requestIp(context, request),
      detail: automation.name,
    });
    return reply.status(201).send({ automation });
  });

  app.patch<{ Params: { id: string } }>('/api/automations/:id', async (request, reply) => {
    const actor = requireOperator(request);
    const parsed = AutomationInput.partial().omit({ workspaceId: true }).safeParse(request.body);
    if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? 'Invalid request.');

    assertPermissionModeAllowed(context, parsed.data.policy?.permissionMode);

    const automation = context.scheduler.update(request.params.id, parsed.data);
    if (!automation) throw new HttpError(404, 'Automation not found.');

    context.audit.record({
      actor: actor.username,
      action: 'automation.update',
      target: automation.id,
      ipAddress: requestIp(context, request),
    });
    return reply.send({ automation });
  });

  app.delete<{ Params: { id: string } }>('/api/automations/:id', async (request, reply) => {
    const actor = requireOperator(request);
    if (!context.scheduler.delete(request.params.id)) throw new HttpError(404, 'Automation not found.');

    context.audit.record({
      actor: actor.username,
      action: 'automation.delete',
      target: request.params.id,
      ipAddress: requestIp(context, request),
    });
    return reply.send({ ok: true });
  });

  app.post<{ Params: { id: string } }>('/api/automations/:id/fire', async (request, reply) => {
    const actor = requireOperator(request);
    const runId = await context.scheduler.fire(request.params.id, 'user');

    context.audit.record({
      actor: actor.username,
      action: 'automation.fire',
      target: request.params.id,
      ipAddress: requestIp(context, request),
      detail: runId,
    });
    return reply.status(202).send({ runId });
  });
  /* -------------------------- Claude's own catalogue --------------------- */

  /**
   * What this CLI offers in one workspace: models, slash commands, subagents,
   * and — the part nothing else could tell an operator — whether each
   * configured MCP server actually connected.
   *
   * Operator-level, not owner-only: it reads capability, changes nothing, and
   * it is what the composer's model picker is built from.
   *
   * `refresh=true` skips the cache. The case it exists for is an operator who
   * has just fixed an MCP server's command and wants to know whether it worked;
   * making them wait out a TTL to find out is the wrong answer.
   */
  app.get('/api/claude/catalogue', async (request, reply) => {
    requireOperator(request);
    const query = request.query as { workspaceId?: string; refresh?: string };

    // With no workspace named, ask from the data directory. The answer is then
    // what the CLI offers everywhere — models and built-in commands — without
    // any workspace's own skills or servers, which is exactly what a caller
    // that named no workspace is asking for.
    const path = query.workspaceId
      ? mustGetWorkspace(context, query.workspaceId).path
      : context.config.dataDir;

    return reply.send(
      await context.claudeCatalogue.get(path, { force: query.refresh === 'true' }),
    );
  });

  /**
   * The subscription's quota windows, from the CLI's own usage endpoint —
   * the five-hour session window, the weekly ones, the per-model buckets,
   * and the CLI's attribution of what has been consuming them. Cached like
   * the catalogue, for the same reason: each read spawns a subprocess.
   */
  app.get('/api/claude/usage', async (request, reply) => {
    requireOperator(request);
    const query = request.query as { workspaceId?: string; refresh?: string };

    const path = query.workspaceId
      ? mustGetWorkspace(context, query.workspaceId).path
      : context.config.dataDir;
    return reply.send(await context.claudeUsage.get(path, { force: query.refresh === 'true' }));
  });

  /* ------------------------ The CLI's own sessions ------------------------ */

  /**
   * Sessions the CLI holds for a workspace's directory — including ones that
   * never went through Metaclaude — and adoption, which binds one to a fresh
   * Metaclaude session so resuming and steering work as for a native one.
   *
   * The service re-lists on adopt and refuses any id the CLI did not name for
   * this directory; the route's only jobs are validation, the audit line, and
   * translating the service's errors into HTTP.
   */
  app.get('/api/claude/sessions', async (request, reply) => {
    requireOperator(request);
    const query = z.object({ workspaceId: z.string().min(1) }).safeParse(request.query);
    if (!query.success) throw new HttpError(400, 'workspaceId is required.');

    return reply.send({
      sessions: await context.claudeSessions.listForWorkspace(query.data.workspaceId),
    });
  });

  app.post('/api/claude/sessions/adopt', async (request, reply) => {
    const actor = requireOperator(request);
    const parsed = z
      .object({ workspaceId: z.string().min(1), claudeSessionId: z.string().min(1) })
      .safeParse(request.body);
    if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? 'Invalid request.');

    const session = await context.claudeSessions.adopt(
      parsed.data.workspaceId,
      parsed.data.claudeSessionId,
    );
    context.audit.record({
      actor: actor.username,
      action: 'session.adopt',
      target: session.id,
      ipAddress: requestIp(context, request),
      detail: parsed.data.claudeSessionId,
    });
    return reply.status(201).send({ session });
  });

  /* ----------------------------- Marketplaces ---------------------------- */

  /**
   * Plugin marketplaces — sources the CLI itself installs from.
   *
   * Reading the list and a catalogue changes nothing and is operator-level;
   * adding or removing a source is a trust decision about a publisher whose
   * plugins bring skills, hooks and MCP servers into the agent, so mutations
   * are owner-only — the same authority as installing a plugin by path.
   */
  app.get('/api/marketplaces', async (request, reply) => {
    requireOperator(request);
    return reply.send({ marketplaces: context.marketplaces.list() });
  });

  app.get<{ Params: { id: string } }>(
    '/api/marketplaces/:id/catalogue',
    async (request, reply) => {
      requireOperator(request);
      const query = request.query as { refresh?: string };
      return reply.send(
        await context.marketplaces.catalogue(request.params.id, {
          force: query.refresh === 'true',
        }),
      );
    },
  );

  app.post('/api/marketplaces', async (request, reply) => {
    const user = requireOwner(request);
    const input = MarketplaceInput.parse(request.body);
    const marketplace = context.marketplaces.add(input);
    context.audit.record({
      actor: user.username,
      action: 'marketplace.add',
      target: marketplace.id,
      ipAddress: requestIp(context, request),
      detail: `${marketplace.name} ← ${JSON.stringify(marketplace.source)}`,
    });
    return reply.status(201).send({ marketplace });
  });

  app.patch<{ Params: { id: string } }>('/api/marketplaces/:id', async (request, reply) => {
    const user = requireOwner(request);
    const body = z.object({ enabled: z.boolean() }).parse(request.body);
    if (!context.marketplaces.setEnabled(request.params.id, body.enabled)) {
      throw new HttpError(404, 'That marketplace does not exist.');
    }
    context.audit.record({
      actor: user.username,
      action: 'marketplace.update',
      target: request.params.id,
      ipAddress: requestIp(context, request),
      detail: body.enabled ? 'enabled' : 'disabled',
    });
    return reply.send({ marketplace: context.marketplaces.get(request.params.id) });
  });

  app.delete<{ Params: { id: string } }>('/api/marketplaces/:id', async (request, reply) => {
    const user = requireOwner(request);
    if (!context.marketplaces.remove(request.params.id)) {
      throw new HttpError(404, 'That marketplace does not exist.');
    }
    context.audit.record({
      actor: user.username,
      action: 'marketplace.remove',
      target: request.params.id,
      ipAddress: requestIp(context, request),
    });
    return reply.send({ ok: true });
  });

  /* ------------------------------- Plugins ------------------------------- */

  /**
   * Agent Plugins 1.0.0 — the vendor-neutral package format.
   *
   * Owner-only throughout. Installing a plugin adds skills the agent will
   * follow and MCP servers this server will run as subprocesses; that is the
   * same authority as editing the workspace's own configuration, and it is not
   * an operator-level action.
   */
  app.get('/api/plugins', async (request, reply) => {
    requireOwner(request);
    return reply.send(await context.plugins.list());
  });

  app.post('/api/plugins', async (request, reply) => {
    const user = requireOwner(request);
    const input = InstallPluginRequest.parse(request.body);
    const record = await context.plugins.install(input.source);
    context.audit.record({
      actor: user.username,
      action: 'plugin.install',
      target: record.name,
      outcome: 'success',
      ipAddress: requestIp(context, request),
      detail: redactUrlCredentials(input.source),
    });
    return reply.status(201).send(record);
  });

  app.patch<{ Params: { id: string } }>('/api/plugins/:id', async (request, reply) => {
    const user = requireOwner(request);
    const body = z.object({ enabled: z.boolean() }).parse(request.body);
    if (!context.plugins.setEnabled(request.params.id, body.enabled)) {
      throw new HttpError(404, 'That plugin is not installed.');
    }
    context.audit.record({
      actor: user.username,
      action: body.enabled ? 'plugin.enable' : 'plugin.disable',
      target: request.params.id,
      outcome: 'success',
      ipAddress: requestIp(context, request),
    });
    const record = context.plugins.get(request.params.id);
    return reply.send(record);
  });

  app.delete<{ Params: { id: string } }>('/api/plugins/:id', async (request, reply) => {
    const user = requireOwner(request);
    if (!(await context.plugins.remove(request.params.id))) {
      throw new HttpError(404, 'That plugin is not installed.');
    }
    context.audit.record({
      actor: user.username,
      action: 'plugin.remove',
      target: request.params.id,
      outcome: 'success',
      ipAddress: requestIp(context, request),
    });
    return reply.status(204).send();
  });

}
