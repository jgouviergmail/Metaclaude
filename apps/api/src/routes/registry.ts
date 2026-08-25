/**
 * Registry and automation routes — skills, agents, MCP servers, automations.
 */

import type { App } from '../http/types.js';
import { AutomationTrigger, EffortLevel, McpTransport, ModelSelector, PermissionMode } from '@metaclaude/shared';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { HttpError, requestIp, requireOperator } from '../http/guards.js';

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
    headers: z.record(z.string().max(128), z.string().max(2048)).default({}),
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
}
