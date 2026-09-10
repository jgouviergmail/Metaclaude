/**
 * Revisions — reading and writing the texts a run is actually shaped by.
 *
 * The fourth loop's target. Memory changes what a run is *told*, the bandit
 * changes what serves it, reflexion changes what is remembered — and none of
 * the three has ever touched the instructions themselves. Those are written
 * once by an operator and then left alone, however often the runs show them to
 * be wrong: measured on production, five skills and five subagents enabled,
 * sixty-three runs, and not one invocation of any of them. Nothing in the
 * system could see that, and nothing could act on it.
 *
 * This module is the seam. It knows how to read one revisable text out of the
 * live services and how to write one back, and nothing else: no window, no
 * model, no policy. Keeping it here means the apply path and the read path
 * cannot disagree about what "the description of a skill" is, which is the
 * failure that would show up as a proposal drawn against one text and applied
 * to another.
 */

import { createHash } from 'node:crypto';
import type { RevisionField, RevisionTargetKind } from '@metaclaude/shared';
import { changedLineRatio } from '@metaclaude/shared';
import {
  AgentDefinitionRecord,
  Automation,
  REVISABLE_FIELDS,
  SkillDefinition,
  WorkspaceSettings,
} from '@metaclaude/shared';
import type { z } from 'zod';
import type { WorkspaceRepo } from '../kernel/repositories.js';
import type { Registry } from '../services/registry.js';
import type { Scheduler } from '../services/scheduler.js';

/**
 * The digest a proposal is checked against before it is applied, and again
 * before it is taken back.
 *
 * Sixteen hex characters of SHA-256, exactly like `consolidation.fingerprint`
 * — the same job, so the same shape, and deliberately not the same function:
 * that one digests a memory's title *and* body, and a one-argument caller
 * passing an empty title would read as a bug every time anyone met it.
 */
export function textFingerprint(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/**
 * Two texts that differ only in trailing whitespace are the same text.
 *
 * Applied when deciding whether a proposal changes anything at all. A model
 * asked to rewrite a prompt will hand back the prompt with a newline on the
 * end often enough to matter, and a card whose diff is one invisible character
 * is one an operator cannot act on either way.
 */
export function sameText(a: string, b: string): boolean {
  const trim = (text: string) => text.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trimEnd();
  return trim(a) === trim(b);
}

/** What a revision points at. */
export interface RevisionTarget {
  kind: RevisionTargetKind;
  id: string;
}

/** The services a revision reads from and writes to. */
export interface RevisionSurfaceDeps {
  workspaces: Pick<WorkspaceRepo, 'get' | 'update'>;
  registry: Pick<
    Registry,
    'getSkill' | 'upsertSkill' | 'getAgent' | 'upsertAgent' | 'listSkills' | 'listAgents'
  >;
  automations: Pick<Scheduler, 'get' | 'update'>;
  /** Refuses a change the system workspace must not take. Optional in tests. */
  guard?: (workspaceId: string, patch: { settings?: Record<string, unknown> }) => void;
}

export class RevisionTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RevisionTargetError';
  }
}

/** Whether this kind of target has that field at all. */
export function hasField(kind: RevisionTargetKind, field: RevisionField): boolean {
  return (REVISABLE_FIELDS[kind] as readonly string[]).includes(field);
}

/**
 * The schema that owns one revisable field, taken from the shape rather than
 * copied.
 *
 * Every one of these has a length the product enforces — 20 000 characters for
 * a workspace's instructions, 1 024 for a skill's description, 200 000 for its
 * body — and a hand-written table of those numbers would be four copies
 * waiting to drift from their originals. `WorkspaceRepo.update` reparses the
 * whole settings object on write, so a rewrite over the ceiling does not
 * silently store: it throws a `ZodError` out of the accept route as a 500,
 * about a proposal that should never have been filed. Refusing it where it is
 * made, with a sentence, is the edge doing its job.
 */
export function fieldSchema(kind: RevisionTargetKind, field: RevisionField): z.ZodType<string> | null {
  if (kind === 'workspace' && field === 'systemPromptAppend') {
    return WorkspaceSettings.shape.systemPromptAppend as unknown as z.ZodType<string>;
  }
  if (kind === 'skill') {
    if (field === 'description') return SkillDefinition.shape.description as unknown as z.ZodType<string>;
    if (field === 'body') return SkillDefinition.shape.body as unknown as z.ZodType<string>;
  }
  if (kind === 'agent') {
    if (field === 'description') return AgentDefinitionRecord.shape.description as unknown as z.ZodType<string>;
    if (field === 'prompt') return AgentDefinitionRecord.shape.prompt as unknown as z.ZodType<string>;
  }
  if (kind === 'automation' && field === 'prompt') {
    return Automation.shape.prompt as unknown as z.ZodType<string>;
  }
  return null;
}

/** Whether a rewrite is something the field it targets would actually accept. */
export function fitsField(
  kind: RevisionTargetKind,
  field: RevisionField,
  text: string,
): { ok: true } | { ok: false; reason: string } {
  const schema = fieldSchema(kind, field);
  if (!schema) return { ok: false, reason: `A ${kind} has no ${field} to revise.` };
  const parsed = schema.safeParse(text);
  if (parsed.success) return { ok: true };
  return {
    ok: false,
    reason: `That rewrite is not something a ${kind}'s ${field} accepts: ${
      parsed.error.issues[0]?.message ?? 'it was refused by the schema'
    }.`,
  };
}

/**
 * How much of a text may stop being shared before the edit is a rewrite.
 *
 * Two fifths, measured against the longer side so that adding two sentences to
 * a two-sentence prompt is not scored as a replacement. The number is a
 * judgement rather than a measurement and it is deliberately generous: what it
 * exists to stop is the answer that replaces an operator's instructions
 * wholesale with the model's own idea of good ones, which is a different thing
 * from an edit and reads, on the card, as a wall of green.
 */
export const MAX_CHANGED_RATIO = 0.4;

/**
 * Below this many lines, a text may be replaced outright.
 *
 * Applied to a one-line skill description the ratio rule stops the *opposite*
 * of what it is for: the single most useful edit this pass can make is turning
 * "Reviews migrations." into "Use when reviewing a database migration before
 * it ships", and that is a hundred per cent of the text by any measure.
 *
 * Six lines, because that is roughly where a diff stops fitting on a card at a
 * glance. Below it the operator reads the whole of both sides and nothing is
 * hidden by the size of the change; above it, "most of this was replaced" is a
 * fact they would have to work to notice.
 */
export const RATIO_APPLIES_ABOVE_LINES = 6;

/**
 * Whether a rewrite is so wholesale that it is no longer an edit.
 *
 * It lives here, beside the read and the write, rather than in the review pass
 * that first needed it — because the pass is only one of two doors.
 * `advisor_propose_revision` is the other, it is mounted into ordinary runs,
 * and it was told this rule in prose and held to it by nothing. A wholesale
 * replacement filed through it produced a card whose diff is a wall of green
 * the operator cannot read, which is precisely the outcome the rule exists to
 * prevent.
 */
export function isRewrite(before: string, after: string): boolean {
  const lines = before ? before.split('\n').length : 0;
  if (lines <= RATIO_APPLIES_ABOVE_LINES) return false;
  return changedLineRatio(before, after) > MAX_CHANGED_RATIO;
}

/**
 * Whether this workspace may rewrite that target.
 *
 * A boundary, not a tidiness rule. `advisor_propose_revision` takes a target
 * id straight from a model's arguments and the reads below resolve records by
 * id alone, so without this a run in one workspace could name a skill — or the
 * standing instructions — of another, file the card under itself, and rewrite
 * them the moment an operator accepted. Revisions are the one proposal kind
 * that takes effect on accept, which is what makes this the boundary that
 * matters most in the feature.
 *
 * The question is asked of the **same listing a run of that workspace is
 * given**, and that choice was measured rather than assumed. Reach lives in
 * `is_global` and a join table; `skills.workspace_id` is only who created the
 * row, and an operator may widen a skill's reach later without it being
 * rewritten. A rule comparing that column would therefore refuse a skill the
 * operator had deliberately shared — while a membership test cannot drift from
 * what the workspace actually runs under, because it *is* that query.
 */
export function mayRevise(
  deps: RevisionSurfaceDeps,
  workspaceId: string,
  target: RevisionTarget,
): boolean {
  switch (target.kind) {
    case 'workspace':
      return target.id === workspaceId;
    case 'skill':
      return deps.registry.listSkills(workspaceId).some((skill) => skill.id === target.id);
    case 'agent':
      return deps.registry.listAgents(workspaceId).some((agent) => agent.id === target.id);
    case 'automation':
      // An automation belongs to exactly one workspace and is reachable from
      // no other, so the row answers on its own.
      return deps.automations.get(target.id)?.workspaceId === workspaceId;
  }
}

/**
 * One revisable text, as it stands right now, and who owns it.
 *
 * Also answers the question "does this target still exist", which is why it
 * returns null rather than throwing: a proposal whose target was deleted is a
 * proposal to refuse, not an error to propagate.
 *
 * `global` is returned rather than taken from the caller for the reason the
 * *name* already was: what the card says about a target has to come from the
 * target. It is what draws the warning that a rewrite reaches every workspace
 * rather than this one, and a caller-supplied answer to that is a claim. It is
 * read from `isGlobal` and not from `workspaceId`, because the latter records
 * who created the row while the former is the reach an operator can widen.
 */
export function readRevisable(
  deps: RevisionSurfaceDeps,
  target: RevisionTarget,
  field: RevisionField,
): { text: string; name: string; global: boolean } | null {
  if (!hasField(target.kind, field)) return null;

  switch (target.kind) {
    case 'workspace': {
      const workspace = deps.workspaces.get(target.id);
      if (!workspace) return null;
      // A workspace's own instructions reach that workspace and no other, by
      // definition — there is nothing here that could be global.
      return {
        text: workspace.settings.systemPromptAppend,
        name: workspace.name,
        global: false,
      };
    }
    case 'skill': {
      const skill = deps.registry.getSkill(target.id);
      if (!skill) return null;
      return {
        text: field === 'body' ? skill.body : skill.description,
        name: skill.name,
        global: skill.isGlobal,
      };
    }
    case 'agent': {
      const agent = deps.registry.getAgent(target.id);
      if (!agent) return null;
      return {
        text: field === 'prompt' ? agent.prompt : agent.description,
        name: agent.name,
        global: agent.isGlobal,
      };
    }
    case 'automation': {
      const automation = deps.automations.get(target.id);
      if (!automation) return null;
      return { text: automation.prompt, name: automation.name, global: false };
    }
  }
}

/**
 * Write one revisable text back, and nothing else.
 *
 * Every branch reads the current record first and rewrites exactly one field
 * of it. That is not ceremony: `upsertSkill` and `upsertAgent` take a whole
 * record, so a caller that assembled one from the proposal alone would silently
 * reset the category, the enabled flag and — worst — the reach, none of which
 * appears on the card. The `.partial()` trap, from the other direction.
 *
 * A workspace goes through the same guard the settings route uses, so the
 * system workspace's fixed settings are refused here exactly as they are
 * there. Nothing about being a machine's proposal lowers that bar.
 */
export function writeRevisable(
  deps: RevisionSurfaceDeps,
  target: RevisionTarget,
  field: RevisionField,
  text: string,
): void {
  if (!hasField(target.kind, field)) {
    throw new RevisionTargetError(`A ${target.kind} has no ${field} to revise.`);
  }

  switch (target.kind) {
    case 'workspace': {
      if (!deps.workspaces.get(target.id)) throw new RevisionTargetError('That workspace no longer exists.');
      const patch = { settings: { systemPromptAppend: text } };
      deps.guard?.(target.id, patch);
      // A partial settings patch: `WorkspaceRepo.update` merges it over the
      // stored object, so naming one key changes one key.
      if (!deps.workspaces.update(target.id, patch)) {
        throw new RevisionTargetError('That workspace no longer exists.');
      }
      return;
    }
    case 'skill': {
      const skill = deps.registry.getSkill(target.id);
      if (!skill) throw new RevisionTargetError('That skill no longer exists.');
      deps.registry.upsertSkill({
        id: skill.id,
        workspaceId: skill.workspaceId,
        name: skill.name,
        description: field === 'description' ? text : skill.description,
        body: field === 'body' ? text : skill.body,
        category: skill.category,
        enabled: skill.enabled,
      });
      return;
    }
    case 'agent': {
      const agent = deps.registry.getAgent(target.id);
      if (!agent) throw new RevisionTargetError('That subagent no longer exists.');
      deps.registry.upsertAgent({
        id: agent.id,
        workspaceId: agent.workspaceId,
        name: agent.name,
        description: field === 'description' ? text : agent.description,
        prompt: field === 'prompt' ? text : agent.prompt,
        category: agent.category,
        tools: agent.tools,
        model: agent.model === null ? null : String(agent.model),
        enabled: agent.enabled,
      });
      return;
    }
    case 'automation': {
      if (!deps.automations.get(target.id)) throw new RevisionTargetError('That automation no longer exists.');
      // Named fields only, so the schedule, the description and the failure
      // ceiling stay exactly as they were — `Scheduler.update` takes a patch.
      if (!deps.automations.update(target.id, { prompt: text })) {
        throw new RevisionTargetError('That automation no longer exists.');
      }
      return;
    }
  }
}
