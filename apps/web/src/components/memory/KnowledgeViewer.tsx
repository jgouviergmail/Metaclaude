/**
 * Reading a document, at the line a run quoted.
 *
 * The editor cannot serve for this. A file-backed document's text is what its
 * extractor produced — the store refuses an edit of it — and the point of
 * opening it is to *check* a citation, which means seeing the line and its
 * neighbours rather than a textarea scrolled to the top.
 *
 * So: numbered lines, the cited one highlighted and scrolled to, and the two
 * things that only make sense here — downloading the original, and asking for
 * it to be read again.
 */

import { useEffect, useRef } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Download, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';

import { Modal } from '@/components/ui/Modal';
import { Badge, Button, Skeleton } from '@/components/ui/primitives';
import { api, ApiError } from '@/lib/api';
import { usePlural, useT } from '@/lib/i18n';
import { formatLabel } from '@/lib/knowledge';
import { cn, formatBytes } from '@/lib/utils';

export function KnowledgeViewer({
  documentId,
  line,
  onOpenChange,
  onChanged,
}: {
  /** Null closes it. */
  documentId: string | null;
  /** The line to open at, 1-based; null opens at the top. */
  line?: number | null;
  onOpenChange: (open: boolean) => void;
  onChanged: () => void;
}) {
  const t = useT();
  const plural = usePlural();
  const body = useRef<HTMLDivElement>(null);

  const query = useQuery({
    // Under the section's prefix, so one `invalidateQueries(['knowledge'])`
    // reaches the list, the rehearsal and this.
    queryKey: ['knowledge', 'document', documentId],
    queryFn: () => api.knowledge.get(documentId!),
    enabled: documentId !== null,
  });

  const document = query.data?.document;
  const lines = document ? document.content.split('\n') : [];

  // Bring the cited line into view once the text is there. Keyed on the id and
  // the line so reopening at a different line scrolls again, and guarded on
  // the content because the element does not exist before it arrives.
  useEffect(() => {
    if (!document || !line) return;
    const target = body.current?.querySelector(`[data-line="${line}"]`);
    target?.scrollIntoView({ block: 'center' });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the rendered text is what makes the element exist; `document.content` is the honest trigger.
  }, [document?.id, document?.content, line]);

  const extract = useMutation({
    mutationFn: () => api.knowledge.extract(documentId!),
    onSuccess: (result) => {
      void query.refetch();
      onChanged();
      toast.success(t('Read again with {engine}', { engine: result.document.source?.extractor ?? '' }), {
        description: plural(
          result.document.chunkCount,
          '{n} passage indexed',
          '{n} passages indexed',
        ),
      });
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t('Could not re-extract that file.')),
  });

  const source = document?.source ?? null;
  const format = formatLabel(source);

  return (
    <Modal
      open={documentId !== null}
      onOpenChange={onOpenChange}
      size="xl"
      title={document?.title ?? t('Document')}
    >
      {query.isLoading ? (
        <Skeleton className="h-64" />
      ) : !document ? (
        <p className="text-body text-muted">{t('This document could not be opened.')}</p>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-caption text-subtle">
            {format ? <Badge tone="neutral">{format}</Badge> : null}
            {source ? <span className="truncate">{source.name}</span> : null}
            <span>
              {plural(document.chunkCount, '{n} passage', '{n} passages')} ·{' '}
              {formatBytes(document.contentLength)}
              {document.pageCount !== null
                ? ` · ${plural(document.pageCount, '{n} page', '{n} pages')}`
                : ''}
            </span>
            {source ? (
              <span className="truncate font-mono text-caption text-subtle">
                {source.extractor}
              </span>
            ) : null}
          </div>

          <div
            ref={body}
            // A bounded, scrollable body: a three-hundred-page PDF is a very
            // long document, and the modal must not become the page.
            className="max-h-[60vh] overflow-auto rounded-lg border border-line bg-sunken/40"
          >
            <ol className="min-w-0 py-2 font-mono text-caption leading-relaxed">
              {lines.map((text, index) => {
                const number = index + 1;
                const cited = line === number;
                return (
                  <li
                    key={number}
                    data-line={number}
                    className={cn(
                      'flex gap-3 px-3',
                      cited ? 'bg-accent-soft/60' : undefined,
                    )}
                  >
                    <span className="w-10 shrink-0 select-none text-right text-subtle">
                      {number}
                    </span>
                    {/* `whitespace-pre-wrap` keeps the document's own shape —
                        a table row stays a row — while still wrapping on a
                        phone rather than scrolling the whole modal sideways. */}
                    <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-ink">
                      {text || ' '}
                    </span>
                  </li>
                );
              })}
            </ol>
          </div>

          {source ? (
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                loading={extract.isPending}
                onClick={() => extract.mutate()}
              >
                <RefreshCw className="size-4" />
                {t('Read the file again')}
              </Button>
              {/* A plain link: the browser downloads it, so a twenty-megabyte
                  file never passes through this process's memory. */}
              <a
                href={api.knowledge.sourceUrl(document.id)}
                download={source.name}
                className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-caption text-ink hover:bg-sunken"
              >
                <Download className="size-4" />
                {t('Download the original')}
              </a>
            </div>
          ) : null}
        </div>
      )}
    </Modal>
  );
}
