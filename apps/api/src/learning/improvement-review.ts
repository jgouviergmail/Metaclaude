/**
 * The pass, and the rules that stand between a model's answer and an
 * instruction in force.
 *
 * Everything here is written on the assumption that the arbiter will sometimes
 * be wrong in exactly the ways a model is wrong: it will cite a run that was
 * not in the window, rest a rewrite on a finding it named once, rewrite a
 * whole prompt when asked for an edit, and propose the text it was already
 * shown. The memory gate measured all four families and concluded that a
 * prompt cannot be trusted to enforce its own rules — four had to sit *after*
 * the model there. These are the same four, for the same reason.
 *
 * Nothing here applies anything. The end of this pass is a row in the
 * operator's inbox with a diff on it.
 */

import type { RevisionFinding, RevisionReview, Workspace } from '@metaclaude/shared';
import { newId, REVISABLE_FIELDS, RevisionPayload, changedLineRatio } from '@metaclaude/shared';
import { isRewrite, MAX_CHANGED_RATIO, RATIO_APPLIES_ABOVE_LINES } from './revision.js';
import type { Db } from '../db/index.js';
import type { AdvisorService } from '../services/advisor.js';
import type { Registry } from '../services/registry.js';
import type { Scheduler } from '../services/scheduler.js';
import type { ContentLanguage } from './language.js';
import { STRUCTURED_DEFAULT_MODEL } from './structured-call.js';
import {
  buildWindow,
  observe,
  recordReview,
  reviewCursor,
  reviewDue,
  OBSERVATION_MIN_RUNS,
  type EvidenceWindow,
  TARGETS_MAX_CHARS,
} from './improvement.js';
import {
  revisable,
  type ArbiterCall,
  type ArbiterRevision,
  type ArbiterTarget,
} from './improvement-arbiter.js';
import { sameText } from './revision.js';

// Moved to `revision.ts` when the service began enforcing the same rule, and
// to `improvement.ts` when the budget became a setting — re-exported so every
// reader that knew them here still finds them.
export { MAX_CHANGED_RATIO, RATIO_APPLIES_ABOVE_LINES };
export { TARGETS_MAX_CHARS };

/** Revisions one pass may file. The advisor's own rule: three that matter. */
export const PROPOSALS_PER_REVIEW = 3;

export interface ImprovementDeps {
  db: Db;
  workspaces: { get(id: string): Workspace | null; list(includeArchived: boolean): Workspace[] };
  registry: Pick<Registry, 'listSkills' | 'listAgents'>;
  automations: Pick<Scheduler, 'list'>;
  advisor: Pick<AdvisorService, 'proposeRevision' | 'refusedFindings' | 'list' | 'recordFollowUp'>;
  arbiter: ArbiterCall;
  language: (workspaceId: string) => ContentLanguage | null;
  /**
   * How spent the subscription's window is, 0..1, or null when unknowable.
   *
   * The board autopilot's guard, reused with its reasoning intact: a
   * background pass must not be the thing that spends the last of a window an
   * operator is about to want. Null fails *open* — under an API key there is
   * no window to be near the end of.
   */
  quota?: (workspace: Workspace) => Promise<number | null>;
  /**
   * What the instruction texts may cost this pass, in characters.
   *
   * A getter, because it is a runtime setting an operator changes from the
   * Configuration screen and this object is built once at boot. Absent, the
   * shipped `TARGETS_MAX_CHARS` stands.
   */
  targetChars?: () => number;
  /**
   * Tell the operator when a background pass proposed something.
   *
   * Not optional in spirit, however optional the type: a pass that files three
   * revisions nobody hears about is the morning brief nobody hears about, read
   * ten hours late. The button's own caller notifies from the route, because it
   * knows the outcome the operator is waiting for; the sweep has nobody
   * waiting, which is exactly why it has to speak.
   *
   * Only when something was proposed. A weekly "nothing to change" is a
   * notification an operator turns off within a month, and with it the one that
   * mattered.
   */
  notify?: (input: { workspace: Workspace; proposed: number }) => void;
  /**
   * Which model judged this window, read at the moment of the review.
   *
   * A getter, not a value: the same setting the arbiter's own policy reads is
   * hot, so a captured name would record `haiku` on a window an operator had
   * just moved to `fable` — a column that is worse than absent, because it
   * reads as an answer.
   */
  model?: () => string;
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
  now?: () => number;
}

/** Above this share of the plan's window, a background pass waits. */
export const QUOTA_CEILING = 0.85;

/** What one pass did, for the caller that asked for it. */
export interface ReviewResult {
  status: 'reviewed' | 'skipped' | 'failed';
  reason?: string;
  runsExamined: number;
  proposed: number;
  reviewId: string | null;
}

/* -------------------------------------------------------------------------- */
/* Targets                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The texts this pass may reason about, and which of them it may rewrite.
 *
 * Descriptions are always shown whole: they are short, and they are the field
 * most often at fault — the CLI reads a skill's description when deciding
 * whether to open it, so a skill offered constantly and never opened is
 * usually a description written as a summary. Bodies and prompts are shown
 * whole when they fit and *in part* when they do not, and a text shown in part
 * is refused as a revision target: the arbiter's answer becomes the surviving
 * text, so judging it on a prefix would fold the tail away.
 */
/**
 * The instruction texts to put to the arbiter, and how many did not fit.
 *
 * The budget is spent greedily in list order, skipping what will not fit
 * rather than stopping at it: a skill's description and its body are separate
 * targets, so a single enormous body would otherwise take every description
 * after it down with it — and a description is the text this pass most often
 * has something useful to say about.
 *
 * The workspace's own instructions are never the thing dropped to make room.
 * They reach every run of the workspace and are paid for on every one, which
 * is what makes them the most valuable text here.
 *
 * `omitted` is not bookkeeping: the prompt says how many texts exist that it
 * is not showing, for the same reason a text shown in part is still listed —
 * so the arbiter knows they are there and does not propose creating one that
 * already exists.
 */
export function collectTargetsWithBudget(
  deps: Pick<ImprovementDeps, 'registry' | 'automations'>,
  workspace: Workspace,
  budget: number = TARGETS_MAX_CHARS,
): { targets: ArbiterTarget[]; omitted: number } {
  const all = collectEveryTarget(deps, workspace);
  const targets: ArbiterTarget[] = [];
  let spent = 0;
  let omitted = 0;

  for (const [index, target] of all.entries()) {
    // Index 0 is the workspace's own instructions, kept whatever it costs.
    if (index > 0 && spent + target.text.length > budget) {
      omitted += 1;
      continue;
    }
    spent += target.text.length;
    targets.push(target);
  }

  return { targets, omitted };
}

/** The bounded list, for the callers that do not need the count. */
export function collectTargets(
  deps: Pick<ImprovementDeps, 'registry' | 'automations'>,
  workspace: Workspace,
): ArbiterTarget[] {
  return collectTargetsWithBudget(deps, workspace).targets;
}

function collectEveryTarget(
  deps: Pick<ImprovementDeps, 'registry' | 'automations'>,
  workspace: Workspace,
): ArbiterTarget[] {
  const targets: ArbiterTarget[] = [];

  targets.push({
    kind: 'workspace',
    id: workspace.id,
    name: workspace.name,
    field: 'systemPromptAppend',
    text: workspace.settings.systemPromptAppend,
    whole: revisable(workspace.settings.systemPromptAppend),
    note: 'Reaches every run of this workspace, and is paid for on every one.',
  });

  for (const skill of deps.registry.listSkills(workspace.id)) {
    if (!skill.enabled) continue;
    targets.push({
      kind: 'skill',
      id: skill.id,
      name: skill.name,
      field: 'description',
      text: skill.description,
      whole: revisable(skill.description),
      note: 'What the assistant reads when deciding whether to open this skill.',
    });
    targets.push({
      kind: 'skill',
      id: skill.id,
      name: skill.name,
      field: 'body',
      text: revisable(skill.body) ? skill.body : skill.body.slice(0, 2000),
      whole: revisable(skill.body),
      note: 'The procedure itself, once the skill is opened.',
    });
  }

  for (const agent of deps.registry.listAgents(workspace.id)) {
    if (!agent.enabled) continue;
    targets.push({
      kind: 'agent',
      id: agent.id,
      name: agent.name,
      field: 'description',
      text: agent.description,
      whole: revisable(agent.description),
      note: 'What the assistant reads when deciding whether to delegate to this subagent.',
    });
    targets.push({
      kind: 'agent',
      id: agent.id,
      name: agent.name,
      field: 'prompt',
      text: revisable(agent.prompt) ? agent.prompt : agent.prompt.slice(0, 2000),
      whole: revisable(agent.prompt),
      note: 'How this subagent behaves once it is delegated to.',
    });
  }

  for (const automation of deps.automations.list(workspace.id)) {
    targets.push({
      kind: 'automation',
      id: automation.id,
      name: automation.name,
      field: 'prompt',
      text: revisable(automation.prompt) ? automation.prompt : automation.prompt.slice(0, 2000),
      whole: revisable(automation.prompt),
      note: `The whole of what each firing is told. Nobody is watching when it runs.${automation.enabled ? '' : ' (Currently disabled.)'}`,
    });
  }

  return targets;
}

/* -------------------------------------------------------------------------- */
/* The rules that sit after the model                                          */
/* -------------------------------------------------------------------------- */

/** A revision the rules refused, and the sentence that says why. */
export interface Dropped {
  target: string;
  reason: string;
}

/**
 * Which of the arbiter's revisions survive.
 *
 * Order matters only for what a rejection *says*: the cheapest checks come
 * first so the reason an operator reads is the most specific true one.
 */
export function applyRules(input: {
  revisions: readonly ArbiterRevision[];
  targets: readonly ArbiterTarget[];
  findings: readonly RevisionFinding[];
  observations: readonly RevisionFinding[];
  window: EvidenceWindow;
  refusedKeys: readonly string[];
}): { kept: Array<{ revision: ArbiterRevision; target: ArbiterTarget; findings: RevisionFinding[] }>; dropped: Dropped[] } {
  const inWindow = new Set(input.window.runs.map((run) => run.id));
  const byKey = new Map<string, RevisionFinding>();
  // The counted facts first, so a model that re-states one under the same key
  // cannot weaken it: whatever it says, the runs behind that key are the runs
  // the code found.
  for (const finding of input.findings) byKey.set(finding.key, finding);
  for (const observation of input.observations) byKey.set(observation.key, observation);
  const refused = new Set(input.refusedKeys);

  const kept: Array<{ revision: ArbiterRevision; target: ArbiterTarget; findings: RevisionFinding[] }> = [];
  const dropped: Dropped[] = [];
  const claimed = new Set<string>();

  for (const revision of input.revisions) {
    const target = input.targets[revision.target - 1];
    if (!target) {
      dropped.push({ target: `#${revision.target}`, reason: 'named a target that was not shown' });
      continue;
    }
    const name = `${target.kind}:${target.name}:${target.field}`;

    if (!target.whole) {
      dropped.push({ target: name, reason: 'that text is too long to be judged whole, so it is not revisable' });
      continue;
    }
    if (!(REVISABLE_FIELDS[target.kind] as readonly string[]).includes(target.field)) {
      dropped.push({ target: name, reason: `a ${target.kind} has no ${target.field}` });
      continue;
    }
    if (claimed.has(name)) {
      dropped.push({ target: name, reason: 'a second rewrite of one text in the same pass' });
      continue;
    }
    if (sameText(target.text, revision.after)) {
      dropped.push({ target: name, reason: 'the rewrite is the text that is already there' });
      continue;
    }

    // The evidence has to exist, be about runs this window actually holds, and
    // clear the recurrence bar. Before the shape rules, deliberately: a
    // revision with no grounds should be told so whatever its size, and an
    // operator reading the review's `dropped` list is better served by "it
    // cites nothing" than by "it is too big".
    const cited = revision.findingKeys
      .map((key) => byKey.get(key))
      .filter((finding): finding is RevisionFinding => finding !== undefined)
      .map((finding) => ({
        ...finding,
        runIds: finding.runIds.filter((runId) => inWindow.has(runId)),
      }));

    if (cited.some((finding) => refused.has(finding.key))) {
      dropped.push({ target: name, reason: 'it rests on a finding the operator has already refused' });
      continue;
    }
    const grounded = cited.filter((finding) => finding.runIds.length >= OBSERVATION_MIN_RUNS);
    if (grounded.length === 0) {
      dropped.push({
        target: name,
        reason:
          cited.length === 0
            ? 'it cites no finding from this window'
            : `no finding behind it names ${OBSERVATION_MIN_RUNS} runs of this window`,
      });
      continue;
    }

    // An edit, not a rewrite — but only where "most of it" means something.
    // The rule itself lives in `revision.ts`, because the service enforces it
    // on the tool's door too and one of the two would otherwise drift.
    const ratio = changedLineRatio(target.text, revision.after);
    if (isRewrite(target.text, revision.after)) {
      dropped.push({
        target: name,
        reason: `it rewrites ${Math.round(ratio * 100)}% of the text, which is a rewrite rather than an edit`,
      });
      continue;
    }

    claimed.add(name);
    kept.push({ revision, target, findings: grounded });
    if (kept.length >= PROPOSALS_PER_REVIEW) break;
  }

  return { kept, dropped };
}

/* -------------------------------------------------------------------------- */
/* The pass                                                                    */
/* -------------------------------------------------------------------------- */

export class ImprovementReviewer {
  /**
   * Workspaces with a pass in flight.
   *
   * The daily sweep and the operator's button are two callers of one method,
   * and they can overlap: a pass takes tens of seconds. Two over the same
   * window would read the same runs and reach the same conclusion, and the
   * service's duplicate rule would refuse the second *proposal* — leaving a
   * review row that records a refusal by the pass beside it, which reads as a
   * defect. The one at a time is here rather than at the route because the
   * route is only one of the two doors; the `catchUpInFlight` flag on the
   * reflexion catch-up guards a single door and is the shape this improves on.
   */
  private readonly inFlight = new Set<string>();

  constructor(private readonly deps: ImprovementDeps) {}

  /**
   * Whether a pass over this workspace is running right now.
   *
   * So a caller can refuse *before* promising: the route answers 202 and the
   * operator waits for a notification, and "started" followed by a silent skip
   * is the shape of a feature nobody trusts. Per workspace, deliberately — two
   * of them read disjoint runs and propose against disjoint texts, so a global
   * lock would refuse a pass an operator asked for to protect nothing.
   */
  busy(workspaceId: string): boolean {
    return this.inFlight.has(workspaceId);
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /**
   * Review one workspace, whether or not the schedule says it is due.
   *
   * `force` is what the button passes: an operator who presses *Review the
   * instructions* has asked, and the weekly gate exists to stop the machine
   * asking unprompted, not to stop them. The run-count floor still applies —
   * a pass over two runs would be answering a question nobody can answer.
   *
   * Never throws. A failure here is a row saying the pass failed, which is the
   * whole point of recording every pass: without it, "nothing needed changing"
   * and "the call died" are the same empty screen.
   */
  async review(workspaceId: string, options: { force?: boolean } = {}): Promise<ReviewResult> {
    const workspace = this.deps.workspaces.get(workspaceId);
    if (!workspace) return { status: 'skipped', reason: 'unknown-workspace', runsExamined: 0, proposed: 0, reviewId: null };
    if (this.inFlight.has(workspaceId)) {
      return { status: 'skipped', reason: 'in-flight', runsExamined: 0, proposed: 0, reviewId: null };
    }

    const now = this.now();
    const due = reviewDue(this.deps.db, workspace, now);
    if (!due.due) {
      // Forced: only the opt-in and the clock are waived. A window with too
      // little in it stays too little, and `enoughRuns` answers that on its
      // own terms — the ordered reasons would otherwise report `opted-out` and
      // say nothing about whether the traffic is there.
      const waivable = due.reason === 'opted-out' || due.reason === 'too-soon';
      if (!options.force || !waivable) {
        return { status: 'skipped', reason: due.reason, runsExamined: 0, proposed: 0, reviewId: null };
      }
      if (!due.enoughRuns) {
        return {
          status: 'skipped',
          reason: due.fresh === 0 ? 'no-runs' : 'too-few-runs',
          runsExamined: 0,
          proposed: 0,
          reviewId: null,
        };
      }
    }

    this.inFlight.add(workspaceId);
    try {
      return await this.reviewNow(workspace, due, options, now);
    } finally {
      this.inFlight.delete(workspaceId);
    }
  }

  /** The pass itself, once it is known to be worth running and not already running. */
  private async reviewNow(
    workspace: Workspace,
    due: ReturnType<typeof reviewDue>,
    options: { force?: boolean },
    now: number,
  ): Promise<ReviewResult> {
    const since = options.force ? reviewCursor(this.deps.db, workspace.id) : due.since;
    const window = buildWindow(this.deps.db, workspace.id, { since, until: now });
    if (window.runs.length === 0) {
      return { status: 'skipped', reason: 'no-runs', runsExamined: 0, proposed: 0, reviewId: null };
    }

    const observations = observe(window, {
      instructionsLength: workspace.settings.systemPromptAppend.length,
    });

    // Before anything else this window is used for: what became of the last
    // pass's advice. It costs no model call — the observations are already
    // computed — and without it the loop never closes, because nothing else
    // can repeat the measurement on the same terms.
    this.followUp(workspace.id, window, observations, now);

    // Read at the moment of the pass, not captured: the reviewer is built once
    // at boot and the setting is hot, so a captured number would need a restart
    // — the wrong answer for a setting about spend, here as for the model.
    const { targets, omitted: omittedTargets } = collectTargetsWithBudget(
      this.deps,
      workspace,
      this.deps.targetChars?.(),
    );
    const refusedKeys = this.deps.advisor.refusedFindings(workspace.id, now);

    const startedAt = Date.now();
    const review: RevisionReview = {
      id: newId('review'),
      workspaceId: workspace.id,
      at: now,
      windowFrom: window.from,
      windowTo: window.to,
      runsExamined: window.runs.length,
      observations,
      findings: [],
      proposed: 0,
      dropped: [],
      model: this.deps.model?.() ?? STRUCTURED_DEFAULT_MODEL,
      durationMs: 0,
      error: null,
    };

    let answer;
    try {
      answer = await this.deps.arbiter({
        workspaceName: workspace.name,
        window,
        observations,
        targets,
        omittedTargets,
        refusedKeys,
        language: this.deps.language(workspace.id),
      });
    } catch (error) {
      review.error = (error as Error).message.slice(0, 500);
      review.durationMs = Date.now() - startedAt;
      recordReview(this.deps.db, review);
      this.deps.log('warn', 'the instruction review could not be completed', {
        workspaceId: workspace.id,
        message: review.error,
      });
      return { status: 'failed', reason: review.error, runsExamined: window.runs.length, proposed: 0, reviewId: review.id };
    }

    const { kept, dropped } = applyRules({
      revisions: answer.revisions,
      targets,
      findings: answer.findings,
      observations,
      window,
      refusedKeys,
    });

    for (const entry of kept) {
      try {
        this.deps.advisor.proposeRevision({
          workspaceId: workspace.id,
          runId: null,
          target: {
            kind: entry.target.kind,
            id: entry.target.id,
            name: entry.target.name,
            workspaceId: entry.target.kind === 'workspace' ? workspace.id : null,
          },
          field: entry.target.field,
          after: entry.revision.after,
          rationale: entry.revision.rationale,
          evidence: evidenceFor(entry.findings, window),
          findings: entry.findings,
          reviewId: review.id,
          now,
        });
        review.proposed += 1;
      } catch (error) {
        // The service refuses for reasons this pass cannot see from here — a
        // cooldown, a pending proposal, a target that moved between the read
        // and the write. Its sentence is the honest one, so it is recorded
        // rather than translated.
        dropped.push({
          target: `${entry.target.kind}:${entry.target.name}:${entry.target.field}`,
          reason: (error as Error).message.slice(0, 300),
        });
      }
    }

    review.findings = answer.findings;
    review.dropped = dropped;
    review.durationMs = Date.now() - startedAt;
    recordReview(this.deps.db, review);

    this.deps.log('info', 'instruction review finished', {
      workspaceId: workspace.id,
      runs: window.runs.length,
      proposed: review.proposed,
      dropped: dropped.length,
    });
    return {
      status: 'reviewed',
      runsExamined: window.runs.length,
      proposed: review.proposed,
      reviewId: review.id,
    };
  }

  /**
   * Say whether the last pass's advice worked.
   *
   * Only for a revision applied *before* the oldest run of this window, so
   * every run it is judged on actually happened under the new text. One
   * accepted halfway through would be judged partly on runs that predate it,
   * which is a measurement of nothing; it simply waits for the next pass.
   *
   * `recurred` is the same finding key coming back from the same deterministic
   * observations — the identical measurement, not a second opinion about it.
   * A window with no runs after the change says so by not being written at all.
   */
  private followUp(
    workspaceId: string,
    window: EvidenceWindow,
    observations: readonly RevisionFinding[],
    now: number,
  ): void {
    const oldest = window.runs[0]?.at;
    if (oldest === undefined) return;
    const keys = new Set(observations.map((observation) => observation.key));

    for (const proposal of this.deps.advisor.list(workspaceId, 'accepted')) {
      if (proposal.kind !== 'revision') continue;
      const parsed = RevisionPayload.safeParse(proposal.payload);
      if (!parsed.success || parsed.data.followUp !== null || parsed.data.revertedAt !== null) continue;
      if (proposal.decidedAt === null || proposal.decidedAt > oldest) continue;

      const recurred = parsed.data.findings.some((finding) => keys.has(finding.key));
      this.deps.advisor.recordFollowUp(proposal.id, {
        at: now,
        windowRuns: window.runs.length,
        recurred,
        note: recurred
          ? 'The finding this was meant to answer came back in the runs that followed.'
          : 'The finding this was meant to answer has not come back since.',
      });
    }
  }

  /**
   * The beat. One workspace at a time, quietly skipping what is not due.
   *
   * A workspace that throws never stops the tour — the advisor's own sweep
   * rule, and for the same reason: one workspace's broken state must not cost
   * every other workspace its review.
   */
  async sweep(): Promise<{ reviewed: number; proposed: number }> {
    let reviewed = 0;
    let proposed = 0;

    for (const workspace of this.deps.workspaces.list(false)) {
      if (!workspace.settings.improvementAuto) continue;
      const due = reviewDue(this.deps.db, workspace, this.now());
      if (!due.due) continue;

      // The autopilot's guard, with its reasoning intact: a background pass
      // must not spend the last of a window the operator is about to want.
      // Null fails open — under an API key there is no window to be near.
      const utilisation = await this.deps.quota?.(workspace).catch(() => null);
      if (utilisation !== null && utilisation !== undefined && utilisation >= QUOTA_CEILING) {
        this.deps.log('debug', 'instruction review deferred: the quota window is nearly spent', {
          workspaceId: workspace.id,
        });
        continue;
      }

      try {
        const result = await this.review(workspace.id);
        if (result.status === 'reviewed') {
          reviewed += 1;
          proposed += result.proposed;
          if (result.proposed > 0) this.deps.notify?.({ workspace, proposed: result.proposed });
        }
      } catch (error) {
        this.deps.log('warn', 'instruction review sweep skipped a workspace', {
          workspaceId: workspace.id,
          message: (error as Error).message,
        });
      }
    }

    return { reviewed, proposed };
  }
}

/**
 * The runs a card links to, deduplicated and bounded.
 *
 * A run id alone is not a destination — the Memory page learned that — so the
 * session travels with it, read from the window rather than looked up, because
 * the window already knows.
 */
function evidenceFor(
  findings: readonly RevisionFinding[],
  window: EvidenceWindow,
): Array<{ runId: string; sessionId: string | null; workspaceId: string | null; note: string }> {
  const bySession = new Map(window.runs.map((run) => [run.id, run]));
  const seen = new Set<string>();
  const out: Array<{ runId: string; sessionId: string | null; workspaceId: string | null; note: string }> = [];

  for (const finding of findings) {
    for (const runId of finding.runIds) {
      if (seen.has(runId)) continue;
      seen.add(runId);
      const run = bySession.get(runId);
      if (!run) continue;
      out.push({
        runId,
        sessionId: run.sessionId,
        workspaceId: window.workspaceId,
        note: finding.summary.slice(0, 500),
      });
      if (out.length >= 20) return out;
    }
  }
  return out;
}
