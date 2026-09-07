/**
 * The checklist rule: which steps exist, when each is done, and when the
 * whole card has nothing left to say.
 */

import { describe, expect, it } from 'vitest';
import { routes } from '@metaclaude/shared';
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

/**
 * Each step lands where its card actually is.
 *
 * Three of the six pointed at Settings, and the cards they name — the Claude
 * credential, notifications, the updater — moved to the server screen when the
 * machine stopped being a Settings tab. Nothing failed: the links still
 * resolved, to a page with none of what the step asks for. An operator arrives,
 * finds nothing to do, and stops trusting the list, which is worse than the
 * list not existing.
 *
 * Asserted against the routes contract rather than against strings, so a path
 * that moves again fails here rather than in someone's afternoon.
 */
describe('where each step sends you', () => {
  const steps = onboardingSteps({
    authenticated: false,
    workspaces: 0,
    hasRuns: false,
    totpEnabled: false,
    pushDevices: 0,
    updaterAvailable: false,
  });
  const href = (key: string) => steps.find((step) => step.key === key)?.href;

  it('sends the three machine steps to the server screen', () => {
    // The credential card, the notifications card and the updater all live
    // there — none of them is a preference.
    expect(href('pair')).toBe(routes.server());
    expect(href('push')).toBe(routes.server());
    expect(href('updater')).toBe(routes.server());
  });

  it('sends two-factor auth to the security group, not to Settings’ landing', () => {
    // `/settings` forwards to Appearance, which is not where the control is.
    expect(href('totp')).toBe(routes.settingsSection('security'));
  });

  it('sends the workspace steps to the workspaces screen', () => {
    expect(href('workspace')).toBe(routes.workspaces());
    expect(href('run')).toBe(routes.workspaces());
  });

  it('leaves no step pointing at a bare /settings', () => {
    // The landing redirects, so a step that ends there is a step that arrives
    // somewhere nobody chose.
    for (const step of steps) {
      expect(step.href, step.key).not.toBe(routes.settings());
    }
  });
});
