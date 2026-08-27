/**
 * Wikilink mechanics, shared verbatim by the API's notes index and the web
 * preview: the note a click opens must be the note the graph drew an edge
 * to, and one implementation is the only way two sides agree forever.
 *
 * Plain functions and types — nothing here costs the entry bundle a schema.
 */

export interface NoteEntry {
  path: string;
  /** The first `# heading`, or the file name without its extension. */
  title: string;
  /** Resolved outgoing links, workspace-relative note paths. */
  links: string[];
  /** Wikilink targets that resolve to no note — the graph's loose ends. */
  unresolved: string[];
}

export interface NotesIndex {
  notes: NoteEntry[];
  /** True when the scan hit a bound and the index is a prefix, not the vault. */
  truncated: boolean;
}

export interface NoteBacklink {
  path: string;
  title: string;
  /** The first line in the source note that links here, trimmed. */
  context: string;
}

/**
 * Wikilink targets in a text, in order, fences and inline code excluded.
 *
 * `[[Note|alias]]` and `[[Note#heading]]` both point at `Note`; `![[x]]` is
 * an embed and still names a target. A link inside a code block is prose
 * *about* a link, so fenced and inline code are cut before matching.
 */
export function extractWikilinks(text: string): string[] {
  const withoutCode = text
    .replace(/^(```|~~~).*?^\1.*?$/gms, '')
    .replace(/`[^`\n]*`/g, '');

  const links: string[] = [];
  for (const match of withoutCode.matchAll(/!?\[\[([^[\]]+)\]\]/g)) {
    const target = (match[1] ?? '').split('|')[0]!.split('#')[0]!.trim();
    if (target.length > 0) links.push(target);
  }
  return links;
}

const folderOf = (path: string): string => path.slice(0, path.lastIndexOf('/') + 1);
const nameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/**
 * Resolve one wikilink from one note against the vault's paths.
 *
 * A target carrying a slash is an explicit path from the vault root; a bare
 * name matches by basename. Everything is case-insensitive, and ties break
 * the way Obsidian's do: the source's own folder first, then the shortest
 * path, then lexicographic order so the answer never depends on scan order.
 */
export function resolveLink(link: string, fromPath: string, paths: string[]): string | null {
  const wanted = link.toLowerCase().endsWith('.md')
    ? link.toLowerCase()
    : `${link.toLowerCase()}.md`;

  if (link.includes('/')) {
    return paths.find((path) => path.toLowerCase() === wanted) ?? null;
  }

  const candidates = paths.filter((path) => nameOf(path).toLowerCase() === wanted);
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0]!;

  const home = folderOf(fromPath);
  const sameFolder = candidates.filter((path) => folderOf(path) === home);
  const pool = sameFolder.length > 0 ? sameFolder : candidates;
  return [...pool].sort(
    (a, b) =>
      a.split('/').length - b.split('/').length || a.length - b.length || a.localeCompare(b),
  )[0]!;
}
