/**
 * The Library tab: the shelf renders with kind and category, chips filter it,
 * install goes through the API, and the editors send the category they show.
 * The MCP tab's connector directory: the credential a connector needs gates
 * the button, and what the operator pastes reaches the API once.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { AgentsPage } from './AgentsPage';

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
