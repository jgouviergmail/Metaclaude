/**
 * The composer's pickers, built from what the CLI says it offers.
 *
 * The model list used to live in the component as three names and their prices,
 * written when the page was built. Which models a subscription grants — and
 * which of them take an effort level — changes without a Metaclaude release,
 * and the CLI knows the answer.
 *
 * The pickers are also the last thing that may break: a composer that cannot
 * offer a model is a session nobody can start. So the catalogue *improves* the
 * lists rather than being required for them, and every path here has a usable
 * answer when the CLI could not be reached at all.
 */

import type { ClaudeCatalogue, EffortLevel } from '@metaclaude/shared';

export interface PickerOption {
  value: string;
  label: string;
  hint: string;
}

/**
 * Metaclaude's own entry, which the CLI does not know about.
 *
 * `default` is not a model: it means the bandit picks one at submit time from
 * what it has learned about this kind of task. It stays first and is never
 * replaced by a CLI-reported model of the same name.
 */
const AUTO: PickerOption = {
  value: 'default',
  label: 'Auto',
  hint: 'Let Metaclaude choose from what it has learned',
};

/** Used when the CLI cannot be reached, or answered with nothing. */
const FALLBACK_MODELS: PickerOption[] = [
  { value: 'opus', label: 'Opus', hint: 'Deepest reasoning, highest cost' },
  { value: 'sonnet', label: 'Sonnet', hint: 'Balanced — the everyday choice' },
  { value: 'haiku', label: 'Haiku', hint: 'Fastest and cheapest, for simple tasks' },
  { value: 'opusplan', label: 'Opus plan', hint: 'Opus to plan, Sonnet to execute' },
];

const EFFORT_LABELS: Array<{ value: EffortLevel; label: string }> = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Very high' },
  { value: 'max', label: 'Maximum' },
];

const DEFER: { value: null; label: string } = { value: null, label: 'Auto' };

export function modelOptions(catalogue: ClaudeCatalogue | undefined): PickerOption[] {
  const reported = (catalogue?.models ?? [])
    // `default` is ours, and a CLI reporting it would otherwise produce two
    // entries that look identical and behave differently.
    .filter((model) => model.value !== AUTO.value)
    .map((model) => ({
      value: model.value,
      label: model.displayName || model.value,
      hint: model.description,
    }));

  return [AUTO, ...(reported.length > 0 ? reported : FALLBACK_MODELS)];
}

/**
 * The effort levels worth offering for one model.
 *
 * The picker used to offer all six for every model, so choosing one the model
 * does not take was a run that silently ignored the setting. Narrowing only
 * happens when the CLI actually named the model: an operator can type a dated
 * model id the catalogue has not enumerated, and removing choices on a guess
 * would take away settings that are very likely valid.
 */
export function effortOptions(
  catalogue: ClaudeCatalogue | undefined,
  model: string,
): Array<{ value: EffortLevel | null; label: string }> {
  const all = [DEFER, ...EFFORT_LABELS];

  // Under Auto the learner chooses the model at submit time, so nothing can be
  // ruled out here.
  if (model === AUTO.value) return all;

  const known = catalogue?.models.find((entry) => entry.value === model);
  if (!known) return all;

  if (!known.supportsEffort || known.supportedEffortLevels.length === 0) return [DEFER];

  const supported = new Set<EffortLevel>(known.supportedEffortLevels);
  return [DEFER, ...EFFORT_LABELS.filter((effort) => supported.has(effort.value))];
}
