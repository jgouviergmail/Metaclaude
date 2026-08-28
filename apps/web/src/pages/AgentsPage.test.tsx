/**
 * The Library tab: the shelf renders with kind and category, chips filter it,
 * install goes through the API, and the editors send the category they show.
 * The MCP tab's connector directory: the credential a connector needs gates
 * the button, and what the operator pastes reaches the API once.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { AgentsPage, withDescriptions } from './AgentsPage';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    workspaces: vi.fn(async () => ({ workspaces: [] })),
    skills: vi.fn(async () => ({ skills: [] })),
    agents: vi.fn(async () => ({ agents: [] })),
    mcpServers: vi.fn(async () => ({ servers: [] })),
    library: vi.fn(async () => ({
      entries: [
        {
          kind: 'agent' as const,
          name: 'code-reviewer',
          category: 'engineering' as const,
          description: 'Reviews a diff for real defects.',
          prompt: 'You are a code reviewer.',
          installed: false,
        },
        {
          kind: 'skill' as const,
          name: 'postmortem',
          category: 'general' as const,
          description: 'Write a blameless postmortem.',
          body: '# Postmortems',
          installed: true,
        },
      ],
    })),
    installLibraryEntry: vi.fn(async (name: string) => ({
      id: 'skill_1',
      entry: {
        kind: 'agent' as const,
        name,
        category: 'engineering' as const,
        description: 'Reviews a diff for real defects.',
        prompt: 'You are a code reviewer.',
        installed: true,
      },
    })),
    saveSkill: vi.fn(async () => ({
      skill: { id: 'skill_2', name: 'sql-review' },
    })),
    claudeCatalogue: vi.fn(async () => ({
      models: [],
      commands: [],
      agents: [],
      mcpServers: [],
      account: null,
      unavailable: [],
      fetchedAt: 0,
    })),
    connectors: vi.fn(async () => ({
      connectors: [
        {
          name: 'sentry',
          title: 'Sentry',
          publisher: 'Sentry',
          category: 'ops' as const,
          description: 'Read issues, events and stack traces from your Sentry organisation.',
          transport: 'http' as const,
          url: 'https://mcp.sentry.dev/mcp',
          command: null,
          args: [],
          credential: {
            kind: 'header' as const,
            key: 'Authorization',
            prefix: 'Sentry-Bearer ',
            hint: 'A Sentry user auth token, from your organisation settings.',
            required: true,
          },
          docsUrl: 'https://github.com/getsentry/sentry-mcp',
          installed: false,
        },
        {
          name: 'sequential-thinking',
          title: 'Sequential thinking',
          publisher: 'Anthropic',
          category: 'general' as const,
          description: 'A scratchpad for multi-step reasoning the agent can revise as it goes.',
          transport: 'stdio' as const,
          url: null,
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
          credential: null,
          docsUrl: 'https://github.com/modelcontextprotocol/servers',
          installed: false,
        },
      ],
    })),
    installConnector: vi.fn(async (name: string) => ({
      id: 'mcpServer_1',
      connector: { name, title: name, installed: true },
    })),
  },
}));

vi.mock('@/lib/api', () => ({ api: apiMock, ApiError: class ApiError extends Error {} }));

async function openLibraryTab(): Promise<void> {
  // Radix tabs activate on mousedown, not click — same jsdom trap as its menus.
  const trigger = await screen.findByRole('tab', { name: /library/i });
  fireEvent.mouseDown(trigger, { button: 0 });
  fireEvent.click(trigger);
  await screen.findByText('code-reviewer');
}

describe('the Library tab', () => {
  it('lists the shelf with kind, category, and installed state', async () => {
    renderWithProviders(<AgentsPage />);
    await openLibraryTab();

    expect(screen.getByText('subagent')).toBeDefined();
    // Twice: once as the filter chip, once as the entry's own badge.
    expect(screen.getAllByText('Engineering')).toHaveLength(2);
    // The installed entry shows its state instead of a button.
    expect(screen.getByText('Installed')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Install “postmortem”' })).toBeNull();
  });

  it('installs an entry through the API on a click', async () => {
    renderWithProviders(<AgentsPage />);
    await openLibraryTab();

    fireEvent.click(screen.getByRole('button', { name: 'Install “code-reviewer”' }));
    await waitFor(() => expect(apiMock.installLibraryEntry).toHaveBeenCalledWith('code-reviewer'));
  });

  it('filters the shelf by category chip', async () => {
    renderWithProviders(<AgentsPage />);
    await openLibraryTab();

    fireEvent.click(screen.getByRole('button', { name: 'General' }));
    expect(screen.queryByText('code-reviewer')).toBeNull();
    expect(screen.getByText('postmortem')).toBeDefined();

    // Back to everything.
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(screen.getByText('code-reviewer')).toBeDefined();
  });
});

describe('the skill editor', () => {
  it('sends the category it shows', async () => {
    renderWithProviders(<AgentsPage />);

    fireEvent.click(await screen.findByRole('button', { name: /new skill/i }));
    fireEvent.change(await screen.findByLabelText(/^Name/), { target: { value: 'sql-review' } });
    fireEvent.change(screen.getByLabelText(/^Description/), {
      target: { value: 'Review SQL before it reaches data.' },
    });
    fireEvent.change(screen.getByLabelText(/^Category/), { target: { value: 'data' } });
    fireEvent.click(screen.getByRole('button', { name: /save skill/i }));

    await waitFor(() =>
      expect(apiMock.saveSkill).toHaveBeenCalledWith(expect.objectContaining({ category: 'data' })),
    );
  });
});

/**
 * Call history does not survive a test, and neither does an override.
 *
 * Without this, "the probe was never asked" passed or failed on the order the
 * tests happened to run in: a call made by an earlier test was still on the
 * mock, and `mockResolvedValue` set by one test was still the answer for the
 * next. An assertion whose truth depends on its neighbours is not an assertion.
 */
beforeEach(() => {
  vi.clearAllMocks();
  apiMock.workspaces.mockResolvedValue({ workspaces: [] } as never);
});

async function openMcpTab(): Promise<void> {
  const trigger = await screen.findByRole('tab', { name: /mcp servers/i });
  fireEvent.mouseDown(trigger, { button: 0 });
  fireEvent.click(trigger);
  // "Sentry" is both the title and the publisher badge; anchor on the endpoint.
  await screen.findByText('https://mcp.sentry.dev/mcp');
}

describe('the connector directory', () => {
  it('shows the endpoint and the name of the credential each connector wants', async () => {
    renderWithProviders(<AgentsPage />);
    await openMcpTab();

    expect(screen.getByText('https://mcp.sentry.dev/mcp')).toBeDefined();
    // The header name is the fact nobody guesses, so it is on the card before
    // anything is clicked — that is what makes the list worth scanning.
    expect(screen.getByText('Authorization')).toBeDefined();
    // A stdio connector shows what would actually be spawned.
    expect(
      screen.getByText('npx -y @modelcontextprotocol/server-sequential-thinking'),
    ).toBeDefined();
    // No field until one is asked for: eleven password inputs is a form, not a
    // shelf.
    expect(screen.queryByLabelText(/Authorization/)).toBeNull();
  });

  it('asks for the credential first, then holds the button until it is pasted', async () => {
    // Installing without it succeeds and the server fails at run time with an
    // authentication error the operator reads as a bad token.
    renderWithProviders(<AgentsPage />);
    await openMcpTab();

    const add = screen.getByRole('button', { name: 'Add “sentry”' });
    // Unarmed, the button asks rather than installs — a button disabled before
    // it has requested anything reads as broken.
    expect(add.hasAttribute('disabled')).toBe(false);
    fireEvent.click(add);
    expect(apiMock.installConnector).not.toHaveBeenCalled();

    const field = await screen.findByLabelText(/Authorization/);
    expect(add.hasAttribute('disabled')).toBe(true);

    fireEvent.change(field, { target: { value: 'tok_abc' } });
    expect(add.hasAttribute('disabled')).toBe(false);

    fireEvent.click(add);
    await waitFor(() =>
      expect(apiMock.installConnector).toHaveBeenCalledWith('sentry', 'tok_abc'),
    );
  });

  it('adds a credential-free connector with nothing to fill in', async () => {
    renderWithProviders(<AgentsPage />);
    await openMcpTab();

    const add = screen.getByRole('button', { name: 'Add “sequential-thinking”' });
    expect(add.hasAttribute('disabled')).toBe(false);
    fireEvent.click(add);
    await waitFor(() =>
      expect(apiMock.installConnector).toHaveBeenCalledWith('sequential-thinking', undefined),
    );
  });
});

/**
 * The MCP tab's connection test.
 *
 * The trap it exists to avoid: with no workspace named, the server probes
 * from the data directory, resolves no runtime for it and mounts nothing — so
 * the answer is an empty list of servers. The first version of this button
 * asked anyway and reported "every server answered" while testing none of
 * them, which is a worse outcome than having no button at all.
 */
/**
 * "Test connections" has to name a workspace, and the first two attempts got
 * the consequence wrong.
 *
 * Connecting is a per-workspace act: with none named the probe mounts nothing
 * and answers an empty list. Version one asked anyway and reported "every
 * server answered" over zero servers. Version two disabled the button in the
 * Global scope — honest, and still wrong, because Global is the scope the page
 * *opens in*, so the ordinary path was a dead button explained by a tooltip no
 * touch device can read. It was reported as "the button does not work", which
 * is exactly what it was.
 *
 * A global server is mounted in every workspace, so "which one" has a real
 * answer. The button asks it.
 */
describe('the MCP tab: testing connections', () => {
  it('asks which workspace, rather than refusing, when the scope is global', async () => {
    apiMock.workspaces.mockResolvedValue({
      workspaces: [
        { id: 'ws_1', name: 'Alpha' },
        { id: 'ws_2', name: 'Beta' },
      ],
    } as never);

    renderWithProviders(<AgentsPage />);
    await openMcpTab();

    const button = await screen.findByRole('button', { name: /Test connections/i });
    expect(button.hasAttribute('disabled')).toBe(false);

    // Nothing is probed until a workspace is chosen: an empty answer cached as
    // though it meant something is the bug this whole design avoids.
    expect(apiMock.claudeCatalogue).not.toHaveBeenCalled();

    // Radix opens on pointerdown, not click.
    fireEvent.pointerDown(button, { button: 0 });
    fireEvent.click(button);

    const beta = await screen.findByRole('menuitem', { name: 'Beta' });
    fireEvent.pointerDown(beta, { button: 0 });
    fireEvent.click(beta);

    // The workspace picked, not the one the view is scoped to.
    await waitFor(() =>
      expect(apiMock.claudeCatalogue).toHaveBeenCalledWith({
        workspaceId: 'ws_2',
        refresh: true,
      }),
    );
  });

  it('refuses only when there is nowhere to mount anything', async () => {
    apiMock.workspaces.mockResolvedValue({ workspaces: [] } as never);

    renderWithProviders(<AgentsPage />);
    await openMcpTab();

    const button = await screen.findByRole('button', { name: /Test connections/i });
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(apiMock.claudeCatalogue).not.toHaveBeenCalled();
  });
});

/**
 * Merging two sources that each know half the answer.
 *
 * The catalogue is the authority on which tools a run would see and on the
 * hints the server advertises; it drops the descriptions. The direct probe has
 * the text and nothing else that should be trusted. Merged by name, with the
 * catalogue deciding what exists.
 */
describe('withDescriptions', () => {
  const tools = [
    { name: 'a', description: '', readOnly: true, destructive: null },
    { name: 'b', description: '', readOnly: null, destructive: true },
  ];

  it('fills in the descriptions the catalogue dropped', () => {
    const merged = withDescriptions(tools, {
      instructions: null,
      serverName: 's',
      serverVersion: '1',
      tools: [
        { name: 'a', description: 'Lists things.' },
        { name: 'b', description: 'Deletes things.' },
      ],
    });

    expect(merged.map((tool) => tool.description)).toEqual(['Lists things.', 'Deletes things.']);
    // The annotations are the catalogue's, and survive untouched.
    expect(merged[0]?.readOnly).toBe(true);
    expect(merged[1]?.destructive).toBe(true);
  });

  it('never adds a tool the catalogue did not list', () => {
    // A run mounts what the catalogue mounts. A tool visible only to the
    // direct probe is one no run would ever have.
    const merged = withDescriptions(tools, {
      instructions: null,
      serverName: 's',
      serverVersion: '1',
      tools: [{ name: 'c', description: 'Invisible to runs.' }],
    });

    expect(merged.map((tool) => tool.name)).toEqual(['a', 'b']);
  });

  it('keeps a description the catalogue did provide', () => {
    const merged = withDescriptions(
      [{ name: 'a', description: 'From the CLI.', readOnly: null, destructive: null }],
      { instructions: null, serverName: 's', serverVersion: '1', tools: [{ name: 'a', description: 'From the probe.' }] },
    );

    expect(merged[0]?.description).toBe('From the CLI.');
  });

  it('is a no-op when nothing was asked', () => {
    expect(withDescriptions(tools, undefined)).toEqual(tools);
  });
});
