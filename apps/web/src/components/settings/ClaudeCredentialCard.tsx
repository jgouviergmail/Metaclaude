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

export function ClaudeCredentialCard() {
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
        ? 'Paired with your Claude subscription.'
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
      toast.error(error instanceof ApiError ? error.message : 'Could not start pairing.'),
  });

  const complete = useMutation({
    mutationFn: (pasted: string) => api.claudePairing.complete(pasted),
    onSuccess: (next) => {
      setStart(null);
      setCode('');
      paired(next);
    },
    onError: (error) => {
      toast.error(error instanceof ApiError ? error.message : 'Pairing failed.');
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
      toast.error(error instanceof ApiError ? error.message : 'Could not save that credential.'),
  });

  const clear = useMutation({
    mutationFn: () => api.claudeCredential.clear(),
    onSuccess: () => {
      refresh();
      setConfirmClear(false);
      toast.success('Credential removed.');
    },
  });

  const stored = status.data?.source === 'stored';

  return (
    <Card>
      <CardHeader
        title="Claude credentials"
        description="What every agent run authenticates with. Stored encrypted, never written to a file."
      />
      <div className="space-y-5 px-4 pb-4">
        {/* ---------------------- The CLI's own sign-in --------------------- */}
        {/* `claude auth login` run in the container is the one credential
            Anthropic grants the session-sync scopes to — and any token
            Metaclaude injects overrides it. Both facts belong where the
            tokens are managed, or removing a token looks like a downgrade
            when it is sometimes the upgrade. */}
        {status.data?.source === 'cli-login' ? (
          <p className="rounded-lg bg-accent-soft px-3 py-2.5 text-[12.5px] leading-relaxed text-ink">
            The CLI is signed in with a Claude account
            {status.data.cliLogin?.subscriptionType ? ` (${status.data.cliLogin.subscriptionType})` : ''}
            {status.data.cliLogin?.full ? ', full scope' : ', inference only'} — runs use that
            sign-in. Pairing a token below would override it.
          </p>
        ) : status.data?.cliLogin ? (
          <p className="rounded-lg border border-dashed border-line px-3 py-2.5 text-[12.5px] leading-relaxed text-muted">
            A CLI account sign-in also exists
            {status.data.cliLogin.full ? ' (full scope — claude.ai session sync)' : ''}, but the{' '}
            {status.data.source === 'stored' ? 'paired' : 'environment'} token overrides it.
            Remove the token to let the account sign-in take over.
          </p>
        ) : null}

        {/* ------------------------- Guided pairing ------------------------- */}
        <div className="space-y-3">
          <h3 className="text-[13px] font-semibold text-ink">Pair with your Claude account</h3>

          {start === null ? (
            <>
              <p className="text-[12.5px] leading-relaxed text-muted">
                Metaclaude runs the <code className="font-mono">claude setup-token</code> flow for
                you: sign in at claude.ai, approve, paste back the code it shows. Works entirely
                from this device. Console (per-token) accounts paste their API key below instead.
              </p>
              <Button
                variant="primary"
                size="sm"
                loading={begin.isPending}
                onClick={() => begin.mutate()}
              >
                Start pairing
              </Button>
            </>
          ) : (
            <div className="space-y-3 rounded-lg border border-line bg-sunken p-3">
              <div className="space-y-2">
                <p className="text-[13px] text-ink">
                  <span className="font-semibold">1 ·</span> Open the sign-in link and approve.
                  Claude then displays a code.
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => window.open(start.url, '_blank', 'noopener,noreferrer')}
                  >
                    <ExternalLink className="size-3.5" />
                    Open claude.ai
                  </Button>
                  <span className="text-[12px] text-subtle">or copy it to another device:</span>
                </div>
                <CopyableCode value={start.url} label="Copy the sign-in link" />
              </div>

              <div className="space-y-2">
                <Label htmlFor="pairing-code">
                  <span className="font-semibold">2 ·</span> Paste the code here
                </Label>
                <Input
                  id="pairing-code"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="the code Claude displayed"
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
                  Finish pairing
                </Button>
                <Button variant="ghost" size="sm" onClick={() => cancel.mutate()}>
                  Cancel
                </Button>
                <span className="text-[12px] text-subtle">The link stays valid for 10 minutes.</span>
              </div>
            </div>
          )}
        </div>

        {/* ------------------------- Manual fallback ------------------------ */}
        <div className="space-y-2">
          <Label htmlFor="claude-token">Or paste a token or API key yourself</Label>
          <Input
            id="claude-token"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="sk-ant-oat01-…"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && value.trim()) save.mutate(value);
            }}
          />
          <p className="text-[12px] text-muted">
            A token beginning <code className="font-mono">sk-ant-oat</code> uses your Pro or Max
            subscription — <code className="font-mono">claude setup-token</code> on any signed-in
            machine prints one. One beginning <code className="font-mono">sk-ant-api</code> bills
            per token instead. Metaclaude tells them apart on its own.
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
            {stored ? 'Replace' : 'Save token'}
          </Button>
          {stored ? (
            <Button variant="ghost" size="sm" onClick={() => setConfirmClear(true)}>
              Remove
            </Button>
          ) : null}
        </div>

        <details className="rounded-lg border border-line bg-sunken p-3">
          <summary className="cursor-pointer text-[13px] font-medium text-ink">
            No signed-in machine anywhere?
          </summary>
          <div className="mt-3 space-y-2 text-[13px] text-muted">
            <p>
              This server ships the CLI. Over SSH, or from the provider&rsquo;s web console, the
              same flow works by hand:
            </p>
            <CopyableCode value="cd /opt/metaclaude && sudo docker compose exec app claude setup-token" />
            <p>
              It prints a URL — open it on this device, sign in, paste the code back into that
              terminal, and put the token it returns in the box above.
            </p>
          </div>
        </details>
      </div>

      <ConfirmDialog
        open={confirmClear}
        onOpenChange={setConfirmClear}
        title="Remove the stored credential?"
        description="Agent runs will fall back to whatever the server environment provides, and will fail if it provides nothing."
        confirmLabel="Remove"
        danger
        onConfirm={() => clear.mutate()}
      />
    </Card>
  );
}
