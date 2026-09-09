/**
 * The two verbs that reach other workspaces.
 *
 * What is worth testing here is the fence and the arithmetic around it: which
 * workspaces a call may read, which of them contribute which arm, and that a
 * slug the run cannot reach is refused with the ones it can. The retrieval
 * itself belongs to the stores and is tested there, so the facade is a double
 * that records what it was asked for.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Workspace } from '@metaclaude/shared';
import {
  PEER_DELEGATE_TOOL,
  PEER_SEARCH_TOOL,
  PEER_TOOL_CATALOGUE,
  buildPeerServer,
  createPeerHandlers,
  peerToolNames,
  type PeerFacade,
} from './peer-tools.js';

const peer = (
  slug: string,
  settings: { memoryEnabled?: boolean; knowledgeEnabled?: boolean } = {},
): Workspace =>
  ({
    id: `ws_${slug}`,
    slug,
    name: slug,
    description: `The ${slug} project.`,
    archived: false,
    settings: {
      memoryEnabled: settings.memoryEnabled ?? true,
      knowledgeEnabled: settings.knowledgeEnabled ?? true,
    },
  }) as unknown as Workspace;

const memoryHit = (workspaceId: string, title: string) => ({
  memory: {
    id: `mem_${title}`,
    workspaceId,
    kind: 'semantic',
    shelf: 'durable',
    title,
    content: `What ${title} says.`,
    tags: [],
    confidence: 1,
    pinned: false,
  },
  score: 1,
});

const passageHit = (workspaceId: string, documentTitle: string) => ({
  chunkId: `chunk_${documentTitle}`,
  documentId: `doc_${documentTitle}`,
  documentTitle,
  sourceName: 'bail.pdf',
  workspaceId,
  heading: 'Préavis',
  text: 'trois mois',
  score: 1,
  pageUnit: 'page',
  pageStart: 4,
  pageEnd: 4,
  lineStart: null,
  lineEnd: null,
});

function make(
  peers: Workspace[],
  answers: {
    memories?: ReturnType<typeof memoryHit>[];
    passages?: ReturnType<typeof passageHit>[];
  } = {},
) {
  const memorySearch = vi.fn(async () => (answers.memories ?? []) as never);
  const knowledgeSearch = vi.fn(async () => (answers.passages ?? []) as never);
  const delegate = vi.fn(async () => ({ status: 'succeeded' as const, finalText: '42', error: null }));
  const facade = {
    delegate,
    memory: { search: memorySearch },
    knowledge: { search: knowledgeSearch },
  } as unknown as PeerFacade;
  return {
    handlers: createPeerHandlers(facade, { runId: 'run_1', peers }),
    memorySearch,
    knowledgeSearch,
    delegate,
  };
}

/**
 * The catalogue is what a workspace pre-approves and what the Tools picker
 * offers; the server is what the run can call. A name in one and not the other
 * is either a pre-approval of nothing or an approval card the operator was
 * promised they would not see.
 */
describe('the catalogue', () => {
  const registered = (verbs: { search: boolean; delegate: boolean }) => {
    const server = buildPeerServer(
      { delegate: async () => ({ status: 'succeeded', finalText: '', error: null }) } as never,
      { runId: 'run_1', peers: [peer('billing')] },
      verbs,
    );
    const table = (server.instance as unknown as { _registeredTools: Record<string, unknown> })
      ._registeredTools;
    return Object.keys(table).sort();
  };

  it('registers exactly what it names, under the names the pre-approvals use', () => {
    expect(registered({ search: true, delegate: true })).toEqual(
      PEER_TOOL_CATALOGUE.map((entry) => entry.name).sort(),
    );
    expect(peerToolNames()).toEqual(
      PEER_TOOL_CATALOGUE.map((entry) => `mcp__metaclaude__${entry.name}`),
    );
  });

  it('registers only the verbs this run holds', () => {
    // The two are decided separately — the search rides with the mount, the
    // verb waits for the workspace's tick — so a server carrying both when the
    // run has one would offer a tool the CLI then refuses.
    expect(registered({ search: true, delegate: false })).toEqual(['search_workspaces']);
    expect(registered({ search: false, delegate: true })).toEqual(['delegate']);
  });

  it('keeps the two constants the supervisor pre-approves by, in step with the rings', () => {
    expect(PEER_SEARCH_TOOL).toBe('mcp__metaclaude__search_workspaces');
    expect(PEER_DELEGATE_TOOL).toBe('mcp__metaclaude__delegate');
    // Ring 1 is pre-approved with the mount, ring 2 is the operator's tick.
    expect(PEER_TOOL_CATALOGUE.filter((entry) => entry.ring === 1).map((entry) => entry.name)).toEqual([
      'search_workspaces',
    ]);
  });
});

describe('search_workspaces', () => {
  it('asks both stores for every peer, and says which it searched', async () => {
    const fx = make([peer('billing'), peer('shop')]);

    const answer = await fx.handlers.search({ query: 'the lease' });

    expect(answer.searched).toEqual(['billing', 'shop']);
    expect(fx.memorySearch).toHaveBeenCalledWith('the lease', {
      workspaceIds: ['ws_billing', 'ws_shop'],
      limit: 6,
    });
    expect(fx.knowledgeSearch).toHaveBeenCalledWith('the lease', {
      workspaceIds: ['ws_billing', 'ws_shop'],
      limit: 6,
    });
  });

  /**
   * The deliberate drop `tool-forwarding.test.ts` records: the slug never
   * reaches the facade, it *becomes* the id set. This is where that is held,
   * because it is also the fence — a call that could name a workspace outside
   * the list would reach past the directory the agent was shown.
   */
  it('narrows to one peer when the caller names it', async () => {
    const fx = make([peer('billing'), peer('shop')]);

    const answer = await fx.handlers.search({ query: 'the lease', workspace: 'shop' });

    expect(answer.searched).toEqual(['shop']);
    expect(fx.memorySearch).toHaveBeenCalledWith('the lease', {
      workspaceIds: ['ws_shop'],
      limit: 6,
    });
  });

  it('refuses a workspace it cannot reach, and names the ones it can', async () => {
    const fx = make([peer('billing'), peer('shop')]);

    // Refused rather than silently widened: a model that mistypes a slug and
    // is answered from the whole deployment reads the answer as being about
    // the workspace it named.
    await expect(fx.handlers.search({ query: 'x', workspace: 'secrets' })).rejects.toThrow(
      /no workspace called "secrets".*billing, shop/s,
    );
    expect(fx.memorySearch).not.toHaveBeenCalled();
  });

  it('honours each peer’s own switches, arm by arm', async () => {
    const fx = make([
      peer('billing', { memoryEnabled: false }),
      peer('shop', { knowledgeEnabled: false }),
    ]);

    await fx.handlers.search({ query: 'the lease' });

    // A workspace that recalls nothing has no memory to offer; one whose
    // library is off has no documents. Reading either while ignoring the
    // switch would be honouring half a setting.
    expect(fx.memorySearch).toHaveBeenCalledWith('the lease', {
      workspaceIds: ['ws_shop'],
      limit: 6,
    });
    expect(fx.knowledgeSearch).toHaveBeenCalledWith('the lease', {
      workspaceIds: ['ws_billing'],
      limit: 6,
    });
  });

  it('does not ask a store no peer contributes to', async () => {
    const fx = make([peer('billing', { memoryEnabled: false, knowledgeEnabled: false })]);

    const answer = await fx.handlers.search({ query: 'the lease' });

    expect(fx.memorySearch).not.toHaveBeenCalled();
    expect(fx.knowledgeSearch).not.toHaveBeenCalled();
    expect(answer).toMatchObject({ memories: [], passages: [] });
  });

  it('labels every hit with the workspace it came from', async () => {
    // Without it an agent quotes "the lease runs to December" and its operator
    // cannot tell which project's lease that is — and the slug is also exactly
    // what `delegate` takes for the follow-up.
    const fx = make([peer('billing'), peer('shop')], {
      memories: [memoryHit('ws_shop', 'Opening hours')],
      passages: [passageHit('ws_billing', 'Bail commercial')],
    });

    const answer = await fx.handlers.search({ query: 'the lease' });

    expect(answer.memories).toEqual([
      { workspace: 'shop', title: 'Opening hours', text: 'What Opening hours says.', kind: 'semantic' },
    ]);
    expect(answer.passages).toEqual([
      {
        workspace: 'billing',
        document: 'Bail commercial',
        heading: 'Préavis',
        location: 'page 4',
        source: 'bail.pdf',
        text: 'trois mois',
      },
    ]);
  });

  it('caps what one call may pull back', async () => {
    const fx = make([peer('billing')]);

    await fx.handlers.search({ query: 'x', limit: 999 });

    expect(fx.memorySearch).toHaveBeenCalledWith('x', { workspaceIds: ['ws_billing'], limit: 20 });
  });
});

describe('delegate', () => {
  it('hands the kernel this run’s id and the resolved slug', async () => {
    const fx = make([peer('billing')]);

    const answer = await fx.handlers.delegate({ workspace: 'billing', prompt: 'the monthly export' });

    expect(fx.delegate).toHaveBeenCalledWith({
      fromRunId: 'run_1',
      target: 'billing',
      prompt: 'the monthly export',
    });
    expect(answer).toEqual({ workspace: 'billing', answer: '42' });
  });

  it('refuses a workspace outside the run’s reach before starting anything', async () => {
    const fx = make([peer('billing')]);

    await expect(fx.handlers.delegate({ workspace: 'secrets', prompt: 'x' })).rejects.toThrow(
      /no workspace called "secrets"/,
    );
    expect(fx.delegate).not.toHaveBeenCalled();
  });

  it('reports a run that did not succeed as a failure, with its reason', async () => {
    const fx = make([peer('billing')]);
    fx.delegate.mockResolvedValueOnce({ status: 'failed', finalText: '', error: 'it ran out of time' } as never);

    await expect(fx.handlers.delegate({ workspace: 'billing', prompt: 'x' })).rejects.toThrow(
      /failed: it ran out of time/,
    );
  });

  it('says so plainly when a successful run produced no text', async () => {
    const fx = make([peer('billing')]);
    fx.delegate.mockResolvedValueOnce({ status: 'succeeded', finalText: '', error: null } as never);

    const answer = await fx.handlers.delegate({ workspace: 'billing', prompt: 'x' });

    expect(answer.answer).toMatch(/without a final message/);
  });
});
