/**
 * Reflexion — turning finished runs into durable knowledge.
 *
 * After a run completes, a small, tool-less Claude call reads what happened and
 * extracts structured lessons: durable facts about the project, procedures that
 * worked, and failure modes to avoid. Those become memories, which are retrieved
 * into future runs. This is the loop that makes the OS improve with use rather
 * than merely accumulate history.
 *
 * Design constraints that matter:
 *  - The reflector has **no tools and no filesystem access**. It reads a
 *    transcript summary and returns JSON. It cannot act on the workspace.
 *  - It runs on the cheapest capable model and is strictly bounded, so
 *    reflection never becomes a meaningful share of the operator's usage.
 *  - It runs out-of-band. A failure here is logged and dropped; it must never
 *    affect the run the operator is watching.
 */

import { withLanguage, type ContentLanguage } from './language.js';
import { extractJson, structuredCall } from './structured-call.js';
import type { Insight, ReflexionInsightPayload, Run, TranscriptEvent } from '@metaclaude/shared';
import { newId } from '@metaclaude/shared';
import type { Db } from '../db/index.js';
import type { GateCandidate, GateDecision, Gatekeeper } from './gatekeeper.js';
import type { MemoryStore } from './memory.js';

/* -------------------------------------------------------------------------- */
/* Schema                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * What we ask the reflector to produce. Kept deliberately small: a schema with
 * twenty optional fields yields twenty fields of noise.
 */
const REFLEXION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['lessons', 'summary'],
  properties: {
    summary: {
      type: 'string',
      description: 'One sentence describing what the run accomplished or failed to accomplish.',
    },
    lessons: {
      type: 'array',
      // Three, down from five: measured on a day of production, five slots
      // were filled with the state of the code five times over. The gate
      // keeps two of these at most, three on a failed run.
      maxItems: 3,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'title', 'content', 'confidence'],
        properties: {
          kind: {
            type: 'string',
            enum: ['semantic', 'procedural', 'failure'],
            description:
              'semantic = a durable fact about this project or the user; procedural = a repeatable way of doing something here; failure = a mistake to avoid next time.',
          },
          title: { type: 'string', maxLength: 200 },
          content: { type: 'string', maxLength: 2000 },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          tags: { type: 'array', maxItems: 6, items: { type: 'string', maxLength: 40 } },
        },
      },
    },
    skillProposal: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'description', 'body'],
      description:
        'Only when this run followed a multi-step procedure worth codifying and repeating verbatim.',
      properties: {
        name: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{2,48}$' },
        description: { type: 'string', maxLength: 300 },
        body: { type: 'string', maxLength: 8000 },
      },
    },
  },
} as const;

interface ReflexionOutput {
  summary: string;
  lessons: Array<{
    kind: 'semantic' | 'procedural' | 'failure';
    title: string;
    content: string;
    confidence: number;
    tags?: string[];
  }>;
  skillProposal?: { name: string; description: string; body: string };
}

// `withLanguage` moved to language.ts when the memory gate arrived; re-exported so callers and tests are undisturbed.
export { withLanguage } from './language.js';

const SYSTEM_PROMPT = `You analyse a finished AI coding session and extract knowledge worth remembering.

You will be shown: the user's request, what the assistant did, which tools it used, and how the run ended.

Extract only what will genuinely help on a FUTURE task in this same project and will still be true in three months. Be ruthless:

- A lesson must be specific and actionable. "Write good code" is worthless. "This project's tests run with \`pnpm -w test:run\`, not \`npm test\`" is valuable.
- Prefer facts you can point at in the transcript over inferences.
- If the run was routine and taught you nothing new, return an empty lessons array. That is the correct answer most of the time.
- Never invent details that are not in the transcript.
- Set confidence honestly: 0.9 for something stated explicitly, 0.5 for a reasonable inference, below 0.4 for a guess (and prefer to omit those).
- Propose a skill ONLY if the run followed a genuinely repeatable multi-step procedure. Most runs should not produce one.

Never record as a lesson:
- the state of the code, the interface, the data or a setting at this moment — what is or is not implemented, a bug that exists today, a count, a version, what a tool showed. It changes with the next release and can be re-read live;
- anything the assistant can read in its standing instructions, the documentation or the source code of what it works on;
- what happened in this one session — an action taken, a mistake made once, the premise of one card — unless a rule generalises from it;
- a restatement of the user's request or of the assistant's answer.

What does belong: a preference or convention the user stated, a non-obvious way of doing something here that worked, a fact about the project that no document carries.

Respond with JSON matching the required schema. No prose outside the JSON.`;

/* -------------------------------------------------------------------------- */
/* Engine                                                                      */
/* -------------------------------------------------------------------------- */

export interface ReflexionDeps {
  db: Db;
  memory: MemoryStore;
  /**
   * The language the lessons should be written in, for this workspace.
   *
   * A getter, and per workspace, because both halves are live: the deployment
   * setting is hot, and each workspace may override it. Without it this pass
   * wrote in whatever language the transcript happened to be in — which is why
   * a French deployment's twenty-two memories were all in English.
   */
  language: (workspaceId: string) => ContentLanguage | null;
  /** Environment for the CLI subprocess (carries subscription auth). */
  env: Record<string, string>;
  claudeBinPath: string | null;
  /** Working directory for the reflector. A scratch dir, never a workspace. */
  cwd: string;
  /**
   * The gate every lesson passes before it is stored — see `gatekeeper.ts`.
   * Required: the reflector proposes, the gate decides, and there is no path
   * from a model's proposal to a row that skips it.
   */
  gate: Pick<Gatekeeper, 'admit'>;
  /**
   * A run that only read — the steward listing, getting, searching — teaches
   * nothing a later run cannot re-read, and its reflexion was the source of
   * most of the state notes measured. Decided by the caller, who knows which
   * tools read; absent, every run reflects.
   */
  readOnlyRun?: (run: Run, events: TranscriptEvent[]) => boolean;
  /** The model call, injectable so `reflect()` can be tested without a CLI. */
  invoke?: (transcript: string, language: ContentLanguage | null) => Promise<ReflexionOutput | null>;
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
}

/** What one candidate became, as the run's insight records it and the Memory page reads it. */
export type ReflexionDecision = ReflexionInsightPayload['decisions'][number];

export class ReflexionEngine {
  constructor(private readonly deps: ReflexionDeps) {}

  /**
   * Reflect on a run and persist what it learned.
   *
   * Returns the memories it wrote, by id — not merely how many. The
   * consolidation pass runs on exactly this set: the only place a fresh
   * duplicate can have appeared is around what was just learned, so seeding it
   * with these ids keeps that pass bounded by the run rather than by the
   * corpus. An id here may name a memory that already existed, when `remember`
   * folded the lesson into a near-identical one; that is the right seed too.
   *
   * Never throws.
   */
  async reflect(run: Run, events: TranscriptEvent[]): Promise<string[]> {
    if (!this.isWorthReflecting(run, events)) return [];

    let output: ReflexionOutput | null = null;
    try {
      output = await (this.deps.invoke ?? this.invoke.bind(this))(
        this.buildTranscriptSummary(run, events),
        this.deps.language(run.workspaceId),
      );
    } catch (error) {
      this.deps.log('warn', `reflexion failed for run ${run.id}`, {
        message: (error as Error).message,
      });
      return [];
    }
    if (!output) return [];

    // The reflector proposes; the gate decides. Low-confidence noise is
    // dropped before it costs a verdict, and the kind the reflector guessed is
    // carried as a tag when it is `failure`, because that is a property of the
    // lesson rather than a storage kind.
    const candidates: GateCandidate[] = [];
    for (const lesson of output.lessons ?? []) {
      if (lesson.confidence < 0.4) continue;
      if (!lesson.title?.trim() || !lesson.content?.trim()) continue;
      candidates.push({
        kind: lesson.kind === 'semantic' ? 'semantic' : 'procedural',
        title: lesson.title.trim(),
        content: lesson.content.trim(),
        confidence: lesson.confidence,
        tags: [...(lesson.tags ?? []), lesson.kind === 'failure' ? 'failure-mode' : 'lesson'].slice(0, 8),
      });
    }

    let decisions: GateDecision[] = [];
    try {
      decisions = await this.deps.gate.admit({
        workspaceId: run.workspaceId,
        runId: run.id,
        failed: run.status === 'failed',
        candidates,
      });
    } catch (error) {
      this.deps.log('warn', 'the memory gate failed; nothing was stored for this run', {
        runId: run.id,
        message: (error as Error).message,
      });
    }
    const written = decisions.filter((d) => d.memoryId).map((d) => d.memoryId as string);

    // An insight only when there is something to show: a memory kept, or a
    // failure whose lessons — kept or not — an operator will want to read.
    // One row per reflected run was the other half of the flood, and a row
    // that says "nothing learned" is not an insight.
    if (output.summary?.trim() && (written.length > 0 || run.status === 'failed')) {
      const payload: ReflexionInsightPayload = {
        kind: 'reflexion',
        decisions: decisions.map((d) => ({
          title: d.candidate.title,
          content: d.candidate.content,
          kind: d.candidate.kind,
          tags: d.candidate.tags,
          level: d.level,
          outcome: d.outcome,
          reason: d.reason,
          memoryId: d.memoryId ?? null,
          shelf: d.shelf ?? null,
        })),
      };
      this.recordInsight({
        workspaceId: run.workspaceId,
        runId: run.id,
        kind: run.status === 'failed' ? 'failure' : 'lesson',
        title: output.summary.trim().slice(0, 300),
        body: payload.decisions
          .map((d) => `- [${d.outcome}${d.shelf ? ` · ${d.shelf}` : ''} · ${d.level}] ${d.title}: ${d.content}`)
          .join('\n'),
        confidence: 0.7,
        payload: JSON.stringify(payload),
      });
    }

    // A proposed skill is never installed automatically — it goes to the
    // operator's review queue. Auto-installing generated instructions into
    // every future run is exactly the kind of unreviewed drift we refuse.
    if (output.skillProposal?.name && output.skillProposal.body) {
      this.recordInsight({
        workspaceId: run.workspaceId,
        runId: run.id,
        kind: 'skill_proposal',
        title: `Proposed skill: ${output.skillProposal.name}`,
        body: output.skillProposal.description,
        confidence: 0.6,
        payload: JSON.stringify(output.skillProposal),
      });
    }

    return written;
  }

  /**
   * Skip reflection when there is demonstrably nothing to learn.
   * Reflecting on "hi" costs money and pollutes the corpus.
   */
  private isWorthReflecting(run: Run, events: TranscriptEvent[]): boolean {
    if (run.status === 'interrupted') return false;
    if (run.prompt.trim().length < 24) return false;
    if (run.status !== 'failed' && this.deps.readOnlyRun?.(run, events)) return false;

    const toolCalls = events.filter((e) => e.kind === 'tool_call').length;
    const assistantChars = events
      .filter((e): e is Extract<TranscriptEvent, { kind: 'assistant_text' }> => e.kind === 'assistant_text')
      .reduce((sum, e) => sum + e.text.length, 0);

    // Either real work happened, or it failed — both are informative.
    return run.status === 'failed' || toolCalls >= 2 || assistantChars >= 600;
  }

  /**
   * Compress a transcript into a bounded prompt.
   *
   * Tool results are the bulk of a transcript and the least informative part per
   * byte, so they are aggressively summarised while the shape of the work — the
   * sequence of tools, the errors, the final answer — is preserved.
   */
  buildTranscriptSummary(run: Run, events: TranscriptEvent[]): string {
    const lines: string[] = [];

    lines.push('## User request');
    lines.push(run.prompt.slice(0, 4000));
    lines.push('');
    lines.push('## What the assistant did');

    const toolCounts = new Map<string, number>();
    const errors: string[] = [];
    const commands: string[] = [];
    const filesTouched = new Set<string>();

    for (const event of events) {
      if (event.kind === 'tool_call') {
        toolCounts.set(event.name, (toolCounts.get(event.name) ?? 0) + 1);

        const input = event.input as Record<string, unknown> | null;
        const path = typeof input?.file_path === 'string' ? input.file_path : null;
        if (path) filesTouched.add(path);

        if (event.name === 'Bash' && typeof input?.command === 'string') {
          commands.push(`- ran: \`${input.command.slice(0, 200)}\``);
        }
        if (event.resultIsError && event.result) {
          errors.push(`${event.name}: ${event.result.slice(0, 400)}`);
        }
      }
    }

    // Bounded like every other section. A run with hundreds of shell calls
    // would otherwise build an 80 KB prompt, and the entire point of this pass
    // is that reflection stays cheap enough to run after every single run.
    const MAX_COMMANDS = 20;
    lines.push(...commands.slice(0, MAX_COMMANDS));
    if (commands.length > MAX_COMMANDS) {
      lines.push(`- … and ${commands.length - MAX_COMMANDS} further commands`);
    }

    if (toolCounts.size > 0) {
      lines.push('');
      lines.push('Tools used: ' + [...toolCounts].map(([n, c]) => `${n}×${c}`).join(', '));
    }
    if (filesTouched.size > 0) {
      lines.push('Files touched: ' + [...filesTouched].slice(0, 25).join(', '));
    }
    if (errors.length > 0) {
      lines.push('');
      lines.push('## Errors encountered');
      lines.push(errors.slice(0, 8).join('\n'));
    }

    const finalText = [...events]
      .reverse()
      .find((e): e is Extract<TranscriptEvent, { kind: 'assistant_text' }> => e.kind === 'assistant_text');
    if (finalText) {
      lines.push('');
      lines.push("## Assistant's final answer");
      lines.push(finalText.text.slice(0, 4000));
    }

    lines.push('');
    lines.push('## Outcome');
    lines.push(`status: ${run.status}${run.error ? ` — ${run.error.slice(0, 500)}` : ''}`);
    lines.push(
      `duration: ${Math.round(run.usage.durationMs / 1000)}s, turns: ${run.usage.turns}, cost: $${run.usage.costUsd.toFixed(4)}`,
    );

    return lines.join('\n');
  }

  /** Run the tool-less structured call. Mechanics shared with skill synthesis. */
  private async invoke(
    transcript: string,
    language: ContentLanguage | null,
  ): Promise<ReflexionOutput | null> {
    return structuredCall<ReflexionOutput>(
      { env: this.deps.env, claudeBinPath: this.deps.claudeBinPath, cwd: this.deps.cwd },
      {
        prompt: transcript,
        // A plain system prompt, not the claude_code preset: the reflector is
        // a classifier, not an agent, and the preset would add cost and tools.
        systemPrompt: withLanguage(SYSTEM_PROMPT, language),
        schema: REFLEXION_SCHEMA as unknown as Record<string, unknown>,
        accept: (parsed) => Array.isArray((parsed as ReflexionOutput).lessons),
      },
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Insights                                                                */
  /* ---------------------------------------------------------------------- */

  recordInsight(input: {
    workspaceId: string | null;
    runId: string | null;
    kind: Insight['kind'];
    title: string;
    body: string;
    confidence: number;
    payload: string | null;
  }): void {
    this.deps.db
      .prepare(
        `INSERT INTO insights (id, workspace_id, run_id, kind, title, body, confidence, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newId('insight'),
        input.workspaceId,
        input.runId,
        input.kind,
        input.title.slice(0, 300),
        input.body.slice(0, 20_000),
        input.confidence,
        input.payload,
        Date.now(),
      );
  }
}

/* -------------------------------------------------------------------------- */
/* Insight queries                                                             */
/* -------------------------------------------------------------------------- */

interface InsightRow {
  id: string;
  workspace_id: string | null;
  run_id: string | null;
  kind: string;
  title: string;
  body: string;
  confidence: number;
  status: string;
  payload: string | null;
  created_at: number;
}

export function listInsights(
  db: Db,
  options: { workspaceId?: string | null; status?: Insight['status']; limit?: number } = {},
): Insight[] {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (options.workspaceId !== undefined) {
    clauses.push('workspace_id IS ?');
    params.push(options.workspaceId);
  }
  if (options.status) {
    clauses.push('status = ?');
    params.push(options.status);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

  return db
    .prepare<unknown[], InsightRow>(
      `SELECT * FROM insights ${where} ORDER BY created_at DESC LIMIT ?`,
    )
    .all(...params, Math.min(options.limit ?? 50, 500))
    .map(toInsight);
}

/**
 * One insight by id. The routes that act on an insight used to find it in
 * the newest five hundred, which answers 404 for a real row once the table
 * outgrows that — and the gate's decisions make it grow one row per kept run.
 */
export function getInsight(db: Db, id: string): Insight | null {
  const row = db.prepare<[string], InsightRow>('SELECT * FROM insights WHERE id = ?').get(id);
  return row ? toInsight(row) : null;
}

function toInsight(row: InsightRow): Insight {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    runId: row.run_id,
    kind: row.kind as Insight['kind'],
    title: row.title,
    body: row.body,
    confidence: row.confidence,
    status: row.status as Insight['status'],
    payload: row.payload,
    createdAt: row.created_at,
  };
}

export function setInsightStatus(db: Db, id: string, status: Insight['status']): boolean {
  return db.prepare('UPDATE insights SET status = ? WHERE id = ?').run(status, id).changes > 0;
}

/** Rewrite an insight's payload — how a refused note records that the operator kept it after all. */
export function setInsightPayload(db: Db, id: string, payload: string): boolean {
  return db.prepare('UPDATE insights SET payload = ? WHERE id = ?').run(payload, id).changes > 0;
}

/**
 * Drop triaged insights older than `retentionDays`.
 *
 * Nothing else deletes from this table. `setInsightStatus` only writes the
 * status column, and the run foreign key is `ON DELETE SET NULL`, so deleting a
 * session cascades its runs and leaves the insights behind with a null
 * `run_id`: only dropping the whole workspace reclaimed them. The footprint is
 * modest on a single-operator system, but "grows forever" is not a retention
 * policy, and every other table in the janitor's sweep has one.
 *
 * Only the terminal statuses. `new` and `accepted` are the operator's review
 * queue, and silently emptying a queue is worse than letting it grow.
 */
export function pruneInsights(db: Db, retentionDays: number, now: number = Date.now()): number {
  const cutoff = now - retentionDays * 86_400_000;
  return db
    .prepare("DELETE FROM insights WHERE status IN ('rejected','applied') AND created_at < ?")
    .run(cutoff).changes;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Best-effort JSON recovery from a model response that may be wrapped in prose
 * or a fenced code block.
 */
export function parseJsonLoose(text: string): ReflexionOutput | null {
  return extractJson<ReflexionOutput>(text, (parsed) =>
    Array.isArray((parsed as ReflexionOutput).lessons),
  );
}
