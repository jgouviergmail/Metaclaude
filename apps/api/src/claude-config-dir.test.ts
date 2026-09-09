/**
 * One config directory, agreed on by all three parties.
 *
 * Three things reason about the CLI's credentials store: the reader that
 * reports the sign-in on screen, the writer that renews it, and the CLI child
 * that authenticates runs with it. They used to disagree — the reader honoured
 * `CLAUDE_CONFIG_DIR`, the child was never told about it — so on any machine
 * that sets the variable the interface described one file while runs used
 * another.
 *
 * That was cosmetic while the file was only read. It stops being cosmetic the
 * moment a renewal writes: a sign-in installed where nothing looks for it,
 * under a message saying it worked.
 *
 * The fix forwards the variable instead of computing one and imposing it, and
 * the difference is not pedantic: imposing a value was written first, and the
 * end-to-end gateway check went red on the first run because the child then
 * inherited a different settings directory. So there are two claims to hold
 * here, not one — the gap is closed where the variable is set, and *nothing
 * moves* where it is not.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildClaudeEnv, claudeConfigDir } from './context.js';
import type { Config } from './config.js';

const config = { claude: { oauthToken: null, apiKey: null } } as unknown as Config;

const original = process.env.CLAUDE_CONFIG_DIR;
afterEach(() => {
  if (original === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = original;
});

describe('the CLI config directory', () => {
  it('reaches the child when it is set, and is what the reader reads', () => {
    process.env.CLAUDE_CONFIG_DIR = '/srv/claude-config';
    expect(claudeConfigDir()).toBe('/srv/claude-config');
    expect(buildClaudeEnv(config).CLAUDE_CONFIG_DIR).toBe('/srv/claude-config');
  });

  it('is not invented when it is unset', () => {
    // The child then resolves its own, exactly as it did before any of this —
    // and handing it a computed path is a behaviour change disguised as a
    // guarantee. Absent is the correct value here, not a chore.
    delete process.env.CLAUDE_CONFIG_DIR;
    expect(buildClaudeEnv(config).CLAUDE_CONFIG_DIR).toBeUndefined();
  });

  it('still resolves for the reader and the writer with nothing set', () => {
    delete process.env.CLAUDE_CONFIG_DIR;
    expect(claudeConfigDir()).toBe(join(homedir(), '.claude'));
  });
});
