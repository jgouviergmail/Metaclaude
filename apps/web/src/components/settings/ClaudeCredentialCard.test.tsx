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
      claudeCliVersion: vi.fn(),
      claudePairing: { begin: vi.fn(), complete: vi.fn(), cancel: vi.fn() },
    },
  };
});

vi.mock('@/lib/api', () => ({ api: apiMock, ApiError: ApiErrorMock }));

const AUTHORIZE_URL = 'https://claude.com/cai/oauth/authorize?code=true&state=abc';

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.claudeCredential.get.mockResolvedValue({ mode: 'none', source: null, hint: null });
  apiMock.claudeCliVersion.mockResolvedValue({
    installed: null,
    latest: null,
    behind: null,
    error: null,
    checkedAt: 0,
  });
  apiMock.claudePairing.begin.mockResolvedValue({
    url: AUTHORIZE_URL,
    expiresAt: 9_999,
    kind: 'token',
  });
  apiMock.claudePairing.complete.mockResolvedValue({
    mode: 'subscription',
    source: 'stored',
    hint: '…DDDD',
  });
  apiMock.claudePairing.cancel.mockResolvedValue({ active: false, expiresAt: null, kind: null });
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

    expect(apiMock.claudePairing.begin).toHaveBeenCalledWith('claudeai', 'token');
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

  it('says when a paired token is shadowing the sign-in, and offers the way out', async () => {
    // Dropping a token is sometimes the upgrade — without this note it reads
    // as a downgrade, and the full-scope sign-in stays shadowed forever.
    apiMock.claudeCredential.get.mockResolvedValue({
      mode: 'subscription',
      source: 'stored',
      hint: '…AAAA',
      cliLogin: LOGIN,
    });
    renderWithProviders(<ClaudeCredentialCard />);

    expect(await screen.findByText(/standing in front of it/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /use the account sign-in/i })).toBeTruthy();
  });

  it('sends the owner to the server environment when that is where the token is', async () => {
    // The button can only drop a *stored* credential. Telling someone to press
    // it when the token is an environment variable sends them to a control
    // that cannot help, so that case gets its own sentence and no button.
    apiMock.claudeCredential.get.mockResolvedValue({
      mode: 'subscription',
      source: 'environment',
      hint: '…AAAA',
      cliLogin: LOGIN,
    });
    renderWithProviders(<ClaudeCredentialCard />);

    expect(await screen.findByText(/server environment/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /use the account sign-in/i })).toBeNull();
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

/**
 * When the sign-in that runs everything stops working.
 *
 * A live deployment ran entirely on the CLI's account sign-in — no token in the
 * vault, none in the environment — and this card said so correctly while saying
 * nothing at all about the fact that the sign-in ends on a fixed date. Measured
 * on that server: the refresh token's expiry did not move across a day and a
 * refresh, so it is a wall rather than a rolling window, and the only warning
 * before it is the one the product chooses to give.
 *
 * The card is where somebody stands when they can act on it, so it is where the
 * date belongs — and it becomes an urgent line only when the end is close,
 * because a permanent one is furniture.
 */
describe('the end of a CLI sign-in', () => {
  const DAY = 86_400_000;

  const signedIn = (signInEndsAt: number | null) => ({
    mode: 'subscription' as const,
    source: 'cli-login' as const,
    hint: null,
    cliLogin: {
      full: true,
      scopes: ['user:profile', 'user:sessions:claude_code'],
      subscriptionType: 'max',
      expiresAt: Date.now() + 3 * 3_600_000,
      signInEndsAt,
    },
    // The status carries the end of whatever is *in force*, and here the
    // sign-in is it. Derived rather than typed twice: the server computes this
    // from the same field, and a fixture that disagreed would be testing a
    // status the API never sends.
    expiresAt: signInEndsAt,
  });

  it('says when the sign-in ends, so the date is somewhere at all', async () => {
    apiMock.claudeCredential.get.mockResolvedValue(signedIn(Date.now() + 60 * DAY));
    renderWithProviders(<ClaudeCredentialCard />);
    expect(await screen.findByText(/sign-in ends/i)).toBeDefined();
  });

  it('makes it urgent only when it is close', async () => {
    apiMock.claudeCredential.get.mockResolvedValue(signedIn(Date.now() + 5 * DAY));
    renderWithProviders(<ClaudeCredentialCard />);
    const line = await screen.findByText(/sign-in ends/i);
    expect(line.className).toMatch(/danger|warning/);
  });

  /**
   * The date the screen never had.
   *
   * A paired token expires too — a year out, and nothing tracked it: the card
   * showed the *sign-in's* countdown whether or not the sign-in applied, so an
   * owner who paired watched a number about a credential their pairing had
   * just shadowed. And the sentence has to name the right remedy: pairing
   * again, not signing in again.
   */
  it('counts down the paired token when that is what is in force', async () => {
    apiMock.claudeCredential.get.mockResolvedValue({
      mode: 'subscription' as const,
      source: 'stored' as const,
      hint: '…AAAA',
      cliLogin: null,
      expiresAt: Date.now() + 300 * DAY,
    });

    renderWithProviders(<ClaudeCredentialCard />);

    expect(await screen.findByText(/paired token expires/i)).toBeDefined();
    expect(screen.queryByText(/sign-in ends/i)).toBeNull();
  });

  it('says nothing when the end is unknown, rather than guessing', async () => {
    apiMock.claudeCredential.get.mockResolvedValue(signedIn(null));
    renderWithProviders(<ClaudeCredentialCard />);
    await screen.findByText(/signed in with a Claude account/i);
    expect(screen.queryByText(/sign-in ends/i)).toBeNull();
  });
});

/**
 * The CLI's version, and the badge when it is behind.
 *
 * A reading, never a button. The CLI is pinned into the image and the
 * container refuses to change it three ways over — non-root process,
 * root-owned directory, read-only filesystem — so "update available" beside a
 * control that could not do it would be worse than silence. What the card owes
 * the operator is where the update actually comes from.
 */
describe('the CLI version', () => {
  const version = (over: Record<string, unknown>) =>
    apiMock.claudeCliVersion.mockResolvedValue({
      installed: '2.1.247',
      latest: '2.1.247',
      behind: false,
      error: null,
      checkedAt: 0,
      ...over,
    });

  it('shows the installed version', async () => {
    version({});
    renderWithProviders(<ClaudeCredentialCard />);

    expect(await screen.findByText(/2\.1\.247/)).toBeTruthy();
  });

  it('badges a newer published version, and says where it comes from', async () => {
    version({ latest: '2.2.0', behind: true });
    renderWithProviders(<ClaudeCredentialCard />);

    expect(await screen.findByText(/2\.2\.0/)).toBeTruthy();
    expect(screen.getByText(/metaclaude update/i)).toBeTruthy();
  });

  it('says nothing when it is current', async () => {
    version({});
    renderWithProviders(<ClaudeCredentialCard />);

    await screen.findByText(/2\.1\.247/);
    expect(screen.queryByText(/metaclaude update/i)).toBeNull();
  });

  /**
   * Unknown is not reassuring. When the registry could not be read the badge
   * stays away rather than claiming the CLI is current — a badge that goes
   * quiet on a broken network is one that lies exactly when it matters.
   */
  it('claims nothing when the registry could not be read', async () => {
    version({ latest: null, behind: null, error: 'ENOTFOUND' });
    renderWithProviders(<ClaudeCredentialCard />);

    await screen.findByText(/2\.1\.247/);
    expect(screen.queryByText(/published/i)).toBeNull();
    expect(screen.queryByText(/metaclaude update/i)).toBeNull();
  });

  it('shows no line at all when the CLI cannot be spawned', async () => {
    version({ installed: null, latest: null, behind: null });
    renderWithProviders(<ClaudeCredentialCard />);

    await screen.findByText(/claude credentials/i);
    expect(screen.queryByText(/claude cli/i)).toBeNull();
  });
});

/**
 * Renewing the account sign-in from the interface.
 *
 * The account sign-in and a paired token are two credentials with two homes,
 * and the whole risk of putting both on one screen is that a wizard started
 * for one finishes as the other. Every case below is about the flows staying
 * told apart — in what is asked for, in what the owner is told, and in what
 * happens when the token they already have is standing in front of the
 * sign-in they just renewed.
 */
const SIGN_IN = {
  full: true,
  scopes: ['user:profile', 'user:inference', 'user:sessions:claude_code', 'user:mcp_servers'],
  subscriptionType: 'max',
  expiresAt: Date.now() + 3_600_000,
  signInEndsAt: Date.now() + 20 * 86_400_000,
};

describe('renewing the account sign-in', () => {
  it('asks for an account sign-in, not a token', async () => {
    apiMock.claudeCredential.get.mockResolvedValue({
      mode: 'subscription',
      source: 'cli-login',
      hint: null,
      cliLogin: SIGN_IN,
      expiresAt: SIGN_IN.signInEndsAt,
    });
    apiMock.claudePairing.begin.mockResolvedValue({
      url: AUTHORIZE_URL,
      expiresAt: 9_999,
      kind: 'account',
    });
    renderWithProviders(<ClaudeCredentialCard />);

    fireEvent.click(await screen.findByRole('button', { name: /renew the sign-in/i }));
    await screen.findByText(AUTHORIZE_URL);

    expect(apiMock.claudePairing.begin).toHaveBeenCalledWith('claudeai', 'account');
    // The two wizards say what they will produce: a code pasted into the wrong
    // one installs the wrong credential in the wrong place.
    expect(screen.getByRole('button', { name: /finish signing in/i })).toBeTruthy();
  });

  it('offers to sign in when no account sign-in exists at all', async () => {
    renderWithProviders(<ClaudeCredentialCard />);
    expect(await screen.findByRole('button', { name: /sign in to a claude account/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /renew the sign-in/i })).toBeNull();
  });

  it('offers to drop the token standing in front of the sign-in', async () => {
    // The renewal cannot take effect while a stored token shadows it, and
    // saying so without offering the one-tap fix is a dead end on a phone.
    apiMock.claudeCredential.get.mockResolvedValue({
      mode: 'subscription',
      source: 'stored',
      hint: '…DDDD',
      cliLogin: SIGN_IN,
      expiresAt: null,
    });
    apiMock.claudeCredential.clear.mockResolvedValue({
      mode: 'subscription',
      source: 'cli-login',
      hint: null,
      cliLogin: SIGN_IN,
      expiresAt: SIGN_IN.signInEndsAt,
    });
    renderWithProviders(<ClaudeCredentialCard />);

    fireEvent.click(await screen.findByRole('button', { name: /use the account sign-in/i }));
    await waitFor(() => expect(apiMock.claudeCredential.clear).toHaveBeenCalled());
  });

  it('does not offer that when there is no sign-in to fall back to', async () => {
    apiMock.claudeCredential.get.mockResolvedValue({
      mode: 'subscription',
      source: 'stored',
      hint: '…DDDD',
      cliLogin: null,
      expiresAt: null,
    });
    renderWithProviders(<ClaudeCredentialCard />);

    await screen.findByText(/claude credentials/i);
    expect(screen.queryByRole('button', { name: /use the account sign-in/i })).toBeNull();
  });

  it('still pairs a token from the same screen', async () => {
    // The fallback stays a first-class path: a token minted elsewhere is a
    // valid way in, and the account flow must not have quietly replaced it.
    apiMock.claudePairing.begin.mockResolvedValue({
      url: AUTHORIZE_URL,
      expiresAt: 9_999,
      kind: 'token',
    });
    renderWithProviders(<ClaudeCredentialCard />);

    fireEvent.click(await screen.findByRole('button', { name: /start pairing/i }));
    await screen.findByText(AUTHORIZE_URL);

    expect(apiMock.claudePairing.begin).toHaveBeenCalledWith('claudeai', 'token');
    expect(screen.getByRole('button', { name: /finish pairing/i })).toBeTruthy();
  });
});
