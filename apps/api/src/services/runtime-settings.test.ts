/**
 * The settings an owner may change without a restart.
 *
 * Three properties carry the whole feature, and each of them is a way the
 * obvious implementation gets it wrong.
 *
 * **A stored value has to win.** `compose.yml` names every one of these with a
 * default of its own, so in a real deployment the environment is *always* set.
 * A design where the environment wins would leave the page inert everywhere
 * except a bare `node dist/index.js`, which is nowhere.
 *
 * **The provenance has to be visible.** A second source of truth that does not
 * say it is one is how a screen and a `.env` come to disagree with nobody
 * noticing. Every record says what is in force and what it would fall back to.
 *
 * **The bounds have to agree with boot.** A form that accepts what `loadConfig`
 * refuses would store a value that stops the server the next time it restarts.
 * That is checked against `loadConfig` itself rather than restated.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { migrate, openDatabase, type Db } from '../db/index.js';
import {
  phaseModel,
  phasePolicy,
  phasePolicyReader,
  RuntimeSettings,
  RUNTIME_SETTING_SPECS,
} from './runtime-settings.js';
import { AUTO_MODEL, LEARNING_PHASES, SETTING_AUTO, SETTING_EFFORTS, SETTING_MODELS } from '@metaclaude/shared';
import { TARGETS_MAX_CHARS } from '../learning/improvement.js';
import { STRUCTURED_DEFAULT_MODEL } from '../learning/structured-call.js';

let db: Db;
let dataRoot: string;

/** A config built from an explicit environment, as the server does at boot. */
function configFrom(env: Record<string, string> = {}) {
  return loadConfig({
    NODE_ENV: 'test',
    METACLAUDE_DATA_DIR: join(dataRoot, 'data'),
    METACLAUDE_WORKSPACES_DIR: join(dataRoot, 'ws'),
    METACLAUDE_WEB_DIR: join(dataRoot, 'web'),
    ...env,
  } as NodeJS.ProcessEnv);
}

function make(env: Record<string, string> = {}) {
  const applied: Array<{ key: string; value: number | string }> = [];
  const settings = new RuntimeSettings({
    db,
    config: configFrom(env),
    // Only the environment this deployment actually declared; everything else
    // is the schema's default and must say so.
    declared: new Set(Object.keys(env)),
    apply: (key, value) => applied.push({ key, value }),
    now: () => 1_700_000_000_000,
  });
  return { settings, applied };
}

beforeEach(() => {
  dataRoot = mkdtempSync(join(tmpdir(), 'mc-rs-'));
  db = openDatabase({ path: ':memory:' });
  migrate(db);
});

afterEach(() => {
  db.close();
  rmSync(dataRoot, { recursive: true, force: true });
});

describe('what is in force, and where it came from', () => {
  it('falls back to the schema default when nothing else says otherwise', () => {
    const { settings } = make();
    const record = settings.all().find((entry) => entry.key === 'idleTimeoutMs')!;

    expect(record.value).toBe(10 * 60_000);
    expect(record.source).toBe('default');
    expect(record.updatedAt).toBeNull();
  });

  it('reports the environment when the deployment declared one', () => {
    const { settings } = make({ METACLAUDE_RUN_IDLE_TIMEOUT_MS: '120000' });
    const record = settings.all().find((entry) => entry.key === 'idleTimeoutMs')!;

    expect(record.value).toBe(120_000);
    expect(record.source).toBe('environment');
  });

  /** The property the whole design turns on. */
  it('lets a stored value beat the environment, and says what it is shadowing', () => {
    const { settings } = make({ METACLAUDE_RUN_IDLE_TIMEOUT_MS: '120000' });
    settings.set('idleTimeoutMs', 300_000, 'owner');

    const record = settings.all().find((entry) => entry.key === 'idleTimeoutMs')!;
    expect(record.value).toBe(300_000);
    expect(record.source).toBe('stored');
    expect(record.fallback).toBe(120_000);
    expect(record.updatedBy).toBe('owner');
    expect(record.updatedAt).toBe(1_700_000_000_000);
  });

  it('goes back to the environment when the override is cleared', () => {
    const { settings } = make({ METACLAUDE_RUN_IDLE_TIMEOUT_MS: '120000' });
    settings.set('idleTimeoutMs', 300_000, 'owner');
    settings.clear('idleTimeoutMs');

    const record = settings.all().find((entry) => entry.key === 'idleTimeoutMs')!;
    expect(record.value).toBe(120_000);
    expect(record.source).toBe('environment');
    expect(record.updatedAt).toBeNull();
  });

  it('reads a stored value back through a fresh instance, not from memory', () => {
    const first = make();
    first.settings.set('maxConcurrentRuns', 9, 'owner');

    const second = make();
    expect(second.settings.number('maxConcurrentRuns')).toBe(9);
  });
});

describe('what may be stored', () => {
  it('refuses a key that is not on the list', () => {
    const { settings } = make();
    // The security tier is not merely absent from the form — it is refused
    // here, where a hand-made request arrives.
    expect(() => settings.set('allowBypassPermissions' as never, 1, 'owner')).toThrow();
    expect(() => settings.set('masterKey' as never, 'x' as never, 'owner')).toThrow();
  });

  it('refuses a value outside the setting’s own bounds', () => {
    const { settings } = make();
    expect(() => settings.set('quotaGuardPct', 101, 'owner')).toThrow();
    expect(() => settings.set('maxConcurrentRuns', 0, 'owner')).toThrow();
    expect(() => settings.set('logLevel', 'chatty', 'owner')).toThrow();
    expect(() => settings.set('idleTimeoutMs', 5_000, 'owner')).toThrow();
  });

  it('accepts 0 for a duration, which is how a ceiling is switched off', () => {
    const { settings } = make();
    settings.set('idleTimeoutMs', 0, 'owner');
    expect(settings.number('idleTimeoutMs')).toBe(0);
  });

  it('refuses a number where a choice is expected, and the reverse', () => {
    const { settings } = make();
    expect(() => settings.set('logLevel', 5 as never, 'owner')).toThrow();
    expect(() => settings.set('maxConcurrentRuns', 'four' as never, 'owner')).toThrow();
  });
});

/**
 * The check that keeps the form and the boot loader from drifting apart.
 *
 * Restating the bounds here would only prove that two copies of a number are
 * equal. Driving `loadConfig` proves the thing that matters: every value this
 * accepts is a value the server can start with, and the edges are the edges.
 */
describe('the bounds agree with what the server will boot with', () => {
  const numeric = RUNTIME_SETTING_SPECS.filter((spec) => spec.kind !== 'choice' && spec.envVar);

  it('covers every numeric setting', () => {
    expect(numeric.length).toBeGreaterThanOrEqual(6);
  });

  for (const spec of numeric) {
    it(`accepts the edges of ${spec.key} and boot accepts them too`, () => {
      const { settings } = make();
      for (const edge of [spec.min, spec.max].filter((v): v is number => v !== null)) {
        expect(() => settings.set(spec.key, edge, 'owner')).not.toThrow();
        expect(() => configFrom({ [spec.envVar!]: String(edge) })).not.toThrow();
      }
    });

    const beyond = spec.max === null ? null : spec.max + 1;
    it(`refuses just outside the bounds of ${spec.key}, and so does boot`, () => {
      if (beyond === null) return;
      const { settings } = make();
      expect(() => settings.set(spec.key, beyond, 'owner')).toThrow();
      expect(() => configFrom({ [spec.envVar!]: String(beyond) })).toThrow();
    });
  }
});

describe('applying a change', () => {
  it('tells the deployment about a setting that needs a side effect', () => {
    const { settings, applied } = make();
    settings.set('logLevel', 'debug', 'owner');
    expect(applied).toEqual([{ key: 'logLevel', value: 'debug' }]);
  });

  it('tells it again when the override is cleared, with what now applies', () => {
    const { settings, applied } = make({ LOG_LEVEL: 'warn' });
    settings.set('logLevel', 'debug', 'owner');
    settings.clear('logLevel');
    expect(applied.at(-1)).toEqual({ key: 'logLevel', value: 'warn' });
  });

  /**
   * Everything else is read at the point of use rather than pushed, which is
   * what makes "hot" true without a notification graph. The getter is the
   * contract those consumers hold.
   */
  it('answers the new value immediately, with no restart and no event', () => {
    const { settings } = make();
    expect(settings.number('maxConcurrentRuns')).toBe(4);
    settings.set('maxConcurrentRuns', 12, 'owner');
    expect(settings.number('maxConcurrentRuns')).toBe(12);
  });

  it('survives a value written into the table by an older or broken writer', () => {
    const { settings } = make();
    db.prepare(
      `INSERT INTO runtime_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)`,
    ).run('maxConcurrentRuns', 'not a number', 1, 'someone');

    // Fail safe, not closed: an unreadable override is ignored in favour of
    // the environment, because refusing to answer would stop every run.
    expect(settings.number('maxConcurrentRuns')).toBe(4);
    expect(settings.all().find((e) => e.key === 'maxConcurrentRuns')?.source).toBe('default');
  });
});

describe('the catalogue itself', () => {
  it('names no security or structural setting', () => {
    const keys = RUNTIME_SETTING_SPECS.map((spec) => spec.key as string);
    for (const forbidden of [
      'allowBypassPermissions',
      'allowedOrigins',
      'trustProxy',
      'secureCookies',
      'masterKey',
      'dataDir',
      'workspacesDir',
      // `embeddings` used to sit here: a switch needed a restart and a manual
      // re-index. It became hot the day the provider could load in the
      // background and every stale row rebuilt itself — see `switchEmbedder`.
    ]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it('gives every setting a kind a form can render', () => {
    for (const spec of RUNTIME_SETTING_SPECS) {
      if (spec.kind === 'choice') {
        expect(spec.options.length).toBeGreaterThan(1);
      } else {
        expect(spec.min).not.toBeNull();
        expect(typeof spec.max === 'number' || spec.max === null).toBe(true);
      }
    }
  });

  it('is what the API exposes, with nothing extra', () => {
    const { settings } = make();
    expect(settings.all().map((entry) => entry.key).sort()).toEqual(
      RUNTIME_SETTING_SPECS.map((spec) => spec.key).sort(),
    );
  });
});

/**
 * A setting that has to be *done* rather than read must survive a restart.
 *
 * The log level lives on the logger object, so nothing looks it up again: a
 * level chosen through the screen would be forgotten by the next boot while
 * the screen went on reporting it — precisely the disagreement the provenance
 * exists to prevent.
 */
describe('replaying stored settings at boot', () => {
  it('re-applies a stored override that needs a side effect', () => {
    make().settings.set('logLevel', 'debug', 'owner');

    const fresh = make();
    fresh.settings.applyStored();
    expect(fresh.applied).toEqual([{ key: 'logLevel', value: 'debug' }]);
  });

  it('applies nothing when there is no override to replay', () => {
    const fresh = make({ LOG_LEVEL: 'warn' });
    fresh.settings.applyStored();
    expect(fresh.applied).toEqual([]);
  });

  it('ignores a stored value that only a getter would read', () => {
    make().settings.set('maxConcurrentRuns', 9, 'owner');

    const fresh = make();
    fresh.settings.applyStored();
    expect(fresh.applied).toEqual([]);
  });
});

/*
 * What serves each background pass.
 *
 * Everything here is derived from `LEARNING_PHASES` rather than written out,
 * because the failure this family is prone to is a key declared in one list
 * and read by nothing: a seventh phase with no spec, or a spec whose options
 * do not match the picker the screen draws, would ship as a control that looks
 * like it works. Twelve hand-written cases would each have to be remembered.
 */
describe('the model and effort of each learning phase', () => {
  it('exposes both settings for every phase', () => {
    const keys = new Set(RUNTIME_SETTING_SPECS.map((spec) => spec.key as string));
    for (const phase of LEARNING_PHASES) {
      expect(keys, `${phase.id} model`).toContain(phase.modelKey);
      expect(keys, `${phase.id} effort`).toContain(phase.effortKey);
    }
  });

  it('offers exactly the aliases a picker knows, plus the sentinel', () => {
    for (const phase of LEARNING_PHASES) {
      const model = RUNTIME_SETTING_SPECS.find((spec) => spec.key === phase.modelKey);
      const effort = RUNTIME_SETTING_SPECS.find((spec) => spec.key === phase.effortKey);
      expect(model?.kind).toBe('choice');
      expect(effort?.kind).toBe('choice');
      expect(model?.options).toEqual([...SETTING_MODELS]);
      expect(effort?.options).toEqual([...SETTING_EFFORTS]);
      // `auto` has to be offerable, or an operator who pinned a model could
      // never go back to the shipped default from the screen.
      expect(model?.options).toContain(SETTING_AUTO);
      expect(effort?.options).toContain(SETTING_AUTO);
    }
  });

  it('starts unpinned, and reads as unpinned', () => {
    const { settings } = make();
    for (const phase of LEARNING_PHASES) {
      expect(settings.choice(phase.modelKey)).toBe(SETTING_AUTO);
      expect(settings.choice(phase.effortKey)).toBe(SETTING_AUTO);
      // `null`, never the string `auto`: the callers spread this into a
      // request, and a literal `auto` would reach the CLI as a model name.
      expect(phasePolicy(settings, phase)).toEqual({ model: null, effort: null });
    }
  });

  it('carries a stored pin through to the pass', () => {
    const { settings } = make();
    for (const phase of LEARNING_PHASES) {
      settings.set(phase.modelKey, 'fable', 'owner');
      settings.set(phase.effortKey, 'high', 'owner');
      expect(phasePolicyReader(settings, phase.id)()).toEqual({ model: 'fable', effort: 'high' });
    }
  });

  it('goes back to the shipped default when the pin is cleared', () => {
    const { settings } = make();
    for (const phase of LEARNING_PHASES) {
      settings.set(phase.modelKey, 'opus', 'owner');
      settings.clear(phase.modelKey);
      expect(phasePolicy(settings, phase).model).toBeNull();
    }
  });

  it('never offers the CLI’s own `default` alias beside `auto`', () => {
    // Two words that read alike and differ by roughly thirty times the price:
    // `auto` is the phase’s shipped default, `default` is the CLI’s alias,
    // which on a subscription is Opus. Only one of them is offered.
    expect(SETTING_MODELS).not.toContain(AUTO_MODEL);
    expect(SETTING_MODELS).toContain(SETTING_AUTO);
    const { settings } = make();
    expect(() => settings.set(LEARNING_PHASES[0].modelKey, AUTO_MODEL, 'owner')).toThrow();
  });

  it('refuses a model no picker offers', () => {
    const { settings } = make();
    // The screen is not the guard: a key posted straight to the route has to
    // meet the same list, or a typo becomes a model name the CLI rejects on
    // every background call, silently, forever.
    expect(() => settings.set(LEARNING_PHASES[0].modelKey, 'gpt-4', 'owner')).toThrow();
    expect(() => settings.set(LEARNING_PHASES[0].effortKey, 'maximum', 'owner')).toThrow();
  });

  it('names the model a review row should record', () => {
    const { settings } = make();
    expect(phaseModel(settings, 'revision')).toBe(STRUCTURED_DEFAULT_MODEL);
    settings.set('revisionModel', 'fable', 'owner');
    expect(phaseModel(settings, 'revision')).toBe('fable');
  });

  it('needs no environment variable, and says so', () => {
    // These are an operator's choice about spend, made from the screen — not a
    // deployment's boot configuration. A row claiming an env var nobody sets
    // would report its provenance as `default` for a value that has none.
    for (const phase of LEARNING_PHASES) {
      for (const key of [phase.modelKey, phase.effortKey]) {
        expect(RUNTIME_SETTING_SPECS.find((spec) => spec.key === key)?.envVar).toBeNull();
      }
    }
  });
});

/*
 * What the weekly review may spend on instruction texts.
 *
 * A ceiling with real money behind it — it is read straight into a model
 * prompt — and the right number depends on how many skills a deployment
 * carries and what it is willing to pay. A constant in the source would mean
 * an operator who needs it higher, or lower, is blocked on a release.
 */
describe('the instruction-review budget', () => {
  it('is a setting, bounded the way the server would accept it', () => {
    const spec = RUNTIME_SETTING_SPECS.find((entry) => entry.key === 'reviewTargetChars');
    expect(spec?.kind).toBe('count');
    expect(spec?.min).toBe(0);
    expect(spec?.max).toBeGreaterThan(0);
    // An operator's choice about spend, made from the screen, not a boot
    // variable — like the twelve model rows and unlike every ceiling above.
    expect(spec?.envVar).toBeNull();
  });

  it('starts at what the code shipped with', () => {
    const { settings } = make();
    expect(settings.number('reviewTargetChars')).toBe(TARGETS_MAX_CHARS);
  });

  it('carries a stored value through', () => {
    const { settings } = make();
    settings.set('reviewTargetChars', 12_000, 'owner');
    expect(settings.number('reviewTargetChars')).toBe(12_000);
  });

  it('refuses a number the pass could not use', () => {
    const { settings } = make();
    expect(() => settings.set('reviewTargetChars', -1, 'owner')).toThrow();
    expect(() => settings.set('reviewTargetChars', 10_000_000, 'owner')).toThrow();
  });
});
