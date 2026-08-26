/**
 * Pending message attachments — the composer's half of the upload flow.
 *
 * Files are uploaded as soon as they are picked (or dropped, or pasted), so
 * sending the message is instant and a failed upload surfaces while the user
 * is still looking at the chip, not after they pressed Send. The server holds
 * them unbound until submission; removing a chip deletes the pending upload.
 */

import { useCallback, useRef, useState } from 'react';
import { ATTACHMENT_LIMITS, ATTACHMENT_MIME_TYPES } from '@metaclaude/shared';
import { api } from './api.js';

export interface PendingAttachment {
  /** Local identity, stable from pick to upload to removal. */
  key: string;
  /** Server id once the upload lands; null while in flight or failed. */
  id: string | null;
  name: string;
  bytes: number;
  mime: string;
  status: 'uploading' | 'ready' | 'error';
  error?: string;
}

/** What the file picker offers. MIME list plus extensions for pickers that match on either. */
export const ATTACHMENT_ACCEPT = [
  ...ATTACHMENT_MIME_TYPES,
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.pdf', '.txt', '.md', '.csv', '.html', '.json',
  '.zip', '.docx', '.xlsx',
].join(',');

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * ArrayBuffer → base64 without blowing the argument limit: `btoa` takes a
 * string, and building it in one `String.fromCharCode(...bytes)` call throws
 * on anything past a few hundred kilobytes.
 */
export function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function usePendingAttachments(sessionId: string | undefined): {
  attachments: PendingAttachment[];
  attach: (files: File[]) => void;
  remove: (key: string) => void;
  clear: () => void;
  readyIds: string[];
  uploading: boolean;
} {
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const counter = useRef(0);

  const patch = useCallback((key: string, changes: Partial<PendingAttachment>) => {
    setAttachments((current) =>
      current.map((item) => (item.key === key ? { ...item, ...changes } : item)),
    );
  }, []);

  const attach = useCallback(
    (files: File[]) => {
      if (!sessionId) return;
      for (const file of files) {
        // Client-side refusals mirror the server's, so the common mistakes
        // never cost a round-trip — the server stays the authority.
        const key = `att-local-${counter.current++}`;
        const base: PendingAttachment = {
          key,
          id: null,
          name: file.name,
          bytes: file.size,
          mime: file.type,
          status: 'uploading',
        };

        setAttachments((current) => {
          if (current.length >= ATTACHMENT_LIMITS.maxPerMessage) {
            return current; // The cap message renders from the count itself.
          }
          if (file.size > ATTACHMENT_LIMITS.maxBytes) {
            return [
              ...current,
              {
                ...base,
                status: 'error',
                error: `Over ${Math.floor(ATTACHMENT_LIMITS.maxBytes / (1024 * 1024))} MB`,
              },
            ];
          }
          void (async () => {
            try {
              const data = bufferToBase64(await file.arrayBuffer());
              const { attachment } = await api.uploadAttachment(sessionId, {
                name: file.name,
                mime: file.type,
                data,
              });
              patch(key, { id: attachment.id, mime: attachment.mime, status: 'ready' });
            } catch (error) {
              patch(key, { status: 'error', error: (error as Error).message });
            }
          })();
          return [...current, base];
        });
      }
    },
    [sessionId, patch],
  );

  const remove = useCallback((key: string) => {
    setAttachments((current) => {
      const found = current.find((item) => item.key === key);
      // Best-effort: a pending server row left behind is reaped as an orphan,
      // never sent — the chip disappearing must not wait on the network.
      if (found?.id) void api.deleteAttachment(found.id).catch(() => undefined);
      return current.filter((item) => item.key !== key);
    });
  }, []);

  const clear = useCallback(() => setAttachments([]), []);

  return {
    attachments,
    attach,
    remove,
    clear,
    readyIds: attachments.filter((item) => item.status === 'ready' && item.id).map((item) => item.id as string),
    uploading: attachments.some((item) => item.status === 'uploading'),
  };
}
