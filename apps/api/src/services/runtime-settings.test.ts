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
import { RuntimeSettings, RUNTIME_SETTING_SPECS } from './runtime-settings.js';

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
