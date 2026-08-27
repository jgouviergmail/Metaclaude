/**
 * The checklist rule: which steps exist, when each is done, and when the
 * whole card has nothing left to say.
 */

import { describe, expect, it } from 'vitest';
import { onboardingDone, onboardingSteps } from './onboarding';

const FRESH = {
  authenticated: false,
  workspaces: 0,
  hasRuns: false,
  totpEnabled: false,
  pushDevices: 0,
  updaterAvailable: false,
};

describe('onboardingSteps', () => {
  it('starts a fresh deployment with everything to do, pairing first', () => {
    const steps = onboardingSteps(FRESH);
    expect(steps.every((step) => !step.done)).toBe(true);
    expect(steps[0]?.key).toBe('pair');
    // Every step points somewhere: a checklist without doors is a scold.
    expect(steps.every((step) => step.href.startsWith('/'))).toBe(true);
  });

  it('ticks each step off its own signal', () => {
    const steps = onboardingSteps({
      authenticated: true,
      workspaces: 2,
      hasRuns: true,
      totpEnabled: false,
      pushDevices: 1,
      updaterAvailable: false,
    });
    const byKey = Object.fromEntries(steps.map((step) => [step.key, step.done]));
    expect(byKey).toEqual({
      pair: true,
      workspace: true,
      run: true,
      totp: false,
      push: true,
      updater: false,
    });
    expect(onboardingDone(steps)).toBe(false);
  });

  it('declares the whole thing done only when everything is', () => {
    expect(
      onboardingDone(
        onboardingSteps({
          authenticated: true,
          workspaces: 1,
          hasRuns: true,
          totpEnabled: true,
          pushDevices: 1,
          updaterAvailable: true,
        }),
      ),
    ).toBe(true);
  });
});
