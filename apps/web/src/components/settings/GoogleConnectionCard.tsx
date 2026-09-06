/**
 * Connecting Metaclaude to your own Google account.
 *
 * The screen exists because the honest answer to "where are my claude.ai
 * connectors?" is that they cannot be imported — a run has no browser to give
 * OAuth consent in — and the useful follow-up is to do the consent *here*,
 * once, and keep the refresh token. Everything after that is unattended.
 *
 * The interface is shaped around the two ways this actually fails:
 *
 *  - **`redirect_uri_mismatch`,** because Google matches the whole string. So
 *    the exact URI is shown first, copyable, before anything is asked for.
 *  - **A refresh token that dies after a week,** because the Cloud project's
 *    consent screen is still in "Testing" and Gmail's read scope is
 *    *restricted*. The warning appears when a restricted grant is ticked,
 *    with what to do about it — not in a footnote after the fact.
 *
 * The secret is typed here and never comes back: the server seals it, and no
 * read path returns it. Re-connecting asks for it again, which is the correct
 * consequence of never storing it anywhere a page could reach.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { GOOGLE_GRANTS, type GoogleGrant } from '@metaclaude/shared';

import { CheckboxField } from '@/components/ui/controls';
import { ConfirmDialog } from '@/components/ui/Modal';
import { CollapsibleCard } from '@/components/ui/CollapsibleCard';
import { CopyableCode } from '@/components/ui/CopyableCode';
import { Badge, Button, Input, Label } from '@/components/ui/primitives';
import { api, ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { TOUCH_TARGET_TEXT } from '@/components/ui/touch-target';
import { cn, formatRelative } from '@/lib/utils';

/** English labels as data; `t()` translates at render, as everywhere else. */
const GRANT_LABELS: Record<GoogleGrant, string> = {
  'gmail.read': 'Read your mail',
  'gmail.send': 'Send mail as you',
  'calendar.read': 'Read your calendar',
  'calendar.write': 'Create and change events',
  'drive.read': 'Read your Drive',
  'drive.write': 'Create files in Drive',
};

/** What each grant actually permits, in the terms a person would ask about. */
const GRANT_NOTES: Record<GoogleGrant, string> = {
  'gmail.read': 'Search and read messages. Nothing is sent or deleted.',
  'gmail.send': 'Compose and send. It cannot read what it did not just write.',
  'calendar.read': 'List events, with recurring ones expanded.',
  'calendar.write': 'Add and update events — grant reading too, or the agent plans blind. Never your calendar settings or sharing.',
  'drive.read': 'Search and read every file you can see.',
  'drive.write': 'Only files Metaclaude itself creates — not the rest of your Drive.',
};

export function GoogleConnectionCard() {
  const t = useT();
  const queryClient = useQueryClient();

  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [grants, setGrants] = useState<GoogleGrant[]>(['calendar.read', 'gmail.read']);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  const state = useQuery({ queryKey: ['google-connection'], queryFn: () => api.google.get() });

  /**
   * Folded by default — once Google works, nobody comes back to this card.
   *
   * Opened by the effect below rather than by a check at mount, because the
   * only render that must be open is the one *after* a consent, and that fact
   * arrives with the effect that also clears the query string carrying it. A
   * mount-time read races its own cleanup, and under `StrictMode` the
   * deliberate remount reads a query that is already gone.
   */
  const [open, setOpen] = useState(false);

  // The callback redirects back here with the outcome in the query string —
  // it is a top-level navigation, so there is nothing else to carry it.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const outcome = params.get('google');
    if (!outcome) return;

    // They just acted, and a folded card would look like nothing happened.
    setOpen(true);
    if (outcome === 'connected') {
      toast.success(t('Google connected.'), {
        description: t(
          'The server was added under Agents & skills → MCP servers, disabled. Switch it on there when you are ready.',
        ),
      });
    } else {
      toast.error(t(
        'Google did not connect.',
      ), { description: params.get('reason') ?? undefined });
    }
    void queryClient.invalidateQueries({ queryKey: ['google-connection'] });
    void queryClient.invalidateQueries({ queryKey: ['mcp-servers', null] });
    // Clear the query so a reload does not repeat the toast.
    window.history.replaceState({}, '', window.location.pathname);
  }, [queryClient, t]);

  const connect = useMutation({
    mutationFn: () => api.google.connect({ clientId, clientSecret, grants }),
    onSuccess: (result) => {
      // Leaving Metaclaude entirely: Google's consent screen refuses to render
      // in a frame, and a popup is blocked as often as not.
      window.location.assign(result.authorizationUrl);
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t(
        'Could not start the connection.',
      )),
  });

  const disconnect = useMutation({
    mutationFn: () => api.google.disconnect(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['google-connection'] });
      void queryClient.invalidateQueries({ queryKey: ['mcp-servers', null] });
      toast.success(t('Google disconnected.'), {
        description: t(
          'The stored token is gone from this deployment. Google still lists Metaclaude until you revoke it at myaccount.google.com/permissions.',
        ),
      });
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t('Could not disconnect.')),
  });

  const connection = state.data?.connection;
  const restricted = state.data?.restrictedGrants ?? [];
  const picksRestricted = grants.some((grant) => restricted.includes(grant));
  const canSubmit = clientId.trim() !== '' && clientSecret.trim() !== '' && grants.length > 0;

  const toggle = (grant: GoogleGrant) =>
    setGrants((current) =>
      current.includes(grant) ? current.filter((g) => g !== grant) : [...current, grant],
    );

  return (
    <CollapsibleCard
      title={t('Google')}
      // Folded, this card is one line — so the line has to answer the question
      // the card exists for. Connected to which account, or not connected at
      // all: anything less and the fold has hidden the only thing worth
      // knowing without being opened.
      status={
        state.isLoading ? null : connection?.connected ? (
          <Badge tone="success">{t('Connected')}</Badge>
        ) : (
          <Badge tone="neutral">{t('Not connected')}</Badge>
        )
      }
      open={open}
      onOpenChange={setOpen}
      description={t(
        'Gmail, Calendar and Drive, through an OAuth application you own. Your connectors on claude.ai cannot be imported — a run has no browser to give consent in — so the consent happens here once, and the refresh token it returns is what lets runs work unattended.',
      )}
    >

      {connection?.connected ? (
        <div className="space-y-4 p-4 pt-0">
          {/* The badge lives on the summary, where it answers "is this
              connected?" without opening anything. What belongs here is the
              part that needs the room: which account, and since when. */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-body font-medium text-ink">
              {connection.accountEmail ?? t('account unknown')}
            </span>
            {connection.connectedAt ? (
              <span className="text-caption text-subtle">
                {formatRelative(connection.connectedAt)}
              </span>
            ) : null}
          </div>

          <div className="flex flex-wrap gap-1.5">
            {connection.grants.map((grant) => (
              <Badge key={grant} tone="info">
                {t(GRANT_LABELS[grant])}
              </Badge>
            ))}
          </div>

          <p className="text-caption leading-relaxed text-muted">
            {t(
              'The tools live on the MCP server named “google”, under Agents & skills. It is created disabled; a server that is on is mounted into every run of every workspace.',
            )}
          </p>

          <div className="flex flex-wrap gap-2">
            <Button variant="ghost" size="sm" onClick={() => setConfirmDisconnect(true)}>
              {t('Disconnect')}
            </Button>
            <a
              href="https://myaccount.google.com/permissions"
              target="_blank"
              rel="noreferrer noopener"
              className={cn(
                'inline-flex items-center gap-1 text-caption font-medium text-muted transition-colors hover:text-accent',
                TOUCH_TARGET_TEXT,
              )}
            >
              <ExternalLink className="size-3.5" aria-hidden />
              {t('Revoke at Google')}
            </a>
          </div>
        </div>
      ) : (
        <div className="space-y-4 p-4 pt-0">
          <ol className="list-decimal space-y-2 pl-5 text-caption leading-relaxed text-muted">
            <li>
              {t(
                'In the Google Cloud console, create a project and enable the Gmail, Calendar and Drive APIs you want.',
              )}
            </li>
            <li>
              {t(
                'On the OAuth consent screen, choose Internal if this is a Workspace account — that is what avoids Google’s verification and the seven-day token expiry.',
              )}
            </li>
            <li>
              {t(
                'Create an OAuth client ID of type “Web application”, and register this exact redirect URI:',
              )}
            </li>
          </ol>

          {state.data?.redirectUri ? (
            <CopyableCode value={state.data.redirectUri} />
          ) : (
            <p className="text-caption text-warning">
              {t(
                'This deployment’s address could not be determined, so the redirect URI cannot be shown.',
              )}
            </p>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="google-client-id">{t('Client ID')}</Label>
              <Input
                id="google-client-id"
                value={clientId}
                autoComplete="off"
                spellCheck={false}
                placeholder={t('…apps.googleusercontent.com')}
                onChange={(event) => setClientId(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="google-client-secret">{t('Client secret')}</Label>
              <Input
                id="google-client-secret"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={clientSecret}
                onChange={(event) => setClientSecret(event.target.value)}
              />
            </div>
          </div>

          <fieldset className="space-y-2">
            <legend className="text-body font-medium text-ink">
              {t('What the agent may do with your account')}
            </legend>
            <p className="text-caption leading-relaxed text-muted">
              {t(
                'Each box is one Google scope. A capability you do not grant is not merely refused at run time — its tool is never registered, so the agent cannot try it.',
              )}
            </p>
            <div className="grid gap-1.5 sm:grid-cols-2">
              {GOOGLE_GRANTS.map((grant) => (
                <CheckboxField
                  key={grant}
                  label={t(GRANT_LABELS[grant])}
                  hint={t(GRANT_NOTES[grant])}
                  checked={grants.includes(grant)}
                  onChange={() => toggle(grant)}
                />
              ))}
            </div>
          </fieldset>

          {picksRestricted ? (
            <p className="flex gap-2 rounded-lg border border-warning/25 bg-warning-soft px-3 py-2 text-caption leading-relaxed text-warning">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>
                {t(
                  'Reading mail or Drive uses a scope Google calls restricted. On a consent screen still in “Testing”, the refresh token expires after seven days — the connection would stop working next week for no visible reason. Publish the app as Internal (Workspace) or leave those two boxes unticked.',
                )}
              </span>
            </p>
          ) : null}

          <Button
            variant="primary"
            size="sm"
            loading={connect.isPending}
            disabled={!canSubmit || connect.isPending}
            onClick={() => connect.mutate()}
          >
            <ExternalLink className="size-4" />
            {t('Continue to Google')}
          </Button>
        </div>
      )}

      <ConfirmDialog
        open={confirmDisconnect}
        onOpenChange={setConfirmDisconnect}
        title={t('Disconnect Google?')}
        description={t(
          'The stored refresh token and client secret are erased and the “google” MCP server is removed. This does not revoke anything at Google — do that at myaccount.google.com/permissions.',
        )}
        confirmLabel={t('Disconnect')}
        danger
        onConfirm={async () => {
          await disconnect.mutateAsync();
          setConfirmDisconnect(false);
        }}
      />
    </CollapsibleCard>
  );
}
