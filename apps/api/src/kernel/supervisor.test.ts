/**
 * The supervisor: the only place the Claude Agent SDK is called.
 *
 * It had no tests at all — the module that decides what the transcript says,
 * what the timeout does, and whether a run can be steered. The excuse was that
 * testing it needs a live CLI; it does not. `query` is a dependency, so a fake
 * one exercises every branch without spawning anything, which is also what the
 * repository's own rule requires.
 *
 * The fake is a faithful `Query`: an AsyncGenerator of SDKMessage that also
 * carries the control methods, exactly as the SDK's type declares.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Workspace } from '@metaclaude/shared';
import { AgentSupervisor, type RunRequest, type SupervisorCallbacks } from './supervisor.js';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const workspace: Workspace = {
  id: 'ws_1',
  name: 'Test',
  slug: 'test',
  description: '',
  path: '/var/lib/metaclaude/workspaces/test',
  color: '#6366f1',
  icon: 'folder',
  archived: false,
  settings: {
    defaultModel: 'default',
    defaultEffort: null,
    defaultPermissionMode: 'default',
    defaultThinking: 'off',
    thinkingBudgetTokens: null,
    maxTurns: 40,
    maxBudgetUsd: null,
    allowedTools: [],
    disallowedTools: [],
    additionalDirectories: [],
    systemPromptAppend: '',
    memoryEnabled: true,
    checkpointing: true,
    autoPolicy: false,
  },
  createdAt: 0,
  updatedAt: 0,
};

function makeRequest(overrides: Partial<RunRequest> = {}): RunRequest {
  return {
    runId: 'run_1',
    sessionId: 'ses_1',
    workspace,
    prompt: 'first turn',
    policy: {
      model: 'default',
      effort: null,
      permissionMode: 'default',
      thinking: 'off',
      thinkingBudgetTokens: null,
      agentName: null,
      source: 'explicit',
    },
    resumeSessionId: null,
    systemPromptAppend: '',
    mcpServers: {},
    agents: {},
    abortSignal: new AbortController().signal,
    ...overrides,
  };
}

function makeCallbacks(): SupervisorCallbacks & { events: unknown[] } {
  const events: unknown[] = [];
  return {
    events,
    onEvent: (event) => events.push(event),
    onDelta: () => {},
    onClaudeSessionId: () => {},
    onWaitingChange: () => {},
  };
}

/* -------------------------------------------------------------------------- */
/* A faithful fake Query                                                       */
/* -------------------------------------------------------------------------- */

interface FakeQuery {
  /** Every message the supervisor pushed into the streaming-input iterable. */
  received: unknown[];
  interrupted: number;
  models: Array<string | undefined>;
  modes: string[];
  /** Let a test decide when the run finishes. */
  finish: (result?: Record<string, unknown>) => void;
  emit: (message: Record<string, unknown>) => void;
}

/**
 * Builds a fake `query` plus a handle for driving it.
 *
 * `emit` pushes an SDK message to the supervisor; `finish` ends the stream.
 * The prompt iterable is drained in the background so that what the supervisor
 * sends is observable — that is the property under test in half these cases.
 */
function fakeQuery() {
  const control: FakeQuery = {
    received: [],
    interrupted: 0,
    models: [],
    modes: [],
    finish: () => {},
    emit: () => {},
  };

  const pushed: Array<Record<string, unknown>> = [];
  let wake: (() => void) | null = null;
  let done = false;
  let aborted = false;

  control.emit = (message) => {
    pushed.push(message);
    wake?.();
  };
  control.finish = (result) => {
    pushed.push(
      result ?? {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'done',
        duration_ms: 1,
        num_turns: 1,
        total_cost_usd: 0,
        usage: {},
        session_id: 'sdk-session',
      },
    );
    done = true;
    wake?.();
  };

  const query = (params: { prompt: unknown; options?: Record<string, unknown> }) => {
    // Faithful to the SDK: aborting the controller ends the message stream.
    // Without this the fake would let the supervisor pass a test the real thing
    // would fail, which is worse than having no test.
    const aborter = params.options?.abortController as AbortController | undefined;
    aborter?.signal.addEventListener('abort', () => {
      aborted = true;
      wake?.();
    });
    // Drain whatever the supervisor gives us, so queued turns are observable.
    void (async () => {
      const prompt = params.prompt as AsyncIterable<unknown> | string;
      if (typeof prompt === 'string') {
        control.received.push(prompt);
        return;
      }
      for await (const message of prompt) control.received.push(message);
    })();

    const generator = (async function* () {
      for (;;) {
        if (aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
        while (pushed.length > 0) yield pushed.shift() as never;
        if (done) return;
        await new Promise<void>((resolve) => {
          wake = () => {
            wake = null;
            resolve();
          };
        });
      }
    })();

    return Object.assign(generator, {
      interrupt: async () => {
        control.interrupted += 1;
        control.finish({
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          result: 'interrupted',
          duration_ms: 1,
          num_turns: 1,
          total_cost_usd: 0,
          usage: {},
          session_id: 'sdk-session',
        });
        return undefined;
      },
      setModel: async (model?: string) => {
        control.models.push(model);
      },
      setPermissionMode: async (mode: string) => {
        control.modes.push(mode);
      },
      getContextUsage: async () => ({ totalTokens: 1234, maxTokens: 200_000, categories: [], rawMaxTokens: 200_000, percentage: 0.6, gridRows: [] }),
    });
  };

  return { query, control };
}

function makeSupervisor(query: unknown) {
  return new AgentSupervisor({
    broker: () => ({ request: async () => ({ behavior: 'allow' }) }) as never,
    allowBypassPermissions: false,
    claudeBinPath: null,
    runTimeoutMs: 60_000,
    env: {},
    directoryPolicy: { workspacesDir: '/var/lib/metaclaude/workspaces', dataDir: '/var/lib/metaclaude' },
    log: () => {},
    query: query as never,
  });
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                       */
/* -------------------------------------------------------------------------- */

describe('the prompt reaches the CLI as streaming input', () => {
  it('sends the prompt as a user message, not as a bare string', async () => {
    const { query, control } = fakeQuery();
    const supervisor = makeSupervisor(query);

    const run = supervisor.execute(makeRequest(), makeCallbacks());
    await vi.waitFor(() => expect(control.received.length).toBe(1));
    control.finish();
    await run;

    // A string prompt is what made every control method unreachable: the SDK
    // documents all 27 as streaming-input only.
    expect(typeof control.received[0]).not.toBe('string');
    expect(control.received[0]).toMatchObject({
      type: 'user',
      message: { role: 'user', content: 'first turn' },
    });
  });

  it('returns the outcome when the run completes', async () => {
    const { query, control } = fakeQuery();
    const supervisor = makeSupervisor(query);

    const run = supervisor.execute(makeRequest(), makeCallbacks());
    await vi.waitFor(() => expect(control.received.length).toBe(1));
    control.finish();

    const outcome = await run;
    expect(outcome.status).toBe('succeeded');
    expect(outcome.claudeSessionId).toBe('sdk-session');
  });
});

describe('a live run can be steered', () => {
  it('delivers a follow-up typed while the agent is working', async () => {
    const { query, control } = fakeQuery();
    const supervisor = makeSupervisor(query);

    const run = supervisor.execute(makeRequest(), makeCallbacks());
    await vi.waitFor(() => expect(control.received.length).toBe(1));

    // The whole point: on a phone you watch a run go wrong and today your only
    // options are wait or kill it.
    await supervisor.send('run_1', 'no, use the shared zod schema');
    await vi.waitFor(() => expect(control.received.length).toBe(2));
    expect(control.received[1]).toMatchObject({
      message: { role: 'user', content: 'no, use the shared zod schema' },
    });

    control.finish();
    await run;
  });

  it('interrupts through the CLI rather than killing the subprocess', async () => {
    const { query, control } = fakeQuery();
    const supervisor = makeSupervisor(query);

    const run = supervisor.execute(makeRequest(), makeCallbacks());
    await vi.waitFor(() => expect(control.received.length).toBe(1));

    await supervisor.interrupt('run_1');
    const outcome = await run;

    // A clean turn-stop, not the SIGKILL an AbortController would have been.
    expect(control.interrupted).toBe(1);
    expect(outcome.status).toBe('interrupted');
  });

  it('changes the model and the permission mode mid-run', async () => {
    const { query, control } = fakeQuery();
    const supervisor = makeSupervisor(query);

    const run = supervisor.execute(makeRequest(), makeCallbacks());
    await vi.waitFor(() => expect(control.received.length).toBe(1));

    await supervisor.setModel('run_1', 'opus');
    await supervisor.setPermissionMode('run_1', 'acceptEdits');
    expect(control.models).toEqual(['opus']);
    expect(control.modes).toEqual(['acceptEdits']);

    control.finish();
    await run;
  });

  it('reports how much context the run has used', async () => {
    const { query, control } = fakeQuery();
    const supervisor = makeSupervisor(query);

    const run = supervisor.execute(makeRequest(), makeCallbacks());
    await vi.waitFor(() => expect(control.received.length).toBe(1));

    expect(await supervisor.contextUsage('run_1')).toMatchObject({ totalTokens: 1234 });

    control.finish();
    await run;
  });
});

describe('control of a run that is not live', () => {
  // Every one of these is reachable from the UI: a socket frame arriving a
  // moment after the run ended, a stale tab, a retried tap. None may throw.
  it('is a no-op rather than a crash', async () => {
    const { query } = fakeQuery();
    const supervisor = makeSupervisor(query);

    await expect(supervisor.send('run_missing', 'hello')).resolves.toBe(false);
    await expect(supervisor.interrupt('run_missing')).resolves.toBe(false);
    await expect(supervisor.setModel('run_missing', 'opus')).resolves.toBe(false);
    await expect(supervisor.contextUsage('run_missing')).resolves.toBeNull();
  });

  it('forgets a run as soon as it ends', async () => {
    const { query, control } = fakeQuery();
    const supervisor = makeSupervisor(query);

    const run = supervisor.execute(makeRequest(), makeCallbacks());
    await vi.waitFor(() => expect(control.received.length).toBe(1));
    control.finish();
    await run;

    // Left in the map, every finished run would retain its handle, its options
    // and its abort controller for the life of the process.
    await expect(supervisor.send('run_1', 'too late')).resolves.toBe(false);
  });
});

describe('the input stream is closed exactly once', () => {
  // The failure mode the design flagged: close it twice and the iterator throws
  // inside the SDK; never close it and the subprocess waits forever for input
  // that is not coming.
  it('closes when the run completes normally', async () => {
    const { query, control } = fakeQuery();
    const supervisor = makeSupervisor(query);

    const run = supervisor.execute(makeRequest(), makeCallbacks());
    await vi.waitFor(() => expect(control.received.length).toBe(1));
    control.finish();
    await run;

    await expect(supervisor.send('run_1', 'after the end')).resolves.toBe(false);
  });

  it('closes when the run is aborted', async () => {
    const { query, control } = fakeQuery();
    const supervisor = makeSupervisor(query);
    const aborter = new AbortController();

    const run = supervisor.execute(makeRequest({ abortSignal: aborter.signal }), makeCallbacks());
    await vi.waitFor(() => expect(control.received.length).toBe(1));

    aborter.abort();
    const outcome = await run;
    expect(outcome.status).toBe('interrupted');
  });
});

describe('failures are reported as failures', () => {
  it('treats a result marked is_error as a failed run', async () => {
    const { query, control } = fakeQuery();
    const supervisor = makeSupervisor(query);

    const run = supervisor.execute(makeRequest(), makeCallbacks());
    await vi.waitFor(() => expect(control.received.length).toBe(1));
    control.finish({
      type: 'result',
      subtype: 'success',
      is_error: true,
      result: 'the API refused',
      duration_ms: 1,
      num_turns: 1,
      total_cost_usd: 0,
      usage: {},
      session_id: 'sdk-session',
    });

    const outcome = await run;
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toContain('refused');
  });
});
