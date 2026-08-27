/**
 * The notes index — wikilinks, backlinks and the graph, straight off disk.
 *
 * A workspace's markdown is its own source of truth: nothing is stored, the
 * index is rebuilt from the files on request (and memoised briefly by the
 * route layer). Resolution follows Obsidian's habit — bare names match by
 * basename case-insensitively, the same folder wins, then the shortest
 * path — deterministically, so two people looking at one vault see one
 * graph. Every scan is bounded in breadth, depth and bytes: a huge tree
 * costs a truncation flag, never a hung request.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { NoteBacklink, NoteEntry, NotesIndex } from '@metaclaude/shared';
import { extractWikilinks, resolveLink } from '@metaclaude/shared';
import { PathEscapeError, resolveInside, toRelative } from '../security/paths.js';
import { FileServiceError, HIDDEN_DIRECTORIES } from './files.js';

export type { NoteBacklink, NoteEntry, NotesIndex };

const MAX_NOTES = 2000;
const MAX_NOTE_BYTES = 512 * 1024;
const MAX_DEPTH = 8;

export class NotesService {
  /** Build the whole index for a workspace root. */
  async index(
    root: string,
    options: { maxNotes?: number } = {},
  ): Promise<NotesIndex> {
    const maxNotes = options.maxNotes ?? MAX_NOTES;
    const found: string[] = [];
    let truncated = false;

    const walk = async (directory: string, depth: number): Promise<void> => {
      if (depth > MAX_DEPTH) {
        truncated = true;
        return;
      }
      let dirents;
      try {
        dirents = await readdir(directory, { withFileTypes: true });
      } catch {
        return;
      }
      // Deterministic scan order so a truncated index is a stable prefix.
      dirents.sort((a, b) => a.name.localeCompare(b.name));
      for (const dirent of dirents) {
        if (found.length >= maxNotes) {
          truncated = true;
          return;
        }
        if (dirent.name.startsWith('.')) continue;
        if (dirent.isDirectory()) {
          if (HIDDEN_DIRECTORIES.has(dirent.name)) continue;
          await walk(join(directory, dirent.name), depth + 1);
        } else if (dirent.isFile() && dirent.name.toLowerCase().endsWith('.md')) {
          found.push(toRelative(root, join(directory, dirent.name)));
        }
      }
    };
    await walk(root, 0);

    const notes: NoteEntry[] = [];
    for (const path of found) {
      const absolute = join(root, path);
      let content: string;
      try {
        const stats = await stat(absolute);
        if (stats.size > MAX_NOTE_BYTES) {
          // A note this size is an export, not a note; its links are not
          // worth an unbounded read.
          notes.push({ path, title: basename(path, '.md'), links: [], unresolved: [] });
          continue;
        }
        content = await readFile(absolute, 'utf8');
      } catch {
        continue; // Deleted mid-scan.
      }

      const links = new Set<string>();
      const unresolved = new Set<string>();
      for (const target of extractWikilinks(content)) {
        const resolved = resolveLink(target, path, found);
        if (resolved && resolved !== path) links.add(resolved);
        else if (!resolved) unresolved.add(target);
      }

      const heading = content.match(/^#\s+(.+)$/m)?.[1]?.trim();
      notes.push({
        path,
        title: heading || basename(path, '.md'),
        links: [...links].sort(),
        unresolved: [...unresolved].sort(),
      });
    }

    notes.sort((a, b) => a.path.localeCompare(b.path));
    return { notes, truncated };
  }

  /**
   * Every note linking to `target`, with the first linking line as context.
   * Pass the memoised index when one is in hand — the panel asks for the
   * graph and the backlinks together, and one scan should serve both.
   */
  async backlinks(root: string, target: string, index?: NotesIndex): Promise<NoteBacklink[]> {
    try {
      resolveInside(root, target);
    } catch (error) {
      if (error instanceof PathEscapeError) {
        throw new FileServiceError('That path is outside the workspace.', 403);
      }
      throw error;
    }

    const { notes } = index ?? (await this.index(root));
    const paths = notes.map((note) => note.path);
    const sources = notes.filter((note) => note.links.includes(target));

    const backlinks: NoteBacklink[] = [];
    for (const source of sources) {
      let context = '';
      try {
        const content = await readFile(join(root, source.path), 'utf8');
        context =
          content
            .split('\n')
            .find((line) =>
              extractWikilinks(line).some(
                (link) => resolveLink(link, source.path, paths) === target,
              ),
            )
            ?.trim() ?? '';
      } catch {
        // The note vanished between the index and this read; keep the entry.
      }
      backlinks.push({ path: source.path, title: source.title, context });
    }
    return backlinks;
  }
}
