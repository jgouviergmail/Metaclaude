/**
 * Where one extension lives, shown on its own row.
 *
 * The reach has been on every record since it became a many-to-many — a skill,
 * a subagent or an MCP server attaches to any number of workspaces — and
 * nothing displayed it. So the only way to learn where something lived was to
 * open its editor, one row at a time, and the listing that shows *everything*
 * is exactly where that mattered most.
 *
 * One component for all four kinds, for the reason `AvailabilityFilter` is one
 * component: they ask the identical question about different rows, and four
 * copies is how one of them ends up saying "global" for a row attached to
 * nothing. An automation is the degenerate case — it belongs to exactly one
 * workspace by schema — and it takes the same badge rather than a fifth
 * spelling of the same idea.
 *
 * Attached to nothing is a real state and is named as one. It is reachable by
 * unticking the last box, and a row that simply showed no badge would read as
 * "global" to anyone scanning the column.
 */

import { Badge, Tooltip } from '@/components/ui/primitives';
import { WorkspaceAvatar } from '@/components/workspace/WorkspaceAvatar';
import { useT } from '@/lib/i18n';

export interface ReachWorkspace {
  id: string;
  name: string;
  color: string;
  icon?: string | null;
}

/**
 * How many avatars before the count takes over.
 *
 * Three, because the badge sits at the end of a row that already carries a
 * name, a description and its controls: past three the row wraps on a phone,
 * and being scannable is the whole point of this column.
 */
const SHOWN = 3;

export function ReachBadge({
  global,
  workspaceIds,
  workspaces,
  className,
}: {
  /** Reaches every workspace, including any created later. */
  global: boolean;
  /**
   * The workspaces it is attached to, when it is not global.
   *
   * Optional because this renders wire data: the contract defaults it to `[]`,
   * but a payload serialised before the field existed carries nothing, and a
   * badge is never worth throwing a page away for. An absent list reads as
   * "attached to nothing", which is what an older record actually was.
   */
  workspaceIds?: readonly string[] | null | undefined;
  /** Every workspace, to resolve ids into names and colours. */
  workspaces: readonly ReachWorkspace[];
  className?: string;
}) {
  const t = useT();

  if (global) {
    return (
      <Badge tone="neutral" className={className}>
        {t('Global')}
      </Badge>
    );
  }

  // An id with no workspace behind it is one whose workspace was deleted.
  // Dropped rather than drawn as a blank avatar: the grant is already gone.
  const attached = (workspaceIds ?? [])
    .map((id) => workspaces.find((workspace) => workspace.id === id))
    .filter((workspace): workspace is ReachWorkspace => workspace !== undefined);

  if (attached.length === 0) {
    return (
      <Badge tone="neutral" className={className}>
        {t('No workspace')}
      </Badge>
    );
  }

  const names = attached.map((workspace) => workspace.name).join(', ');

  return (
    <Tooltip content={names}>
      <Badge tone="neutral" className={className} aria-label={names}>
        {attached.slice(0, SHOWN).map((workspace) => (
          <WorkspaceAvatar
            key={workspace.id}
            color={workspace.color}
            icon={workspace.icon ?? null}
          />
        ))}
        {/* One attachment names itself — the common case, and a name reads
            faster than a count. Several are carried by the number, with the
            tooltip and the accessible name spelling them out. */}
        {attached.length === 1 ? (
          <span className="max-w-32 truncate">{attached[0]?.name}</span>
        ) : (
          <span className="tabular-nums">
            {t('{n} workspaces', { n: String(attached.length) })}
          </span>
        )}
      </Badge>
    </Tooltip>
  );
}
