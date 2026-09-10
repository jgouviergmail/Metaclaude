/**
 * What each background pass is served, and when it reads it.
 *
 * Every one of these calls is built **once**, at boot, inside `context.ts`.
 * The settings behind them are hot — an operator changes a model from the
 * screen and expects the next pass to obey — so each factory takes a *getter*
 * rather than a value, and this file is what holds them to it: a captured
 * model passes the first two cases here and fails the third.
 *
 * The table is derived from `LEARNING_PHASES`, not written beside it, so a
 * seventh phase fails on the day it is declared rather than shipping with a
 * setting no code reads. That is the failure this whole family is prone to: a
 * key in a list, a picker on a screen, and nothing in between.
 */

import { describe, expect, it, vi } from 'vitest';
import { LEARNING_PHASES, type LearningPhaseId } from '@metaclaude/shared';

// The recorder has to exist before the mock factory runs, and those factories
// are hoisted above every top-level statement — see the temporal-dead-zone
// trap in CLAUDE.md.
const seen = vi.hoisted(() => ({ requests: [] as Array<Record<string, unknown>> }));

vi.mock('./structured-call.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./structured-call.js')>();
  return {
    ...actual,
    structuredCall: vi.fn(async (_context: unknown, request: Record<string, unknown>) => {
      seen.requests.push(request);
      return null;
    }),
  };
});

import { createGateCall } from './gatekeeper.js';
import { createReflexionCall } from './reflexion.js';
import { createConsolidationCall } from './consolidation.js';
import { createSynthesisCall } from './synthesis.js';
import { createArbiterCall } from './improvement-arbiter.js';
import { STRUCTURED_DEFAULT_MODEL, type PhasePolicyReader, type StructuredCallContext } from './structured-call.js';

const CONTEXT: StructuredCallContext = { env: {}, claudeBinPath: null, cwd: '/scratch' };

/**
 * One driver per phase. It **builds** the pass's call, once, and returns
 * something that fires it — the split that matters: a factory rebuilt between
 * two firings would make a policy captured at construction indistinguishable
 * from one read per call, and the third case below would prove nothing. (It
 * did not, at first. The sabotage was invisible until the build moved out.)
 */
type Driver = (policy: PhasePolicyReader) => () => Promise<void>;

const DRIVERS: Record<LearningPhaseId, Driver> = {
  reflexion: (policy) => {
    const call = createReflexionCall(CONTEXT, policy);
    return async () => {
      await call('a transcript summary', null);
    };
  },
  memoryGate: (policy) => {
    const call = createGateCall(CONTEXT, policy);
    // The gate retries once and then refuses, having been answered nothing.
    // What this file is about is the request, which the first attempt made.
    return async () => {
      await call({
        candidates: [{ kind: 'semantic', title: 'A note', content: 'Its body.', confidence: 0.8, tags: [] }],
        neighbours: [],
        instructions: null,
        language: null,
      }).catch(() => undefined);
    };
  },
  consolidation: (policy) => {
    const call = createConsolidationCall(CONTEXT, policy);
    return async () => {
      await call(
        [
          [
            { id: 'm1', title: 'One', content: 'First.' },
            { id: 'm2', title: 'Two', content: 'Second.' },
          ],
        ],
        null,
      );
    };
  },
  synthesis: (policy) => {
    const call = createSynthesisCall(CONTEXT, () => null, policy);
    return async () => {
      await call('a prompt', 'w1');
    };
  },
  revision: (policy) => {
    const call = createArbiterCall(CONTEXT, policy);
    return async () => {
      await call({
        workspaceName: 'Metaclaude',
        window: {
          from: 0,
          to: 1,
          runs: [],
          toolFailures: [],
          subagentRuns: [],
          skillUses: [],
          automations: [],
        } as never,
        observations: [],
        targets: [],
        refusedKeys: [],
        language: null,
      }).catch(() => undefined);
    };
  },
  advisor: () => async () => {
    // The advisor is not a structured call: it is an ordinary run through the
    // kernel, so its pinned model rides the submit's overrides. Driven in
    // `advisor-model.test.ts`, where a fake submit can see them.
  },
};

/** The five that go through `structuredCall`; the advisor is a run, not a call. */
const STRUCTURED_PHASES = LEARNING_PHASES.filter((phase) => phase.id !== 'advisor');

describe('what each background pass is served', () => {
  it('has a driver for every phase an operator can pin', () => {
    // The point of the file: a new phase without a driver fails here.
    for (const phase of LEARNING_PHASES) expect(DRIVERS[phase.id]).toBeTypeOf('function');
  });

  it('states the same shipped default the calls actually take', () => {
    // The screen tells the operator what `auto` means for each row. If that
    // sentence and the code disagree, the screen is the one they believe.
    for (const phase of STRUCTURED_PHASES) expect(phase.shipped).toBe(STRUCTURED_DEFAULT_MODEL);
  });

  for (const phase of STRUCTURED_PHASES) {
    describe(phase.id, () => {
      it('sends neither model nor effort when nothing is pinned', async () => {
        seen.requests.length = 0;
        await DRIVERS[phase.id](() => ({ model: null, effort: null }))();
        expect(seen.requests.length).toBeGreaterThan(0);
        // Absence, not null: an absent `model` lets the call take its own
        // default, and an absent `effort` lets the CLI choose for the model it
        // is serving — `effort: null` is a value the SDK would carry.
        expect(seen.requests[0]).not.toHaveProperty('model');
        expect(seen.requests[0]).not.toHaveProperty('effort');
      });

      it('sends both when the operator has pinned them', async () => {
        seen.requests.length = 0;
        await DRIVERS[phase.id](() => ({ model: 'fable', effort: 'high' }))();
        expect(seen.requests[0]).toMatchObject({ model: 'fable', effort: 'high' });
      });

      it('reads the setting at the moment of the call, not at boot', async () => {
        seen.requests.length = 0;
        let model: string | null = null;
        // Built once, exactly as `context.ts` builds it: at boot.
        const fire = DRIVERS[phase.id](() => ({ model, effort: null }));
        await fire();
        model = 'sonnet';
        await fire();
        // The first call saw the shipped default, the second the change — with
        // no restart in between, which is the whole point of a getter.
        expect(seen.requests[0]).not.toHaveProperty('model');
        expect(seen.requests.at(-1)).toMatchObject({ model: 'sonnet' });
      });
    });
  }
});
