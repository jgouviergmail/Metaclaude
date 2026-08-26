/**
 * What actually ran — model, effort, permission mode, provenance — shown with
 * every result.
 *
 * Under Auto nothing else answers "which model was that?": the policy can say
 * literally `default`, with the CLI choosing. So the model chip prefers the
 * *served* model captured off the CLI's init message and falls back to the
 * requested one; the tooltip carries the request/served distinction, and the
 * provenance chip says who chose — the learner, the workspace default, or
 * the operator. Styled to the ResultFooter's own meta row: this is context,
 * not content.
 */

import { Cpu, Network } from 'lucide-react';
import type { RunPolicy } from '@metaclaude/shared';
import { PERMISSION_MODE_INFO } from '@metaclaude/shared';
import { Tooltip } from '@/components/ui/primitives';

const SOURCE_LABEL: Record<RunPolicy['source'], string | null> = {
  // The interesting provenances get a word; an explicit choice is not news.
  learned: 'learned',
  workspace: null,
  explicit: null,
};

export function RunMetaChips({
  policy,
  servedModel,
}: {
  policy: RunPolicy;
  servedModel: string | null;
}) {
  const requested = String(policy.model);
  const model = servedModel ?? (requested !== 'default' ? requested : 'auto');
  const sourceLabel = SOURCE_LABEL[policy.source];

  return (
    <>
      <Tooltip
        content={
          <span>
            Requested: {requested === 'default' ? 'auto (CLI default)' : requested}
            {servedModel ? ` — served by ${servedModel}` : ' — the CLI did not report which model served'}
            {sourceLabel ? '. Chosen by the learner from past performance here.' : ''}
          </span>
        }
      >
        <span className="flex cursor-help items-center gap-1">
          <Cpu className="size-3" aria-hidden />
          <span className="font-mono">{model}</span>
          {sourceLabel ? <span className="text-accent">({sourceLabel})</span> : null}
        </span>
      </Tooltip>

      <span>{policy.effort ?? 'effort auto'}</span>

      <span>{PERMISSION_MODE_INFO[policy.permissionMode].label}</span>

      {policy.ultracode ? (
        <span className="flex items-center gap-1 text-accent">
          <Network className="size-3" aria-hidden />
          ultracode
        </span>
      ) : null}
    </>
  );
}
