/**
 * Enable, disable or delete a whole listing in one action.
 *
 * One component for skills and for subagents: the two tabs render different
 * rows but the management question is identical, and two copies of a
 * destructive confirmation would eventually say two different things about
 * what it destroys.
 *
 * It acts on the ids it was handed — the rows the operator is looking at —
 * rather than on a scope the server would expand on its own. A workspace's
 * listing includes the global entries, so "all of them" has to mean "all of
 * these", or the button lies about its own reach.
 */

import { useMutation } from '@tanstack/react-query';
import { CheckCircle2, CircleSlash, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/primitives';
import { ConfirmDialog } from '@/components/ui/Modal';
import { api, ApiError, type BulkRegistryInput } from '@/lib/api';
import { usePlural, useT } from '@/lib/i18n';

export interface BulkItem {
  id: string;
  enabled: boolean;
}

export function BulkActions({
  kind,
  items,
  workspaceId,
  onChanged,
}: {
  kind: 'skill' | 'agent';
  items: BulkItem[];
  /** Absent for every scope; null for global only; an id for that workspace. */
  workspaceId?: string | null;
  onChanged: () => void;
}) {
  const t = useT();
  const plural = usePlural();
  const [confirming, setConfirming] = useState(false);

  const run = useMutation({
    mutationFn: (body: BulkRegistryInput) =>
      kind === 'skill' ? api.bulkSkills(body) : api.bulkAgents(body),
    onSuccess: (result) => {
      onChanged();
      // Two distinct English keys, because the English string *is* the key:
      // one key cannot hold two French forms.
      toast.success(plural(result.changed, '{n} entry changed', '{n} entries changed'));
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t('Could not apply that.')),
  });

  const apply = (action: BulkRegistryInput['action'], ids: string[]) => {
    if (ids.length === 0) return;
    run.mutate({ action, ids, ...(workspaceId === undefined ? {} : { workspaceId }) });
  };

  // Offering "enable all" when everything is already on would be a button that
  // reports "0 changed" — technically honest, and useless.
  const disabledIds = items.filter((item) => !item.enabled).map((item) => item.id);
  const enabledIds = items.filter((item) => item.enabled).map((item) => item.id);
  const allIds = items.map((item) => item.id);

  if (items.length === 0) return null;

  return (
    <>
      {/* Wraps rather than scrolls: at 375px three labelled buttons do not fit
          on one row, and a horizontal scroller hides the destructive one. */}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="ghost"
          disabled={disabledIds.length === 0 || run.isPending}
          onClick={() => apply('enable', disabledIds)}
        >
          <CheckCircle2 className="size-4" aria-hidden />
          {t('Enable all')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={enabledIds.length === 0 || run.isPending}
          onClick={() => apply('disable', enabledIds)}
        >
          <CircleSlash className="size-4" aria-hidden />
          {t('Disable all')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="text-danger hover:bg-danger-soft"
          disabled={run.isPending}
          onClick={() => setConfirming(true)}
        >
          <Trash2 className="size-4" aria-hidden />
          {t('Delete all')}
        </Button>
      </div>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        danger
        title={
          kind === 'skill'
            ? plural(items.length, 'Delete {n} skill?', 'Delete {n} skills?')
            : plural(items.length, 'Delete {n} subagent?', 'Delete {n} subagents?')
        }
        // The count and the scope, both, because the workspace listing shows
        // the global entries too and the operator is about to remove those as
        // well. Naming the way back matters more than a scarier warning: most
        // of what is here arrived from the Library and returns from there.
        description={
          <>
            {workspaceId
              ? t('This removes everything listed here, including the global entries this workspace also sees.')
              : t('This removes everything listed here.')}{' '}
            {t('Anything installed from the Library can be installed again.')}
          </>
        }
        confirmLabel={t('Delete {n}', { n: items.length })}
        onConfirm={() => apply('delete', allIds)}
      />
    </>
  );
}
