/**
 * "You changed the prompt. Carry it to the other copies?"
 *
 * An automation reaches one workspace by schema — it carries its own
 * continuous session, failure count, schedule and paused state — so serving two
 * projects means two rows, and two rows drift the moment one is edited. That is
 * the cost of a copy, and this dialog is what turns the drift into a decision
 * instead of an accident.
 *
 * It asks rather than syncing, and that is the whole design: a copy whose
 * prompt deliberately names its own project must be able to refuse, once, per
 * save, per sibling. Ticked by default because opening this dialog is already
 * the answer "yes, carry it" — unticking one is how you say a copy has gone its
 * own way, and "Detach" in its menu is how you say so permanently.
 *
 * It appears only when there is something to ask: a family with other members,
 * and at least one changed field that means the same thing elsewhere. Every
 * other save goes through untouched.
 */

import { useState } from 'react';
import type { Automation } from '@metaclaude/shared';
import { Button } from '@/components/ui/primitives';
import { CheckboxField } from '@/components/ui/controls';
import { Modal } from '@/components/ui/Modal';
import { WorkspaceAvatar } from '@/components/workspace/WorkspaceAvatar';
import { useT } from '@/lib/i18n';

export interface PropagateWorkspace {
  id: string;
  name: string;
  color: string;
  icon?: string;
}

/**
 * The fields worth carrying, named for the operator.
 *
 * `workspaceId` and `enabled` are absent on purpose and the route strips them
 * too: a sibling keeps its own workspace, and it keeps its own pause — carrying
 * `enabled` would let saving the original wake a copy somebody had deliberately
 * stopped. Every label is a catalogue key.
 */
const FIELD_LABELS: Record<string, string> = {
  prompt: 'the prompt',
  name: 'the name',
  description: 'the description',
  trigger: 'the trigger',
  policy: 'the model and permissions',
  continuous: 'continuous mode',
  maxConsecutiveFailures: 'the failure ceiling',
};

/** What of this patch means the same thing in another workspace. */
export function propagatableFields(patch: Record<string, unknown>): string[] {
  return Object.keys(patch).filter((key) => key in FIELD_LABELS);
}

export function PropagateDialog({
  fields,
  siblings,
  workspaces,
  onDecide,
  busy,
}: {
  /** The changed field names, as `propagatableFields` returned them. */
  fields: readonly string[];
  /** The other copies of this automation. */
  siblings: readonly Automation[];
  /** Every workspace, to name and colour each copy. */
  workspaces: readonly PropagateWorkspace[];
  /** Called with the ids to carry to — empty means "just this one". */
  onDecide: (ids: string[]) => void;
  busy: boolean;
}) {
  const t = useT();
  const [ticked, setTicked] = useState<Set<string>>(new Set(siblings.map((s) => s.id)));

  const toggle = (id: string): void =>
    setTicked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const named = fields.map((field) => t(FIELD_LABELS[field] as string)).join(', ');

  return (
    <Modal
      open
      onOpenChange={() => onDecide([])}
      title={t('Carry this change to the other copies?')}
      description={t(
        'You changed {fields}. These copies are the same automation in other workspaces — each keeps its own schedule, history and paused state whatever you choose here.',
        { fields: named },
      )}
    >
      <ul className="space-y-2">
        {siblings.map((sibling) => {
          const workspace = workspaces.find((w) => w.id === sibling.workspaceId);
          return (
            <li key={sibling.id}>
              <CheckboxField
                checked={ticked.has(sibling.id)}
                onChange={() => toggle(sibling.id)}
                label={
                  <span className="flex items-center gap-2">
                    {workspace ? (
                      <WorkspaceAvatar color={workspace.color} icon={workspace.icon} />
                    ) : null}
                    {workspace?.name ?? t('Unknown workspace')}
                  </span>
                }
              />
            </li>
          );
        })}
      </ul>

      <div className="mt-4 flex flex-wrap justify-end gap-2">
        {/* Saving only this one is a real answer and not a cancel — the edit is
            already made, the question is only who else hears about it. */}
        <Button variant="secondary" onClick={() => onDecide([])} disabled={busy}>
          {t('Only this one')}
        </Button>
        <Button
          variant="primary"
          onClick={() => onDecide([...ticked])}
          disabled={busy || ticked.size === 0}
          loading={busy}
        >
          {t('Carry it over')}
        </Button>
      </div>
    </Modal>
  );
}
