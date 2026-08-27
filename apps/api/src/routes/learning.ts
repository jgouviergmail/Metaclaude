/**
 * Learning routes — memory, insights, policy and the classifier.
 *
 * The whole point of exposing these is inspectability. A self-modifying system
 * the operator cannot read, edit or reset is not trustworthy, so every learned
 * artefact here is listable, editable and resettable.
 */

import type { App } from '../http/types.js';
import { CreateMemoryRequest, MemoryKind } from '@metaclaude/shared';
import type { RunGenesis } from '@metaclaude/shared';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { HttpError, mustGetWorkspace, requestIp, requireOperator } from '../http/guards.js';
import { spreadInt } from '../http/query.js';
import { listInsights, setInsightStatus } from '../learning/reflexion.js';

export function registerLearningRoutes(app: App, context: AppContext): void {
  /* -------------------------------- Memory ------------------------------ */

  app.get<{
    Querystring: {
      workspaceId?: string;
      kind?: string;
      search?: string;
      limit?: string;
      offset?: string;
      scope?: string;
    };
  }>('/api/memory', async (request, reply) => {
    const { workspaceId, kind, search, limit, offset, scope } = request.query;

    // `scope=global` means "only unscoped memories"; a workspace id means "that
    // workspace plus globals"; neither means "everything".
    const workspaceFilter =
      scope === 'global' ? null : workspaceId ? workspaceId : undefined;

    const parsedKind = kind ? MemoryKind.safeParse(kind) : null;

    const memories = context.memory.list({
      ...(workspaceFilter !== undefined ? { workspaceId: workspaceFilter } : {}),
      ...(parsedKind?.success ? { kind: parsedKind.data } : {}),
      ...(search ? { search } : {}),
      ...spreadInt('limit', limit, { min: 1, max: 500 }),
      ...spreadInt('offset', offset, { min: 0, max: 1_000_000 }),
    });

    return reply.send({
      memories,
      stats: context.memory.stats(workspaceFilter),
      total: context.memory.count(workspaceFilter),
    });
  });

  app.get<{ Querystring: { q?: string; workspaceId?: string; limit?: string } }>(
    '/api/memory/search',
    async (request, reply) => {
      if (!request.query.q?.trim()) return reply.send({ results: [] });

      const results = await context.memory.search(request.query.q, {
        ...(request.query.workspaceId ? { workspaceId: request.query.workspaceId } : {}),
        ...spreadInt('limit', request.query.limit, { min: 1, max: 100 }),
      });
      return reply.send({ results });
    },
  );

  app.post('/api/memory', async (request, reply) => {
    const actor = requireOperator(request);
    const parsed = CreateMemoryRequest.safeParse(request.body);
    if (!parsed.success) {
      throw new HttpError(400, parsed.error.issues[0]?.message ?? 'Invalid request.');
    }

    const { memory, merged } = await context.memory.remember(parsed.data);
    context.audit.record({
      actor: actor.username,
      action: merged ? 'memory.merge' : 'memory.create',
      target: memory.id,
      ipAddress: requestIp(context, request),
    });
    return reply.status(merged ? 200 : 201).send({ memory, merged });
  });

  const UpdateMemory = z.object({
    title: z.string().min(1).max(300).optional(),
    content: z.string().min(1).max(20_000).optional(),
    tags: z.array(z.string().max(48)).max(24).optional(),
    confidence: z.number().min(0).max(1).optional(),
    pinned: z.boolean().optional(),
    kind: MemoryKind.optional(),
  });

  app.patch<{ Params: { id: string } }>('/api/memory/:id', async (request, reply) => {
    requireOperator(request);
    const parsed = UpdateMemory.safeParse(request.body);
    if (!parsed.success) throw new HttpError(400, 'Invalid request.');

    const memory = await context.memory.update(request.params.id, parsed.data);
    if (!memory) throw new HttpError(404, 'Memory not found.');
    return reply.send({ memory });
  });

  app.delete<{ Params: { id: string } }>('/api/memory/:id', async (request, reply) => {
    const actor = requireOperator(request);
    if (!context.memory.delete(request.params.id)) throw new HttpError(404, 'Memory not found.');

    context.audit.record({
      actor: actor.username,
      action: 'memory.delete',
      target: request.params.id,
      ipAddress: requestIp(context, request),
    });
    return reply.send({ ok: true });
  });

  /**
   * Manual maintenance. These run on a schedule anyway; exposing them lets the
   * operator see the effect immediately rather than waiting a day.
   */
  app.post('/api/memory/maintenance', async (request, reply) => {
    requireOperator(request);
    const parsed = z
      .object({ action: z.enum(['decay', 'collect', 'reindex']) })
      .safeParse(request.body);
    if (!parsed.success) throw new HttpError(400, 'Unknown maintenance action.');

    switch (parsed.data.action) {
      case 'decay':
        return reply.send({ affected: context.memory.decay() });
      case 'collect':
        return reply.send({ affected: context.memory.collect() });
      case 'reindex':
        return reply.send({ affected: await context.memory.reindex() });
    }
  });

  /* ------------------------------- Insights ----------------------------- */

  app.get<{ Querystring: { workspaceId?: string; status?: string; limit?: string } }>(
    '/api/insights',
    async (request, reply) => {
      const status = request.query.status;
      return reply.send({
        insights: listInsights(context.db, {
          ...(request.query.workspaceId ? { workspaceId: request.query.workspaceId } : {}),
          ...(status && ['new', 'accepted', 'rejected', 'applied'].includes(status)
            ? { status: status as 'new' | 'accepted' | 'rejected' | 'applied' }
            : {}),
          ...spreadInt('limit', request.query.limit, { min: 1, max: 200 }),
        }),
      });
    },
  );

  app.post<{ Params: { id: string } }>('/api/insights/:id/status', async (request, reply) => {
    const actor = requireOperator(request);
    const parsed = z
      .object({ status: z.enum(['new', 'accepted', 'rejected', 'applied']) })
      .safeParse(request.body);
    if (!parsed.success) throw new HttpError(400, 'Invalid status.');

    if (!setInsightStatus(context.db, request.params.id, parsed.data.status)) {
      throw new HttpError(404, 'Insight not found.');
    }
    context.audit.record({
      actor: actor.username,
      action: `insight.${parsed.data.status}`,
      target: request.params.id,
      ipAddress: requestIp(context, request),
    });
    return reply.send({ ok: true });
  });

  /**
   * Accept a proposed skill.
   *
   * The generated skill is only installed by this explicit action — the
   * reflexion pass never writes to the registry itself.
   */
  app.post<{ Params: { id: string } }>('/api/insights/:id/install-skill', async (request, reply) => {
    const actor = requireOperator(request);

    const insight = listInsights(context.db, { limit: 500 }).find((i) => i.id === request.params.id);
    if (!insight) throw new HttpError(404, 'Insight not found.');
    if (insight.kind !== 'skill_proposal' || !insight.payload) {
      throw new HttpError(400, 'That insight does not carry a skill proposal.');
    }

    let proposal: { name: string; description: string; body: string };
    try {
      proposal = JSON.parse(insight.payload);
    } catch {
      throw new HttpError(422, 'The stored skill proposal is malformed.');
    }

    const skill = context.registry.upsertSkill({
      workspaceId: insight.workspaceId,
      name: proposal.name,
      description: proposal.description,
      body: proposal.body,
      autoGenerated: true,
    });
    setInsightStatus(context.db, insight.id, 'applied');

    context.audit.record({
      actor: actor.username,
      action: 'skill.install_from_insight',
      target: skill.id,
      ipAddress: requestIp(context, request),
      detail: skill.name,
    });
    return reply.status(201).send({ skill });
  });

  /**
   * Distil a workspace's accumulated procedures into a proposed skill.
   *
   * The output is a `skill_proposal` insight — the same object the per-run
   * reflexion produces — so it lands in the same review queue and installs
   * through the same explicit action above. Costs one cheap model call, so
   * it is a button, never a background loop. 204 when the model judged the
   * procedures do not cohere: a legitimate answer, not an error.
   */
  app.post<{ Params: { id: string } }>(
    '/api/workspaces/:id/synthesise-skill',
    async (request, reply) => {
      const actor = requireOperator(request);
      mustGetWorkspace(context, request.params.id);

      const insight = await context.synthesizer.synthesise(request.params.id);
      context.audit.record({
        actor: actor.username,
        action: 'skill.synthesise',
        target: request.params.id,
        ipAddress: requestIp(context, request),
        detail: insight ? insight.title : 'declined: the procedures do not cohere',
      });

      if (!insight) return reply.status(204).send();
      return reply.status(201).send({ insight });
    },
  );

  /* -------------------------------- Policy ------------------------------ */

  app.get<{ Querystring: { workspaceId?: string; category?: string } }>(
    '/api/policy',
    async (request, reply) => {
      const workspaceId = request.query.workspaceId ?? null;
      const categories = context.policy.categories(workspaceId);

      return reply.send({
        categories,
        arms: context.policy.list(workspaceId, request.query.category),
        explanations: Object.fromEntries(
          categories.map(({ category }) => [category, context.policy.explain(workspaceId, category)]),
        ),
        classifierDistribution: context.classifier.distribution(workspaceId),
      });
    },
  );

  app.post('/api/policy/reset', async (request, reply) => {
    const actor = requireOperator(request);
    const parsed = z
      .object({
        workspaceId: z.string().nullable().default(null),
        category: z.string().optional(),
        includeClassifier: z.boolean().default(false),
      })
      .safeParse(request.body);
    if (!parsed.success) throw new HttpError(400, 'Invalid request.');

    const arms = context.policy.reset(parsed.data.workspaceId, parsed.data.category);
    const exemplars = parsed.data.includeClassifier
      ? context.classifier.reset(parsed.data.workspaceId)
      : 0;

    context.audit.record({
      actor: actor.username,
      action: 'policy.reset',
      target: parsed.data.workspaceId ?? 'global',
      ipAddress: requestIp(context, request),
      detail: `${arms} arms, ${exemplars} exemplars`,
    });
    return reply.send({ arms, exemplars });
  });

  /**
   * Why one run was shaped the way it was: the classifier's verdict, the
   * exact policy arm it stood on (when one matches), and the memories that
   * were actually injected. Immutable once the run has started, which is why
   * the client may cache it forever — except that recall is recorded just
   * before execution, so a run still queued answers with an empty list that
   * fills in moments later.
   */
  app.get<{ Params: { id: string } }>('/api/runs/:id/genesis', async (request, reply) => {
    const run = context.runRepo.get(request.params.id);
    if (!run) throw new HttpError(404, 'Run not found.');

    const arms = run.category ? context.policy.list(run.workspaceId, run.category) : [];
    const arm =
      arms.find(
        (candidate) =>
          String(candidate.model) === String(run.policy.model) &&
          candidate.effort === run.policy.effort,
      ) ?? null;

    const genesis: RunGenesis = {
      category: run.category,
      source: run.policy.source,
      memories: context.memory.recalledFor(run.id),
      arm,
      explanation: run.category ? context.policy.explain(run.workspaceId, run.category) : '',
    };
    return reply.send(genesis);
  });

  /**
   * Explain what the learner would choose for a prompt, without running it.
   * This is the "why did it pick Opus?" answer, available before committing.
   */
  app.post('/api/policy/preview', async (request, reply) => {
    const parsed = z
      .object({ prompt: z.string().min(1).max(100_000), workspaceId: z.string().nullable().default(null) })
      .safeParse(request.body);
    if (!parsed.success) throw new HttpError(400, 'A prompt is required.');

    const classification = await context.classifier.classify(
      parsed.data.prompt,
      parsed.data.workspaceId,
    );
    const selection = context.policy.select(parsed.data.workspaceId, classification.category);
    const retrieved = await context.memory.search(parsed.data.prompt, {
      ...(parsed.data.workspaceId ? { workspaceId: parsed.data.workspaceId } : {}),
      limit: 5,
    });

    return reply.send({
      classification,
      selection,
      explanation: context.policy.explain(parsed.data.workspaceId, classification.category),
      memories: retrieved.map((r) => ({
        id: r.memory.id,
        title: r.memory.title,
        kind: r.memory.kind,
        score: r.score,
        confidence: r.memory.confidence,
      })),
    });
  });
}
