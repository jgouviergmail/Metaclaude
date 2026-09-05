/**
 * Skill synthesis — the workspace distilling what it has learned.
 *
 * Reflexion proposes skills one run at a time; this reads *across* runs: the
 * workspace's accumulated procedural memories, handed to a cheap tool-less
 * model call that either distils them into one coherent skill or says they
 * do not cohere. Refusal is a first-class answer — most piles of procedures
 * are not a skill, and inventing one anyway would be noise with authority.
 *
 * The output is a `skill_proposal` insight, the same object the per-run path
 * produces, so it lands in the same review queue and installs through the
 * same explicit operator action. Synthesis never touches the registry.
 */

import type { Insight, Memory } from '@metaclaude/shared';
import { newId } from '@metaclaude/shared';
import type { Db } from '../db/index.js';

export class SynthesisError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
    this.name = 'SynthesisError';
  }
}

/** What the model answers. `worthIt: false` means "these do not cohere". */
export interface SynthesisOutput {
  worthIt: boolean;
  name?: string;
  description?: string;
  body?: string;
}

const MIN_PROCEDURES = 3;
const MAX_PROCEDURES = 12;

export const SYNTHESIS_SYSTEM_PROMPT = `You distil procedures an agent has learned in one project into a reusable skill.

You are given procedural memories — each a titled, step-like lesson learned from real runs. Decide whether a coherent, genuinely reusable skill exists across them.

- If they cohere: produce ONE skill. The body is markdown the agent will follow: concrete steps, project-specific commands and paths kept verbatim, no filler.
- If they are unrelated fragments, or would only restate generic knowledge: answer worthIt=false. Refusing is the common, correct case.

Respond with JSON matching the required schema. No prose outside the JSON.`;

export const SYNTHESIS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['worthIt'],
  properties: {
    worthIt: { type: 'boolean' },
    name: { type: 'string', maxLength: 64 },
    description: { type: 'string', maxLength: 1024 },
    body: { type: 'string', maxLength: 20_000 },
  },
} as const;

export interface SynthesisDeps {
  db: Db;
  memory: {
    list(options: { workspaceId?: string | null; kind?: Memory['kind']; limit?: number }): Memory[];
  };
  /**
   * The tool-less structured call. Injected; tests never spawn the CLI.
   *
   * Takes the workspace so the caller can resolve which language the drafted
   * skill should be written in — a skill is prose an operator reads, and one
   * distilled in English from a French project is one they will not use.
   */
  call: (prompt: string, workspaceId: string) => Promise<SynthesisOutput | null>;
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
  now?: () => number;
}

export class SkillSynthesizer {
  constructor(private readonly deps: SynthesisDeps) {}

  /**
   * Distil one workspace's procedures. Returns the proposal insight, or null
   * when the model judged (legitimately) that nothing coheres.
   */
  async synthesise(workspaceId: string): Promise<Insight | null> {
    const procedures = this.deps.memory
      .list({ workspaceId, kind: 'procedural', limit: 100 })
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, MAX_PROCEDURES);

    if (procedures.length < MIN_PROCEDURES) {
      throw new SynthesisError(
        `Only ${procedures.length} procedural memor${procedures.length === 1 ? 'y' : 'ies'} so far — ` +
          `synthesis needs at least ${MIN_PROCEDURES} to have anything to distil.`,
        409,
      );
    }

    const prompt = [
      `# ${procedures.length} procedures learned in this workspace`,
      '',
      ...procedures.map(
        (procedure) =>
          `## ${procedure.title} (confidence ${procedure.confidence.toFixed(2)})\n${procedure.content.slice(0, 1200)}`,
      ),
    ].join('\n');

    const output = await this.deps.call(prompt, workspaceId);
    if (!output) {
      throw new SynthesisError('The synthesis pass produced no answer — try again later.', 502);
    }
    if (!output.worthIt || !output.name?.trim() || !output.body?.trim()) {
      this.deps.log('info', 'skill synthesis declined: the procedures do not cohere', {
        workspaceId,
      });
      return null;
    }

    const id = newId('insight');
    const now = this.deps.now ? this.deps.now() : Date.now();
    this.deps.db
      .prepare(
        `INSERT INTO insights (id, workspace_id, run_id, kind, title, body, confidence, payload, created_at)
         VALUES (?, ?, NULL, 'skill_proposal', ?, ?, 0.6, ?, ?)`,
      )
      .run(
        id,
        workspaceId,
        `Proposed skill: ${output.name.trim()}`.slice(0, 300),
        (output.description ?? '').slice(0, 20_000),
        JSON.stringify({
          name: output.name.trim(),
          description: output.description?.trim() ?? '',
          body: output.body,
        }),
        now,
      );

    const row = this.deps.db
      .prepare<[string], Record<string, unknown>>('SELECT * FROM insights WHERE id = ?')
      .get(id);
    return row
      ? ({
          id: row.id,
          workspaceId: row.workspace_id,
          runId: row.run_id,
          kind: row.kind,
          title: row.title,
          body: row.body,
          confidence: row.confidence,
          status: row.status,
          payload: row.payload,
          createdAt: row.created_at,
        } as Insight)
      : null;
  }
}
