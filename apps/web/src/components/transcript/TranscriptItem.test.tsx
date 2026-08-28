/**
 * The transcript row, and the pieces it dispatches to.
 *
 * One assertion here matters more than the rest: assistant output reaches the
 * DOM through `dangerouslySetInnerHTML`. The sanitiser has its own thorough
 * tests in `lib/markdown.test.ts` — including the classic mXSS payload — but
 * those prove the sanitiser works, not that it is *in the path*. A refactor
 * that passed the raw text straight through would leave every one of them
 * green while handing agent output to the browser as markup.
 */

import { fireEvent, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TranscriptEvent } from '@metaclaude/shared';

import { renderWithProviders } from '@/test/render';

import { AssistantText, ThinkingBlock, TodoList, TranscriptItem } from './TranscriptItem';

const { ui } = vi.hoisted(() => ({ ui: { showThinking: true, expandTools: false } }));

vi.mock('@/lib/store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/store')>('@/lib/store');
  return {
    ...actual,
    useUiStore: (selector: (state: typeof ui) => unknown) => selector(ui),
  };
});

const noop = {
  rating: null,
  onRate: vi.fn(),
  canRewind: false,
  onRewind: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  ui.showThinking = true;
  ui.expandTools = false;
});

describe('assistant output', () => {
  it('renders markdown rather than escaping it', () => {
    renderWithProviders(<AssistantText text="Le préavis est de **trois mois**." />);
    expect(screen.getByText('trois mois').tagName).toBe('STRONG');
  });

  it('keeps the sanitiser in the path, not merely in its own test file', () => {
    // The output goes through `dangerouslySetInnerHTML`. `lib/markdown` is
    // where the allow-list is proven; this is where it is proven to be used.
    const { container } = renderWithProviders(
      <AssistantText text={'Voici le rapport.\n\n<img src=x onerror="alert(1)">'} />,
    );
    expect(container.innerHTML).not.toContain('onerror');
    expect(container.querySelector('script')).toBeNull();
  });

  it('renders nothing rather than a stray element for empty output', () => {
    const { container } = renderWithProviders(<AssistantText text="" />);
    expect(container.textContent).toBe('');
  });
});

describe('reasoning', () => {
  it('is absent entirely when the reader has switched it off', () => {
    ui.showThinking = false;
    const { container } = renderWithProviders(<ThinkingBlock text="Je réfléchis." />);
    expect(container.textContent).toBe('');
  });

  it('opens itself while streaming, because it is the only sign of life', () => {
    renderWithProviders(<ThinkingBlock text="Je réfléchis à voix haute." streaming />);
    expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Thinking…')).toBeDefined();
  });

  it('stays folded once finished, showing a one-line preview', () => {
    renderWithProviders(<ThinkingBlock text={'Première ligne.\n\nDeuxième ligne.'} />);
    const toggle = screen.getByRole('button');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByText('Reasoning')).toBeDefined();
    // Whitespace collapsed: a preview is one line by construction.
    expect(screen.getByText('Première ligne. Deuxième ligne.')).toBeDefined();
  });

  it('opens on demand', () => {
    renderWithProviders(<ThinkingBlock text="Le détail." />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('true');
  });
});

describe('the plan', () => {
  const todo = (items: Array<{ content: string; status: string; activeForm?: string }>) =>
    ({ kind: 'todo', id: 'e1', runId: 'run_1', at: 1, items }) as unknown as Extract<
      TranscriptEvent,
      { kind: 'todo' }
    >;

  it('counts what is finished against the whole', () => {
    renderWithProviders(
      <TodoList
        event={todo([
          { content: 'Lire le bail', status: 'completed' },
          { content: 'Résumer', status: 'in_progress' },
          { content: 'Envoyer', status: 'pending' },
        ])}
      />,
    );
    expect(screen.getByText('1/3')).toBeDefined();
  });

  it('says what is happening now, in the present tense the model supplied', () => {
    // `activeForm` exists so the running step reads as an action rather than
    // as a title; using `content` there would say "Summarise" while it is
    // being summarised.
    renderWithProviders(
      <TodoList
        event={todo([{ content: 'Résumer', status: 'in_progress', activeForm: 'Résumé en cours' }])}
      />,
    );
    expect(screen.getByText('Résumé en cours')).toBeDefined();
    expect(screen.queryByText('Résumer')).toBeNull();
  });

  it('falls back to the title when no active form was given', () => {
    renderWithProviders(<TodoList event={todo([{ content: 'Résumer', status: 'in_progress' }])} />);
    expect(screen.getByText('Résumer')).toBeDefined();
  });
});

describe('dispatch', () => {
  const event = (kind: string, extra: Record<string, unknown> = {}) =>
    ({ kind, id: 'e1', runId: 'run_1', at: 1, ...extra }) as unknown as TranscriptEvent;

  it('routes each kind to its own presentation', () => {
    const { rerender, container } = renderWithProviders(
      <TranscriptItem event={event('assistant_text', { text: '**gras**' })} {...noop} />,
    );
    expect(container.querySelector('strong')).not.toBeNull();

    rerender(<TranscriptItem event={event('thinking', { text: 'hmm' })} {...noop} />);
    expect(screen.getByText('Reasoning')).toBeDefined();
  });

  it('renders nothing for a kind it does not know', () => {
    // The SDK adds message types; an unknown one must be silent rather than
    // throwing inside a transcript the reader is scrolling.
    const { container } = renderWithProviders(
      <TranscriptItem event={event('something_new_from_the_sdk')} {...noop} />,
    );
    expect(container.textContent).toBe('');
  });
});
