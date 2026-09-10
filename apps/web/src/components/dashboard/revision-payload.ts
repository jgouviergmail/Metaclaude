/**
 * Reading a revision proposal's payload, apart from the card that draws it.
 *
 * The card is loaded on demand — it carries the diff renderer — but the list
 * that decides *whether* to draw one has to look at every proposal on every
 * dashboard. A guard living in the card would drag the card back into the
 * entry chunk and undo the split; a guard here is a few lines that cost
 * nothing.
 */

import type { AdvisorProposal, RevisionPayload } from '@metaclaude/shared';

/** What each target is called on the card, and the set of kinds it can draw. */
export const TARGET_LABELS: Record<RevisionPayload['target']['kind'], string> = {
  workspace: 'workspace instructions',
  skill: 'skill',
  agent: 'subagent',
  automation: 'automation',
};

export const FIELD_LABELS: Record<RevisionPayload['field'], string> = {
  systemPromptAppend: 'instructions',
  description: 'description',
  body: 'body',
  prompt: 'prompt',
};

/** Whether a lookup table carries this key itself, prototype excluded. */
function owns(table: Record<string, string>, key: unknown): boolean {
  return typeof key === 'string' && Object.prototype.hasOwnProperty.call(table, key);
}

/**
 * The payload, or null when the row is not one the card can draw.
 *
 * A hand-rolled guard rather than the Zod schema, and the reason is measured:
 * `RevisionPayload` lives in `api-contracts.ts`, and importing a *value* from
 * there pulls that whole module — every API-only schema in it — into the entry
 * chunk. It cost 5 kB gzipped on every page load the first time this was
 * written with `safeParse`.
 *
 * Nothing is lost. The proposal's own `kind` already says what this is; the
 * server validated the payload when it was written and validates it again
 * before applying it; and what this checks is exactly what the card
 * dereferences, which is what a guard is for.
 */
export function readRevision(
  proposal: Pick<AdvisorProposal, 'kind' | 'payload'>,
): RevisionPayload | null {
  if (proposal.kind !== 'revision') return null;
  const payload = proposal.payload as Partial<RevisionPayload> | null;
  if (!payload || typeof payload !== 'object') return null;
  const { target, field, diff, rationale, evidence } = payload;
  // `hasOwn`, never `in`: `in` walks the prototype chain, so `constructor` and
  // `toString` answer true for any object — and the label the card would then
  // render is a *function*, which React throws on. These tables are lookups,
  // so the question is whether they carry the key themselves.
  if (!target || typeof target.name !== 'string' || !owns(TARGET_LABELS, target.kind)) return null;
  if (typeof field !== 'string' || !owns(FIELD_LABELS, field)) return null;
  if (typeof diff !== 'string' || typeof rationale !== 'string') return null;
  if (!Array.isArray(evidence)) return null;
  return payload as RevisionPayload;
}
