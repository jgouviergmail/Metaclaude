/**
 * Sign-in.
 *
 * Two-step when TOTP is enabled: the password form submits, the server replies
 * `totp_required`, and the same form swaps to a code field without losing what
 * was typed. The error copy never distinguishes "no such user" from "wrong
 * password", matching what the API does.
 */

import { Fingerprint, KeyRound, Loader2, ShieldCheck } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { APP_NAME } from '@metaclaude/shared';
import { api, ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { assertPasskey, isCeremonyCancelled, passkeyDomainOk, passkeySupported } from '@/lib/passkeys';
import { useAuthStore } from '@/lib/store';
import { Button, Input, Label } from '@/components/ui/primitives';

export function LoginPage() {
  const navigate = useNavigate();
  const setUser = useAuthStore((state) => state.setUser);
  const t = useT();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [needsTotp, setNeedsTotp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const totpRef = useRef<HTMLInputElement>(null);

  const { data: bootstrap } = useQuery({
    queryKey: ['bootstrap-status'],
    queryFn: () => api.bootstrapStatus(),
    retry: false,
  });

  useEffect(() => {
    if (needsTotp) totpRef.current?.focus();
  }, [needsTotp]);

  // Offered only when pressing it could work: a passkey exists somewhere, the
  // browser has the API, and we are on a domain (a passkey cannot be scoped
  // to an IP address — the server refuses enrolment there for the same reason).
  const offerPasskey =
    Boolean(bootstrap?.passkeysEnrolled) && passkeySupported() && passkeyDomainOk();

  const signInWithPasskey = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const { ceremonyId, options } = await api.passkeys.loginBegin();
      const response = await assertPasskey(options);
      const result = await api.passkeys.loginFinish(ceremonyId, response);
      setUser(result.user);
      navigate('/', { replace: true });
    } catch (caught) {
      // Closing the browser's passkey sheet is a choice, not an error.
      if (isCeremonyCancelled(caught)) return;
      setError(
        caught instanceof ApiError ? caught.message : t('That passkey did not sign in. Try your password.'),
      );
    } finally {
      setBusy(false);
    }
  };

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const result = await api.login({
        username,
        password,
        ...(needsTotp ? { totp } : {}),
      });

      if (result.status === 'totp_required') {
        setNeedsTotp(true);
        return;
      }

      setUser(result.user);
      navigate('/', { replace: true });
    } catch (caught) {
      const message =
        caught instanceof ApiError
          ? caught.message
          : t('Could not reach the server. Check that it is running.');
      setError(message);
      // A rejected code is far more often a typo than a wrong password, so keep
      // the operator on the code step rather than sending them back.
      if (needsTotp) setTotp('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center bg-bg px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <Logo />
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-ink">{APP_NAME}</h1>
            <p className="mt-1 text-[13px] text-muted">{t('Your private agentic OS.')}</p>
          </div>
        </div>

        {bootstrap?.needsBootstrap ? (
          <div className="mb-4 rounded-xl border border-warning/30 bg-warning-soft/40 p-4 text-[13px] leading-relaxed text-ink">
            <p className="font-medium">{t('No account exists yet.')}</p>
            <p className="mt-1 text-muted">
              Set <code className="font-mono text-[12px]">METACLAUDE_BOOTSTRAP_USER</code> and{' '}
              <code className="font-mono text-[12px]">METACLAUDE_BOOTSTRAP_PASSWORD</code> in your{' '}
              <code className="font-mono text-[12px]">.env</code>, then restart the container.
            </p>
          </div>
        ) : null}

        <form
          onSubmit={(event) => void submit(event)}
          className="space-y-4 rounded-2xl border border-line bg-surface p-6 shadow-[var(--mc-shadow)]"
        >
          {!needsTotp ? (
            <>
              <Label htmlFor="username">
                {t('Username')}
                <Input
                  id="username"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  autoComplete="username"
                  autoFocus
                  required
                  className="mt-1.5"
                />
              </Label>

              <Label htmlFor="password">
                {t('Password')}
                <Input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="current-password"
                  required
                  className="mt-1.5"
                />
              </Label>
            </>
          ) : (
            <>
              <div className="flex items-center gap-2 rounded-lg bg-accent-soft px-3 py-2 text-[13px] text-accent">
                <ShieldCheck className="size-4 shrink-0" aria-hidden />
                {t('Enter the code from your authenticator app.')}
              </div>

              <Label htmlFor="totp" hint={t('A recovery code also works here.')}>
                {t('Verification code')}
                <Input
                  id="totp"
                  ref={totpRef}
                  value={totp}
                  onChange={(event) => setTotp(event.target.value.trim())}
                  // Not `numeric`: the hint above promises a recovery code
                  // works here, and those are `XXXXX-XXXXX`. A numeric keypad
                  // on a phone makes the one credential that exists for a lost
                  // authenticator the hardest thing on the screen to type.
                  inputMode="text"
                  autoComplete="one-time-code"
                  autoCapitalize="characters"
                  spellCheck={false}
                  placeholder={t('123456 or ABCDE-FGHJK')}
                  required
                  className="mt-1.5 text-center font-mono text-lg tracking-[0.35em]"
                />
              </Label>
            </>
          )}

          {error ? (
            <p role="alert" className="text-[13px] leading-relaxed text-danger">
              {error}
            </p>
          ) : null}

          <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <KeyRound className="size-4" />}
            {needsTotp ? t('Verify') : t('Sign in')}
          </Button>

          {needsTotp ? (
            <button
              type="button"
              onClick={() => {
                setNeedsTotp(false);
                setTotp('');
                setError(null);
              }}
              className="w-full text-center text-[12.5px] text-muted hover:text-ink"
            >
              {t('Use a different account')}
            </button>
          ) : null}

          {offerPasskey && !needsTotp ? (
            <>
              <div className="flex items-center gap-3 text-[11px] uppercase tracking-wide text-subtle">
                <span className="h-px flex-1 bg-line" aria-hidden />
                {t('or')}
                <span className="h-px flex-1 bg-line" aria-hidden />
              </div>
              <Button
                type="button"
                variant="secondary"
                size="lg"
                className="w-full"
                disabled={busy}
                onClick={() => void signInWithPasskey()}
              >
                <Fingerprint className="size-4" aria-hidden />
                {t('Sign in with a passkey')}
              </Button>
            </>
          ) : null}
        </form>

        <p className="mt-6 text-center text-[11.5px] leading-relaxed text-subtle">
          {t('This instance is private. Every action is recorded in a hash-chained audit log.')}
        </p>
      </div>
    </div>
  );
}

function Logo() {
  return (
    <svg viewBox="0 0 32 32" className="size-12" aria-hidden>
      <defs>
        <linearGradient id="mc-login-logo" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="var(--mc-accent)" />
          <stop offset="100%" stopColor="var(--mc-thinking)" />
        </linearGradient>
      </defs>
      <circle
        cx="16"
        cy="16"
        r="11"
        fill="none"
        stroke="url(#mc-login-logo)"
        strokeWidth="3"
        strokeLinecap="round"
        strokeDasharray="52 17"
        transform="rotate(-45 16 16)"
      />
      <circle cx="16" cy="16" r="3.5" fill="url(#mc-login-logo)" />
    </svg>
  );
}
