/**
 * The notes index: wikilink extraction and Obsidian-style resolution.
 *
 * The properties that must hold: a link inside a code fence is prose about
 * a link, not a link; resolution prefers the same folder, then the shortest
 * path, case-insensitively — deterministically, so the graph two people see
 * is the same graph; and the scan is bounded, so a huge workspace costs a
 * truncation marker, never a hung request.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NotesService } from './notes.js';

let root: string;
const service = new NotesService();

const note = (path: string, content: string) => {
  mkdirSync(join(root, path, '..'), { recursive: true });
  writeFileSync(join(root, path), content);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'metaclaude-notes-'));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

/* ------------------------------------------------------------------------ */
/* The index                                                                 */
/* ------------------------------------------------------------------------ */

describe('the index', () => {
  it('builds the graph with resolved edges and finds backlinks with context', async () => {
    note('Hub.md', '# Hub\n\nStart at [[Widget]] then [[projects/Widget|the project one]].');
    note('Widget.md', 'Root widget. Links back to [[Hub]].');
    mkdirSync(join(root, 'projects'), { recursive: true });
    note('projects/Widget.md', 'Project widget, no links.');

    const index = await service.index(root);
    expect(index.truncated).toBe(false);
    const hub = index.notes.find((entry) => entry.path === 'Hub.md');
    expect(hub?.links.sort()).toEqual(['Widget.md', 'projects/Widget.md']);

    const backlinks = await service.backlinks(root, 'Widget.md');
    expect(backlinks.map((entry) => entry.path)).toEqual(['Hub.md']);
    expect(backlinks[0]?.context).toContain('Start at');

    const hubBacklinks = await service.backlinks(root, 'Hub.md');
    expect(hubBacklinks.map((entry) => entry.path)).toEqual(['Widget.md']);
  });

  it('skips hidden directories and non-markdown files', async () => {
    note('Real.md', 'A note.');
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    note('node_modules/fake.md', 'Not a note.');
    note('script.ts', 'const x = 1;');
    mkdirSync(join(root, '.obsidian'), { recursive: true });
    note('.obsidian/config.md', 'Vault config.');

    const index = await service.index(root);
    expect(index.notes.map((entry) => entry.path)).toEqual(['Real.md']);
  });

  it('marks truncation instead of scanning without bound', async () => {
    for (let i = 0; i < 30; i += 1) note(`n${i}.md`, `Note ${i} links [[n${(i + 1) % 30}]].`);
    const index = await service.index(root, { maxNotes: 10 });
    expect(index.notes).toHaveLength(10);
    expect(index.truncated).toBe(true);
  });

  it('refuses a backlink path outside the workspace', async () => {
    note('Real.md', 'A note.');
    await expect(service.backlinks(root, '../escape.md')).rejects.toThrow(/outside/i);
  });
});
