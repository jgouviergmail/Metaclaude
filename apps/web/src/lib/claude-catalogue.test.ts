/**
 * Turning the CLI's catalogue into the composer's pickers.
 *
 * The model list was hard-coded in the component — three names and their prices,
 * written when the page was built. The CLI knows which models this subscription
 * actually grants and which of them take an effort level, and that changes
 * without a Metaclaude release.
 *
 * The pickers are the last thing that may break, though: a composer that cannot
 * offer a model is a session nobody can start. So the properties worth pinning
 * are the degradations — no catalogue, an empty catalogue, a model the CLI has
 * never heard of because the operator typed it.
 */

import { describe, expect, it } from 'vitest';
import type { ClaudeCatalogue } from '@metaclaude/shared';
import { effortOptions, modelOptions, supportsUltracode } from './claude-catalogue';

const catalogue = (models: ClaudeCatalogue['models']): ClaudeCatalogue => ({
  models,
  commands: [],
  agents: [],
  mcpServers: [],
  account: null,
  unavailable: [],
  fetchedAt: 0,
});

const model = (over: Partial<ClaudeCatalogue['models'][number]>): ClaudeCatalogue['models'][number] => ({
  value: 'sonnet',
  displayName: 'Sonnet',
  description: 'Balanced',
  resolvedModel: null,
  supportsEffort: false,
  supportedEffortLevels: [],
  supportsAdaptiveThinking: false,
  ...over,
});

describe('modelOptions', () => {
  it('falls back to a usable list when there is no catalogue', () => {
    // The composer must never be unusable because a subprocess could not be
    // spawned. This is the offline and no-CLI case.
    const options = modelOptions(undefined);

    expect(options.length).toBeGreaterThan(1);
    expect(options.map((option) => option.value)).toContain('sonnet');
  });

  it('falls back when the CLI answered with nothing', () => {
    // An empty catalogue and a missing one are the same to the operator: they
    // still need to pick a model.
    expect(modelOptions(catalogue([])).length).toBeGreaterThan(1);
  });

  it('offers the current flagship in the fallback list', () => {
    // "Toujours pas de fable" — when the CLI cannot enumerate models, the
    // fallback is all the operator sees, and a list frozen at the previous
    // generation quietly hides the newest tier from them. The CLI accepts the
    // `fable` alias (and degrades with a visible refusal message when the
    // subscription lacks it), so offering it costs nothing and hiding it
    // costs the operator the best model they pay for.
    expect(modelOptions(undefined).map((option) => option.value)).toContain('fable');
  });

  it('always offers Auto first', () => {
    // `default` is Metaclaude's own choice — the bandit picks from what it has
    // learned — so the CLI does not know about it and never will.
    const options = modelOptions(catalogue([model({ value: 'opus', displayName: 'Opus' })]));

    expect(options[0]?.value).toBe('default');
    expect(options[0]?.label).toBe('Auto');
  });

  it('uses the CLI’s own names and descriptions', () => {
    const options = modelOptions(
      catalogue([model({ value: 'opus', displayName: 'Opus 5', description: 'Deepest reasoning' })]),
    );

    expect(options[1]).toMatchObject({ value: 'opus', label: 'Opus 5', hint: 'Deepest reasoning' });
  });

  it('never offers the same model twice', () => {
    // `default` is in the fallback list too; a CLI that also reports it would
    // otherwise produce two entries that look identical and behave the same.
    const options = modelOptions(catalogue([model({ value: 'default', displayName: 'Default' })]));

    expect(options.filter((option) => option.value === 'default')).toHaveLength(1);
  });

  it('keeps the stable aliases on offer even when the CLI enumerates without them', () => {
    // "Toujours pas de fable", the enumerated case: the CLI's list reflects
    // what it chose to enumerate, not everything it accepts — the alias runs
    // fine and degrades with a visible message when the subscription lacks
    // it. The catalogue improves the list; it must never shrink it below
    // the documented aliases.
    const options = modelOptions(
      catalogue([model({ value: 'sonnet' }), model({ value: 'opus', displayName: 'Opus 5' })]),
    );

    const values = options.map((option) => option.value);
    for (const alias of ['fable', 'opus', 'sonnet', 'haiku', 'opusplan']) {
      expect(values).toContain(alias);
    }
    // The CLI's own entries keep their names; the filled-in aliases follow them.
    expect(options[1]?.value).toBe('sonnet');
    expect(options[2]?.label).toBe('Opus 5');
    expect(values.indexOf('fable')).toBeGreaterThan(values.indexOf('opus'));
  });

  it('does not duplicate an alias the CLI did enumerate', () => {
    const options = modelOptions(catalogue([model({ value: 'fable', displayName: 'Fable (CLI)' })]));
    const fables = options.filter((option) => option.value === 'fable');
    expect(fables).toHaveLength(1);
    expect(fables[0]?.label).toBe('Fable (CLI)');
  });
});

describe('effortOptions', () => {
  it('offers only what the chosen model supports', () => {
    // The picker used to offer all six levels for every model, so choosing one
    // the model does not take was a run that silently ignored the setting.
    const options = effortOptions(
      catalogue([model({ value: 'opus', supportsEffort: true, supportedEffortLevels: ['low', 'high'] })]),
      'opus',
    );

    expect(options.map((option) => option.value)).toEqual([null, 'low', 'high']);
  });

  it('offers only Auto for a model that takes no effort level', () => {
    const options = effortOptions(
      catalogue([model({ value: 'haiku', supportsEffort: false, supportedEffortLevels: [] })]),
      'haiku',
    );

    expect(options.map((option) => option.value)).toEqual([null]);
  });

  it('offers everything when the model is unknown to the CLI', () => {
    // An operator can type a model id the CLI has not enumerated. Narrowing the
    // effort list on a guess would remove a choice that may well be valid.
    const options = effortOptions(catalogue([model({ value: 'opus' })]), 'some-dated-model-id');

    expect(options.length).toBeGreaterThan(3);
  });

  it('offers everything when there is no catalogue at all', () => {
    expect(effortOptions(undefined, 'opus').length).toBeGreaterThan(3);
  });

  it('offers everything under Auto, because the model is not yet decided', () => {
    // Under `default` the learner picks the model at submit time, so no effort
    // level can be ruled out here.
    const options = effortOptions(
      catalogue([model({ value: 'opus', supportsEffort: true, supportedEffortLevels: ['low'] })]),
      'default',
    );

    expect(options.length).toBeGreaterThan(3);
  });

  it('always lets the operator defer', () => {
    for (const value of ['opus', 'default', 'unknown']) {
      expect(effortOptions(undefined, value)[0]?.value).toBeNull();
    }
  });
});

describe('supportsUltracode', () => {
  it('offers it for a model the CLI marks xhigh-capable', () => {
    const cat = catalogue([
      model({ value: 'opus', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] }),
    ]);
    expect(supportsUltracode(cat, 'opus')).toBe(true);
  });

  it('withholds it from a model that cannot reach xhigh', () => {
    const cat = catalogue([
      model({ value: 'haiku', supportsEffort: false, supportedEffortLevels: [] }),
    ]);
    expect(supportsUltracode(cat, 'haiku')).toBe(false);
  });

  it('withholds it under Auto, where the learner may pick an incapable model', () => {
    const cat = catalogue([
      model({ value: 'opus', supportsEffort: true, supportedEffortLevels: ['xhigh'] }),
    ]);
    expect(supportsUltracode(cat, 'default')).toBe(false);
  });

  it('allows a typed model id the catalogue has not enumerated', () => {
    // Same stance as effortOptions: withdrawing a capability on a guess takes
    // away settings that are very likely valid; the CLI degrades gracefully.
    expect(supportsUltracode(catalogue([]), 'claude-fable-5')).toBe(true);
    expect(supportsUltracode(undefined, 'claude-fable-5')).toBe(true);
  });
});
