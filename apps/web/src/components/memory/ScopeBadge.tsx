/**
 * Which tier a memory or a document sits on, said once.
 *
 * Two tiers reach a run: what was learned in *this* project, and what applies
 * wherever the agent works. Retrieval unions them — a workspace run is given
 * its own memories *and* every global one — so a list that shows the union
 * without marking it is a list an operator cannot reason about. The knowledge
 * library had this right from the start; the memory list did not, and read as
 * one undifferentiated pile sorted by confidence, with a workspace's rows and
 * the global ones interleaved.
 *
 * Extracted rather than copied so the vocabulary and the colour cannot drift
 * apart: "Global" is one word in one place, and the tone that distinguishes a
 * standing note from a project one is decided here.
 */

import type { Workspace } from '@metaclaude/shared';

import { Badge } from '@/components/ui/primitives';
import { useT } from '@/lib/i18n';

export function ScopeBadge({
  workspaceId,
  workspaces,
  className,
}: {
  /** `null` is the global tier. */
  workspaceId: string | null;
  workspaces: readonly Workspace[];
  className?: string;
}) {
  const t = useT();
  return (
    <Badge tone={workspaceId === null ? 'info' : 'neutral'} className={className}>
      {scopeName(workspaceId, workspaces, t)}
    </Badge>
  );
}

/**
 * The tier's name in words.
 *
 * Exported because headings and confirmation prompts need the name without the
 * badge around it, and a second spelling of "Global" is exactly what this file
 * exists to prevent. A workspace that has been deleted, or one this operator's
 * list has not loaded, falls back to the generic noun rather than to a bare id.
 */
export function scopeName(
  workspaceId: string | null,
  workspaces: readonly Workspace[],
  t: (key: string) => string,
): string {
  if (workspaceId === null) return t('Global');
  return workspaces.find((workspace) => workspace.id === workspaceId)?.name ?? t('Workspace');
}
