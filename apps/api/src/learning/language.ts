/**
 * The language the system *writes* in.
 *
 * Distinct from the interface's language, which is a per-browser preference
 * and has no business deciding what a shared corpus is written in — two people
 * reading the same memories in two languages is not a thing a store of text
 * can be. So the decision is server-side: a deployment-wide choice, which any
 * workspace may override.
 *
 * The gap this closes was visible in production. A French deployment, whose
 * only workspace was on the default `auto`, had distilled twenty-two memories
 * and every one of them was in English — because `auto` meant "no directive at
 * all", and because the passes that *write* memory never carried one anyway.
 * The run's own answers followed the operator, as they always had; everything
 * the system wrote *about* the run did not.
 */

/** What a workspace or a deployment can say about language. */
export type LanguageChoice = 'auto' | 'fr' | 'en';

/** What the writer is actually told, or null for "say nothing". */
export type ContentLanguage = 'fr' | 'en';

/**
 * The language generated content should be in.
 *
 * The workspace wins whenever it has an opinion, and `auto` — the default on
 * every workspace ever created — defers to the deployment. Both silent is the
 * behaviour that shipped before this existed: no directive, and the model
 * follows whatever it was written to.
 */
export function resolveContentLanguage(
  workspace: LanguageChoice,
  deployment: LanguageChoice,
): ContentLanguage | null {
  if (workspace !== 'auto') return workspace;
  if (deployment !== 'auto') return deployment;
  return null;
}

const NAMES: Record<ContentLanguage, string> = { fr: 'French', en: 'English' };

/**
 * The sentence appended to a schema-constrained call's system prompt.
 *
 * Worded for a *structured* call, not for a conversation, and the difference
 * is load-bearing twice over. It has to say that the language governs the
 * values and not the field names — a model told only "write in French" will
 * translate the keys and make its own answer unparseable — and it has to
 * exempt what must survive verbatim, because a procedure whose entire value is
 * `pnpm test:run` is worth nothing translated.
 */
export function contentLanguageDirective(language: ContentLanguage | null): string {
  if (!language) return '';
  return (
    `Write every piece of prose you produce in ${NAMES[language]}, whatever language ` +
    'the material you are reading is in. This governs the *values* only: field names ' +
    'and enum values in the schema stay exactly as specified, and so does anything ' +
    'quoted from the project — commands, identifiers, file paths, error text.'
  );
}
