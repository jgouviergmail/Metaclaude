/**
 * Learning routes — memory, insights, policy and the classifier.
 *
 * The whole point of exposing these is inspectability. A self-modifying system
 * the operator cannot read, edit or reset is not trustworthy, so every learned
 * artefact here is listable, editable and resettable.
 */

import type { App } from '../http/types.js';
import {
  ApplyConsolidationRequest,
  ConsolidationProposal,
  CreateMemoryRequest,
  SaveKnowledgeRequest,
  MemoryKind,
  MemoryShelf,
  ReflexionInsightPayload,
} from '@metaclaude/shared';
import type { RunGenesis } from '@metaclaude/shared';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { HttpError, mustGetWorkspace, requestIp, requireOperator } from '../http/guards.js';
import { spreadInt } from '../http/query.js';
import { fingerprint } from '../learning/consolidation.js';
import { MemoryReconcileError } from '../learning/memory.js';
import { reindexStale } from '../learning/reindex.js';
import { shelfForKeep } from '../learning/gatekeeper.js';
import { getInsight, listInsights, setInsightPayload, setInsightStatus } from '../learning/reflexion.js';

/**
 * Where each memory was learned, as somewhere an operator can actually go.
 *
 * `source_run_id` has been stored since the table existed and shown nowhere,
 * because a run id alone is not a destination: runs are read inside their
 * session, and the memory row knows nothing about sessions. One indexed
 * lookup per page turns a dead identifier into a link.
 *
 * Returned beside the memories rather than folded into them: `Memory` is a
 * shared schema that the web bundle carries at runtime, and this is a join
 * result rather than a property of the memory. A run that has since been
 * pruned by retention simply has no entry, and the card shows no link.
 */
function sourcesOf(
  context: AppContext,
  memories: readonly { sourceRunId: string | null }[],
): Record<string, { sessionId: string; workspaceId: string }> {
  const ids = [...new Set(memories.map((memory) => memory.sourceRunId).filter(Boolean))];
  if (ids.length === 0) return {};

  // One statement, three columns. `RunRepo.get` reads the whole row and parses
  // its usage JSON, which is two hundred needless parses on a full page for
  // two fields — and a page is the common case, not the extreme one.
  const rows = context.db
    .prepare<string[], { id: string; session_id: string; workspace_id: string }>(
      `SELECT id, session_id, workspace_id FROM runs WHERE id IN (${ids.map(() => '?').join(',')})`,
    )
    .all(...(ids as string[]));

  const sources: Record<string, { sessionId: string; workspaceId: string }> = {};
  for (const row of rows) {
    sources[row.id] = { sessionId: row.session_id, workspaceId: row.workspace_id };
  }
  return sources;
}

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
      includeRetired?: string;
    };
  }>('/api/memory', async (request, reply) => {
    const { workspaceId, kind, search, limit, offset, scope, includeRetired } = request.query;

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
      ...(includeRetired === '1' || includeRetired === 'true' ? { includeRetired: true } : {}),
    });

    return reply.send({
      memories,
      stats: context.memory.stats(workspaceFilter),
      total: context.memory.count(workspaceFilter),
      sources: sourcesOf(context, memories),
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
    shelf: MemoryShelf.optional(),
    /** `true` retires (a soft delete, restorable for thirty days), `false` restores. */
    retired: z.boolean().optional(),
  });

  app.patch<{ Params: { id: string } }>('/api/memory/:id', async (request, reply) => {
    const actor = requireOperator(request);
    const parsed = UpdateMemory.safeParse(request.body);
    if (!parsed.success) throw new HttpError(400, 'Invalid request.');
    const { retired, ...patch } = parsed.data;

    let memory = await context.memory.update(request.params.id, patch);
    if (!memory) throw new HttpError(404, 'Memory not found.');
    if (retired !== undefined && retired !== (memory.retiredAt !== null)) {
      try {
        memory = (retired ? context.memory.retire(memory.id) : context.memory.restore(memory.id)) ?? memory;
      } catch (error) {
        if (error instanceof MemoryReconcileError) throw new HttpError(error.statusCode, error.message);
        throw error;
      }
      context.audit.record({
        actor: actor.username,
        action: retired ? 'memory.retire' : 'memory.restore',
        target: memory.id,
        ipAddress: requestIp(context, request),
      });
    }
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
   * Move a memory between tiers.
   *
   * Not part of `PATCH /api/memory/:id`, and deliberately so. Every other
   * field there is the memory's own content; this one decides which runs, in
   * which projects, will be shaped by it — promoting one memory changes what
   * every workspace recalls. It gets its own verb, its own audit line, and its
   * own confirmation in the interface.
   */
  app.post<{ Params: { id: string }; Body: unknown }>(
    '/api/memory/:id/scope',
    async (request, reply) => {
      const actor = requireOperator(request);
      const parsed = z
        .object({ workspaceId: z.string().nullable() })
        .safeParse(request.body);
      if (!parsed.success) throw new HttpError(400, 'Invalid request.');

      try {
        const result =
          parsed.data.workspaceId === null
            ? await context.memory.promote(request.params.id)
            : await context.memory.confine(request.params.id, parsed.data.workspaceId);

        if (result.moved) {
          context.audit.record({
            actor: actor.username,
            action: parsed.data.workspaceId === null ? 'memory.promote' : 'memory.confine',
            target: result.memory.id,
            ipAddress: requestIp(context, request),
            detail: result.memory.title,
          });
        }
        return reply.send({ memory: result.memory, moved: result.moved });
      } catch (error) {
        if (error instanceof MemoryReconcileError) {
          throw new HttpError(error.statusCode, error.message);
        }
        throw error;
      }
    },
  );

  /**
   * Manual maintenance. These run on a schedule anyway; exposing them lets the
   * operator see the effect immediately rather than waiting a day.
   */
  app.post('/api/memory/maintenance', async (request, reply) => {
    const actor = requireOperator(request);
    const parsed = z
      .object({ action: z.enum(['decay', 'collect', 'reindex', 'consolidate']) })
      .safeParse(request.body);
    if (!parsed.success) throw new HttpError(400, 'Unknown maintenance action.');

    switch (parsed.data.action) {
      case 'decay':
        return reply.send({ affected: context.memory.decay() });
      case 'collect':
        return reply.send({ affected: context.memory.collect() });
      case 'reindex': {
        // Every store the model serves, not memories alone: a change of
        // embedder leaves documents and the classifier's exemplars just as
        // stale, and the button used to rebuild a third of what it claimed.
        const done = await reindexStale({
          db: context.db,
          memory: context.memory,
          knowledge: context.knowledge,
          classifier: context.classifier,
          embedder: context.embedder,
          log: (level, message, data) => context.log[level](data ?? {}, message),
        });
        return reply.send({ affected: done.memories + done.documents + done.exemplars, reindex: done });
      }
      case 'consolidate': {
        // The only one that spends anything, and the only one that answers
        // with more than a count: what it found is a queue of questions, not
        // a change. `affected` stays the shape every other action returns so
        // one client method covers all four.
        const result = await context.consolidator.sweep();
        context.audit.record({
          actor: actor.username,
          action: 'memory.consolidate',
          ipAddress: requestIp(context, request),
          detail: `${result.groups} group(s) examined, ${result.proposed} proposed`,
        });
        return reply.send({ affected: result.proposed, consolidation: result });
      }
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
   * Keep a note the memory gate refused.
   *
   * The gate is a model and it is wrong sometimes; what makes that safe is
   * that every verdict rides the run's insight and the operator can overturn
   * one here in a gesture. The memory is written the way the gate would have
   * written it — the level's shelf, the run as its source — and the payload
   * records the id so the button cannot be pressed twice.
   */
  app.post<{ Params: { id: string } }>('/api/insights/:id/keep', async (request, reply) => {
    const actor = requireOperator(request);
    const parsed = z.object({ index: z.number().int().min(0) }).safeParse(request.body);
    if (!parsed.success) throw new HttpError(400, 'Name the note to keep by its index.');

    const insight = getInsight(context.db, request.params.id);
    if (!insight) throw new HttpError(404, 'Insight not found.');
    const payload = insight.payload ? ReflexionInsightPayload.safeParse(JSON.parse(insight.payload)) : null;
    if (!payload?.success) throw new HttpError(400, 'That insight carries no gate decisions.');
    const decision = payload.data.decisions[parsed.data.index];
    if (!decision) throw new HttpError(400, 'No such note on that insight.');
    if (decision.memoryId) throw new HttpError(409, 'That note is already a memory.');

    const { memory } = await context.memory.remember({
      workspaceId: insight.workspaceId,
      kind: decision.kind,
      title: decision.title,
      content: decision.content,
      tags: decision.tags,
      shelf: shelfForKeep(decision.level),
      // The run as its source, for provenance — which also makes it count as
      // a machine write against the gate's daily budget. Deliberate: an
      // operator keeping six refused notes in one day is six verdicts
      // overturned, and a gate that then keeps nothing more until tomorrow
      // errs on the side this whole path exists to hold.
      sourceRunId: insight.runId,
    });
    decision.memoryId = memory.id;
    decision.outcome = 'kept';
    decision.shelf = memory.shelf;
    setInsightPayload(context.db, insight.id, JSON.stringify(payload.data));
    context.audit.record({
      actor: actor.username,
      action: 'memory.create',
      target: memory.id,
      detail: `kept from insight ${insight.id}, against the gate's "${decision.level}"`,
      ipAddress: requestIp(context, request),
    });
    return reply.status(201).send({ memory });
  });

  /**
   * Apply a consolidation the operator has read and agreed with.
   *
   * Everything here is a re-check of something the pass already decided,
   * because the pass decided it against a corpus that has since been live:
   * runs reinforce memories, the operator edits them, the janitor collects
   * them. A plan drawn up ten minutes ago can describe a memory that no longer
   * says what it said, and folding on that basis would delete an edit nobody
   * ever saw. So the fingerprints are compared, and any drift is a 409 the
   * operator can act on rather than a silent best effort.
   */
  app.post<{ Params: { id: string } }>('/api/insights/:id/consolidate', async (request, reply) => {
    const actor = requireOperator(request);
    const body = ApplyConsolidationRequest.safeParse(request.body ?? {});
    if (!body.success) throw new HttpError(400, 'Invalid request.');

    const insight = getInsight(context.db, request.params.id);
    if (!insight) throw new HttpError(404, 'Insight not found.');
    if (insight.kind !== 'consolidation' || !insight.payload) {
      throw new HttpError(400, 'That insight does not carry a consolidation proposal.');
    }
    if (insight.status === 'applied') {
      throw new HttpError(409, 'That consolidation has already been applied.');
    }

    let proposal: ConsolidationProposal;
    try {
      proposal = ConsolidationProposal.parse(JSON.parse(insight.payload));
    } catch {
      throw new HttpError(422, 'The stored consolidation proposal is malformed.');
    }
    if (proposal.verdict !== 'duplicate' || !proposal.merged) {
      // A contradiction has no merged text by construction: what to keep is a
      // judgement the operator makes by editing or deleting, not a button.
      throw new HttpError(409, 'That proposal has nothing to merge — decide between them yourself.');
    }

    for (const member of proposal.members) {
      const current = context.memory.get(member.id);
      if (!current) {
        throw new HttpError(409, `“${member.title}” no longer exists — dismiss this and run consolidation again.`);
      }
      if (fingerprint(current.title, current.content) !== member.fingerprint) {
        throw new HttpError(409, `“${current.title}” changed since this was proposed — dismiss it and run consolidation again.`);
      }
    }

    if (body.data.promote && !proposal.promotable) {
      throw new HttpError(409, 'This proposal was not judged to hold beyond its workspace.');
    }

    const losers = proposal.members.map((member) => member.id).filter((id) => id !== proposal.winnerId);
    let result;
    try {
      result = await context.memory.reconcile({
        winnerId: proposal.winnerId,
        loserIds: losers,
        title: proposal.merged.title,
        content: proposal.merged.content,
        tags: proposal.merged.tags,
        ...(body.data.promote ? { scope: null } : {}),
      });
    } catch (error) {
      if (error instanceof MemoryReconcileError) {
        throw new HttpError(error.statusCode, error.message);
      }
      throw error;
    }

    setInsightStatus(context.db, insight.id, 'applied');
    context.audit.record({
      actor: actor.username,
      action: 'memory.merge',
      target: result.memory.id,
      ipAddress: requestIp(context, request),
      detail: `absorbed ${result.absorbed.length}${result.moved ? ', promoted to global' : ''}`,
    });
    return reply.send({ memory: result.memory, absorbed: result.absorbed, moved: result.moved });
  });

  app.post<{ Params: { id: string } }>('/api/insights/:id/install-skill', async (request, reply) => {
    const actor = requireOperator(request);

    const insight = getInsight(context.db, request.params.id);
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
  /* ------------------------------ Knowledge ------------------------------ */

  // The knowledge library: reference documents, chunked and embedded on write,
  // retrieved into runs. Same authorisation bar as memories — an operator can
  // shape what the agent reads — and the same audit habit.
  app.get('/api/knowledge', async (request, reply) => {
    const query = request.query as { workspaceId?: string; scope?: string };
    const options =
      query.scope === 'global'
        ? { workspaceId: null }
        : query.workspaceId
          ? { workspaceId: query.workspaceId }
          : {};
    return reply.send({ documents: context.knowledge.list(options) });
  });

  app.get<{ Params: { id: string } }>('/api/knowledge/:id', async (request, reply) => {
    const document = context.knowledge.get(request.params.id);
    if (!document) throw new HttpError(404, 'Document not found.');
    return reply.send({ document });
  });

  app.post('/api/knowledge', async (request, reply) => {
    const actor = requireOperator(request);
    const parsed = SaveKnowledgeRequest.safeParse(request.body);
    if (!parsed.success) {
      throw new HttpError(400, parsed.error.issues[0]?.message ?? 'Invalid request.');
    }

    const document = await context.knowledge.upsert(parsed.data);
    context.audit.record({
      actor: actor.username,
      action: parsed.data.id ? 'knowledge.update' : 'knowledge.create',
      target: document.id,
      ipAddress: requestIp(context, request),
      detail: document.title,
    });
    return reply.status(parsed.data.id ? 200 : 201).send({ document });
  });

  /**
   * Re-embed every chunk written by a different provider.
   *
   * The twin of memory maintenance's `reindex`, and needed for the same
   * reason: vectors from two providers are not comparable, so after a switch
   * the dense arm silently stops contributing until this has run. Until then
   * the lexical arm still answers, which is why the degradation is quiet
   * enough to need a button rather than a crash.
   */
  app.post('/api/knowledge/reindex', async (request, reply) => {
    const actor = requireOperator(request);
    const affected = await context.knowledge.reindex();
    context.audit.record({
      actor: actor.username,
      action: 'knowledge.reindex',
      target: null,
      ipAddress: requestIp(context, request),
      detail: `${affected} passages`,
    });
    return reply.send({ affected });
  });

  app.delete<{ Params: { id: string } }>('/api/knowledge/:id', async (request, reply) => {
    const actor = requireOperator(request);
    if (!context.knowledge.delete(request.params.id)) {
      throw new HttpError(404, 'Document not found.');
    }
    context.audit.record({
      actor: actor.username,
      action: 'knowledge.delete',
      target: request.params.id,
      ipAddress: requestIp(context, request),
    });
    return reply.send({ ok: true });
  });

  // The preview search the UI offers: "what would a run see for this query?"
  // Reuses the exact retrieval path a run takes, options included, so what
  // the preview shows is what a run would get — not a lookalike.
  app.get<{ Querystring: { q: string; workspaceId?: string } }>(
    '/api/knowledge/search',
    async (request, reply) => {
      if (!request.query.q?.trim()) throw new HttpError(400, 'q is required.');
      const results = await context.knowledge.search(request.query.q, {
        workspaceId: request.query.workspaceId ?? null,
      });
      return reply.send({ results });
    },
  );

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
      documents: context.knowledge.consultedFor(run.id),
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
