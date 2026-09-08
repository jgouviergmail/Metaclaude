/**
 * Dropping files into the library.
 *
 * Three decisions worth naming.
 *
 * **Uploads are sequential.** A twenty-megabyte file is twenty-seven of
 * base64, and the server extracts each one in a worker thread on a two-core
 * host: three at once is three times the memory for the same wall-clock, and
 * a queue an operator can watch is easier to read than three bars racing.
 *
 * **A refusal stays on screen.** The server's message is the useful half —
 * "this PDF is a scan", "this type is not read" — and a toast is gone before
 * it has been understood. Each file keeps its own line until it is dismissed.
 *
 * **The obvious refusals happen here.** Size and type are checked before the
 * bytes are read, so dropping a film does not spend a minute encoding it into
 * base64 to be told no.
 */

import { useRef, useState } from 'react';
import { FileUp, Loader2, Upload, X } from 'lucide-react';
import type { ExtensionReach, KnowledgeDocumentMeta } from '@metaclaude/shared';

import { Button } from '@/components/ui/primitives';
import { TOUCH_TARGET_Y } from '@/components/ui/touch-target';
import { api, ApiError } from '@/lib/api';
import { bufferToBase64 } from '@/lib/attachments';
import { usePlural, useT } from '@/lib/i18n';
import { KNOWLEDGE_ACCEPT, KNOWLEDGE_MAX_BYTES } from '@/lib/knowledge';
import { cn, formatBytes } from '@/lib/utils';

interface Pending {
  key: string;
  name: string;
  bytes: number;
  status: 'uploading' | 'done' | 'error';
  /** Passages indexed on success, or the server's own sentence on failure. */
  detail: string;
}

const ACCEPTED_EXTENSIONS = KNOWLEDGE_ACCEPT.split(',').filter((one) => one.startsWith('.'));

/**
 * What the hint under the drop zone lists.
 *
 * The aliases are dropped — `.markdown` beside `.md`, `.htm` beside `.html` —
 * because the hint is read, not parsed: eleven extensions wrap to two lines on
 * a phone and say nothing the nine do not. The picker still accepts all of
 * them, and so does the server.
 */
const HINTED_EXTENSIONS = ACCEPTED_EXTENSIONS.filter(
  (one) => one !== '.markdown' && one !== '.htm',
);

export function KnowledgeUploadZone({
  reach,
  onUploaded,
}: {
  /** What a dropped file will reach — the section's current scope. */
  reach: ExtensionReach;
  onUploaded: (document: KnowledgeDocumentMeta) => void;
}) {
  const t = useT();
  const plural = usePlural();
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [pending, setPending] = useState<Pending[]>([]);
  const [busy, setBusy] = useState(false);
  const counter = useRef(0);
  const queue = useRef<{ row: Pending; file: File }[]>([]);
  const draining = useRef(false);

  const update = (key: string, patch: Partial<Pending>): void =>
    setPending((rows) => rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));

  /**
   * Add to the queue, and start the drain if nothing is draining it.
   *
   * A queue and a flag rather than a loop per drop: sequencing the files of
   * one drop is not the same promise as sequencing the drops, and dropping a
   * second file while a twenty-megabyte PDF is still going is ordinary. Two
   * loops then ran together, and the first to finish declared the queue idle
   * — which is what put "Clear the list" under a row still in flight, where
   * clearing it dropped the row and lost the result of a request nobody had
   * cancelled. Both refs, never state: this is read and written inside one
   * synchronous event handler, where a re-render would be too late to help.
   */
  function enqueue(files: File[]): void {
    if (files.length === 0) return;
    const queued: Pending[] = files.map((file) => ({
      key: `f${(counter.current += 1)}`,
      name: file.name,
      bytes: file.size,
      status: 'uploading',
      detail: '',
    }));
    setPending((rows) => [...rows, ...queued]);
    queue.current.push(...files.map((file, index) => ({ row: queued[index]!, file })));
    if (!draining.current) void drain();
  }

  async function drain(): Promise<void> {
    draining.current = true;
    setBusy(true);

    // One at a time, and on purpose: see the header.
    while (queue.current.length > 0) {
      const { row, file } = queue.current.shift()!;

      if (file.size > KNOWLEDGE_MAX_BYTES) {
        update(row.key, {
          status: 'error',
          detail: t('Larger than {size}.', { size: formatBytes(KNOWLEDGE_MAX_BYTES) }),
        });
        continue;
      }
      if (!acceptable(file)) {
        update(row.key, {
          status: 'error',
          detail: t('This type is not read. Accepted: {list}.', {
            list: ACCEPTED_EXTENSIONS.join(', '),
          }),
        });
        continue;
      }

      try {
        const { document } = await api.knowledge.upload({
          name: file.name,
          mime: file.type,
          data: bufferToBase64(await file.arrayBuffer()),
          reach,
        });
        update(row.key, {
          status: 'done',
          detail: plural(document.chunkCount, '{n} passage indexed', '{n} passages indexed'),
        });
        onUploaded(document);
      } catch (error) {
        update(row.key, {
          status: 'error',
          // The server's sentence, verbatim: it knows whether this was a scan,
          // a duplicate or a type nobody reads, and a generic message would
          // throw that away.
          detail: error instanceof ApiError ? error.message : t('Could not upload that file.'),
        });
      }
    }

    draining.current = false;
    setBusy(false);
  }

  const pick = (list: FileList | null): void => {
    if (list) enqueue([...list]);
  };

  return (
    <div className="space-y-2">
      <div
        // A plain region, with the control named inside it. Wrapping the area
        // in a `<label>` would make all of it clickable, and it would also put
        // a button inside a label, where a click is claimed by both — so the
        // named control is the button, and the hidden input carries its own
        // label for anyone who reaches it directly.
        className={cn(
          'flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed px-4 py-6 text-center transition-colors',
          dragging ? 'border-accent bg-accent-soft/40' : 'border-line bg-sunken/30',
        )}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          pick(event.dataTransfer.files);
        }}
      >
        <FileUp className="size-5 text-subtle" aria-hidden />
        <p className="text-caption text-muted">
          {t('Drop files here, or')}{' '}
          <button
            type="button"
            className="font-medium text-accent underline-offset-2 hover:underline"
            onClick={() => input.current?.click()}
          >
            {t('choose them')}
          </button>
        </p>
        <p className="text-caption text-subtle">
          {HINTED_EXTENSIONS.join(' · ')} — {formatBytes(KNOWLEDGE_MAX_BYTES)} {t('max')}
        </p>
        <input
          ref={input}
          type="file"
          multiple
          accept={KNOWLEDGE_ACCEPT}
          className="hidden"
          aria-label={t('Choose files to add to the library')}
          onChange={(event) => {
            pick(event.target.files);
            // Cleared, so choosing the same file twice in a row still fires.
            event.target.value = '';
          }}
        />
      </div>

      {pending.length > 0 ? (
        <ul className="space-y-1" aria-label={t('Uploads')}>
          {pending.map((row) => (
            <li
              key={row.key}
              className={cn(
                'flex items-center gap-2 rounded-lg border px-3 py-2 text-caption',
                row.status === 'error'
                  ? 'border-danger/40 bg-danger-soft/30'
                  : 'border-line bg-surface',
              )}
            >
              {row.status === 'uploading' ? (
                <Loader2 className="size-3.5 shrink-0 animate-spin text-accent" aria-hidden />
              ) : (
                <Upload
                  className={cn(
                    'size-3.5 shrink-0',
                    row.status === 'error' ? 'text-danger' : 'text-success',
                  )}
                  aria-hidden
                />
              )}
              <span className="min-w-0 flex-1 truncate text-ink">{row.name}</span>
              <span
                className={cn(
                  'shrink-0 text-right',
                  row.status === 'error' ? 'text-danger' : 'text-subtle',
                )}
              >
                {row.status === 'uploading' ? t('Uploading…') : row.detail}
              </span>
              {row.status !== 'uploading' ? (
                <button
                  type="button"
                  className={cn('shrink-0 text-subtle hover:text-ink', TOUCH_TARGET_Y)}
                  aria-label={t('Dismiss “{name}”', { name: row.name })}
                  onClick={() => setPending((rows) => rows.filter((one) => one.key !== row.key))}
                >
                  <X className="size-3.5" />
                </button>
              ) : null}
            </li>
          ))}
          {!busy && pending.length > 1 ? (
            <li className="flex justify-end">
              <Button variant="ghost" size="sm" onClick={() => setPending([])}>
                {t('Clear the list')}
              </Button>
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * Is this a file the library reads?
 *
 * By type when the browser gave one it knows, by extension otherwise — the
 * same two-step the server does, because several browsers hand over an empty
 * type for a drag-dropped `.md` and refusing it here would be a bug nobody
 * could explain.
 */
function acceptable(file: File): boolean {
  const accepted = KNOWLEDGE_ACCEPT.split(',');
  if (file.type && accepted.includes(file.type)) return true;
  const dot = file.name.lastIndexOf('.');
  return dot > 0 && accepted.includes(file.name.slice(dot).toLowerCase());
}
