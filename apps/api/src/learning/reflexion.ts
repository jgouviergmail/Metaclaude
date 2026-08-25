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

import { query } from '@anthropic-ai/claude-agent-sdk';
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
   * Returns the number of memories written. Never throws.
   */
  async reflect(run: Run, events: TranscriptEvent[]): Promise<number> {
    if (!this.isWorthReflecting(run, events)) return 0;

    let output: ReflexionOutput | null = null;
    try {
      output = await this.invoke(this.buildTranscriptSummary(run, events));
    } catch (error) {
      this.deps.log('warn', `reflexion failed for run ${run.id}`, {
        message: (error as Error).message,
      });
      return 0;
    }
    if (!output) return 0;

    let written = 0;

    for (const lesson of output.lessons ?? []) {
      // Drop low-confidence noise before it ever enters the corpus.
      if (lesson.confidence < 0.4) continue;
      if (!lesson.title?.trim() || !lesson.content?.trim()) continue;

      const kind: MemoryKind = lesson.kind === 'semantic' ? 'semantic' : 'procedural';
      const tags = [...(lesson.tags ?? []), lesson.kind === 'failure' ? 'failure-mode' : 'lesson'];

      try {
        await this.deps.memory.remember({
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
        written += 1;
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
    let filesTouched = new Set<string>();

    for (const event of events) {
      if (event.kind === 'tool_call') {
        toolCounts.set(event.name, (toolCounts.get(event.name) ?? 0) + 1);

        const input = event.input as Record<string, unknown> | null;
        const path = typeof input?.file_path === 'string' ? input.file_path : null;
        if (path) filesTouched.add(path);

        if (event.name === 'Bash' && typeof input?.command === 'string') {
          lines.push(`- ran: \`${input.command.slice(0, 200)}\``);
        }
        if (event.resultIsError && event.result) {
          errors.push(`${event.name}: ${event.result.slice(0, 400)}`);
        }
      }
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

  /** Run the tool-less structured call. */
  private async invoke(transcript: string): Promise<ReflexionOutput | null> {
    const controller = new AbortController();
    // Reflection is a background nicety; it must never run long.
    const timer = setTimeout(() => controller.abort(), 120_000);
    timer.unref?.();

    try {
      let structured: unknown = null;
      let text = '';

      for await (const message of query({
        prompt: transcript,
        options: {
          cwd: this.deps.cwd,
          // A plain system prompt, not the claude_code preset: the reflector is
          // a classifier, not an agent, and the preset would add cost and tools.
          systemPrompt: SYSTEM_PROMPT,
          model: 'haiku',
          maxTurns: 1,
          // Belt and braces: no tools offered, and none permitted.
          allowedTools: [],
          disallowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task'],
          permissionMode: 'dontAsk',
          settingSources: [],
          thinking: { type: 'disabled' },
          outputFormat: {
            type: 'json_schema',
            schema: REFLEXION_SCHEMA as unknown as Record<string, unknown>,
          },
          abortController: controller,
          env: this.deps.env,
          ...(this.deps.claudeBinPath ? { pathToClaudeCodeExecutable: this.deps.claudeBinPath } : {}),
        },
      })) {
        if (message.type === 'result') {
          structured = (message as { structured_output?: unknown }).structured_output ?? null;
          const result = (message as { result?: string }).result;
          if (typeof result === 'string') text = result;
        }
      }

      if (structured && typeof structured === 'object') return structured as ReflexionOutput;
      // Some CLI versions omit `structured_output`; recover from the text body.
      return parseJsonLoose(text);
    } finally {
      clearTimeout(timer);
    }
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

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Best-effort JSON recovery from a model response that may be wrapped in prose
 * or a fenced code block.
 */
export function parseJsonLoose(text: string): ReflexionOutput | null {
  if (!text?.trim()) return null;

  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidates = [fenced?.[1], text].filter((c): c is string => Boolean(c));

  for (const candidate of candidates) {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start < 0 || end <= start) continue;
    try {
      const parsed = JSON.parse(candidate.slice(start, end + 1)) as ReflexionOutput;
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.lessons)) return parsed;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}
