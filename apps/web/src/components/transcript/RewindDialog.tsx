/**
 * Undoing a run's file changes.
 *
 * Two steps on purpose. Opening the dialog asks the CLI what a rewind *would*
 * do and shows the answer; only then is there a button that does it. The
 * preview is the CLI's own dry run rather than a second implementation that
 * could disagree with the real one, which is what makes it worth trusting.
 *
 * The states this has to render are all real: still asking, refused (with the
 * reason), nothing to undo, ready, and — the one that is easy to forget —
 * finished but *partial*, where some files were deliberately not restored.
 */

import { AlertTriangle, FileDiff, History, Undo2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { RewindResult } from '@metaclaude/shared';
import { Button, Spinner } from '@/components/ui/primitives';
import { Modal } from '@/components/ui/Modal';
import { usePlural, useT } from '@/lib/i18n';

export interface RewindDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Ask what a rewind would do. Called once per opening. */
  onPreview: () => Promise<RewindResult>;
  /** Do it. */
  onApply: () => Promise<RewindResult>;
}

export function RewindDialog({ open, onOpenChange, onPreview, onApply }: RewindDialogProps) {
  const plural = usePlural();
  const t = useT();
  const [preview, setPreview] = useState<RewindResult | null>(null);
  const [outcome, setOutcome] = useState<RewindResult | null>(null);
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    if (!open) return;
    // Re-asked on every opening rather than cached: the tree may have moved on
    // since last time, and a stale preview is worse than none — it is a
    // confident number that is wrong.
    let live = true;
    setPreview(null);
    setOutcome(null);
    void onPreview().then((result) => {
      if (live) setPreview(result);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const apply = async (): Promise<void> => {
    setApplying(true);
    try {
      setOutcome(await onApply());
    } catch (caught) {
      // A rejected request used to leave the dialog looking idle — button
      // re-enabled, nothing said — with no way to tell whether the files had
      // been touched. Failing loudly is the only safe reading.
      setOutcome({
        canRewind: false,
        error: caught instanceof Error ? caught.message : String(caught),
        filesChanged: [],
        insertions: 0,
        deletions: 0,
        skippedLinks: 0,
        applied: false,
      });
    } finally {
      setApplying(false);
    }
  };

  const empty = preview?.canRewind === true && preview.filesChanged.length === 0;
  /**
   * Whether to render the confirm button at all — disabled included.
   *
   * It is shown while the preview is still in flight, greyed out, rather than
   * appearing once the answer lands: a primary action that pops into existence
   * moves the buttons under a thumb already travelling towards Cancel. It
   * disappears only for the cases where confirming is never going to be
   * offered — the CLI refused, the run changed nothing, or it is already done.
   */
  const showConfirm = (preview === null || (preview.canRewind && !empty)) && !outcome;

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={
        <span className="flex items-center gap-2">
          <History className="size-4 text-accent" aria-hidden />
          {t('Rewind this run')}
        </span>
      }
      description={t(
        'Restore every file this run changed to the state it was in before the run started. Nothing else in the workspace is touched.',
      )}
      footer={
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            {outcome ? t('Close') : t('Cancel')}
          </Button>
          {showConfirm ? (
            <Button
              variant="danger"
              size="sm"
              // Confirming against an unknown blast radius is the thing this
              // dialog exists to prevent, so the count is part of the label and
              // the button is inert until there is one.
              disabled={preview === null}
              loading={applying}
              onClick={() => void apply()}
            >
              <Undo2 className="size-4" />
              {preview === null
                ? t('Restore files')
                : plural(preview.filesChanged.length, 'Restore {n} file', 'Restore {n} files')}
            </Button>
          ) : null}
        </div>
      }
    >
      {preview === null ? (
        <div className="flex items-center gap-3 py-6 text-[13px] text-muted">
          <Spinner className="size-4" />
          {t('Checking what this would restore…')}
        </div>
      ) : !preview.canRewind ? (
        <Notice tone="warning" text={preview.error ?? t('This run cannot be rewound.')} />
      ) : outcome ? (
        <Outcome result={outcome} />
      ) : empty ? (
        <p className="py-4 text-[13px] leading-relaxed text-muted">
          {t('This run made no file changes, so there is nothing to undo.')}
        </p>
      ) : (
        <Changes result={preview} />
      )}
    </Modal>
  );
}

/* -------------------------------------------------------------------------- */

function Notice({ tone, text }: { tone: 'warning' | 'success'; text: string }) {
  return (
    <div
      className={`flex items-start gap-2.5 rounded-lg px-3 py-2.5 text-[13px] leading-relaxed text-ink ${
        tone === 'warning' ? 'bg-warning-soft' : 'bg-success-soft'
      }`}
    >
      <AlertTriangle
        className={`mt-0.5 size-4 shrink-0 ${tone === 'warning' ? 'text-warning' : 'text-success'}`}
        aria-hidden
      />
      <span className="min-w-0 break-words">{text}</span>
    </div>
  );
}

/** The line-count summary, shared by the preview and the outcome. */
function DiffSummary({ result }: { result: RewindResult }) {
  const plural = usePlural();
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] tabular-nums text-muted">
      <span className="flex items-center gap-1.5">
        <FileDiff className="size-3.5 text-accent" aria-hidden />
        {plural(result.filesChanged.length, '{n} file', '{n} files')}
      </span>
      {result.insertions > 0 ? <span className="text-success">+{result.insertions}</span> : null}
      {result.deletions > 0 ? <span className="text-danger">−{result.deletions}</span> : null}
    </div>
  );
}

/**
 * The file list.
 *
 * Scrolls inside itself rather than growing the dialog: a run that touched
 * eighty files must not push the confirm button off a phone screen.
 */
function FileList({ paths }: { paths: string[] }) {
  return (
    <ul className="max-h-56 space-y-0.5 overflow-y-auto rounded-lg border border-line bg-raised p-2">
      {paths.map((path) => (
        <li key={path} className="truncate font-mono text-[12px] text-ink" title={path}>
          {path}
        </li>
      ))}
    </ul>
  );
}

function Changes({ result }: { result: RewindResult }) {
  const t = useT();
  return (
    <div className="space-y-3">
      <DiffSummary result={result} />
      <FileList paths={result.filesChanged} />
      <p className="text-[12px] leading-relaxed text-muted">
        {t(
          'This cannot be undone from here. Anything written since the run finished is overwritten too — the restore is to the point the run began, not a merge.',
        )}
      </p>
    </div>
  );
}

function Outcome({ result }: { result: RewindResult }) {
  const plural = usePlural();
  const t = useT();
  // The preview can succeed and the restore still fail — the CLI session can go
  // away in between. Reporting the count from a refused attempt would be the
  // worst lie available here: the operator stops looking for their changes.
  if (!result.applied) {
    return <Notice tone="warning" text={result.error ?? t('Nothing was restored.')} />;
  }

  return (
    <div className="space-y-3">
      {result.skippedLinks > 0 ? (
        // Stated first and as a warning. A partial restore reported as a
        // complete one is how an operator walks away believing their tree is
        // clean when part of it is not.
        <Notice
          tone="warning"
          text={plural(
            result.skippedLinks,
            'Restored, but {n} file was left alone: a symbolic link, a hard link or a moved directory made restoring it unsafe. Check that path by hand.',
            'Restored, but {n} files were left alone: a symbolic link, a hard link or a moved directory made restoring them unsafe. Check those paths by hand.',
          )}
        />
      ) : (
        <Notice
          tone="success"
          text={plural(
            result.filesChanged.length,
            'Restored {n} file to its state before the run.',
            'Restored {n} files to their state before the run.',
          )}
        />
      )}
      {result.filesChanged.length > 0 ? <FileList paths={result.filesChanged} /> : null}
    </div>
  );
}
