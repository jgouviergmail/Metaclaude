/**
 * Registry and automation routes — skills, agents, MCP servers, automations.
 */

import type { App } from '../http/types.js';
import { AutomationTrigger, EffortLevel, McpTransport, ModelSelector, PermissionMode } from '@metaclaude/shared';
import { z } from 'zod';
import { InstallPluginRequest } from '@metaclaude/shared';
import type { AppContext } from '../context.js';
import { HttpError, requestIp, requireOperator, requireOwner } from '../http/guards.js';

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
    return reply.status(parsed.data.id ? 200 : 201).send({ agent });
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
    return reply.send({ ok: true });
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
    return reply.status(parsed.data.id ? 200 : 201).send({ server });
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
    if (
      parsed.data.policy?.permissionMode === 'bypassPermissions' &&
      !context.config.allowBypassPermissions
    ) {
      throw new HttpError(403, 'Bypass mode is disabled on this deployment.');
    }

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

    if (
      parsed.data.policy?.permissionMode === 'bypassPermissions' &&
      !context.config.allowBypassPermissions
    ) {
      throw new HttpError(403, 'Bypass mode is disabled on this deployment.');
    }

    const automation = context.scheduler.update(request.params.id, parsed.data as never);
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

    const workspace = query.workspaceId ? context.workspaceRepo.get(query.workspaceId) : null;
    if (query.workspaceId && !workspace) throw new HttpError(404, 'Workspace not found.');

    // With no workspace named, ask from the data directory. The answer is then
    // what the CLI offers everywhere — models and built-in commands — without
    // any workspace's own skills or servers, which is exactly what a caller
    // that named no workspace is asking for.
    const path = workspace?.path ?? context.config.dataDir;

    return reply.send(
      await context.claudeCatalogue.get(path, { force: query.refresh === 'true' }),
    );
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
      detail: input.source,
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
