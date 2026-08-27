/**
 * The getting-set-up checklist, as a pure function.
 *
 * A fresh deployment has half a dozen one-time steps spread across four
 * screens, and each was historically discovered by hitting the wall it
 * guards: no credential — runs fail opaquely; no updater — Apply never
 * appears; no notifications — approvals block silently. The checklist
 * names them in the order they unblock each other, and the card renders
 * whatever this answers so the rule stays readable and testable here.
 */

export interface OnboardingInput {
  /** A Claude credential is live (paired, env, or CLI sign-in). */
  authenticated: boolean;
  workspaces: number;
  /** Any run has ever been recorded. */
  hasRuns: boolean;
  totpEnabled: boolean;
  pushDevices: number;
  /** The host updater answered as installed. */
  updaterAvailable: boolean;
}

export interface OnboardingStep {
  key: string;
  label: string;
  detail: string;
  done: boolean;
  href: string;
}

export function onboardingSteps(input: OnboardingInput): OnboardingStep[] {
  return [
    {
      key: 'pair',
      label: 'Pair Claude',
      detail: 'Sign in with your Pro or Max account — nothing runs without it.',
      done: input.authenticated,
      href: '/settings',
    },
    {
      key: 'workspace',
      label: 'Create a workspace',
      detail: 'A directory plus the agent policy that applies inside it.',
      done: input.workspaces > 0,
      href: '/workspaces',
    },
    {
      key: 'run',
      label: 'Run the agent once',
      detail: 'Open a session and ask for something small; watch it work.',
      done: input.hasRuns,
      href: '/workspaces',
    },
    {
      key: 'totp',
      label: 'Turn on two-factor auth',
      detail: 'This server is on the network; your account should need more than a password.',
      done: input.totpEnabled,
      href: '/settings',
    },
    {
      key: 'push',
      label: 'Enable notifications',
      detail: 'A push when a run waits on your approval — the phone is the point.',
      done: input.pushDevices > 0,
      href: '/settings',
    },
    {
      key: 'updater',
      label: 'Install the host updater',
      detail: 'Re-run deploy/install-app.sh once; updates become one button here.',
      done: input.updaterAvailable,
      href: '/settings',
    },
  ];
}

export function onboardingDone(steps: OnboardingStep[]): boolean {
  return steps.every((step) => step.done);
}
