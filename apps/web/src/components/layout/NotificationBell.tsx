/**
 * Notification centre.
 *
 * Runs finish while the operator is on another screen — often on another
 * device — so completion, failure and "I learned something" notices collect
 * here rather than only appearing as transient toasts.
 */

import * as Popover from '@radix-ui/react-popover';
import { Bell, CheckCheck, Trash2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useT } from '@/lib/i18n';
import { useNotificationStore } from '@/lib/store';
import { Button, EmptyState } from '@/components/ui/primitives';
import { cn, formatRelative } from '@/lib/utils';

/** What each level *means*, for the readers a colour cannot reach. */
const LEVEL_LABEL: Record<'success' | 'error' | 'warning' | 'info', string> = {
  success: 'Succeeded',
  error: 'Failed',
  warning: 'Needs attention',
  info: 'Information',
};

export function NotificationBell() {
  const t = useT();
  const { items, markAllRead, clear } = useNotificationStore();
  const unread = items.filter((item) => !item.read).length;

  return (
    <Popover.Root onOpenChange={(open) => open && markAllRead()}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="relative flex size-8 items-center justify-center rounded-lg text-subtle hover:bg-raised hover:text-ink"
          aria-label={unread > 0 ? t(
            'Notifications ({n} unread)',
            { n: unread },
          ) : t('Notifications')}
        >
          <Bell className="size-4" aria-hidden />
          {unread > 0 ? (
            <span className="absolute right-1 top-1 flex min-w-[15px] items-center justify-center rounded-full bg-accent px-1 text-[9px] font-bold leading-[15px] text-accent-ink">
              {unread > 9 ? '9+' : unread}
            </span>
          ) : null}
        </button>
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          side="right"
          align="end"
          sideOffset={8}
          collisionPadding={12}
          className="animate-in-up z-50 flex max-h-[70vh] w-[min(22rem,92vw)] flex-col overflow-hidden rounded-xl border border-line bg-raised shadow-[var(--mc-shadow-lg)]"
        >
          <div className="flex items-center justify-between border-b border-line px-3 py-2">
            <h3 className="text-[13px] font-semibold text-ink">{t('Notifications')}</h3>
            {items.length > 0 ? (
              <div className="flex items-center gap-1">
                <Button variant="ghost" size="icon-sm" onClick={markAllRead} aria-label={t(
                  'Mark all read',
                )}>
                  <CheckCheck className="size-3.5" />
                </Button>
                <Button variant="ghost" size="icon-sm" onClick={clear} aria-label={t('Clear all')}>
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            ) : null}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {items.length === 0 ? (
              <EmptyState
                title={t('Nothing yet')}
                description={t('Run results and things Metaclaude learns will show up here.')}
                className="py-10"
              />
            ) : (
              <ul className="divide-y divide-line">
                {items.map((item) => {
                  const body = (
                    <>
                      <div className="flex items-start gap-2">
                        <span
                          className={cn(
                            'mt-1.5 size-1.5 shrink-0 rounded-full',
                            item.level === 'success' && 'bg-success',
                            item.level === 'error' && 'bg-danger',
                            item.level === 'warning' && 'bg-warning',
                            item.level === 'info' && 'bg-info',
                          )}
                          aria-hidden
                        />
                        {/* The dot carries the level in colour alone, so a
                            failed run and a finished one read identically to
                            anyone not seeing it. This is where a failure is
                            found, which makes that the wrong thing to leave
                            to a hue. */}
                        <span className="sr-only">{t(LEVEL_LABEL[item.level])}</span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[13px] font-medium text-ink">{t(item.title)}</p>
                          <p className="mt-0.5 line-clamp-2 text-[12px] leading-snug text-muted">
                            {item.message}
                          </p>
                        </div>
                        <span className="shrink-0 text-[10.5px] text-subtle">
                          {formatRelative(item.at)}
                        </span>
                      </div>
                    </>
                  );

                  return (
                    <li key={item.id}>
                      {item.href ? (
                        <Popover.Close asChild>
                          <Link to={item.href} className="block px-3 py-2.5 hover:bg-surface">
                            {body}
                          </Link>
                        </Popover.Close>
                      ) : (
                        <div className="px-3 py-2.5">{body}</div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
