/**
 * The user's bubble, and the files it carries.
 *
 * The renderer works from the transcript event alone: an image with an id
 * becomes a thumbnail served by the authenticated attachment route, any other
 * file becomes a chip linking to it, and an event persisted before
 * attachments carried ids degrades to a plain, unlinked chip.
 */

import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { TranscriptEvent } from '@metaclaude/shared';
import { renderWithProviders } from '@/test/render';
import { UserMessage } from './TranscriptItem';

type UserMessageEvent = Extract<TranscriptEvent, { kind: 'user_message' }>;

function event(attachments: UserMessageEvent['attachments']): UserMessageEvent {
  return {
    kind: 'user_message',
    id: 'ev_1',
    runId: 'run_1',
    seq: 0,
    at: 0,
    text: 'look at these',
    attachments,
  };
}

describe('UserMessage attachments', () => {
  it('renders nothing extra for a plain message', () => {
    renderWithProviders(<UserMessage event={event([])} />);
    expect(screen.queryByRole('list', { name: /attachments/i })).toBeNull();
  });

  it('shows an image as an inline thumbnail served by the attachment route', () => {
    renderWithProviders(
      <UserMessage
        event={event([
          { name: 'plan.png', path: 'attachments/ab-plan.png', bytes: 2048, attachmentId: 'att_1', mime: 'image/png' },
        ])}
      />,
    );

    const img = screen.getByRole('img', { name: 'plan.png' });
    expect(img.getAttribute('src')).toBe('/api/attachments/att_1');
  });

  it('shows any other file as a chip linking to its bytes', () => {
    renderWithProviders(
      <UserMessage
        event={event([
          { name: 'report.pdf', path: 'attachments/cd-report.pdf', bytes: 4096, attachmentId: 'att_2', mime: 'application/pdf' },
        ])}
      />,
    );

    const link = screen.getByRole('link', { name: /report\.pdf/i });
    expect(link.getAttribute('href')).toBe('/api/attachments/att_2');
    expect(screen.getByText('4 KB')).toBeTruthy();
  });

  it('degrades an event persisted without an id to an unlinked chip', () => {
    renderWithProviders(
      <UserMessage event={event([{ name: 'old.txt', path: 'attachments/ef-old.txt', bytes: 100 }])} />,
    );

    expect(screen.getByText('old.txt')).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByRole('img')).toBeNull();
  });
});
