/**
 * The operational settings, changed without a restart.
 *
 * The screen's whole job beyond "edit a number" is to be honest about where
 * each value comes from. `compose.yml` names every one of these with a default
 * of its own, so a stored override is nearly always shadowing something — and
 * a form that showed only the value in force would be a second source of truth
 * that never admits it is one. Each row therefore says what applies, what it
 * would fall back to, and who decided.
 *
 * Durations are shown in minutes. `14400000` is not a duration anybody reads;
 * the wire keeps milliseconds because that is the unit the server validates.
 * Zero survives the conversion in both directions because it is the value that
 * means "no ceiling" rather than "zero minutes".
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RotateCcw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import type { RuntimeSettingRecord } from '@metaclaude/shared';

import { Menu, MenuItem } from '@/components/ui/Menu';
import { Badge, Button, Card, CardHeader, Input, Spinner } from '@/components/ui/primitives';
import { api, ApiError } from '@/lib/api';
import { usePlural, useT } from '@/lib/i18n';
import { formatRelative } from '@/lib/utils';

/**
 * What each setting is, in the words of someone deciding whether to change it.
 *
 * English held as data and translated at render, which is the pattern
 * `i18n.tsx` documents: a constant evaluated at import time must never bake a
 * language in. Keyed by the server's own key, so a setting the server stops
 * exposing simply stops being rendered.
 */
export const COPY: Record<string, { label: string; help: string }> = {
  idleTimeoutMs: {
    label: 'Stop a run that goes quiet after',
    help: 'The ceiling that should normally do the stopping: it asks whether a run is still alive, not how long it has worked. The agent reports every half minute while a tool runs, so silence this long means it stopped. 0 switches it off.',
  },
  runTimeoutMs: {
    label: 'Stop a run outright after',
    help: 'A backstop, deliberately generous: elapsed time is the wrong question for a loop or a long refactor. It exists for the one case silence cannot see — a tool that never returns. 0 switches it off.',
  },
  maxConcurrentRuns: {
    label: 'Runs at once',
    help: 'Across the whole server. Anything beyond this waits its turn rather than being refused. Lowering it never stops a run already going.',
  },
  quotaGuardPct: {
    label: 'Pause automatic starts above',
    help: 'Percent of the plan’s tightest quota window. Only automatic starts wait — you pressing the button is never refused. 100 switches the guard off.',
  },
  runRetentionDays: {
    label: 'Keep finished runs for',
    help: 'Days. Transcripts are the only thing here that grows without limit, and the only sweep that destroys something you wrote. 0 keeps everything.',
  },
  runKeepPerWorkspace: {
    label: 'Always keep, per workspace',
    help: 'The newest runs survive the sweep whatever their age, so a workspace left alone for a year still has its history.',
  },
  logLevel: {
    label: 'Log level',
    help: 'What the server writes to its own log. `debug` is worth switching on while chasing something and worth switching off afterwards.',
  },
  language: {
    label: 'Metaclaude writes in',
    help: 'The language of what the system produces — memories, distilled lessons, what it proposes. Not the interface, which each browser keeps for itself; switching the language under Appearance sets both. A workspace can override this one. `auto` leaves it to the model.',
  },
};

/** Milliseconds on the wire, minutes on the screen. 0 is 0 in both. */
function toDisplay(record: RuntimeSettingRecord): string {
  if (record.kind === 'choice') return String(record.value);
  const value = Number(record.value);
  return String(record.kind === 'duration' ? Math.round(value / 60_000) : value);
}

function toWire(record: RuntimeSettingRecord, text: string): number | string {
  if (record.kind === 'choice') return text;
  const value = Number(text);
  return record.kind === 'duration' ? value * 60_000 : value;
}

export function ConfigurationCard() {
  const t = useT();
  const plural = usePlural();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Record<string, string>>({});

  const query = useQuery({
    queryKey: ['runtime-settings'],
    queryFn: () => api.runtimeSettings(),
  });
  const settings = query.data?.settings;

  /*
   * The draft follows the server, and a refetch that changes nothing does not
   * disturb it: React Query shares structure, so an identical response comes
   * back as the *same* array reference and this effect does not re-run.
   *
   * A version keyed on a signature of the values was written first, on the
   * assumption that every refetch hands back a new array. It does not, the
   * assumption was wrong, and no test could be made to fail without it — so it
   * was removed rather than kept as insurance against a bug that is not there.
   */
  useEffect(() => {
    if (!settings) return;
    setDraft(Object.fromEntries(settings.map((record) => [record.key, toDisplay(record)])));
  }, [settings]);

  const save = useMutation({
    mutationFn: async (changes: Array<{ key: string; value: number | string | null }>) => {
      for (const change of changes) await api.setRuntimeSetting(change.key, change.value);
    },
    onSuccess: () => toast.success(t('Settings saved')),
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : (error as Error).message),
    // On settled, not on success: a batch that failed halfway has still
    // written the ones before it, and leaving those on screen as they were
    // would be the form disagreeing with the server it just wrote to.
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ['runtime-settings'] }),
  });

  /**
   * What differs from the server — and an emptied box does not.
   *
   * `Number('')` is 0, and 0 is the value that switches a ceiling *off*, so
   * treating a cleared field as a change would quietly disable the very thing
   * it was meant to adjust. Half-typed input (`-`, `1e`) is excluded for the
   * same reason.
   */
  const changed = (settings ?? []).filter((record) => {
    const text = (draft[record.key] ?? '').trim();
    if (text === '') return false;
    if (record.kind !== 'choice' && !Number.isFinite(Number(text))) return false;
    return text !== toDisplay(record);
  });

  return (
    <Card>
      <CardHeader
        title={t('Configuration')}
        description={t(
          'What this server does on its own, changed without a restart. A value saved here takes effect on the next run and outranks the environment — the row says what it is shadowing, so nothing here disagrees with your .env in silence.',
        )}
      />

      {query.isLoading ? (
        <div className="flex justify-center p-6">
          <Spinner className="size-5" />
        </div>
      ) : (
        <div className="divide-y divide-line">
          {(settings ?? []).map((record) => {
            const copy = COPY[record.key];
            if (!copy) return null;
            const id = `setting-${record.key}`;
            const unit =
              record.kind === 'duration'
                ? t('minutes')
                : record.kind === 'percent'
                  ? '%'
                  : record.key === 'runRetentionDays'
                    ? t('days')
                    : null;

            return (
              <div key={record.key} className="px-4 py-3.5">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                  <div className="min-w-0 sm:flex-1">
                    <label htmlFor={id} className="block text-[13px] font-medium text-ink">
                      {t(copy.label)}
                    </label>
                    <p className="mt-0.5 text-[12px] leading-relaxed text-muted">{t(copy.help)}</p>
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    {record.kind === 'choice' ? (
                      <Menu
                        side="bottom"
                        trigger={
                          <Button
                            id={id}
                            aria-label={t(copy.label)}
                            variant="secondary"
                            size="sm"
                            className="w-36 justify-between"
                          >
                            {draft[record.key] ?? ''}
                          </Button>
                        }
                      >
                        {record.options.map((option) => (
                          <MenuItem
                            key={option}
                            selected={draft[record.key] === option}
                            onSelect={() =>
                              setDraft((current) => ({ ...current, [record.key]: option }))
                            }
                          >
                            {option}
                          </MenuItem>
                        ))}
                      </Menu>
                    ) : (
                      <>
                        <Input
                          id={id}
                          type="number"
                          inputMode="numeric"
                          className="w-24 text-right"
                          {...(record.min !== null ? { min: record.min } : {})}
                          {...(record.max !== null ? { max: record.max } : {})}
                          value={draft[record.key] ?? ''}
                          onChange={(event) =>
                            setDraft((current) => ({
                              ...current,
                              [record.key]: event.target.value,
                            }))
                          }
                        />
                        {unit ? <span className="text-[12px] text-muted">{unit}</span> : null}
                      </>
                    )}
                  </div>
                </div>

                <Provenance record={record} onRevert={() => save.mutate([{ key: record.key, value: null }])} />
              </div>
            );
          })}
        </div>
      )}

      <div className="flex items-center justify-end gap-3 border-t border-line px-4 py-3">
        {changed.length > 0 ? (
          <span className="text-[12px] text-muted">
            {plural(changed.length, '{n} unsaved change', '{n} unsaved changes')}
          </span>
        ) : null}
        <Button
          variant="primary"
          size="sm"
          disabled={changed.length === 0}
          loading={save.isPending}
          onClick={() =>
            save.mutate(
              changed.map((record) => ({
                key: record.key,
                value: toWire(record, draft[record.key] ?? ''),
              })),
            )
          }
        >
          {t('Save changes')}
        </Button>
      </div>
    </Card>
  );
}

/**
 * Where the value in force came from — and, when something is being shadowed,
 * what it is and one action to hand the setting back.
 *
 * The button matters more than it looks: an operator changing a value here
 * rarely knows what the environment said, so "type the old number in" is not a
 * way back. The row is what tells them, and the button is what acts on it.
 */
function Provenance({
  record,
  onRevert,
}: {
  record: RuntimeSettingRecord;
  onRevert: () => void;
}) {
  const t = useT();

  if (record.source !== 'stored') {
    return (
      <p className="mt-1.5 text-[11.5px] text-subtle">
        {record.source === 'environment'
          ? t('From this deployment’s environment.')
          : t('Built-in default.')}
      </p>
    );
  }

  const fallback =
    record.fallback === null
      ? null
      : record.kind === 'duration'
        ? t('{n} minutes', { n: Math.round(Number(record.fallback) / 60_000) })
        : String(record.fallback);

  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
      <Badge tone="accent">{t('Saved here')}</Badge>
      <span className="text-[11.5px] text-subtle">
        {record.updatedBy
          ? record.updatedAt === null
            ? t('by {who}', { who: record.updatedBy })
            : t('by {who}, {when}', {
                who: record.updatedBy,
                when: formatRelative(record.updatedAt),
              })
          : null}
        {fallback ? ` · ${t('the environment says {value}', { value: fallback })}` : null}
      </span>
      <Button variant="ghost" size="sm" className="h-6 px-2 text-[11.5px]" onClick={onRevert}>
        <RotateCcw className="size-3" aria-hidden />
        {t('Use the environment’s value')}
      </Button>
    </div>
  );
}
