/**
 * Pairing the deployment with a Claude subscription, without a shell.
 *
 * The guided flow is the point: the server builds the same OAuth link
 * `claude setup-token` would, the owner approves it in their own browser —
 * this device or any other — and pastes back the code Claude displays. The
 * token never passes through this page; the server exchanges and seals it.
 *
 * Pasting a ready-made token stays available below, because a token minted
 * elsewhere (or an API key, for Console accounts) is still a valid way in.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import type { ClaudePairingStart } from '@metaclaude/shared';
import { ConfirmDialog } from '@/components/ui/Modal';
import { CopyableCode } from '@/components/ui/CopyableCode';
import { Button, Card, CardHeader, Input, Label } from '@/components/ui/primitives';
import { api, ApiError } from '@/lib/api';
import { Trans, useT } from '@/lib/i18n';
import { cn, formatRelative } from '@/lib/utils';

export function ClaudeCredentialCard() {
  const t = useT();
  const queryClient = useQueryClient();
  const [start, setStart] = useState<ClaudePairingStart | null>(null);
  const [code, setCode] = useState('');
  const [value, setValue] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);

  const status = useQuery({
    queryKey: ['claude-credential'],
    queryFn: () => api.claudeCredential.get(),
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['claude-credential'] });
    void queryClient.invalidateQueries({ queryKey: ['system'] });
  };

  const paired = (saved: { mode: string }) => {
    refresh();
    toast.success(
      saved.mode === 'subscription'
        ? t('Paired with your Claude subscription.')
        : 'API key saved — runs will be billed per token.',
    );
  };

  const begin = useMutation({
    mutationFn: () => api.claudePairing.begin('claudeai'),
    onSuccess: (next) => {
      setStart(next);
      setCode('');
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t('Could not start pairing.')),
  });

  const complete = useMutation({
    mutationFn: (pasted: string) => api.claudePairing.complete(pasted),
    onSuccess: (next) => {
      setStart(null);
      setCode('');
      paired(next);
    },
    onError: (error) => {
      toast.error(error instanceof ApiError ? error.message : t('Pairing failed.'));
      // 409 means the server no longer holds this attempt (a restart, or a
      // newer one elsewhere) — the code box would only ever fail, so fold
      // the wizard back to its start.
      if (error instanceof ApiError && error.status === 409) setStart(null);
    },
  });

  const cancel = useMutation({
    mutationFn: () => api.claudePairing.cancel(),
    onSettled: () => {
      setStart(null);
      setCode('');
    },
  });

  const save = useMutation({
    mutationFn: (token: string) => api.claudeCredential.save(token),
    onSuccess: (next) => {
      setValue('');
      paired(next);
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t(
        'Could not save that credential.',
      )),
  });

  const clear = useMutation({
    mutationFn: () => api.claudeCredential.clear(),
    onSuccess: () => {
      refresh();
      setConfirmClear(false);
      toast.success(t('Credential removed.'));
    },
  });

  const stored = status.data?.source === 'stored';

  return (
    <Card>
      <CardHeader
        title={t('Claude credentials')}
        description={t(
          'What every agent run authenticates with. Stored encrypted, never written to a file.',
        )}
      />
      <div className="space-y-5 px-4 pb-4">
        {/* ---------------------- The CLI's own sign-in --------------------- */}
        {/* `claude auth login` run in the container is the one credential
            Anthropic grants the session-sync scopes to — and any token
            Metaclaude injects overrides it. Both facts belong where the
            tokens are managed, or removing a token looks like a downgrade
            when it is sometimes the upgrade. */}
        {status.data?.source === 'cli-login' ? (
          <p className="rounded-lg bg-accent-soft px-3 py-2.5 text-caption leading-relaxed text-ink">
            {t(
              'The CLI is signed in with a Claude account{plan}{scope} — runs use that sign-in. Pairing a token below would override it.',
              {
                plan: status.data.cliLogin?.subscriptionType
                  ? ` (${status.data.cliLogin.subscriptionType})`
                  : '',
                scope: status.data.cliLogin?.full
                  ? t(', full scope')
                  : t(', inference only'),
              },
            )}
          </p>
        ) : status.data?.cliLogin ? (
          <p className="rounded-lg border border-dashed border-line px-3 py-2.5 text-caption leading-relaxed text-muted">
            {t(
              'A CLI account sign-in also exists{scope}, but the {source} token overrides it. Remove the token to let the account sign-in take over.',
              {
                scope: status.data.cliLogin.full ? t(
                  ' (full scope — claude.ai session sync)',
                ) : '',
                source: status.data.source === 'stored' ? t('paired') : t('environment'),
              },
            )}
          </p>
        ) : null}

        {/*
            When the sign-in stops working, said where somebody can act on it.

            The date is the *refresh* token's, not the access token's: measured
            on a live deployment, the access token rotated across a day while
            this one did not move at all, so it is a wall rather than a rolling
            window and no amount of use pushes it back. Absent means unknown —
            a pasted setup token carries no such field — and unknown is not
            worth a line. It turns urgent only near the end, because a
            permanent warning is furniture.
        */}
        <SignInEnds endsAt={status.data?.cliLogin?.signInEndsAt ?? null} />

        {/* ------------------------- Guided pairing ------------------------- */}
        <div className="space-y-3">
          <h3 className="text-body font-semibold text-ink">{t(
            'Pair with your Claude account',
          )}</h3>

          {start === null ? (
            <>
              <p className="text-caption leading-relaxed text-muted">
                <Trans
                  template={t(
                    'Metaclaude runs the {command} flow for you: sign in at claude.ai, approve, paste back the code it shows. Works entirely from this device. Console (per-token) accounts paste their API key below instead.',
                  )}
                  values={{ command: <code className="font-mono">{t(
                    'claude setup-token',
                  )}</code> }}
                />
              </p>
              <Button
                variant="primary"
                size="sm"
                loading={begin.isPending}
                onClick={() => begin.mutate()}
              >
                {t('Start pairing')}
              </Button>
            </>
          ) : (
            <div className="space-y-3 rounded-lg border border-line bg-sunken p-3">
              <div className="space-y-2">
                <p className="text-body text-ink">
                  <span className="font-semibold">1 ·</span> {t(
                    'Open the sign-in link and approve. Claude then displays a code.',
                  )}
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => window.open(start.url, '_blank', 'noopener,noreferrer')}
                  >
                    <ExternalLink className="size-3.5" />
                    {t('Open claude.ai')}
                  </Button>
                  <span className="text-caption text-subtle">{t(
                    'or copy it to another device:',
                  )}</span>
                </div>
                <CopyableCode value={start.url} label={t('Copy the sign-in link')} />
              </div>

              <div className="space-y-2">
                <Label htmlFor="pairing-code">
                  <span className="font-semibold">2 ·</span> {t('Paste the code here')}
                </Label>
                <Input
                  id="pairing-code"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={t('the code Claude displayed')}
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && code.trim()) complete.mutate(code);
                  }}
                />
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="primary"
                  size="sm"
                  disabled={!code.trim()}
                  loading={complete.isPending}
                  onClick={() => complete.mutate(code)}
                >
                  {t('Finish pairing')}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => cancel.mutate()}>
                  {t('Cancel')}
                </Button>
                <span className="text-caption text-subtle">{t(
                  'The link stays valid for 10 minutes.',
                )}</span>
              </div>
            </div>
          )}
        </div>

        {/* ------------------------- Manual fallback ------------------------ */}
        <div className="space-y-2">
          <Label htmlFor="claude-token">{t('Or paste a token or API key yourself')}</Label>
          <Input
            id="claude-token"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={t('sk-ant-oat01-…')}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && value.trim()) save.mutate(value);
            }}
          />
          <p className="text-caption text-muted">
            <Trans
              template={t(
                'A token beginning {oat} uses your Pro or Max subscription — {command} on any signed-in machine prints one. One beginning {api} bills per token instead. Metaclaude tells them apart on its own.',
              )}
              values={{
                oat: <code className="font-mono">sk-ant-oat</code>,
                command: <code className="font-mono">claude setup-token</code>,
                api: <code className="font-mono">sk-ant-api</code>,
              }}
            />
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            disabled={!value.trim()}
            loading={save.isPending}
            onClick={() => save.mutate(value)}
          >
            {stored ? t('Replace') : t('Save token')}
          </Button>
          {stored ? (
            <Button variant="ghost" size="sm" onClick={() => setConfirmClear(true)}>
              {t('Remove')}
            </Button>
          ) : null}
        </div>

        <details className="rounded-lg border border-line bg-sunken p-3">
          <summary className="cursor-pointer text-body font-medium text-ink">
            {t('No signed-in machine anywhere?')}
          </summary>
          <div className="mt-3 space-y-2 text-body text-muted">
            <p>
              {t(
                'This server ships the CLI. Over SSH, or from the provider’s web console, the same flow works by hand:',
              )}
            </p>
            <CopyableCode value="cd /opt/metaclaude && sudo docker compose exec app claude setup-token" />
            <p>
              {t(
                'It prints a URL — open it on this device, sign in, paste the code back into that terminal, and put the token it returns in the box above.',
              )}
            </p>
          </div>
        </details>
      </div>

      <ConfirmDialog
        open={confirmClear}
        onOpenChange={setConfirmClear}
        title={t('Remove the stored credential?')}
        description={t(
          'Agent runs will fall back to whatever the server environment provides, and will fail if it provides nothing.',
        )}
        confirmLabel={t('Remove')}
        danger
        onConfirm={() => clear.mutate()}
      />
    </Card>
  );
}

/**
 * How long the CLI's account sign-in has left, when that is known.
 *
 * Fourteen days is the same threshold the doctor's credential check uses, and
 * the two are meant to agree: whichever screen an operator happens to be on,
 * the answer about a credential that is about to lapse is the same one.
 */
function SignInEnds({ endsAt }: { endsAt: number | null }) {
  const t = useT();
  if (endsAt === null) return null;

  const days = Math.ceil((endsAt - Date.now()) / 86_400_000);
  const urgent = days <= 14;

  return (
    <p
      className={cn(
        'rounded-lg px-3 py-2.5 text-caption leading-relaxed',
        urgent ? 'bg-danger-soft text-danger' : 'text-muted',
      )}
    >
      {days > 0
        ? t('This sign-in ends {when} — renew it before then, or pair a token below.', {
            when: formatRelative(endsAt),
          })
        : t('This sign-in has ended. Runs cannot authenticate until you renew it.')}
    </p>
  );
}
