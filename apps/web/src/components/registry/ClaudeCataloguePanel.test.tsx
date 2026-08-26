/**
 * What Claude itself offers, on screen.
 *
 * The panel's job is to answer questions Metaclaude could not answer before:
 * which models this subscription actually grants, which slash commands and
 * subagents exist here, and — the one nothing else could tell an operator —
 * whether each configured MCP server actually connected. A server that is
 * merely *configured* looked identical to one that was working, so a mistyped
 * command read as an agent ignoring its tools.
 *
 * The states worth pinning are therefore the unhappy ones: a server that failed
 * and why, a CLI that could not be reached at all, and a partial answer from an
 * older CLI that supports some control requests and not others.
 */

import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ClaudeCatalogue } from '@metaclaude/shared';
import { renderWithProviders as render } from '@/test/render';
import { ClaudeCataloguePanel } from './ClaudeCataloguePanel';

const catalogue = (over: Partial<ClaudeCatalogue> = {}): ClaudeCatalogue => ({
  models: [],
  commands: [],
  agents: [],
  mcpServers: [],
  account: null,
  unavailable: [],
  fetchedAt: 1_000,
  ...over,
});

const setup = (over: Partial<ClaudeCatalogue> = {}, props: { loading?: boolean } = {}) => {
  const onRefresh = vi.fn();
  render(
    <ClaudeCataloguePanel
      catalogue={props.loading ? undefined : catalogue(over)}
      loading={props.loading ?? false}
      onRefresh={onRefresh}
    />,
  );
  return { onRefresh };
};

describe('MCP server status', () => {
  it('shows why a server failed, in the CLI’s words', () => {
    // "failed" alone sends the operator to the logs. "spawn npx ENOENT" tells
    // them the command is wrong, which is the whole answer.
    setup({
      mcpServers: [
        { name: 'github', status: 'failed', error: 'spawn npx ENOENT', serverName: null, serverVersion: null, scope: null, tools: [] },
      ],
    });

    expect(screen.getByText('github')).toBeTruthy();
    expect(screen.getByText('spawn npx ENOENT')).toBeTruthy();
  });

  it('marks a failed server as an alert, not as a row', () => {
    setup({
      mcpServers: [
        { name: 'github', status: 'failed', error: 'nope', serverName: null, serverVersion: null, scope: null, tools: [] },
      ],
    });

    expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
  });

  it('says a server needs authorising, which is not the same as broken', () => {
    // Distinct because the remedy is completely different: one is a config
    // mistake, the other is a consent flow nobody has completed.
    setup({
      mcpServers: [
        { name: 'linear', status: 'needs-auth', error: null, serverName: null, serverVersion: null, scope: null, tools: [] },
      ],
    });

    expect(screen.getByText(/needs.?auth/i)).toBeTruthy();
  });

  it('lists the tools a connected server actually exposes', () => {
    // The difference between "connected" and "useful".
    setup({
      mcpServers: [
        {
          name: 'fs',
          status: 'connected',
          error: null,
          serverName: 'filesystem',
          serverVersion: '1.2.0',
          scope: null,
          tools: [
            { name: 'read_file', description: 'Read a file', readOnly: true, destructive: null },
            { name: 'write_file', description: 'Write a file', readOnly: null, destructive: true },
          ],
        },
      ],
    });

    expect(screen.getByText('read_file')).toBeTruthy();
    expect(screen.getByText('write_file')).toBeTruthy();
  });

  it('does not invent a version for a server that reported none', () => {
    setup({
      mcpServers: [
        { name: 'fs', status: 'connected', error: null, serverName: null, serverVersion: null, scope: null, tools: [] },
      ],
    });

    expect(screen.queryByText(/v?null/)).toBeNull();
    expect(screen.queryByText(/undefined/)).toBeNull();
  });
});

describe('models, commands and subagents', () => {
  it('shows a model with what it resolves to', () => {
    // An alias silently pointing at a dated model is exactly the kind of thing
    // an operator wants to confirm before blaming their prompt.
    setup({
      models: [
        {
          value: 'opus',
          displayName: 'Opus',
          description: 'Deepest reasoning',
          resolvedModel: 'claude-opus-5',
          supportsEffort: true,
          supportedEffortLevels: ['low', 'high'],
          supportsAdaptiveThinking: false,
        },
      ],
    });

    expect(screen.getByText('Opus')).toBeTruthy();
    expect(screen.getByText('claude-opus-5')).toBeTruthy();
  });

  it('shows commands with their argument hint', () => {
    setup({ commands: [{ name: 'review', description: 'Review the diff', argumentHint: '[path]', aliases: [] }] });

    expect(screen.getByText(/\/review/)).toBeTruthy();
    expect(screen.getByText('[path]')).toBeTruthy();
  });

  it('shows subagents the CLI knows about', () => {
    setup({ agents: [{ name: 'explorer', description: 'Reads widely', model: 'haiku' }] });

    expect(screen.getByText('explorer')).toBeTruthy();
    expect(screen.getByText('Reads widely')).toBeTruthy();
  });
});

describe('the paired account', () => {
  it('names which account the CLI is actually signed in as', () => {
    // Metaclaude can hold credentials without ever saying whose. Confirming the
    // account is how an operator tells "my subscription is not being used" from
    // "my subscription is exhausted", and the two look identical otherwise.
    setup({
      account: {
        email: 'someone@example.com',
        organization: 'Personal',
        subscriptionType: 'max',
        apiProvider: 'firstParty',
      },
    });

    expect(screen.getByText(/someone@example\.com/)).toBeTruthy();
    expect(screen.getByText(/max/i)).toBeTruthy();
  });

  it('says nothing rather than "null" when the CLI reported no account', () => {
    setup({ account: null });

    expect(screen.queryByText(/null|undefined/)).toBeNull();
  });

  it('copes with an account that reports only a subscription', () => {
    // Every field is optional on the wire, and a bare "· " separator with
    // nothing after it is how that shows up if it is not handled.
    setup({
      account: { email: null, organization: null, subscriptionType: 'pro', apiProvider: null },
    });

    expect(screen.getByText(/pro/i)).toBeTruthy();
  });
});

describe('when the answer is incomplete', () => {
  it('says which questions the CLI could not answer', () => {
    // An empty list means something different depending on whether the question
    // failed or the answer was genuinely empty, and only one of those is the
    // operator's problem.
    setup({ unavailable: ['commands', 'agents'] });

    // Matched on the sentence, not on the word: "Slash commands" is also a
    // heading on this screen, and a query that cannot tell them apart would
    // pass whether or not the warning rendered.
    expect(screen.getByText(/could not answer about slash commands, subagents/i)).toBeTruthy();
  });

  it('explains a CLI that could not be reached at all', () => {
    setup({ unavailable: ['session'] });

    expect(screen.getByText(/could not be reached|not be started/i)).toBeTruthy();
  });

  it('shows a loading state rather than an empty catalogue', () => {
    // Reading it spawns a subprocess, so this is a real, visible wait.
    setup({}, { loading: true });

    expect(screen.getByRole('status')).toBeTruthy();
  });

  it('offers a refresh, because the operator just fixed something', () => {
    const { onRefresh } = setup();
    return userEvent.click(screen.getByRole('button', { name: /refresh/i })).then(() => {
      expect(onRefresh).toHaveBeenCalledTimes(1);
    });
  });
});
