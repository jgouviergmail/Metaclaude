/**
 * The CLI reading, on the screen it moved to.
 *
 * It is three sentences and no controls, so what is worth holding is that each
 * of the three says something true about a *different* state: a missing binary
 * must not read like a present one, and "authenticated" has three answers that
 * bill differently. The version line is the one an operator quotes when
 * something breaks.
 */

import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { ClaudeCliCard } from './ClaudeCliCard';

const { apiMock } = vi.hoisted(() => ({ apiMock: { system: vi.fn() } }));
vi.mock('@/lib/api', () => ({ api: apiMock }));

const health = (over: Record<string, unknown> = {}) => ({
  claudeCli: {
    available: true,
    version: '2.1.263',
    authenticated: true,
    authMode: 'subscription',
    authSource: 'stored',
    authHint: '…DDDD',
    ...over,
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.system.mockResolvedValue(health());
});

describe('the Claude CLI reading', () => {
  it('reports the version and how it authenticates', async () => {
    renderWithProviders(<ClaudeCliCard />);

    expect(await screen.findByText('2.1.263')).toBeTruthy();
    expect(screen.getByText(/subscription/i)).toBeTruthy();
    // The hint is what tells two tokens apart without showing either.
    expect(screen.getByText('…DDDD')).toBeTruthy();
    expect(screen.getByText(/paired here/i)).toBeTruthy();
  });

  it('says an API key is billed per token rather than calling it a subscription', async () => {
    // The two are both "authenticated" and cost entirely different things; a
    // card that flattened them would hide a bill.
    apiMock.system.mockResolvedValue(health({ authMode: 'api_key', authSource: 'environment' }));
    renderWithProviders(<ClaudeCliCard />);

    expect(await screen.findByText(/pay as you go/i)).toBeTruthy();
    expect(screen.getByText(/from the environment/i)).toBeTruthy();
  });

  it('names the account sign-in, which is a third thing again', async () => {
    apiMock.system.mockResolvedValue(health({ authSource: 'cli-login', authHint: null }));
    renderWithProviders(<ClaudeCliCard />);

    expect(await screen.findByText(/CLI account sign-in/i)).toBeTruthy();
  });

  it('does not read as present when the binary is missing', async () => {
    apiMock.system.mockResolvedValue(
      health({ available: false, version: null, authMode: 'none', authSource: null, authHint: null }),
    );
    renderWithProviders(<ClaudeCliCard />);

    expect(await screen.findByText(/not found/i)).toBeTruthy();
    expect(screen.getByText(/none configured/i)).toBeTruthy();
    expect(screen.getByText('—')).toBeTruthy();
  });
});
