/**
 * The one automation the system workspace ships with.
 *
 * Disabled, deliberately: it exists to show what scheduling Metaclaude looks
 * like — a run of its own workspace, with its own tools, on a cron — not to
 * start reviewing a deployment nobody asked it to review. Seeded once, under a
 * `kv` key: an operator who deletes it has said something, and the next boot
 * must not contradict them.
 */

import type { Automation } from '@metaclaude/shared';
import { kvGet, kvSet, type Db } from '../db/index.js';
import type { Scheduler } from './scheduler.js';

export const SYSTEM_AUTOMATION_KEY = 'system.automationId';
export const SYSTEM_AUTOMATION_NAME = 'Morning review';

/**
 * Worded for an unattended run: it has no operator to ask, so it must end on
 * something an operator can act on when they read it, and it must not spend a
 * morning on a deployment where nothing happened.
 */
export const MORNING_REVIEW_PROMPT = [
  'Review the last 24 hours of this deployment and write the operator a short brief.',
  '',
  'Start from system_overview. Then look at what changed: runs that failed (system_runs with',
  'status "failed", then system_run on each), approval cards still waiting (system_approvals),',
  'new insights (system_insights with status "new"), pending proposals (system_proposals),',
  'automations whose failure streak is growing (system_automations), and anything the doctor',
  'flags (system_doctor).',
  '',
  'Act on what is reversible and clearly right — reject an insight that repeats a memory,',
  'pause an automation that has failed three times running — and say so. For anything',
  'irreversible, say precisely what you would do and stop.',
  '',
  'If nothing happened, say so in two lines and finish. Otherwise: three findings that',
  'matter, what you did, what you propose, what you need from the operator.',
].join('\n');

export function seedSystemAutomation(deps: {
  db: Db;
  workspaceId: string;
  automations: Pick<Scheduler, 'create'>;
}): Automation | null {
  if (kvGet<string | null>(deps.db, SYSTEM_AUTOMATION_KEY, null)) return null;

  const automation = deps.automations.create({
    workspaceId: deps.workspaceId,
    name: SYSTEM_AUTOMATION_NAME,
    description:
      'Disabled by default. Every morning, Metaclaude reads the last 24 hours — failures, ' +
      'waiting approvals, new insights, health — acts on what is reversible and briefs you ' +
      'on the rest. Enable it when you want that review waiting in your session list.',
    prompt: MORNING_REVIEW_PROMPT,
    trigger: { type: 'cron', expression: '0 8 * * *' },
    enabled: false,
  });
  kvSet(deps.db, SYSTEM_AUTOMATION_KEY, automation.id);
  return automation;
}
