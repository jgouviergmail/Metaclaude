/**
 * Pairing the deployment with a Claude subscription, without a shell.
 *
 * Rendered under Settings → Connections, beneath the CLI reading it explains:
 * that one says what is in force, this one changes it. Both moved there from
 * the Server screen, where they sat three sections apart under a heading about
 * the machine — a credential is not the box, it is what the box talks to.
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
import type {
  ClaudeCredentialStatus,
  ClaudePairingKind,
  ClaudePairingStart,
} from '@metaclaude/shared';
import { ConfirmDialog } from '@/components/ui/Modal';
import { CopyableCode } from '@/components/ui/CopyableCode';
import {
  Badge,
  Button,
  Input,
  Label,
} from '@/components/ui/primitives';
import { Section } from '@/components/ui/layout';
import { api, ApiError } from '@/lib/api';
import { Trans, useT } from '@/lib/i18n';
import { cn, formatUntil } from '@/lib/utils';

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

  /*
   * Cached hard on the server (six hours), so this costs a request per page
   * view and no outbound call. `staleTime` keeps React Query from asking
   * again while the card is re-rendered by its neighbours' mutations.
   */
  const cli = useQuery({
    queryKey: ['claude-cli'],
    queryFn: () => api.claudeCliVersion(),
    staleTime: 5 * 60_000,
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
    mutationFn: (kind: ClaudePairingKind) => api.claudePairing.begin('claudeai', kind),
    onSuccess: (next) => {
      setStart(next);
      setCode('');
    },
    onError: (error, kind) =>
      toast.error(
        error instanceof ApiError
          ? error.message
          : kind === 'account'
            ? t('Could not start signing in.')
            : t('Could not start pairing.'),
      ),
  });

  const complete = useMutation({
    mutationFn: (pasted: string) => api.claudePairing.complete(pasted),
    onSuccess: (next) => {
      // Read before the wizard folds: which flow just finished decides what
      // the owner is told, and a renewed sign-in is not a paired token.
      const renewed = start?.kind === 'account';
      setStart(null);
      setCode('');
      if (renewed) {
        refresh();
        toast.success(t('Your Claude account sign-in was renewed.'));
        return;
      }
      paired(next);
    },
    onError: (error) => {
      toast.error(
        error instanceof ApiError
          ? error.message
          : start?.kind === 'account'
            ? t('Signing in failed.')
            : t('Pairing failed.'),
      );
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
    onSuccess: (next) => {
      refresh();
      setConfirmClear(false);
      // What happened is decided by what took over, not by what was removed:
      // dropping a token that was shadowing a sign-in is a switch, and calling
      // it a removal would read as a loss.
      toast.success(
        next.source === 'cli-login'
          ? t('Runs now use your Claude account sign-in.')
          : t('Credential removed.'),
      );
    },
  });

  const stored = status.data?.source === 'stored';

  return (
    <Section
      title={t('Claude credentials')}
      description={t(
        'What every agent run authenticates with. Stored encrypted, never written to a file.',
      )}
    >
      <div className="space-y-5">
        {/*
          The CLI's own version, and whether it is behind.
          
          A reading, not a button: the CLI is pinned into the image and the
          container refuses to change it three ways over — non-root process,
          root-owned directory, read-only filesystem. Saying "update available"
          beside a control that could not do it would be worse than silence, so
          the line says where the update actually comes from.
        */}
        {cli.data?.installed ? (
          <p className="flex flex-wrap items-center gap-2 text-caption text-muted">
            <span>{t('Claude CLI {version}', { version: cli.data.installed })}</span>
            {cli.data.behind && cli.data.latest ? (
              <Badge tone="info">
                {t('{version} published', { version: cli.data.latest })}
              </Badge>
            ) : null}
            {cli.data.behind ? (
              <span>
                {t('It ships with the image, so a Metaclaude update is what brings it in.')}
              </span>
            ) : null}
          </p>
        ) : null}

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
          <div className="space-y-2 rounded-lg border border-dashed border-line px-3 py-2.5">
            {/* Two sentences rather than one with a hole in it: only a
                stored token can be dropped from here, and telling someone to
                "remove the token" when the token is an environment variable
                sends them looking for a control that does not exist. */}
            <p className="text-caption leading-relaxed text-muted">
              {stored
                ? t(
                    'A Claude account sign-in also exists{scope}, and the paired token is standing in front of it.',
                    {
                      scope: status.data.cliLogin.full
                        ? t(' (full scope — claude.ai session sync)')
                        : '',
                    },
                  )
                : t(
                    'A Claude account sign-in also exists{scope}, but a token in the server environment overrides it. Remove it there to let the sign-in take over.',
                    {
                      scope: status.data.cliLogin.full
                        ? t(' (full scope — claude.ai session sync)')
                        : '',
                    },
                  )}
              {/* The countdown above follows the credential in force, which is
                  right — but a shadowed sign-in still expires, silently, and
                  the owner finds out on the day they drop the token and
                  discover there is nothing behind it. Said here because this
                  is the only line that is about the other credential. */}
              {status.data.cliLogin.signInEndsAt !== null ? (
                <>
                  {' '}
                  {t('It ends {when}.', {
                    when: formatUntil(status.data.cliLogin.signInEndsAt),
                  })}
                </>
              ) : null}
            </p>
            {/* Naming the situation and not offering the way out is a dead
                end on a phone: it leaves an owner scrolling to the Remove
                control below and deciding whether its warning applies. It does
                not — there is a sign-in waiting to take over, which is the
                whole point — so the switch belongs beside the sentence. */}
            {stored ? (
              <Button
                variant="secondary"
                size="sm"
                loading={clear.isPending}
                onClick={() => clear.mutate()}
              >
                {t('Use the account sign-in')}
              </Button>
            ) : null}
          </div>
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
        <CredentialEnds
          endsAt={status.data?.expiresAt ?? null}
          source={status.data?.source ?? null}
        />

        {/* ------------------------- Guided flows --------------------------- */}
        {/*
          Two credentials, one wizard.

          The server holds a single attempt at a time, so the screen shows a
          single wizard: two open panels would let a code minted for one flow
          be pasted into the other, which installs the wrong credential in the
          wrong place. While nothing is running, both doors are described; once
          one is open, it is the only thing on screen.
        */}
        {start === null ? (
          <div className="space-y-5">
            {/* The fuller credential, and therefore the one offered first. The
                loading state asks which kind is in flight: two buttons share
                one mutation, so pressing either would otherwise spin both. */}
            <div className="space-y-3">
              <h3 className="text-body font-semibold text-ink">{t(
                'Claude account sign-in',
              )}</h3>
              <p className="text-caption leading-relaxed text-muted">
                {t(
                  'The complete credential: it reports your plan’s quota windows, syncs sessions with claude.ai and carries MCP servers. It is fixed-term, and this is where it is renewed — no shell, no SSH.',
                )}
              </p>
              <Button
                variant="primary"
                size="sm"
                loading={begin.isPending && begin.variables === 'account'}
                // Which word this button carries depends on whether a sign-in
                // exists, so it stays out of reach until that is known rather
                // than changing under a thumb already on its way down.
                disabled={status.isPending}
                onClick={() => begin.mutate('account')}
              >
                {status.data?.cliLogin
                  ? t('Renew the sign-in')
                  : t('Sign in to a Claude account')}
              </Button>
            </div>

            <div className="space-y-3">
              <h3 className="text-body font-semibold text-ink">{t(
                'Pair with your Claude account',
              )}</h3>
              <p className="text-caption leading-relaxed text-muted">
                <Trans
                  template={t(
                    'Metaclaude runs the {command} flow for you: sign in at claude.ai, approve, paste back the code it shows. A paired token runs work for a year and reports no quota — it asks for inference alone. Console (per-token) accounts paste their API key below instead.',
                  )}
                  values={{ command: <code className="font-mono">{t(
                    'claude setup-token',
                  )}</code> }}
                />
              </p>
              <Button
                variant="secondary"
                size="sm"
                loading={begin.isPending && begin.variables === 'token'}
                onClick={() => begin.mutate('token')}
              >
                {t('Start pairing')}
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <h3 className="text-body font-semibold text-ink">
              {start.kind === 'account'
                ? t('Sign in to your Claude account')
                : t('Pair with your Claude account')}
            </h3>
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
                  {start.kind === 'account' ? t('Finish signing in') : t('Finish pairing')}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => cancel.mutate()}>
                  {t('Cancel')}
                </Button>
                <span className="text-caption text-subtle">{t(
                  'The link stays valid for 10 minutes.',
                )}</span>
              </div>
            </div>
          </div>
        )}

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
        description={
          /* What happens next depends on what is behind it. Telling an owner
             with a valid account sign-in that runs 'will fail if it provides
             nothing' is a warning about a situation they are not in, and it is
             the situation the button is usually pressed to reach. */
          status.data?.cliLogin
            ? t(
                'Agent runs will use your Claude account sign-in instead, which is the fuller credential.',
              )
            : t(
                'Agent runs will fall back to whatever the server environment provides, and will fail if it provides nothing.',
              )
        }
        confirmLabel={t('Remove')}
        danger
        onConfirm={() => clear.mutate()}
      />
    </Section>
  );
}

/**
 * How long the CLI's account sign-in has left, when that is known.
 *
 * Fourteen days is the same threshold the doctor's credential check uses, and
 * the two are meant to agree: whichever screen an operator happens to be on,
 * the answer about a credential that is about to lapse is the same one.
 */
/**
 * When the credential *in force* runs out.
 *
 * It read the CLI sign-in's date whatever was actually being used, so an owner
 * who paired a token watched a countdown belonging to the credential their
 * pairing had just shadowed — while the token they were running on, which does
 * expire, was tracked by nothing at all. Reassurance about the wrong thing is
 * worse than no date.
 *
 * The sentence follows the source too: a sign-in is renewed by signing in
 * again, a paired token by pairing again, and telling an owner to do the wrong
 * one of those is how a credential lapses with the screen in front of them.
 */
function CredentialEnds({
  endsAt,
  source,
}: {
  endsAt: number | null;
  source: ClaudeCredentialStatus['source'];
}) {
  const t = useT();
  if (endsAt === null) return null;

  const days = Math.ceil((endsAt - Date.now()) / 86_400_000);
  const urgent = days <= 14;
  const paired = source === 'stored';

  return (
    <p
      className={cn(
        'rounded-lg px-3 py-2.5 text-caption leading-relaxed',
        urgent ? 'bg-danger-soft text-danger' : 'text-muted',
      )}
    >
      {days > 0
        ? paired
          ? t('This paired token expires {when} — pair again before then.', {
              when: formatUntil(endsAt),
            })
          : t('This sign-in ends {when} — renew it before then, or pair a token below.', {
              when: formatUntil(endsAt),
            })
        : paired
          ? t('This paired token has expired. Pair again to let runs authenticate.')
          : t('This sign-in has ended. Runs cannot authenticate until you renew it.')}
    </p>
  );
}
