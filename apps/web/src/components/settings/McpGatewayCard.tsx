/**
 * Metaclaude as an MCP server — the tokens other applications connect with.
 *
 * The screen is written around one uncomfortable fact, and says it rather than
 * decorating over it: a token that may start runs can make this deployment
 * execute things, unattended, for as long as it lives. So the reach of each
 * token is on the card at a glance — what it can do, where, and under what
 * ceiling — and the secret is shown exactly once, in a dialog that says so.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderGit2, KeyRound, Plug, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { MAX_API_TOKEN_DAYS } from '@metaclaude/shared';
import type { ApiTokenCeiling, ApiTokenRecord, ApiTokenScope } from '@metaclaude/shared';
import { CopyableCode } from '@/components/ui/CopyableCode';
import { ConfirmDialog, Modal } from '@/components/ui/Modal';
import { CheckboxField } from '@/components/ui/controls';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Input,
  Label,
  Skeleton,
  Spinner,
} from '@/components/ui/primitives';
import { api } from '@/lib/api';
import { type TranslateFn, useT } from '@/lib/i18n';
import { formatDateTime, formatRelative } from '@/lib/utils';

/** What each ceiling actually permits, in the words an operator decides with. */
export function describeCeiling(ceiling: ApiTokenCeiling, t: TranslateFn): string {
  if (ceiling === 'plan') return t('Research and answer only — no tool ever executes.');
  if (ceiling === 'dontAsk') {
    // Names the setting, because for a long time this sentence named nothing:
    // it promised "what this workspace already allows" while no workspace
    // could allow anything — the field existed in the schema and had no
    // control in the app. A run under this ceiling was refused WebSearch,
    // Write and every mutating command, which is not what the line described.
    return t('Runs the tools this workspace pre-approves in its settings, and refuses the rest.');
  }
  return t('Also edits files, without asking.');
}

/**
 * The state a token is actually in.
 *
 * Three, not two: an expired token is not revoked — nobody decided anything —
 * and an operator looking at a broken integration needs to tell "I turned this
 * off" from "this ran out while I was not looking".
 */
export function tokenState(
  token: ApiTokenRecord,
  now = Date.now(),
): 'revoked' | 'expired' | 'live' {
  if (token.revokedAt !== null) return 'revoked';
  if (token.expiresAt <= now) return 'expired';
  return 'live';
}

const DEFAULT_DRAFT = {
  name: '',
  scopes: ['run', 'read'] as ApiTokenScope[],
  workspaceIds: [] as string[],
  ceiling: 'dontAsk' as ApiTokenCeiling,
  expiresInDays: 90,
};

export function McpGatewayCard() {
  const t = useT();
  const queryClient = useQueryClient();

  const tokens = useQuery({ queryKey: ['api-tokens'], queryFn: () => api.apiTokens() });
  const endpoint = useQuery({ queryKey: ['gateway-endpoint'], queryFn: () => api.gatewayEndpoint() });
  const workspaces = useQuery({ queryKey: ['workspaces'], queryFn: () => api.workspaces() });

  const [drafting, setDrafting] = useState(false);
  const [draft, setDraft] = useState(DEFAULT_DRAFT);
  /** Held only until the dialog closes. It exists nowhere else, ever again. */
  const [minted, setMinted] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<ApiTokenRecord | null>(null);
  // The token whose reach is being repaired, and the choice being made for it.
  const [granting, setGranting] = useState<ApiTokenRecord | null>(null);
  const [grants, setGrants] = useState<string[]>([]);

  const create = useMutation({
    mutationFn: () => api.createApiToken(draft),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['api-tokens'] });
      setDrafting(false);
      setDraft(DEFAULT_DRAFT);
      setMinted(result.secret);
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const regrant = useMutation({
    mutationFn: ({ id, workspaceIds }: { id: string; workspaceIds: string[] }) =>
      api.updateApiToken(id, { workspaceIds }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['api-tokens'] });
      setGranting(null);
      toast.success(t('Token updated'), {
        description: t('The same secret, reaching the workspaces you chose.'),
      });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeApiToken(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['api-tokens'] });
      setRevoking(null);
      toast.success(t('Token revoked'), {
        description: t('Anything still using it is refused from now on.'),
      });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const all = tokens.data?.tokens ?? [];
  const available = workspaces.data?.workspaces ?? [];
  const nameOf = (id: string) => available.find((one) => one.id === id)?.name ?? id;

  const toggle = <T,>(list: T[], value: T): T[] =>
    list.includes(value) ? list.filter((one) => one !== value) : [...list, value];

  return (
    <Card>
      <CardHeader
        title={t('MCP access for other applications')}
        description={t(
          'Connect another application to this agent. A token can reach only the workspaces you name, and never more than the ceiling you set.',
        )}
        actions={
          <Button variant="primary" size="sm" onClick={() => setDrafting(true)}>
            <KeyRound className="size-4" aria-hidden />
            {t('New token')}
          </Button>
        }
      />

      <div className="space-y-3 px-4 pb-4">
        {/* What to paste into the other application. Shown once, above the
            list, because it is the same for every token. */}
        {/* Three states, not two. `endpoint.data?.url` is also falsy while the
            request is in flight and when it failed, and the message below is a
            claim about this deployment's configuration — asserting it before
            the server has answered told an operator their address was unset
            when it was set. Loading shows the shape; a failure says it could
            not be read; only a resolved `null` is the configuration itself. */}
        {endpoint.isPending ? (
          <Skeleton className="h-[52px] rounded-lg" />
        ) : endpoint.isError ? (
          <p className="rounded-lg border border-line bg-sunken px-3 py-2 text-[12px] leading-relaxed text-muted">
            {t('The endpoint could not be read from the server. Reload to try again.')}
          </p>
        ) : endpoint.data?.url ? (
          <div className="space-y-1.5">
            <p className="text-[12px] text-muted">{t('Endpoint to connect to')}</p>
            <CopyableCode value={endpoint.data.url} label={t('Copy the endpoint')} />
          </div>
        ) : (
          <p className="rounded-lg border border-warning/25 bg-warning-soft px-3 py-2 text-[12px] leading-relaxed text-warning">
            {t(
              'This deployment has no public address configured (METACLAUDE_PUBLIC_URL), so the endpoint cannot be shown here. Tokens still work — the address is your site’s, followed by /api/gateway/mcp.',
            )}
          </p>
        )}
      </div>

      {tokens.isLoading ? (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      ) : all.length === 0 ? (
        <EmptyState
          icon={<Plug className="size-5" aria-hidden />}
          title={t('No tokens yet')}
          description={t('Nothing outside this deployment can reach the agent.')}
        />
      ) : (
        <ul className="divide-y divide-[var(--mc-border)]">
          {all.map((token) => {
            const state = tokenState(token);
            return (
              <li key={token.id} className="flex items-start gap-3 px-4 py-3">
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="flex flex-wrap items-center gap-2 text-[13px] text-ink">
                    <span className="truncate font-medium">{token.name}</span>
                    {state === 'revoked' ? (
                      <Badge tone="danger">{t('revoked')}</Badge>
                    ) : state === 'expired' ? (
                      <Badge tone="warning">{t('expired')}</Badge>
                    ) : null}
                    {token.scopes.includes('run') ? (
                      <Badge tone="warning">{t('can start runs')}</Badge>
                    ) : (
                      <Badge tone="neutral">{t('read only')}</Badge>
                    )}
                  </p>
                  <p className="text-[11.5px] leading-relaxed text-subtle">
                    {token.workspaceIds.length > 0
                      ? token.workspaceIds.map(nameOf).join(', ')
                      : t('no workspace')}{' '}
                    · {describeCeiling(token.ceiling, t)}
                  </p>
                  {/* A token whose grants were pruned by a workspace deletion
                      reaches nothing, and every call it makes reads as "this
                      deployment is empty" on the other side. Said here, where
                      it can be repaired, rather than left to be inferred. */}
                  {state === 'live' && token.workspaceIds.length === 0 ? (
                    <p className="flex flex-wrap items-center gap-2 text-[11.5px] leading-relaxed text-warning">
                      {t('This token reaches no workspace — whatever holds it sees an empty deployment.')}
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setGrants(token.workspaceIds);
                          setGranting(token);
                        }}
                      >
                        {t('Grant a workspace')}
                      </Button>
                    </p>
                  ) : null}
                  <p className="font-mono text-[11px] text-subtle">
                    {token.hint}… ·{' '}
                    {state === 'live'
                      ? t('expires {when}', { when: formatDateTime(token.expiresAt) })
                      : t('expired {when}', { when: formatDateTime(token.expiresAt) })}{' '}
                    ·{' '}
                    {token.lastUsedAt
                      ? t('last used {when}', { when: formatRelative(token.lastUsedAt) })
                      : t('never used')}
                  </p>
                </div>
                {state === 'live' ? (
                  <>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t('Workspaces for {name}', { name: token.name })}
                      onClick={() => {
                        setGrants(token.workspaceIds);
                        setGranting(token);
                      }}
                    >
                      <FolderGit2 className="size-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t('Revoke {name}', { name: token.name })}
                      onClick={() => setRevoking(token)}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      <Modal
        open={drafting}
        onOpenChange={setDrafting}
        title={t('New MCP token')}
        description={t('The value is shown once, when it is created.')}
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setDrafting(false)}>
              {t('Cancel')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={create.isPending}
              disabled={!draft.name.trim() || draft.workspaceIds.length === 0}
              onClick={() => create.mutate()}
            >
              {t('Create token')}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Label>
            {t('Name')}
            <Input
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              placeholder={t('The application that will use it')}
              className="mt-1.5"
              autoFocus
            />
          </Label>

          <fieldset className="space-y-2">
            <legend className="text-[12px] font-medium text-ink">{t('Workspaces it can reach')}</legend>
            {/* No "all workspaces" option, deliberately: a token minted for one
                integration would otherwise follow this deployment into every
                workspace created afterwards. */}
            <div className="max-h-40 space-y-1.5 overflow-y-auto rounded-lg border border-line p-2">
              {available.map((workspace) => (
                <CheckboxField
                  key={workspace.id}
                  checked={draft.workspaceIds.includes(workspace.id)}
                  onChange={() =>
                    setDraft({ ...draft, workspaceIds: toggle(draft.workspaceIds, workspace.id) })
                  }
                  label={workspace.name}
                  hint={workspace.slug}
                />
              ))}
            </div>
          </fieldset>

          <fieldset className="space-y-2">
            <legend className="text-[12px] font-medium text-ink">{t('What it may do')}</legend>
            <CheckboxField
              checked={draft.scopes.includes('run')}
              onChange={() => setDraft({ ...draft, scopes: toggle(draft.scopes, 'run') })}
              label={t('Start runs')}
              hint={t('The agent works in the workspace. This is what executes things.')}
            />
            <CheckboxField
              checked={draft.scopes.includes('read')}
              onChange={() => setDraft({ ...draft, scopes: toggle(draft.scopes, 'read') })}
              label={t('Read notes and the board')}
              hint={t('Search the knowledge base and list cards. Nothing executes.')}
            />
          </fieldset>

          <fieldset className="space-y-2">
            <legend className="text-[12px] font-medium text-ink">
              {t('Ceiling on what a run may do')}
            </legend>
            <p className="text-[11.5px] leading-relaxed text-muted">
              {t(
                'Nobody is watching these runs, so they never stop to ask. This is the most they may do on their own — a workspace set to less stays at less.',
              )}
            </p>
            <div className="space-y-1.5">
              {(['plan', 'dontAsk', 'acceptEdits'] as const).map((ceiling) => (
                <label
                  key={ceiling}
                  className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-line px-3 py-2 text-[12.5px] hover:border-accent/40"
                >
                  <input
                    type="radio"
                    name="ceiling"
                    className="mt-0.5 accent-[var(--mc-accent)]"
                    checked={draft.ceiling === ceiling}
                    onChange={() => setDraft({ ...draft, ceiling })}
                  />
                  <span>
                    <span className="text-ink">
                      {ceiling === 'plan'
                        ? t('Plan only')
                        : ceiling === 'dontAsk'
                          ? t('Run what is already allowed')
                          : t('Run and edit files')}
                    </span>
                    <span className="block text-[11.5px] text-muted">
                      {describeCeiling(ceiling, t)}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <Label>
            {t('Expires in (days)')}
            <Input
              type="number"
              min={1}
              // The API refuses anything above this; a form that offered more
              // would produce a 400 the operator has no way to read.
              max={MAX_API_TOKEN_DAYS}
              value={draft.expiresInDays}
              onChange={(event) =>
                setDraft({ ...draft, expiresInDays: Number(event.target.value) || 1 })
              }
              className="mt-1.5"
            />
          </Label>
        </div>
      </Modal>

      {/* The one moment the value exists outside the other application. */}
      <Modal
        open={minted !== null}
        onOpenChange={(open) => !open && setMinted(null)}
        title={t('Copy your token now')}
        description={t(
          'This is the only time it is shown. Paste it into the other application as an Authorization: Bearer header.',
        )}
        footer={
          <Button variant="primary" size="sm" onClick={() => setMinted(null)}>
            {t('I have saved it')}
          </Button>
        }
      >
        <div className="space-y-3">
          <CopyableCode value={minted ?? ''} label={t('Copy the token')} />
          <p className="rounded-lg border border-warning/25 bg-warning-soft px-3 py-2 text-[12px] leading-relaxed text-warning">
            {t(
              'Treat it like a password: anything holding it can ask this agent to work in the workspaces you named.',
            )}
          </p>
        </div>
      </Modal>

      {/* Repairing a grant, not minting a credential: the secret is untouched,
          so whatever holds it keeps working the moment this is saved. */}
      <Modal
        open={granting !== null}
        onOpenChange={(open) => {
          if (!open) setGranting(null);
        }}
        title={t('Workspaces this token can reach')}
        description={t('The secret does not change. Whatever holds it keeps working.')}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setGranting(null)}>
              {t('Cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={grants.length === 0}
              loading={regrant.isPending}
              onClick={() => granting && regrant.mutate({ id: granting.id, workspaceIds: grants })}
            >
              {t('Save')}
            </Button>
          </>
        }
      >
        <fieldset className="space-y-2">
          <legend className="sr-only">{t('Workspaces it can reach')}</legend>
          <div className="max-h-56 space-y-1.5 overflow-y-auto rounded-lg border border-line p-2">
            {available.map((workspace) => (
              <CheckboxField
                key={workspace.id}
                checked={grants.includes(workspace.id)}
                onChange={() => setGrants(toggle(grants, workspace.id))}
                label={workspace.name}
                hint={workspace.slug}
              />
            ))}
          </div>
        </fieldset>
      </Modal>

      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) setRevoking(null);
        }}
        title={t('Revoke this token?')}
        description={t(
          'Anything using it stops working immediately. This cannot be undone — issue a new token instead.',
        )}
        confirmLabel={t('Revoke')}
        danger
        onConfirm={() => {
          if (revoking) revoke.mutate(revoking.id);
        }}
      />
    </Card>
  );
}
