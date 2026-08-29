/**
 * The MCP gateway card.
 *
 * What is worth testing here is not that a list renders — it is that the screen
 * tells the truth about a credential. A token's reach has to be legible before
 * anyone decides to mint one, the value has to be visible exactly once, and a
 * token that stopped working has to say *which* way it stopped: revoked is a
 * decision somebody made, expired is one nobody did.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiTokenRecord } from '@metaclaude/shared';

import { renderWithProviders } from '@/test/render';

import { McpGatewayCard, describeCeiling, tokenState } from './McpGatewayCard';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    apiTokens: vi.fn(),
    createApiToken: vi.fn(),
    revokeApiToken: vi.fn(),
    gatewayEndpoint: vi.fn(),
    workspaces: vi.fn(),
  },
}));

vi.mock('@/lib/api', () => ({ api: apiMock, ApiError: class ApiError extends Error {} }));

const token = (overrides: Partial<ApiTokenRecord> = {}): ApiTokenRecord => ({
  id: 'tok_1',
  name: 'n8n production',
  scopes: ['run', 'read'],
  workspaceIds: ['ws_1'],
  ceiling: 'dontAsk',
  createdBy: 'jules',
  createdAt: Date.now() - 86_400_000,
  expiresAt: Date.now() + 30 * 86_400_000,
  lastUsedAt: null,
  revokedAt: null,
  hint: 'mck_tok_01M1',
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.apiTokens.mockResolvedValue({ tokens: [] });
  apiMock.gatewayEndpoint.mockResolvedValue({ url: 'https://mc.example/api/gateway/mcp' });
  apiMock.workspaces.mockResolvedValue({
    workspaces: [
      { id: 'ws_1', name: 'Metaclaude', slug: 'metaclaude' },
      { id: 'ws_2', name: 'Side project', slug: 'side' },
    ],
  });
});

describe('the endpoint', () => {
  it('shows the address to paste into the other application', async () => {
    renderWithProviders(<McpGatewayCard />);

    expect(await screen.findByText('https://mc.example/api/gateway/mcp')).toBeDefined();
  });

  /**
   * A deployment with no public URL cannot be told its own address, and a
   * wrong one produces a connection error that reads exactly like a bad token.
   * Saying so beats showing a guess.
   */
  it('says why it cannot show one, rather than guessing', async () => {
    apiMock.gatewayEndpoint.mockResolvedValue({ url: null });
    renderWithProviders(<McpGatewayCard />);

    expect(await screen.findByText(/METACLAUDE_PUBLIC_URL/)).toBeDefined();
  });
});

describe('the listing', () => {
  it('puts a token’s reach on the card: where, what, and the ceiling', async () => {
    apiMock.apiTokens.mockResolvedValue({ tokens: [token()] });
    renderWithProviders(<McpGatewayCard />);

    expect(await screen.findByText('n8n production')).toBeDefined();
    // The workspace by name, not by id — an id tells an operator nothing.
    expect(screen.getByText(/Metaclaude/)).toBeDefined();
    expect(screen.getByText(/pre-approves/)).toBeDefined();
    // The capability that executes things is the one flagged.
    expect(screen.getByText('can start runs')).toBeDefined();
  });

  it('marks a read-only token as read-only rather than flagging it', async () => {
    apiMock.apiTokens.mockResolvedValue({ tokens: [token({ scopes: ['read'] })] });
    renderWithProviders(<McpGatewayCard />);

    expect(await screen.findByText('read only')).toBeDefined();
    expect(screen.queryByText('can start runs')).toBeNull();
  });

  it('never renders anything that could be a secret', async () => {
    apiMock.apiTokens.mockResolvedValue({ tokens: [token()] });
    const { container } = renderWithProviders(<McpGatewayCard />);
    await screen.findByText('n8n production');

    // The hint is short by construction; the card must not be showing more.
    expect(container.textContent).toContain('mck_tok_01M1');
    expect(container.textContent).not.toMatch(/mck_tok_[A-Za-z0-9]{20,}/);
  });

  it('offers no revoke button for a token that is already dead', async () => {
    apiMock.apiTokens.mockResolvedValue({
      tokens: [token({ revokedAt: Date.now() - 1000 })],
    });
    renderWithProviders(<McpGatewayCard />);
    await screen.findByText('n8n production');

    expect(screen.getByText('revoked')).toBeDefined();
    expect(screen.queryByLabelText(/Revoke n8n/)).toBeNull();
  });
});

describe('minting', () => {
  it('will not create a token that reaches nothing', async () => {
    renderWithProviders(<McpGatewayCard />);
    fireEvent.click(await screen.findByRole('button', { name: 'New token' }));

    fireEvent.change(screen.getByPlaceholderText('The application that will use it'), {
      target: { value: 'n8n' },
    });

    // Named but pointed at no workspace: the button stays out of reach, because
    // "every workspace" is not on offer and an empty list is a mistake.
    expect(screen.getByRole('button', { name: 'Create token' }).getAttribute('disabled')).not.toBeNull();

    fireEvent.click(screen.getByLabelText('Metaclaude'));
    expect(screen.getByRole('button', { name: 'Create token' }).getAttribute('disabled')).toBeNull();
  });

  it('shows the value exactly once, and says that is what it is doing', async () => {
    apiMock.createApiToken.mockResolvedValue({
      token: token(),
      secret: 'mck_tok_01M1_thesecretvaluethatmustneverbestored',
    });
    renderWithProviders(<McpGatewayCard />);

    fireEvent.click(await screen.findByRole('button', { name: 'New token' }));
    fireEvent.change(screen.getByPlaceholderText('The application that will use it'), {
      target: { value: 'n8n' },
    });
    fireEvent.click(screen.getByLabelText('Metaclaude'));
    fireEvent.click(screen.getByRole('button', { name: 'Create token' }));

    expect(
      await screen.findByText('mck_tok_01M1_thesecretvaluethatmustneverbestored'),
    ).toBeDefined();
    expect(screen.getByText(/only time it is shown/i)).toBeDefined();

    // Dismissed, it is gone from the document — the component holds it in
    // state and nothing re-fetches it, because nothing can.
    fireEvent.click(screen.getByRole('button', { name: 'I have saved it' }));
    await waitFor(() =>
      expect(
        screen.queryByText('mck_tok_01M1_thesecretvaluethatmustneverbestored'),
      ).toBeNull(),
    );
  });
});

describe('tokenState', () => {
  /**
   * Three states, not two. An operator debugging a dead integration needs to
   * tell "I turned this off" from "this ran out while I was not looking" —
   * different causes, different fixes.
   */
  it('tells a revoked token from one that merely ran out', () => {
    const now = 1_000_000;
    expect(tokenState(token({ revokedAt: 5 }), now)).toBe('revoked');
    expect(tokenState(token({ expiresAt: now - 1 }), now)).toBe('expired');
    expect(tokenState(token({ expiresAt: now + 1 }), now)).toBe('live');
  });

  it('calls a revoked token revoked even when it also expired', () => {
    // Revocation is the decision somebody made; it outranks the clock.
    expect(tokenState(token({ revokedAt: 5, expiresAt: 10 }), 1_000)).toBe('revoked');
  });
});

describe('describeCeiling', () => {
  const t = ((text: string) => text) as never;

  it('says what each ceiling permits, in terms of what executes', () => {
    expect(describeCeiling('plan', t)).toMatch(/no tool ever executes/i);
    expect(describeCeiling('acceptEdits', t)).toMatch(/edits files/i);
  });

  /**
   * This line used to read "runs what this workspace already allows" — and no
   * workspace could allow anything: the setting existed in the schema, reached
   * the CLI, and had no control anywhere in the app. So the sentence described
   * a configuration that did not exist, and the ceiling it describes is the
   * form's own default. Measured at the time: a run under it was refused
   * `WebSearch`, `Write` and every mutating shell command.
   *
   * It now points at the control that makes it true, which is the only reason
   * the claim is allowed to stand.
   */
  it('points the dontAsk ceiling at the setting that decides what it may run', () => {
    expect(describeCeiling('dontAsk', t)).toMatch(/pre-approve/i);
    expect(describeCeiling('dontAsk', t)).toMatch(/refuses the rest/i);
  });
});
