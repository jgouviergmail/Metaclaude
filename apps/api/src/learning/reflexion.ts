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

import { extractJson, structuredCall } from './structured-call.js';
import type { Insight, MemoryKind, Run, TranscriptEvent } from '@metaclaude/shared';
import { newId } from '@metaclaude/shared';
import type { Db } from '../db/index.js';
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
      maxItems: 5,
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

const SYSTEM_PROMPT = `You analyse a finished AI coding session and extract knowledge worth remembering.

You will be shown: the user's request, what the assistant did, which tools it used, and how the run ended.

Extract only what will genuinely help on a FUTURE task in this same project. Be ruthless:

- A lesson must be specific and actionable. "Write good code" is worthless. "This project's tests run with \`pnpm -w test:run\`, not \`npm test\`" is valuable.
- Prefer facts you can point at in the transcript over inferences.
- If the run was routine and taught you nothing new, return an empty lessons array. That is the correct answer most of the time.
- Never invent details that are not in the transcript.
- Set confidence honestly: 0.9 for something stated explicitly, 0.5 for a reasonable inference, below 0.4 for a guess (and prefer to omit those).
- Propose a skill ONLY if the run followed a genuinely repeatable multi-step procedure. Most runs should not produce one.

Respond with JSON matching the required schema. No prose outside the JSON.`;

/* -------------------------------------------------------------------------- */
/* Engine                                                                      */
/* -------------------------------------------------------------------------- */

export interface ReflexionDeps {
  db: Db;
  memory: MemoryStore;
  /** Environment for the CLI subprocess (carries subscription auth). */
  env: Record<string, string>;
  claudeBinPath: string | null;
  /** Working directory for the reflector. A scratch dir, never a workspace. */
  cwd: string;
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
}

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
      output = await this.invoke(this.buildTranscriptSummary(run, events));
    } catch (error) {
      this.deps.log('warn', `reflexion failed for run ${run.id}`, {
        message: (error as Error).message,
      });
      return [];
    }
    if (!output) return [];

    const written: string[] = [];

    for (const lesson of output.lessons ?? []) {
      // Drop low-confidence noise before it ever enters the corpus.
      if (lesson.confidence < 0.4) continue;
      if (!lesson.title?.trim() || !lesson.content?.trim()) continue;

      const kind: MemoryKind = lesson.kind === 'semantic' ? 'semantic' : 'procedural';
      const tags = [...(lesson.tags ?? []), lesson.kind === 'failure' ? 'failure-mode' : 'lesson'];

      try {
        const { memory } = await this.deps.memory.remember({
          workspaceId: run.workspaceId,
          kind,
          title: lesson.title.trim(),
          content: lesson.content.trim(),
          tags: tags.slice(0, 8),
          // Start below what the reflector claims: a lesson earns trust by
          // being retrieved into runs that then succeed, not by asserting it.
          confidence: Math.min(0.75, lesson.confidence * 0.85),
          sourceRunId: run.id,
        });
        written.push(memory.id);
      } catch (error) {
        this.deps.log('warn', 'failed to store a reflexion lesson', {
          message: (error as Error).message,
        });
      }
    }

    if (output.summary?.trim()) {
      this.recordInsight({
        workspaceId: run.workspaceId,
        runId: run.id,
        kind: run.status === 'failed' ? 'failure' : 'lesson',
        title: output.summary.trim().slice(0, 300),
        body: (output.lessons ?? []).map((l) => `- ${l.title}: ${l.content}`).join('\n'),
        confidence: 0.7,
        payload: null,
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
  private async invoke(transcript: string): Promise<ReflexionOutput | null> {
    return structuredCall<ReflexionOutput>(
      { env: this.deps.env, claudeBinPath: this.deps.claudeBinPath, cwd: this.deps.cwd },
      {
        prompt: transcript,
        // A plain system prompt, not the claude_code preset: the reflector is
        // a classifier, not an agent, and the preset would add cost and tools.
        systemPrompt: SYSTEM_PROMPT,
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
    .map((row) => ({
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
    }));
}

export function setInsightStatus(db: Db, id: string, status: Insight['status']): boolean {
  return db.prepare('UPDATE insights SET status = ? WHERE id = ?').run(status, id).changes > 0;
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
