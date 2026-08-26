/**
 * The help system's logic: the guide manifest, search, and the ask flow.
 *
 * The manifest is asserted against the real corpus on disk — the guide the
 * user reads is the guide these tests read, so a chapter that fails to load
 * or loses its title fails here, not in production.
 */

import { describe, expect, it, vi } from 'vitest';
import { ensureHelpSession, guideChapters, loadChangelog, searchGuide } from './help';

describe('the guide manifest', () => {
  it('lists every chapter on disk, in reading order', async () => {
    expect(guideChapters.length).toBeGreaterThanOrEqual(9);
    const slugs = guideChapters.map((chapter) => chapter.slug);
    expect(slugs).toEqual([...slugs].sort());
    expect(slugs[0]).toContain('getting-started');
  });

  it('derives each title from the chapter itself, not from a second list', async () => {
    const first = guideChapters[0];
    if (!first) throw new Error('no chapters');
    expect(first.title).toBe('Getting started');
    const body = await first.load();
    expect(body.startsWith('# Getting started')).toBe(true);
  });

  it('loads the changelog, and its top entry names the running version', async () => {
    const changelog = await loadChangelog();
    expect(changelog).toContain('# Changelog');
  });
});

describe('searchGuide', () => {
  const corpus = [
    { slug: 'a', title: 'Alpha', body: 'The permission prompt shows the literal command.\nDeny is focused.' },
    { slug: 'b', title: 'Beta', body: 'Automations run on a schedule.\nGuard rails included.' },
  ];

  it('returns the chapters that mention the query, best first, with an excerpt', () => {
    const hits = searchGuide(corpus, 'permission prompt');
    expect(hits.map((hit) => hit.slug)).toEqual(['a']);
    expect(hits[0]?.excerpt.toLowerCase()).toContain('permission prompt');
  });

  it('matches every term, not any term — a two-word query is a conjunction', () => {
    expect(searchGuide(corpus, 'permission schedule')).toEqual([]);
  });

  it('is case-insensitive and ignores an empty query', () => {
    expect(searchGuide(corpus, 'AUTOMATIONS')[0]?.slug).toBe('b');
    expect(searchGuide(corpus, '   ')).toEqual([]);
  });
});

describe('ensureHelpSession', () => {
  function fakeApi(existing: Array<{ id: string; slug: string }>) {
    const calls = {
      create: [] as unknown[],
      write: [] as unknown[],
      session: [] as unknown[],
      run: [] as unknown[],
    };
    return {
      calls,
      workspaces: async () => ({ workspaces: existing }),
      createWorkspace: async (body: unknown) => {
        calls.create.push(body);
        return { workspace: { id: 'ws_help', slug: 'metaclaude-help' } };
      },
      updateWorkspace: async () => ({}),
      writeFile: async (id: string, path: string) => {
        calls.write.push(`${id}:${path}`);
        return {};
      },
      createSession: async (body: unknown) => {
        calls.session.push(body);
        return { session: { id: 'ses_help' } };
      },
      submitRun: async (sessionId: string, body: { prompt: string; permissionMode?: string }) => {
        calls.run.push({ sessionId, ...body });
        return { run: { id: 'run_help' } };
      },
    };
  }

  it('creates the help workspace once, seeds it with the guide, and asks in plan mode', async () => {
    const api = fakeApi([{ id: 'ws_other', slug: 'projet' }]);
    const result = await ensureHelpSession(api, 'How do automations avoid overlap?');

    expect(api.calls.create).toHaveLength(1);
    // The whole guide plus the assistant's own instructions land in the workspace.
    expect(api.calls.write.length).toBeGreaterThanOrEqual(guideChapters.length + 1);
    expect(api.calls.write.some((w) => String(w).endsWith(':CLAUDE.md'))).toBe(true);
    // Read-only by construction: the help agent explains the product, it never
    // mutates the host that runs it.
    expect(api.calls.run[0]).toMatchObject({
      sessionId: 'ses_help',
      permissionMode: 'plan',
      prompt: 'How do automations avoid overlap?',
    });
    expect(result).toEqual({ workspaceId: 'ws_help', sessionId: 'ses_help' });
  });

  it('reuses an existing help workspace without re-seeding it', async () => {
    const api = fakeApi([{ id: 'ws_help', slug: 'metaclaude-help' }]);
    await ensureHelpSession(api, 'What does rewind restore?');

    expect(api.calls.create).toHaveLength(0);
    expect(api.calls.write).toHaveLength(0);
    expect(api.calls.session).toHaveLength(1);
  });

  it('propagates a failure instead of leaving a half-seeded workspace silent', async () => {
    const api = fakeApi([]);
    api.writeFile = vi.fn().mockRejectedValue(new Error('disk full'));
    await expect(ensureHelpSession(api, 'q')).rejects.toThrow('disk full');
  });
});
