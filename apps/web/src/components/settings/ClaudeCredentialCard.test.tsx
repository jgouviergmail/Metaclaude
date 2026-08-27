/**
 * The guided pairing wizard.
 *
 * What matters here is where each failure leaves the owner: a bad code keeps
 * the box (and the attempt) so a re-paste can work, a lost attempt folds the
 * wizard back to its start, and the token itself never appears anywhere in
 * this component — only the code travels up.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { ClaudeCredentialCard } from './ClaudeCredentialCard';

const { apiMock, ApiErrorMock } = vi.hoisted(() => {
  class ApiErrorMock extends Error {
    constructor(
      readonly status: number,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    ApiErrorMock,
    apiMock: {
      claudeCredential: { get: vi.fn(), save: vi.fn(), clear: vi.fn() },
      claudePairing: { begin: vi.fn(), complete: vi.fn(), cancel: vi.fn() },
    },
  };
});

vi.mock('@/lib/api', () => ({ api: apiMock, ApiError: ApiErrorMock }));

const AUTHORIZE_URL = 'https://claude.com/cai/oauth/authorize?code=true&state=abc';

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.claudeCredential.get.mockResolvedValue({ mode: 'none', source: null, hint: null });
  apiMock.claudePairing.begin.mockResolvedValue({ url: AUTHORIZE_URL, expiresAt: 9_999 });
  apiMock.claudePairing.complete.mockResolvedValue({
    mode: 'subscription',
    source: 'stored',
    hint: '…DDDD',
  });
  apiMock.claudePairing.cancel.mockResolvedValue({ active: false, expiresAt: null });
});

async function startPairing() {
  renderWithProviders(<ClaudeCredentialCard />);
  fireEvent.click(screen.getByRole('button', { name: /start pairing/i }));
  await screen.findByText(AUTHORIZE_URL);
}

describe('the guided pairing wizard', () => {
  it('shows the sign-in link both ways: opened here, or copied to another device', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    await startPairing();

    expect(apiMock.claudePairing.begin).toHaveBeenCalledWith('claudeai');
    fireEvent.click(screen.getByRole('button', { name: /open claude\.ai/i }));
    expect(open).toHaveBeenCalledWith(AUTHORIZE_URL, '_blank', 'noopener,noreferrer');
    // The copyable rendering is what makes the cross-device story real.
    expect(screen.getByText(AUTHORIZE_URL)).toBeTruthy();
    open.mockRestore();
  });

  it('sends the pasted code and folds back to the start once paired', async () => {
    await startPairing();

    fireEvent.change(screen.getByLabelText(/paste the code here/i), {
      target: { value: '  the-code#abc  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: /finish pairing/i }));

    await waitFor(() =>
      expect(apiMock.claudePairing.complete).toHaveBeenCalledWith('  the-code#abc  '),
    );
    // Paired: the wizard offers a fresh start rather than a stale step two.
    expect(await screen.findByRole('button', { name: /start pairing/i })).toBeTruthy();
  });

  it('keeps the code box on a rejected code, so a re-paste can work', async () => {
    apiMock.claudePairing.complete.mockRejectedValue(
      new ApiErrorMock(400, 'Claude did not accept that code.'),
    );
    await startPairing();

    fireEvent.change(screen.getByLabelText(/paste the code here/i), {
      target: { value: 'mistyped' },
    });
    fireEvent.click(screen.getByRole('button', { name: /finish pairing/i }));

    await waitFor(() => expect(apiMock.claudePairing.complete).toHaveBeenCalled());
    expect(screen.getByLabelText(/paste the code here/i)).toBeTruthy();
  });

  it('folds the wizard back when the server no longer holds the attempt', async () => {
    // A 409 means a restart or a newer attempt elsewhere: the code box could
    // only ever fail from here, and leaving it up would read as "try harder".
    apiMock.claudePairing.complete.mockRejectedValue(
      new ApiErrorMock(409, 'No pairing is in progress here.'),
    );
    await startPairing();

    fireEvent.change(screen.getByLabelText(/paste the code here/i), {
      target: { value: 'orphaned' },
    });
    fireEvent.click(screen.getByRole('button', { name: /finish pairing/i }));

    expect(await screen.findByRole('button', { name: /start pairing/i })).toBeTruthy();
    expect(screen.queryByLabelText(/paste the code here/i)).toBeNull();
  });

  it('cancels server-side as well as locally', async () => {
    await startPairing();
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));

    await waitFor(() => expect(apiMock.claudePairing.cancel).toHaveBeenCalled());
    expect(await screen.findByRole('button', { name: /start pairing/i })).toBeTruthy();
  });
});

describe('the CLI account sign-in', () => {
  const LOGIN = {
    full: true,
    scopes: ['user:profile', 'user:inference', 'user:sessions:claude_code'],
    subscriptionType: 'max',
    expiresAt: null,
  };

  it('says runs use the sign-in when nothing overrides it', async () => {
    apiMock.claudeCredential.get.mockResolvedValue({
      mode: 'subscription',
      source: 'cli-login',
      hint: null,
      cliLogin: LOGIN,
    });
    renderWithProviders(<ClaudeCredentialCard />);

    expect(await screen.findByText(/signed in with a claude account/i)).toBeTruthy();
    expect(screen.getByText(/full scope/i)).toBeTruthy();
  });

  it('says when a paired token is shadowing the sign-in, and what removes it', async () => {
    // Removing a token is sometimes the upgrade — without this note it reads
    // as a downgrade, and the full-scope sign-in stays shadowed forever.
    apiMock.claudeCredential.get.mockResolvedValue({
      mode: 'subscription',
      source: 'stored',
      hint: '…AAAA',
      cliLogin: LOGIN,
    });
    renderWithProviders(<ClaudeCredentialCard />);

    expect(await screen.findByText(/overrides it/i)).toBeTruthy();
    expect(screen.getByText(/remove the token/i)).toBeTruthy();
  });

  it('stays silent when the CLI store holds no sign-in', async () => {
    renderWithProviders(<ClaudeCredentialCard />);
    await screen.findByRole('button', { name: /start pairing/i });
    expect(screen.queryByText(/signed in with a claude account/i)).toBeNull();
    expect(screen.queryByText(/overrides it/i)).toBeNull();
  });
});

describe('the manual fallback', () => {
  it('still pairs by pasting a token directly', async () => {
    apiMock.claudeCredential.save.mockResolvedValue({
      mode: 'subscription',
      source: 'stored',
      hint: '…AAAA',
    });
    renderWithProviders(<ClaudeCredentialCard />);

    fireEvent.change(screen.getByLabelText(/paste a token or api key yourself/i), {
      target: { value: 'sk-ant-oat01-pasted' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save token/i }));

    await waitFor(() =>
      expect(apiMock.claudeCredential.save).toHaveBeenCalledWith('sk-ant-oat01-pasted'),
    );
  });
});
