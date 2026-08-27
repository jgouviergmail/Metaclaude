/**
 * Slash-command suggestions for the composer.
 *
 * The CLI reports its commands through the catalogue; typing `/` should
 * offer them where they are typed instead of asking the operator to
 * remember. Pure over its inputs: when suggestions misbehave, the rule is
 * here to read and to test, not spread across a keydown handler.
 */

export interface SlashCommand {
  name: string;
  description: string;
}

const LIMIT = 8;

/**
 * The suggestions for a draft, or none.
 *
 * Active only while the draft is a single `/token`. A `/` further into a
 * sentence (a path, a fraction) never triggers, and no separate whitespace
 * guard is needed for the "arguments have started" case: once a space
 * lands, the needle contains it and no command name prefixes it — the
 * prefix filter retires the list by itself, and the tests pin exactly that.
 */
export function slashMatches(commands: SlashCommand[], draft: string): SlashCommand[] {
  if (!draft.startsWith('/')) return [];
  const needle = draft.slice(1).toLowerCase();
  return commands
    .filter((command) => command.name.toLowerCase().startsWith(needle))
    .slice(0, LIMIT);
}

/** The draft after choosing a suggestion: the command, ready for arguments. */
export function completeSlash(name: string): string {
  return `/${name} `;
}
