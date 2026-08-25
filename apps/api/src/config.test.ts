/**
 * Configuration loading.
 *
 * This runs once, at startup, before anything can report a problem through the
 * UI or the logs an operator is watching. A mistake here is a container that
 * crash-loops with a message nobody sees, so the cases below are the ones a
 * deployment actually produces — including the values `compose.yml` sends,
 * which are not the same as the values a shell would.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

let root: string;

/** The minimum a real deployment always supplies. */
function base(): NodeJS.ProcessEnv {
  return {
    METACLAUDE_DATA_DIR: join(root, 'data'),
    METACLAUDE_WORKSPACES_DIR: join(root, 'workspaces'),
    METACLAUDE_WEB_DIR: join(root, 'web'),
  } as NodeJS.ProcessEnv;
}

const load = (extra: Record<string, string> = {}) =>
  loadConfig({ ...base(), ...extra } as NodeJS.ProcessEnv);

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'metaclaude-config-'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('bootstrap credentials', () => {
  it('treats an empty password as absent, which is what compose sends', () => {
    // `${METACLAUDE_BOOTSTRAP_PASSWORD:-}` sets the variable to the empty
    // string, not to nothing. Comparing against `undefined` rejected it and
    // threw at startup, so the container crash-looped on the first
    // `docker compose up` with an unedited .env — and again whenever the
    // operator blanked the password after the account existed, exactly as
    // .env.example tells them to.
    expect(() => load({ METACLAUDE_BOOTSTRAP_PASSWORD: '' })).not.toThrow();
    expect(load({ METACLAUDE_BOOTSTRAP_PASSWORD: '' }).bootstrap).toBeNull();
  });

  it('also accepts the variable being genuinely absent', () => {
    expect(load().bootstrap).toBeNull();
  });

  it('still rejects a password that is set but too short', () => {
    // The check exists because this password creates the owner account of a
    // system that runs shell commands; a weak one is worse than none.
    expect(() => load({ METACLAUDE_BOOTSTRAP_PASSWORD: 'short' })).toThrow(/at least 12/);
    expect(() => load({ METACLAUDE_BOOTSTRAP_PASSWORD: 'elevenchars' })).toThrow(/at least 12/);
  });

  it('accepts a usable pair', () => {
    const config = load({
      METACLAUDE_BOOTSTRAP_USER: 'owner',
      METACLAUDE_BOOTSTRAP_PASSWORD: 'a-long-enough-passphrase',
    });
    expect(config.bootstrap).toEqual({
      username: 'owner',
      password: 'a-long-enough-passphrase',
    });
  });

  it('needs both halves — a user with no password creates nothing', () => {
    expect(load({ METACLAUDE_BOOTSTRAP_USER: 'owner' }).bootstrap).toBeNull();
    expect(load({ METACLAUDE_BOOTSTRAP_PASSWORD: 'a-long-enough-passphrase' }).bootstrap).toBeNull();
  });
});

describe('the values compose sends for every optional setting', () => {
  it('accepts an empty string wherever a variable is left unset in .env', () => {
    // Every `${VAR:-}` in compose.yml arrives as an empty string. Any one of
    // them rejecting that is a crash-loop on an unedited .env, so they are
    // checked together rather than one bug at a time.
    const emptied = {
      METACLAUDE_MASTER_KEY: '',
      METACLAUDE_BOOTSTRAP_USER: '',
      METACLAUDE_BOOTSTRAP_PASSWORD: '',
      METACLAUDE_ALLOWED_ORIGINS: '',
      METACLAUDE_ALLOW_BYPASS_PERMISSIONS: '',
      CLAUDE_CODE_OAUTH_TOKEN: '',
      ANTHROPIC_API_KEY: '',
      METACLAUDE_IMAGE: '',
    };
    expect(() => load(emptied)).not.toThrow();

    const config = load(emptied);
    expect(config.allowedOrigins).toEqual([]);
    expect(config.claude.authMode).toBe('none');
    expect(config.allowBypassPermissions).toBe(false);
  });
});

describe('Claude credentials', () => {
  it('prefers the subscription token over the API key', () => {
    const config = load({
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-example',
      ANTHROPIC_API_KEY: 'sk-ant-api-example',
    });
    expect(config.claude.authMode).toBe('subscription');
    expect(config.claude.oauthToken).toBe('sk-ant-oat01-example');
  });

  it('falls back to the API key, and reports none when neither is set', () => {
    expect(load({ ANTHROPIC_API_KEY: 'sk-ant-api-example' }).claude.authMode).toBe('api_key');
    expect(load().claude.authMode).toBe('none');
  });

  it('treats a whitespace-only token as absent rather than as a credential', () => {
    expect(load({ CLAUDE_CODE_OAUTH_TOKEN: '   ' }).claude.authMode).toBe('none');
  });
});

describe('allowed origins', () => {
  it('splits, trims and drops empties', () => {
    expect(load({ METACLAUDE_ALLOWED_ORIGINS: 'https://a.example, https://b.example' }).allowedOrigins)
      .toEqual(['https://a.example', 'https://b.example']);
    expect(load({ METACLAUDE_ALLOWED_ORIGINS: ' , ,' }).allowedOrigins).toEqual([]);
  });
});

describe('paths', () => {
  it('insists the data and workspace directories are absolute', () => {
    // A relative path here resolves against whatever the process's working
    // directory happens to be, which in a container is not where the volume is.
    expect(() =>
      loadConfig({ ...base(), METACLAUDE_DATA_DIR: 'relative/data' } as NodeJS.ProcessEnv),
    ).toThrow();
  });

  it('derives the database and artefact locations from the data directory', () => {
    const config = load();
    expect(config.databasePath).toBe(join(root, 'data', 'metaclaude.db'));
    expect(config.artifactsDir).toBe(join(root, 'data', 'artifacts'));
  });
});

describe('master key', () => {
  it('generates one when none is supplied, and it is 32 bytes', () => {
    // Generated is a fallback, not the recommendation: it lands in the same
    // volume as the database it protects, so a single snapshot carries both
    // the ciphertext and the key. docs/DEPLOYMENT.md says to set it explicitly.
    expect(load().masterKey).toHaveLength(32);
  });

  it('accepts a supplied hex key of the right length', () => {
    const hex = 'a'.repeat(64);
    expect(load({ METACLAUDE_MASTER_KEY: hex }).masterKey.toString('hex')).toBe(hex);
  });

  it('rejects a key of the wrong length rather than padding it', () => {
    expect(() => load({ METACLAUDE_MASTER_KEY: 'abcd' })).toThrow();
  });
});
