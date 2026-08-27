/**
 * The upload plumbing the composer trusts.
 *
 * bufferToBase64 exists because `btoa(String.fromCharCode(...bytes))` throws
 * past a few hundred kilobytes of arguments — precisely the size of every
 * interesting screenshot — so the encoding must chunk, and chunking must not
 * change the answer.
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { bufferToBase64, usePendingAttachments } from './attachments';

vi.mock('./api.js', () => ({
  api: {
    uploadAttachment: vi.fn(async (_session: string, body: { name: string }) => ({
      attachment: { id: `att_${body.name}`, mime: 'image/png' },
    })),
    deleteAttachment: vi.fn(async () => ({ ok: true })),
  },
}));

describe('bufferToBase64', () => {
  it('matches btoa on something small', () => {
    const bytes = new TextEncoder().encode('hello attachments');
    expect(bufferToBase64(bytes.buffer as ArrayBuffer)).toBe(btoa('hello attachments'));
  });

  it('round-trips a buffer far larger than one chunk', () => {
    // 200 KB of a repeating non-ASCII-safe byte pattern spans many 32 KB
    // chunks; a chunking bug (overlap, gap, argument overflow) breaks the
    // round-trip or throws.
    const bytes = new Uint8Array(200_000);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = i % 251;

    const decoded = atob(bufferToBase64(bytes.buffer as ArrayBuffer));
    expect(decoded.length).toBe(bytes.length);
    expect(decoded.charCodeAt(0)).toBe(0);
    expect(decoded.charCodeAt(199_999)).toBe(199_999 % 251);
    expect(decoded.charCodeAt(65_536)).toBe(65_536 % 251);
  });
});

describe('usePendingAttachments', () => {
  it('uploads a picked file and reports it ready', async () => {
    const { result } = renderHook(() => usePendingAttachments('ses_1'));

    act(() => {
      result.current.attach([new File(['bytes'], 'shot.png', { type: 'image/png' })]);
    });

    await waitFor(() => expect(result.current.readyIds).toEqual(['att_shot.png']));
    expect(result.current.uploading).toBe(false);
  });

  it('drops pending files when the user navigates to another session', async () => {
    // The page keeps the hook mounted across session navigation; files picked
    // for one conversation must not follow into the next — the server would
    // refuse the bind, after the surprise.
    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId: string }) => usePendingAttachments(sessionId),
      { initialProps: { sessionId: 'ses_1' } },
    );

    act(() => {
      result.current.attach([new File(['bytes'], 'shot.png', { type: 'image/png' })]);
    });
    await waitFor(() => expect(result.current.attachments).toHaveLength(1));

    rerender({ sessionId: 'ses_2' });
    expect(result.current.attachments).toHaveLength(0);
  });
});
