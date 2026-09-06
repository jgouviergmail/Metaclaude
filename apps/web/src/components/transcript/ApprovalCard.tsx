/**
 * Permission prompt.
 *
 * This is the moment where the operator either understands what is about to
 * happen or rubber-stamps it. Three design decisions follow from that:
 *
 *  1. The action is shown verbatim — the actual command, the actual path — not a
 *     paraphrase. A summary you cannot verify is worse than no summary.
 *  2. High-risk calls get a visually distinct treatment and no "always allow"
 *     shortcut, so the dangerous path is never the fast path.
 *  3. Approve is never the default focus. Deny is the safe key.
 */

import { AlertTriangle, Check, Clock, ShieldQuestion, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ApprovalRequest } from '@metaclaude/shared';
import { useT } from '@/lib/i18n';
import { Badge, Button, Tooltip } from '@/components/ui/primitives';
import { cn } from '@/lib/utils';

const RISK_COPY: Record<ApprovalRequest['risk'], { label: string; blurb: string }> = {
  low: { label: 'Low risk', blurb: 'Reads data without changing anything.' },
  medium: {
    label: 'Medium risk',
    blurb: 'Writes files, runs a command, or reaches an external service.',
  },
  high: {
    label: 'High risk',
    blurb: 'This command matches a destructive pattern. Read it carefully.',
  },
};

export function ApprovalCard({
  request,
  onDecide,
}: {
  request: ApprovalRequest;
  onDecide: (approved: boolean, remember: boolean) => void | Promise<void>;
}) {
  const t = useT();
  const [remember, setRemember] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [remaining, setRemaining] = useState(() =>
    Math.max(0, request.expiresAt - Date.now()),
  );

  // A live countdown, because a prompt that silently expires and denies the tool
  // is confusing without one.
  useEffect(() => {
    const tick = setInterval(() => {
      setRemaining(Math.max(0, request.expiresAt - Date.now()));
    }, 1000);
    return () => clearInterval(tick);
  }, [request.expiresAt]);

  const decide = (approved: boolean): void => {
    setSubmitting(true);
    // `submitting` disables both buttons and short-circuits the accelerators,
    // and nothing else clears it — the card is expected to disappear when the
    // server confirms. So a decision that never arrived has to say so, or the
    // operator is left looking at a card they can no longer act on.
    void Promise.resolve(onDecide(approved, remember && request.risk !== 'high')).catch(() => {
      setSubmitting(false);
    });
  };

  /*
   * Keyboard accelerators, scoped to this card.
   *
   * They were on `window`, which made them global in the worst way: every
   * mounted card installed its own listener, so one ⌘Enter approved *all*
   * pending prompts at once, and Escape — the key that closes a menu or a
   * modal — denied all of them. Worse, ⌘Enter is how the composer sends a
   * message, so typing a prompt while an approval was pending silently
   * authorised the tool.
   *
   * Handling the event on the card means it only fires when focus is inside
   * this card, which is also what makes the shortcut legible: you act on the
   * thing you are looking at.
   */
  const cardRef = useRef<HTMLDivElement>(null);

  /*
   * Whether this card may claim focus at all, decided once — during the first
   * render, which is before React commits `autoFocus` and before any effect
   * runs, so `document.activeElement` is still whatever held focus when the
   * prompt arrived.
   *
   * Two things were wrong, and they share this one answer.
   *
   * `autoFocus` on Deny is committed during the mount commit, *before* passive
   * effects; the effect below then ran and moved focus to the container, which
   * handles no keys of its own. So "Deny holds initial focus, because a
   * reflexive Enter should land on the safe choice" was quietly false — Enter
   * did nothing, and a keyboard user had to Tab before anything was reachable.
   *
   * And several prompts can be pending at once: the broker keeps a map, the
   * stream maps over an array. A second card arriving would take focus off the
   * first — invisibly, since `preventScroll` means nothing moves on screen — so
   * a ⌘Enter meant for the prompt being read approved a different one.
   *
   * Gating both on "is focus already somewhere it should not be taken from"
   * settles it: the first prompt focuses Deny and keeps it, a later one leaves
   * the operator where they are, and nobody is interrupted mid-sentence.
   */
  const [mayClaimFocus] = useState(() => {
    if (typeof document === 'undefined') return true;
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return true;
    const isEditing =
      active.isContentEditable ||
      active.tagName === 'INPUT' ||
      active.tagName === 'TEXTAREA' ||
      active.tagName === 'SELECT';
    return !isEditing && !active.closest('[role="alertdialog"]');
  });

  // The fallback for when `autoFocus` did not take — a background tab, a
  // browser that declined it. Keydown reaches the handler either way, by
  // bubbling up from whichever descendant holds focus.
  useEffect(() => {
    if (!mayClaimFocus) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.closest('[role="alertdialog"]')) return;
    cardRef.current?.focus({ preventScroll: true });
  }, [mayClaimFocus]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (submitting) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      decide(false);
    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      event.stopPropagation();
      decide(true);
    }
  };

  const risk = RISK_COPY[request.risk];
  const command = extractCommand(request.input);

  return (
    <div
      className={cn(
        'animate-in-up overflow-hidden rounded-xl border-2 shadow-[var(--mc-shadow)]',
        request.risk === 'high'
          ? 'border-danger bg-danger-soft/30'
          : request.risk === 'medium'
            ? 'border-warning/60 bg-warning-soft/25'
            : 'border-accent/50 bg-accent-soft/25',
      )}
      role="alertdialog"
      aria-labelledby={`approval-${request.id}-title`}
      aria-describedby={`approval-${request.id}-action`}
      ref={cardRef}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <div className="flex items-start gap-3 px-4 pt-3.5">
        <span
          className={cn(
            'mt-0.5 shrink-0 [&>svg]:size-5',
            request.risk === 'high' ? 'text-danger' : 'text-accent',
          )}
          aria-hidden
        >
          {request.risk === 'high' ? <AlertTriangle /> : <ShieldQuestion />}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 id={`approval-${request.id}-title`} className="text-body font-semibold text-ink">
              {t('Permission needed')}
            </h3>
            <Badge
              tone={
                request.risk === 'high' ? 'danger' : request.risk === 'medium' ? 'warning' : 'accent'
              }
            >
              {t(risk.label)}
            </Badge>
            <code className="rounded bg-raised px-1.5 py-0.5 font-mono text-[11px] text-muted">
              {request.toolName}
            </code>

            {remaining > 0 ? (
              <Tooltip content={t('Unanswered prompts are declined automatically.')}>
                <span className="ml-auto flex cursor-help items-center gap-1 text-[11px] tabular-nums text-subtle">
                  <Clock className="size-3" aria-hidden />
                  {formatCountdown(remaining)}
                </span>
              </Tooltip>
            ) : null}
          </div>

          <p className="mt-1 text-[13px] leading-relaxed text-muted">{t(risk.blurb)}</p>
        </div>
      </div>

      {/* The literal action. This is the part that must be trustworthy. */}
      <div
        id={`approval-${request.id}-action`}
        className="mx-4 mt-3 overflow-hidden rounded-lg border border-line bg-surface"
      >
        {command ? (
          <pre className="max-h-52 overflow-auto px-3 py-2.5 font-mono text-[12.5px] leading-relaxed text-ink">
            {command}
          </pre>
        ) : (
          <div className="space-y-1 px-3 py-2.5">
            <p className="text-[13px] text-ink">{request.summary}</p>
            <pre className="max-h-40 overflow-auto font-mono text-[11.5px] text-muted">
              {safeJson(request.input)}
            </pre>
          </div>
        )}
      </div>

      {request.reason ? (
        <p className="mx-4 mt-2 text-[12px] leading-relaxed text-muted">
          <span className="font-medium text-ink">{t('Why you are being asked:')} </span>
          {request.reason}
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line/60 bg-surface/40 px-4 py-3">
        <Button
          variant="danger"
          size="sm"
          onClick={() => decide(false)}
          disabled={submitting}
          // Deny holds initial focus: the safe choice should be the one a
          // reflexive Enter press lands on. Withheld when another prompt or an
          // input already has it — see `mayClaimFocus`.
          autoFocus={mayClaimFocus}
        >
          <X className="size-4" aria-hidden />
          {t('Deny')}
          <kbd className="ml-1 hidden rounded bg-black/20 px-1 text-[10px] sm:inline">{t(
            'Esc',
          )}</kbd>
        </Button>

        <Button variant="success" size="sm" onClick={() => decide(true)} disabled={submitting}>
          <Check className="size-4" aria-hidden />
          {t('Allow')}
        </Button>

        {/* "Always allow" is withheld for high-risk calls by design. */}
        {request.risk !== 'high' ? (
          <label className="ml-auto flex cursor-pointer select-none items-center gap-2 text-[12px] text-muted">
            <input
              type="checkbox"
              checked={remember}
              onChange={(event) => setRemember(event.target.checked)}
              className="size-3.5 accent-[var(--mc-accent)]"
            />
            {t('Remember for this session')}
          </label>
        ) : (
          <span className="ml-auto text-[11px] text-danger">
            {t('High-risk actions are always asked individually.')}
          </span>
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

/** Pull the human-verifiable command out of a tool input, when there is one. */
function extractCommand(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const record = input as Record<string, unknown>;

  if (typeof record.command === 'string') return record.command;
  if (typeof record.file_path === 'string' && typeof record.content === 'string') {
    const preview = record.content.slice(0, 800);
    return `${record.file_path}\n\n${preview}${record.content.length > 800 ? '\n…' : ''}`;
  }
  if (typeof record.file_path === 'string') return record.file_path;
  if (typeof record.url === 'string') return record.url;
  return null;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function formatCountdown(ms: number): string {
  const totalSeconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
