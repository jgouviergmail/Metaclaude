/**
 * The help system: the user guide as a build output, and the ask flow.
 *
 * The guide lives in `docs/guide/` at the repository root — one corpus for the
 * repository reader, the in-app Help screen, and the help agent alike. Vite
 * bundles each chapter as its own lazy chunk, so Help costs the entry bundle
 * nothing and a chapter is only downloaded when read.
 *
 * "Ask Metaclaude" reuses the machinery that already exists rather than
 * growing a parallel one: an ordinary workspace seeded with this same guide,
 * an ordinary session in plan mode, an ordinary run. The help agent explains
 * the product; plan mode is what guarantees it never mutates the host that
 * runs it.
 */

export interface GuideChapter {
  slug: string;
  title: string;
  load: () => Promise<string>;
}

export interface GuideHit {
  slug: string;
  title: string;
  excerpt: string;
  score: number;
}

/** The minimal API surface the ask flow needs — see `api` in lib/api.ts. */
export interface HelpApi {
  workspaces: () => Promise<{ workspaces: Array<{ id: string; slug: string }> }>;
  createWorkspace: (body: {
    name: string;
    description?: string;
    icon?: string;
  }) => Promise<{ workspace: { id: string } }>;
  updateWorkspace: (
    id: string,
    body: { settings?: Record<string, unknown> },
  ) => Promise<unknown>;
  writeFile: (workspaceId: string, path: string, content: string) => Promise<unknown>;
  createSession: (body: {
    workspaceId: string;
    title?: string;
    permissionMode?: string;
  }) => Promise<{ session: { id: string } }>;
  submitRun: (
    sessionId: string,
    body: { prompt: string; permissionMode?: string },
  ) => Promise<unknown>;
}

const HELP_SLUG = 'metaclaude-help';

/* -------------------------------------------------------------------------- */
/* The corpus                                                                  */
/* -------------------------------------------------------------------------- */

const modules = import.meta.glob('../../../../docs/guide/*.md', {
  query: '?raw',
  import: 'default',
}) as Record<string, () => Promise<string>>;

const changelogModule = import.meta.glob('../../../../CHANGELOG.md', {
  query: '?raw',
  import: 'default',
}) as Record<string, () => Promise<string>>;

/**
 * Title-cases the slug as a synchronous fallback; the real title replaces it
 * the moment the chapter loads, and `titleOf` is what both use.
 */
function titleFromSlug(slug: string): string {
  const words = slug.replace(/^\d+-/, '').split('-');
  return words
    .map((word, index) => (index === 0 ? (word[0]?.toUpperCase() ?? '') + word.slice(1) : word))
    .join(' ');
}

/** The first heading is the chapter's name — one source of truth, in the file. */
export function titleOf(body: string, fallback: string): string {
  const match = body.match(/^#\s+(.+)$/m);
  return match?.[1] ? match[1].trim() : fallback;
}

export const guideChapters: GuideChapter[] = Object.entries(modules)
  .map(([path, loader]) => {
    const slug = path.split('/').pop()?.replace(/\.md$/, '') ?? path;
    const chapter: GuideChapter = {
      slug,
      title: titleFromSlug(slug),
      load: async () => {
        const body = await loader();
        chapter.title = titleOf(body, chapter.title);
        return body;
      },
    };
    return chapter;
  })
  .sort((a, b) => a.slug.localeCompare(b.slug));

// Eagerly resolve the real titles: the chunks are tiny, the navigation reads
// better with them, and awaiting nothing keeps the manifest synchronous for
// consumers that only need slugs.
for (const chapter of guideChapters) void chapter.load().catch(() => undefined);

export function loadChangelog(): Promise<string> {
  const loader = Object.values(changelogModule)[0];
  return loader ? loader() : Promise.resolve('# Changelog\n\nNo changelog was bundled.');
}

/* -------------------------------------------------------------------------- */
/* Search                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Every term must match — a two-word query is a question, not two questions —
 * and the excerpt is the first line containing the rarest term, so what the
 * user sees is why the chapter matched.
 */
export function searchGuide(
  corpus: Array<{ slug: string; title: string; body: string }>,
  query: string,
): GuideHit[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];

  const hits: GuideHit[] = [];
  for (const chapter of corpus) {
    const haystack = `${chapter.title}\n${chapter.body}`.toLowerCase();
    let score = 0;
    for (const term of terms) {
      const count = haystack.split(term).length - 1;
      if (count === 0) {
        score = 0;
        break;
      }
      score += count;
    }
    if (score === 0) continue;

    const lines = chapter.body.split('\n');
    const excerpt =
      lines.find((line) => terms.every((term) => line.toLowerCase().includes(term))) ??
      lines.find((line) => terms.some((term) => line.toLowerCase().includes(term))) ??
      lines[0] ??
      '';
    hits.push({ slug: chapter.slug, title: chapter.title, excerpt: excerpt.trim(), score });
  }

  return hits.sort((a, b) => b.score - a.score);
}

/* -------------------------------------------------------------------------- */
/* Ask Metaclaude                                                              */
/* -------------------------------------------------------------------------- */

const HELP_CLAUDE_MD = `# Metaclaude Help

You are Metaclaude's help assistant. This workspace contains the product's own
user guide, one chapter per file. Answer the user's question **from these
documents**, citing the chapter (by its title) each part of your answer comes
from. When the guide does not cover something, say so plainly rather than
guessing — an honest "the guide does not cover this" beats an invented answer.

You are running in plan mode on purpose: read and explain, execute nothing.
`;

/**
 * Find or create the help workspace, seed it with the guide on first use, and
 * open a plan-mode session already answering the question.
 *
 * Every step is an existing API the rest of the product already exercises —
 * the help agent is an ordinary session with a curated library, not a second
 * agent pipeline to maintain.
 */
export async function ensureHelpSession(
  api: HelpApi,
  question: string,
): Promise<{ workspaceId: string; sessionId: string }> {
  const { workspaces } = await api.workspaces();
  let workspaceId = workspaces.find((workspace) => workspace.slug === HELP_SLUG)?.id;

  if (!workspaceId) {
    const created = await api.createWorkspace({
      name: 'Metaclaude Help',
      description: "The product's own guide, and the assistant that answers from it.",
      icon: 'book',
    });
    workspaceId = created.workspace.id;

    // The guide, verbatim, then the assistant's standing instructions. Writes
    // are sequential and failures propagate: a half-seeded library that fails
    // silently would produce confidently incomplete answers forever.
    for (const chapter of guideChapters) {
      const body = await chapter.load();
      await api.writeFile(workspaceId, `guide/${chapter.slug}.md`, body);
    }
    await api.writeFile(workspaceId, 'CLAUDE.md', HELP_CLAUDE_MD);
    await api.updateWorkspace(workspaceId, {
      settings: { defaultPermissionMode: 'plan', memoryEnabled: false },
    });
  }

  const { session } = await api.createSession({
    workspaceId,
    title: 'Ask Metaclaude',
    permissionMode: 'plan',
  });
  await api.submitRun(session.id, { prompt: question, permissionMode: 'plan' });

  return { workspaceId, sessionId: session.id };
}
