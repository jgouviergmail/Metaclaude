/**
 * The settings whose value is a model or an effort, and the phases that read them.
 *
 * A module of its own, deliberately holding **no Zod schema**. The
 * Configuration screen draws these twelve rows, so the web app imports these
 * values at runtime — and `api-contracts.ts`, where they started, cannot be
 * imported for a value without carrying every request schema declared beside
 * it into the bundle (`z.object(...)` is a call Rollup cannot prove
 * side-effect-free, so the whole module rides along). Nothing here is a call.
 *
 * The keys themselves stay in `RuntimeSettingKey`, which is a schema and
 * belongs there; this file is what says which of them go together.
 */

import { AUTO_MODEL, EffortLevel, ModelAlias } from './domain.js';
import type { RuntimeSettingKey } from './api-contracts.js';

/**
 * The sentinel these settings use for "leave it alone".
 *
 * Deliberately **not** `AUTO_MODEL`, which is the string `default` — that is
 * the CLI's own alias, and it means "the model the CLI would pick", which on a
 * subscription is Opus. An operator who set the reflexion pass to `default`
 * expecting "unchanged" would move every background call from Haiku to Opus,
 * roughly thirty times the price, silently. `auto` is the sentinel the
 * `language` setting already uses, and here it means the phase's shipped
 * default, which each row states.
 */
export const SETTING_AUTO = 'auto';

/**
 * The background passes whose model and effort an operator may pin, in the
 * order the screen shows them.
 *
 * A table rather than twelve loose keys, because three things have to agree
 * and did not when this was written by hand: the settings that exist, the
 * getters the passes read, and the rows the Configuration screen draws. One
 * definition, and `runtime-settings.test.ts` derives its coverage from it.
 *
 * `shipped` is what `auto` resolves to. Five of the six are `haiku` because
 * they are classifiers rather than agents — they read text and answer JSON
 * under a schema. The advisor is not: it is an ordinary agentic run, so its
 * shipped answer is the workspace's own default, and pinning one here
 * overrides that for every workspace at once.
 */
export const LEARNING_PHASES = [
  { id: 'reflexion', modelKey: 'reflexionModel', effortKey: 'reflexionEffort', shipped: 'haiku' },
  { id: 'memoryGate', modelKey: 'memoryGateModel', effortKey: 'memoryGateEffort', shipped: 'haiku' },
  { id: 'consolidation', modelKey: 'consolidationModel', effortKey: 'consolidationEffort', shipped: 'haiku' },
  { id: 'synthesis', modelKey: 'synthesisModel', effortKey: 'synthesisEffort', shipped: 'haiku' },
  { id: 'revision', modelKey: 'revisionModel', effortKey: 'revisionEffort', shipped: 'haiku' },
  { id: 'advisor', modelKey: 'advisorModel', effortKey: 'advisorEffort', shipped: SETTING_AUTO },
] as const satisfies ReadonlyArray<{
  id: string;
  modelKey: RuntimeSettingKey;
  effortKey: RuntimeSettingKey;
  shipped: string;
}>;

export type LearningPhaseId = (typeof LEARNING_PHASES)[number]['id'];

/**
 * What a model picker offers for these settings.
 *
 * The aliases plus the sentinel, **minus `AUTO_MODEL`**. That one is the
 * string `default`, and a picker showing `auto` and `default` side by side
 * offers an operator two words that read alike and differ by roughly thirty
 * times the price: `auto` is the phase's shipped default (Haiku, for five of
 * the six), and `default` is the CLI's own alias, which on a subscription is
 * Opus. There is no reading of that pair where the operator is well served, so
 * only one of them is offered — and anyone who genuinely wants the expensive
 * one can name it.
 */
export const SETTING_MODELS: readonly string[] = [
  SETTING_AUTO,
  ...ModelAlias.options.filter((alias) => alias !== AUTO_MODEL),
];
/** And what an effort picker offers. `auto` is the CLI's own choice for that model. */
export const SETTING_EFFORTS: readonly string[] = [SETTING_AUTO, ...EffortLevel.options];
