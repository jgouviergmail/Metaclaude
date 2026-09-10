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
import { LEARNING_PHASES, SETTING_AUTO } from '@metaclaude/shared';

import { Menu, MenuItem } from '@/components/ui/Menu';
import {
  Badge,
  Button,
  Input,
  Label,
  Spinner,
} from '@/components/ui/primitives';
import { Section } from '@/components/ui/layout';
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
  delegationDirectoryChars: {
    label: 'Peer directory budget',
    help: 'Characters of the directory of other workspaces injected into every run that may delegate, so the agent knows who it can consult and what for. Around twenty workspaces all keep their description at this size; past that the names remain and the descriptions go together. 0 switches delegation between workspaces off.',
  },
  reviewTargetChars: {
    label: 'Instruction review budget',
    help: 'Characters of your own instructions — skill descriptions and bodies, subagent prompts, automation prompts — put to the weekly review in one go. It is read straight into a model prompt, so it is what that pass costs. A workspace’s own standing instructions are always included, whatever this says, so 0 reviews those alone. Raise it if the review keeps saying it could not show everything.',
  },
  logLevel: {
    label: 'Log level',
    help: 'What the server writes to its own log. `debug` is worth switching on while chasing something and worth switching off afterwards.',
  },
  embeddings: {
    label: 'Embeddings',
    help: '`local` loads the sentence-transformer shipped with the image and switches search to meaning — in French and English — once it is ready; until then, and under `hash`, search matches words. Every stored vector is rebuilt in the background after a switch, and the Memory page says how many still wait.',
  },
  language: {
    label: 'Metaclaude writes in',
    help: 'The language of what the system produces — memories, distilled lessons, what it proposes. Not the interface, which each browser keeps for itself; switching the language under Appearance sets both. A workspace can override this one. `auto` leaves it to the model.',
  },
};

/**
 * What each learning pass is, for someone deciding what to pay for it.
 *
 * Keyed by phase id rather than by setting key: the screen shows one row per
 * pass with two pickers, because a model and an effort are one decision and
 * twelve separate rows would put the halves of it eight rows apart.
 */
export const PHASE_COPY: Record<string, { label: string; help: string }> = {
  reflexion: {
    label: 'Reading a finished run',
    help: 'Runs after every run that did something, and reads the whole transcript — the longest prompt here, and the most frequent call. Raising this one costs the most.',
  },
  memoryGate: {
    label: 'Deciding what to remember',
    help: 'Judges each proposed note against its neighbours and your standing instructions, and refuses most of them. It is the pass that keeps the memory small, so its judgement is worth more than its price.',
  },
  consolidation: {
    label: 'Merging duplicate memories',
    help: 'Rewrites a group of overlapping notes into the one sentence that survives. Rare, and its answer becomes the stored text.',
  },
  synthesis: {
    label: 'Distilling a skill',
    help: 'Turns a procedure repeated across runs into a draft skill you review. Rare, and what it writes is prose an operator reads.',
  },
  revision: {
    label: 'Reviewing the instructions',
    help: 'The weekly pass that reads a workspace’s own week and proposes rewrites of its instructions, its skills and its agents. Its answer becomes the proposed text.',
  },
  advisor: {
    label: 'The advisor',
    help: 'Not a classifier but an ordinary agentic run, with tools and a session of its own. Left alone it uses each workspace’s own model; pinning one here overrides that for every workspace at once.',
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

  const byKey = new Map((settings ?? []).map((record) => [record.key as string, record]));
  const setOne = (key: string, value: string) =>
    setDraft((current) => ({ ...current, [key]: value }));

  return (
    <Section
      title={t('Configuration')}
      description={t(
        'What this server does on its own, changed without a restart. A value saved here takes effect on the next run and outranks the environment — the row says what it is shadowing, so nothing here disagrees with your .env in silence.',
      )}
    >

      {query.isLoading ? (
        <div className="flex justify-center p-6">
          <Spinner className="size-5" />
        </div>
      ) : (
        <div className="divide-y divide-line">
          {(settings ?? []).map((record) => {
            const copy = COPY[record.key];
            // The twelve phase settings are drawn below, two to a row: a model
            // and an effort are one decision, and the generic list would put
            // the halves of it eight rows apart.
            if (!copy || PHASE_KEYS.has(record.key)) return null;
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
              <div key={record.key} className="py-3">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                  <div className="min-w-0 sm:flex-1">
                    {/*
                      * `Label`, not a hand-written pair: eight settings, three
                      * lines of explanation each, is twenty-four lines of prose
                      * on one screen — the densest thing in the app and exactly
                      * what the compact density exists to fold.
                      */}
                    <Label htmlFor={id} explanation={t(copy.help)}>
                      {t(copy.label)}
                    </Label>
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
                        {unit ? <span className="text-caption text-muted">{unit}</span> : null}
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

      {query.isLoading ? null : (
        <LearningPhases
          byKey={byKey}
          draft={draft}
          onPick={setOne}
          onRevert={(keys) => save.mutate(keys.map((key) => ({ key, value: null })))}
        />
      )}

      <div className="flex items-center justify-end gap-3 border-t border-line pt-3">
        {changed.length > 0 ? (
          <span className="text-caption text-muted">
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
    </Section>
  );
}

/** The twelve keys the block below owns, so the generic list skips them. */
const PHASE_KEYS = new Set(
  LEARNING_PHASES.flatMap((phase) => [phase.modelKey, phase.effortKey] as string[]),
);

/**
 * What serves each background pass — six rows, two pickers each.
 *
 * One row per phase rather than one per setting, because a model and an effort
 * are one decision: an operator moving the weekly review to a stronger model
 * wants to say what effort it should think at in the same gesture, and twelve
 * alphabetical rows would separate the halves of it.
 *
 * Both pickers offer `auto`, which is the way back: without it an operator who
 * pinned a model could never return to the shipped default from this screen.
 */
function LearningPhases({
  byKey,
  draft,
  onPick,
  onRevert,
}: {
  byKey: Map<string, RuntimeSettingRecord>;
  draft: Record<string, string>;
  onPick: (key: string, value: string) => void;
  onRevert: (keys: string[]) => void;
}) {
  const t = useT();
  const rows = LEARNING_PHASES.filter((phase) => byKey.has(phase.modelKey));
  if (rows.length === 0) return null;

  return (
    <div className="border-t border-line pt-3">
      <h3 className="text-body font-medium text-ink">{t('What serves each learning pass')}</h3>
      <p className="mt-1 text-caption text-muted">
        {t(
          'The passes that read your runs and write what the system remembers. They ship on the cheapest capable model and are meant to stay in the background; raising one buys better judgement and costs more on every run. An effort means nothing on a model without the knob — Haiku has none, and a level pinned there is quietly ignored, so change the model first.',
        )}
      </p>

      <div className="mt-2 divide-y divide-line">
        {rows.map((phase) => {
          const model = byKey.get(phase.modelKey);
          const effort = byKey.get(phase.effortKey);
          const copy = PHASE_COPY[phase.id];
          if (!model || !effort || !copy) return null;
          // Either half may be the pinned one, and the row attributes whichever
          // was written last.
          const stored = [model, effort]
            .filter((entry) => entry.source === 'stored')
            .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
          const pinned = stored !== undefined;

          return (
            <div key={phase.id} className="py-3">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                <div className="min-w-0 sm:flex-1">
                  <Label htmlFor={`setting-${phase.modelKey}`} explanation={t(copy.help)}>
                    {t(copy.label)}
                  </Label>
                </div>

                {/*
                  * A grid, never a bare flex row: two triggers whose labels are
                  * half again as long in French shrink below their own text in
                  * a flex row rather than wrapping, and the second one leaves
                  * the screen on a phone.
                  */}
                <div className="grid shrink-0 grid-cols-2 gap-2 sm:w-60">
                  <PhasePicker
                    record={model}
                    value={draft[phase.modelKey] ?? ''}
                    caption={t('Model')}
                    label={t('Model for {pass}', { pass: t(copy.label) })}
                    onPick={(option) => onPick(phase.modelKey, option)}
                  />
                  <PhasePicker
                    record={effort}
                    value={draft[phase.effortKey] ?? ''}
                    caption={t('Effort')}
                    label={t('Effort for {pass}', { pass: t(copy.label) })}
                    onPick={(option) => onPick(phase.effortKey, option)}
                  />
                </div>
              </div>

              <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-subtle">
                {pinned ? (
                  <>
                    <Badge tone="accent">{t('Saved here')}</Badge>
                    {/* Who and when, the same words the generic rows use: a
                        value somebody else pinned is one you should be able to
                        attribute before you undo it. */}
                    {stored?.updatedBy ? (
                      <span>
                        {stored.updatedAt === null
                          ? t('by {who}', { who: stored.updatedBy })
                          : t('by {who}, {when}', {
                              who: stored.updatedBy,
                              when: formatRelative(stored.updatedAt),
                            })}
                      </span>
                    ) : null}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-caption"
                      onClick={() => onRevert([phase.modelKey, phase.effortKey])}
                    >
                      <RotateCcw className="size-3" aria-hidden />
                      {t('Back to the default')}
                    </Button>
                  </>
                ) : (
                  // What `auto` resolves to, said plainly: a row showing `auto`
                  // in both pickers otherwise tells the operator nothing about
                  // what is actually running.
                  <span>
                    {t('Runs on {model}.', {
                      model:
                        phase.shipped === SETTING_AUTO
                          ? t('the workspace’s own model')
                          : phase.shipped,
                    })}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * One picker, under a word saying which of the two it is.
 *
 * The caption is not decoration: an unpinned row shows `auto` in both boxes,
 * and without it a sighted operator has two identical controls and no way to
 * tell the model from the effort until they open one. It is `aria-hidden`
 * because the button's own `aria-label` already carries the same thing in full,
 * and a caption outside the label would otherwise be announced twice.
 */
function PhasePicker({
  record,
  value,
  caption,
  label,
  onPick,
}: {
  record: RuntimeSettingRecord;
  value: string;
  caption: string;
  label: string;
  onPick: (option: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-caption text-subtle" aria-hidden>
        {caption}
      </span>
      <Menu
        side="bottom"
        trigger={
          <Button
            id={`setting-${record.key}`}
            aria-label={label}
            variant="secondary"
            size="sm"
            className="w-full justify-between"
          >
            {value}
          </Button>
        }
      >
        {record.options.map((option) => (
          <MenuItem key={option} selected={value === option} onSelect={() => onPick(option)}>
            {option}
          </MenuItem>
        ))}
      </Menu>
    </div>
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
      <p className="mt-1.5 text-caption text-subtle">
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
      <span className="text-caption text-subtle">
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
      <Button variant="ghost" size="sm" className="h-6 px-2 text-caption" onClick={onRevert}>
        <RotateCcw className="size-3" aria-hidden />
        {t('Use the environment’s value')}
      </Button>
    </div>
  );
}
