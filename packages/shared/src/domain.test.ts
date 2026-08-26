/**
 * The contracts, where they carry a rule rather than just a shape.
 *
 * Most schemas here are field lists and testing them would restate the file.
 * These are the ones where the schema *decides* something — what a login may
 * carry, what a default means — and where getting it wrong locks someone out of
 * their own server.
 */

import { describe, expect, it } from 'vitest';
import { LoginRequest, RewindRequest, RunPolicy, WorkspaceSettings } from './domain.js';

const base = { username: 'owner', password: 'a-long-enough-password' };

describe('LoginRequest — the second factor', () => {
  it('accepts a six-digit TOTP code', () => {
    expect(LoginRequest.safeParse({ ...base, totp: '123456' }).success).toBe(true);
  });

  it('accepts a recovery code', () => {
    // The bug this pins. Recovery codes are generated as `XXXXX-XXXXX` from a
    // no-lookalike alphabet, the login form says in so many words that "a
    // recovery code also works here", and the field was `/^\d{6}$/` — so the
    // route answered 400 before the code was ever checked.
    //
    // Nothing recovered from a lost TOTP device. The codes were generated,
    // displayed, and told to be kept somewhere safe, and they were dead on
    // arrival; the only way back into the box was editing SQLite by hand.
    expect(LoginRequest.safeParse({ ...base, totp: 'ABCDE-FGHJK' }).success).toBe(true);
  });

  it('accepts a recovery code the operator typed in lower case', () => {
    // `consumeSecondFactor` upper-cases before comparing, so the schema must not
    // be stricter than the check behind it.
    expect(LoginRequest.safeParse({ ...base, totp: 'abcde-fghjk' }).success).toBe(true);
  });

  it('still rejects anything that is neither shape', () => {
    // The field is bounded so the verifier is never handed something absurd.
    for (const totp of ['', '12345', '1234567', 'ABCDEFGHJK', 'ABCDE_FGHJK', 'ABCDE-FGHJ', "' OR 1=1", 'x'.repeat(200)]) {
      expect(LoginRequest.safeParse({ ...base, totp }).success).toBe(false);
    }
  });

  it('leaves the second factor optional, because most logins have none', () => {
    expect(LoginRequest.safeParse(base).success).toBe(true);
  });

  it('bounds the username and password rather than trusting them', () => {
    expect(LoginRequest.safeParse({ ...base, username: '' }).success).toBe(false);
    expect(LoginRequest.safeParse({ ...base, username: 'u'.repeat(65) }).success).toBe(false);
    expect(LoginRequest.safeParse({ ...base, password: '' }).success).toBe(false);
    expect(LoginRequest.safeParse({ ...base, password: 'p'.repeat(1025) }).success).toBe(false);
  });
});

describe('RewindRequest', () => {
  it('previews when the caller says nothing', () => {
    // The default is the safety property: a request that forgets its body must
    // preview rather than overwrite a working tree.
    expect(RewindRequest.parse({})).toEqual({ dryRun: true });
  });

  it('applies only when asked explicitly', () => {
    expect(RewindRequest.parse({ dryRun: false })).toEqual({ dryRun: false });
  });
});

describe('WorkspaceSettings defaults', () => {
  it('fills every field from an empty object', () => {
    // Repositories persist whatever this produces, and the kernel reads the
    // result without checking for undefined.
    const settings = WorkspaceSettings.parse({});

    for (const [key, value] of Object.entries(settings)) {
      expect(value, `${key} is undefined`).not.toBeUndefined();
    }
  });

  it('defaults checkpointing on, which is what makes a run rewindable', () => {
    expect(WorkspaceSettings.parse({}).checkpointing).toBe(true);
  });

  it('rejects a permission mode outside the known set', () => {
    expect(WorkspaceSettings.safeParse({ defaultPermissionMode: 'yolo' }).success).toBe(false);
  });
});

describe('RunPolicy — ultracode', () => {
  const base = {
    model: 'opus',
    effort: 'xhigh',
    permissionMode: 'default',
    thinking: 'adaptive',
    thinkingBudgetTokens: null,
    agentName: null,
    source: 'explicit',
  };

  it('defaults to off, so every policy written before the field existed still parses', () => {
    const parsed = RunPolicy.parse(base);
    expect(parsed.ultracode).toBe(false);
  });

  it('round-trips an explicit true', () => {
    expect(RunPolicy.parse({ ...base, ultracode: true }).ultracode).toBe(true);
  });
});
