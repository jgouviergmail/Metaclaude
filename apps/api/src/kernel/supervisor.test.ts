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

function makeCallbacks(): SupervisorCallbacks & { events: unknown[]; waiting: boolean[] } {
  const events: unknown[] = [];
  /** Every `onWaitingChange` value, in order. */
  const waiting: boolean[] = [];
  return {
    events,
    waiting,
    onEvent: (event) => events.push(event),
    onDelta: () => {},
    onClaudeSessionId: () => {},
    onWaitingChange: (value) => waiting.push(value),
  };
}

/** A permission broker whose answers the test releases by hand. */
function heldBroker() {
  const pending: Array<() => void> = [];
  return {
    get outstanding(): number {
      return pending.length;
    },
    releaseAll(): void {
      for (const release of pending.splice(0)) release();
    },
    request: () =>
      new Promise<{ behavior: 'allow' }>((resolve) => {
        pending.push(() => resolve({ behavior: 'allow' }));
      }),
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
  /** Options each `query()` was opened with, newest last. */
  opened: Array<Record<string, unknown>>;
  /** Arguments of every `rewindFiles` call. */
  rewinds: Array<{ userMessageId: string; dryRun: boolean | undefined }>;
  /** What the next `rewindFiles` should answer. */
  rewindResult: Record<string, unknown>;
  /** True once the supervisor tore this session down. */
  torndown: boolean;
  /** Catalogue answers. Trailing underscore: `models` is already the setModel log. */
  models_: Array<Record<string, unknown>>;
  commands_: Array<Record<string, unknown>>;
  agents_: Array<Record<string, unknown>>;
  mcp_: Array<Record<string, unknown>>;
  /** Make `supportedCommands` throw, the way an older CLI would. */
  failCommands: boolean;
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
    opened: [],
    rewinds: [],
    rewindResult: { canRewind: true, filesChanged: ['src/a.ts'], insertions: 3, deletions: 7 },
    torndown: false,
    models_: [{ value: 'sonnet', displayName: 'Sonnet', description: 'Balanced' }],
    commands_: [{ name: 'review', description: 'Review the diff', argumentHint: '[path]' }],
    agents_: [{ name: 'explorer', description: 'Reads widely' }],
    mcp_: [],
    failCommands: false,
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
    control.opened.push(params.options ?? {});
    // Faithful to the SDK: aborting the controller ends the message stream.
    // Without this the fake would let the supervisor pass a test the real thing
    // would fail, which is worse than having no test.
    const aborter = params.options?.abortController as AbortController | undefined;
    aborter?.signal.addEventListener('abort', () => {
      aborted = true;
      control.torndown = true;
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
      rewindFiles: async (userMessageId: string, options?: { dryRun?: boolean }) => {
        control.rewinds.push({ userMessageId, dryRun: options?.dryRun });
        return control.rewindResult;
      },
      supportedModels: async () => control.models_,
      supportedCommands: async () => {
        if (control.failCommands) throw new Error('unsupported control request');
        return control.commands_;
      },
      supportedAgents: async () => control.agents_,
      mcpServerStatus: async () => control.mcp_,
      accountInfo: async () => ({ subscriptionType: 'max', organization: 'Personal' }),
    });
  };

  return { query, control };
}

function makeSupervisor(query: unknown, broker?: { request: () => Promise<unknown> }) {
  return new AgentSupervisor({
    broker: () => (broker ?? { request: async () => ({ behavior: 'allow' }) }) as never,
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

/* -------------------------------------------------------------------------- */
/* Rewind                                                                      */
/* -------------------------------------------------------------------------- */

describe('a run records where it can be rewound to', () => {
  /**
   * The workspace setting has always been honoured — `enableFileCheckpointing`
   * was set — but nothing could act on it, because rewinding needs the uuid the
   * CLI assigns to the user message that opened the turn, and that uuid exists
   * only on the wire. It arrives as a replay acknowledgement mid-run. Miss it
   * and the checkpoints are unreachable forever.
   */
  const replay = (uuid: string, text: string) => ({
    type: 'user',
    uuid,
    isReplay: true,
    session_id: 'sdk-session',
    parent_tool_use_id: null,
    message: { role: 'user', content: text },
  });

  it('captures the uuid the CLI assigns to the opening prompt', async () => {
    const { query, control } = fakeQuery();
    const supervisor = makeSupervisor(query);

    const run = supervisor.execute(makeRequest(), makeCallbacks());
    await vi.waitFor(() => expect(control.received.length).toBe(1));
    control.emit(replay('11111111-1111-4111-8111-111111111111', 'first turn'));
    control.finish();

    expect((await run).rewindPoint).toBe('11111111-1111-4111-8111-111111111111');
  });

  it('keeps the first acknowledgement, not the last', async () => {
    // A run is steerable: the operator can type a follow-up into it. Undoing
    // "the run" means undoing all of it, so a later turn must not move the
    // anchor forward and quietly shrink what a rewind restores.
    const { query, control } = fakeQuery();
    const supervisor = makeSupervisor(query);

    const run = supervisor.execute(makeRequest(), makeCallbacks());
    await vi.waitFor(() => expect(control.received.length).toBe(1));
    control.emit(replay('11111111-1111-4111-8111-111111111111', 'first turn'));
    await supervisor.send('run_1', 'and also this');
    control.emit(replay('22222222-2222-4222-8222-222222222222', 'and also this'));
    control.finish();

    expect((await run).rewindPoint).toBe('11111111-1111-4111-8111-111111111111');
  });

  it('reports no rewind point when the CLI never acknowledges', async () => {
    // Checkpointing off, or an older CLI. Null is the honest answer, and it is
    // what stops the UI offering a button that cannot work.
    const { query, control } = fakeQuery();
    const supervisor = makeSupervisor(query);

    const run = supervisor.execute(makeRequest(), makeCallbacks());
    await vi.waitFor(() => expect(control.received.length).toBe(1));
    control.finish();

    expect((await run).rewindPoint).toBeNull();
  });

  it('ignores a user message that is not a replay acknowledgement', async () => {
    // Tool results arrive as `type: 'user'` too. Treating one as the anchor
    // would rewind to the middle of the run.
    const { query, control } = fakeQuery();
    const supervisor = makeSupervisor(query);

    const run = supervisor.execute(makeRequest(), makeCallbacks());
    await vi.waitFor(() => expect(control.received.length).toBe(1));
    control.emit({
      type: 'user',
      uuid: '33333333-3333-4333-8333-333333333333',
      session_id: 'sdk-session',
      parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] },
    });
    control.finish();

    expect((await run).rewindPoint).toBeNull();
  });
});

describe('rewinding a finished run', () => {
  const target = {
    claudeSessionId: 'sdk-session',
    rewindPoint: '11111111-1111-4111-8111-111111111111',
    workspacePath: '/var/lib/metaclaude/workspaces/test',
  };

  it('previews without touching the files', async () => {
    const { query, control } = fakeQuery();
    const supervisor = makeSupervisor(query);

    const result = await supervisor.rewind({ ...target, dryRun: true });

    expect(control.rewinds).toEqual([{ userMessageId: target.rewindPoint, dryRun: true }]);
    expect(result.applied).toBe(false);
    expect(result.filesChanged).toEqual(['src/a.ts']);
    expect(result.insertions).toBe(3);
    expect(result.deletions).toBe(7);
  });

  it('applies when asked to', async () => {
    const { query, control } = fakeQuery();
    const supervisor = makeSupervisor(query);

    const result = await supervisor.rewind({ ...target, dryRun: false });

    expect(control.rewinds).toEqual([{ userMessageId: target.rewindPoint, dryRun: false }]);
    expect(result.applied).toBe(true);
  });

  it('resumes the run\'s own session, in the workspace, with checkpointing on', async () => {
    // All three or nothing: the checkpoints belong to that session, they are
    // recorded relative to that directory, and the CLI will not serve a rewind
    // for a session it did not open with checkpointing enabled.
    const { query, control } = fakeQuery();
    const supervisor = makeSupervisor(query);

    await supervisor.rewind({ ...target, dryRun: true });

    expect(control.opened).toHaveLength(1);
    expect(control.opened[0]).toMatchObject({
      resume: 'sdk-session',
      cwd: '/var/lib/metaclaude/workspaces/test',
      enableFileCheckpointing: true,
    });
  });

  it('tears the session down instead of waiting to be let go', async () => {
    // The subprocess sits on stdin until the input iterable ends, so a rewind
    // that leaks one leaks a whole CLI per click. But closing the input only
    // *asks* it to exit: this fake, like a CLI that keeps its stream open,
    // never ends the message side on its own. The first implementation awaited
    // that ending as proof of teardown and hung here forever — which is what
    // "undo my run" would have done to the operator.
    const { query, control } = fakeQuery();
    const supervisor = makeSupervisor(query);

    await supervisor.rewind({ ...target, dryRun: true });

    expect(control.torndown).toBe(true);
  });

  it('passes the refusal through in the CLI\'s own words', async () => {
    // "Could not rewind" tells the operator nothing. "No checkpoints found for
    // this session" tells them the workspace had checkpointing off.
    const { query, control } = fakeQuery();
    control.rewindResult = { canRewind: false, error: 'No checkpoints found for this session.' };
    const supervisor = makeSupervisor(query);

    const result = await supervisor.rewind({ ...target, dryRun: false });

    expect(result.canRewind).toBe(false);
    expect(result.error).toBe('No checkpoints found for this session.');
    expect(result.applied).toBe(false);
  });

  it('reports files the CLI refused to restore', async () => {
    // A partial restore that reads as a complete one is how an operator walks
    // away believing their tree is clean.
    const { query, control } = fakeQuery();
    control.rewindResult = { canRewind: true, filesChanged: ['a'], skippedLinks: 2 };
    const supervisor = makeSupervisor(query);

    const result = await supervisor.rewind({ ...target, dryRun: false });

    expect(result.skippedLinks).toBe(2);
  });

  it('never throws when the CLI cannot be reached', async () => {
    // A rewind is offered from a screen the operator is already using. A
    // rejected promise here becomes an unhandled 500 on a button they pressed
    // to recover from something that had already gone wrong.
    const supervisor = makeSupervisor(() => {
      throw new Error('spawn claude ENOENT');
    });

    const result = await supervisor.rewind({ ...target, dryRun: true });

    expect(result.canRewind).toBe(false);
    expect(result.error).toContain('ENOENT');
  });
});

/* -------------------------------------------------------------------------- */
/* Out-of-band CLI messages                                                    */
/* -------------------------------------------------------------------------- */

describe('the transcript explains what the CLI was doing', () => {
  /** The system events the run recorded, in order. */
  const notes = (callbacks: { events: unknown[] }) =>
    callbacks.events.filter(
      (event): event is { kind: string; level: string; message: string; data?: unknown } =>
        (event as { kind?: string }).kind === 'system',
    );

  it('records an API retry rather than leaving the run looking hung', async () => {
    // This is the whole point of the lot: these messages used to reach
    // `default: return {}` and vanish, so a run that sat still for thirty
    // seconds looked like a bug in Metaclaude.
    const { query, control } = fakeQuery();
    const callbacks = makeCallbacks();
    const supervisor = makeSupervisor(query);

    const run = supervisor.execute(makeRequest(), callbacks);
    await vi.waitFor(() => expect(control.received.length).toBe(1));
    control.emit({
      type: 'system',
      subtype: 'api_retry',
      attempt: 2,
      max_retries: 5,
      retry_delay_ms: 3000,
      error_status: 529,
      uuid: 'u',
      session_id: 's',
    });
    control.finish();
    await run;

    const note = notes(callbacks).find((event) => event.message.includes('529'));
    expect(note).toBeTruthy();
    expect(note?.level).toBe('warn');
  });

  it('carries the structured payload, not only the sentence', async () => {
    // A rate limit's reset time is what the UI needs to render a countdown; a
    // prose-only note would force it to parse English back into a timestamp.
    const { query, control } = fakeQuery();
    const callbacks = makeCallbacks();
    const supervisor = makeSupervisor(query);

    const run = supervisor.execute(makeRequest(), callbacks);
    await vi.waitFor(() => expect(control.received.length).toBe(1));
    control.emit({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1_800_000_000 },
      uuid: 'u',
      session_id: 's',
    });
    control.finish();
    await run;

    const note = notes(callbacks).find((event) => event.level === 'error');
    expect((note?.data as { resetsAt?: number })?.resetsAt).toBe(1_800_000_000_000);
  });

  it('stays silent about the heartbeats', async () => {
    // `tool_progress` arrives every few seconds for the life of a tool call.
    // One row each would make a long run's transcript unreadable and grow the
    // database without bound.
    const { query, control } = fakeQuery();
    const callbacks = makeCallbacks();
    const supervisor = makeSupervisor(query);

    const run = supervisor.execute(makeRequest(), callbacks);
    await vi.waitFor(() => expect(control.received.length).toBe(1));
    for (let i = 0; i < 20; i += 1) {
      control.emit({
        type: 'tool_progress',
        tool_use_id: 't',
        tool_name: 'Bash',
        parent_tool_use_id: null,
        elapsed_time_seconds: i,
        uuid: `u${i}`,
        session_id: 's',
      });
    }
    control.finish();
    await run;

    expect(notes(callbacks)).toEqual([]);
  });

  it('ignores a message type invented after this build', async () => {
    // Forward compatibility: a newer CLI must not be able to put arbitrary text
    // into the transcript through a type nobody has reviewed.
    const { query, control } = fakeQuery();
    const callbacks = makeCallbacks();
    const supervisor = makeSupervisor(query);

    const run = supervisor.execute(makeRequest(), callbacks);
    await vi.waitFor(() => expect(control.received.length).toBe(1));
    control.emit({ type: 'something_invented_later', text: 'inject me', uuid: 'u', session_id: 's' });
    control.finish();
    await run;

    expect(notes(callbacks)).toEqual([]);
  });

  it('does not double-report a denied tool as a note as well', async () => {
    // `permission_denied` already has a handler that attaches the denial to the
    // tool call it belongs to. Narrating it too would say it twice, once
    // without the context that makes it useful.
    const { query, control } = fakeQuery();
    const callbacks = makeCallbacks();
    const supervisor = makeSupervisor(query);

    const run = supervisor.execute(makeRequest(), callbacks);
    await vi.waitFor(() => expect(control.received.length).toBe(1));
    control.emit({
      type: 'system',
      subtype: 'permission_denied',
      tool_name: 'Bash',
      message: 'not allowed',
      tool_use_id: 'nonexistent',
      uuid: 'u',
      session_id: 's',
    });
    control.finish();
    await run;

    expect(notes(callbacks)).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* What Claude itself offers                                                   */
/* -------------------------------------------------------------------------- */

describe('reading the CLI’s own catalogue', () => {
  const WORKSPACE = '/var/lib/metaclaude/workspaces/test';

  it('asks in the workspace, because the answer is per-directory', async () => {
    // Skills, subagents and MCP servers are discovered relative to `cwd`.
    // Asking from anywhere else answers a different question.
    const { query, control } = fakeQuery();
    const supervisor = makeSupervisor(query);

    await supervisor.catalogue(WORKSPACE);

    expect(control.opened[0]).toMatchObject({ cwd: WORKSPACE });
  });

  it('returns the models with their effort levels', async () => {
    // The web app had three model names and their prices hard-coded, written
    // when the page was built. Which models a subscription grants, and which
    // take an effort level, changes without a Metaclaude release.
    const { query, control } = fakeQuery();
    control.models_ = [
      {
        value: 'opus',
        displayName: 'Opus',
        description: 'Deepest reasoning',
        resolvedModel: 'claude-opus-5',
        supportsEffort: true,
        supportedEffortLevels: ['low', 'high'],
      },
    ];
    const supervisor = makeSupervisor(query);

    const catalogue = await supervisor.catalogue(WORKSPACE);

    expect(catalogue.models).toHaveLength(1);
    expect(catalogue.models[0]?.supportedEffortLevels).toEqual(['low', 'high']);
    expect(catalogue.models[0]?.resolvedModel).toBe('claude-opus-5');
  });

  it('reports MCP servers with their runtime status and error', async () => {
    // Metaclaude could configure an MCP server and never say whether it
    // actually connected — so a mistyped command looked like a server the
    // agent was ignoring.
    const { query, control } = fakeQuery();
    control.mcp_ = [
      { name: 'github', status: 'failed', error: 'spawn npx ENOENT', tools: [] },
      {
        name: 'fs',
        status: 'connected',
        serverInfo: { name: 'filesystem', version: '1.2.0' },
        tools: [{ name: 'read', description: 'Read a file', annotations: { readOnly: true } }],
      },
    ];
    const supervisor = makeSupervisor(query);

    const catalogue = await supervisor.catalogue(WORKSPACE);

    expect(catalogue.mcpServers[0]).toMatchObject({ name: 'github', status: 'failed' });
    expect(catalogue.mcpServers[0]?.error).toBe('spawn npx ENOENT');
    expect(catalogue.mcpServers[1]?.serverVersion).toBe('1.2.0');
    expect(catalogue.mcpServers[1]?.tools[0]?.readOnly).toBe(true);
  });

  it('keeps what it could read when one question fails', async () => {
    // An older CLI answers some of these and not others. Losing the whole
    // catalogue to one missing control method is the wrong trade.
    const { query, control } = fakeQuery();
    control.failCommands = true;
    const supervisor = makeSupervisor(query);

    const catalogue = await supervisor.catalogue(WORKSPACE);

    expect(catalogue.unavailable).toContain('commands');
    expect(catalogue.models.length).toBeGreaterThan(0);
  });

  it('distinguishes "the question failed" from "the answer was empty"', async () => {
    // An empty model list means something very different in each case, and
    // only one of them is worth telling the operator about.
    const { query, control } = fakeQuery();
    control.models_ = [];
    const supervisor = makeSupervisor(query);

    const catalogue = await supervisor.catalogue(WORKSPACE);

    expect(catalogue.models).toEqual([]);
    expect(catalogue.unavailable).not.toContain('models');
  });

  it('tears the probe session down like the rewind one does', async () => {
    const { query, control } = fakeQuery();
    const supervisor = makeSupervisor(query);

    await supervisor.catalogue(WORKSPACE);

    expect(control.torndown).toBe(true);
  });

  it('answers with an empty catalogue rather than throwing', async () => {
    // Reached from a page load. A rejection here is a broken screen, not a
    // missing panel.
    const supervisor = makeSupervisor(() => {
      throw new Error('spawn claude ENOENT');
    });

    const catalogue = await supervisor.catalogue(WORKSPACE);

    expect(catalogue.models).toEqual([]);
    expect(catalogue.unavailable).toContain('session');
  });

  it('stamps when it was read', async () => {
    const { query } = fakeQuery();
    const supervisor = makeSupervisor(query);

    const before = Date.now();
    const catalogue = await supervisor.catalogue(WORKSPACE);

    expect(catalogue.fetchedAt).toBeGreaterThanOrEqual(before);
  });
});

/* -------------------------------------------------------------------------- */
/* Waiting on a human                                                          */
/* -------------------------------------------------------------------------- */

describe('a run says when it is waiting for a person', () => {
  /**
   * `onWaitingChange` was declared on the callbacks, implemented by the kernel —
   * which flips the run and its session between `running` and
   * `waiting_approval` — and never called by anything.
   *
   * The broker sets `waiting_approval` when a prompt is raised, and nothing ever
   * set it back. So the first time a run asked permission it showed as waiting
   * for the rest of its life: the agent worked, the screen said it was blocked
   * on the operator, and the operator had already answered.
   */
  const prompt = (options: Record<string, unknown>, id = 'tool-1') =>
    (options.canUseTool as (n: string, i: unknown, o: unknown) => Promise<unknown>)(
      'Bash',
      { command: 'ls' },
      { toolUseID: id, signal: new AbortController().signal },
    );

  it('reports waiting while a prompt is outstanding, and not before', async () => {
    const { query, control } = fakeQuery();
    const broker = heldBroker();
    const callbacks = makeCallbacks();
    const supervisor = makeSupervisor(query, broker);

    const run = supervisor.execute(makeRequest(), callbacks);
    await vi.waitFor(() => expect(control.opened).toHaveLength(1));
    expect(callbacks.waiting).toEqual([]);

    const asked = prompt(control.opened[0] as Record<string, unknown>);
    await vi.waitFor(() => expect(broker.outstanding).toBe(1));
    expect(callbacks.waiting).toEqual([true]);

    broker.releaseAll();
    await asked;
    expect(callbacks.waiting).toEqual([true, false]);

    control.finish();
    await run;
  });

  it('does not clear the flag while another prompt is still outstanding', async () => {
    // Tool calls arrive in parallel. A naive true/false pair around each one
    // reports "no longer waiting" the moment the *first* is answered, while the
    // operator is still looking at the second.
    const { query, control } = fakeQuery();
    const broker = heldBroker();
    const callbacks = makeCallbacks();
    const supervisor = makeSupervisor(query, broker);

    const run = supervisor.execute(makeRequest(), callbacks);
    await vi.waitFor(() => expect(control.opened).toHaveLength(1));

    const first = prompt(control.opened[0] as Record<string, unknown>, 'tool-1');
    const second = prompt(control.opened[0] as Record<string, unknown>, 'tool-2');
    await vi.waitFor(() => expect(broker.outstanding).toBe(2));

    // Raised once, not twice.
    expect(callbacks.waiting).toEqual([true]);

    broker.releaseAll();
    await Promise.all([first, second]);
    expect(callbacks.waiting).toEqual([true, false]);

    control.finish();
    await run;
  });

  it('clears the flag even when the prompt is refused', async () => {
    // A denial, an abort or a broker that throws must not leave the run
    // permanently marked as waiting — that is the bug in a new costume.
    const { query, control } = fakeQuery();
    const callbacks = makeCallbacks();
    const supervisor = makeSupervisor(query, {
      request: () => Promise.reject(new Error('cancelled')),
    });

    const run = supervisor.execute(makeRequest(), callbacks);
    await vi.waitFor(() => expect(control.opened).toHaveLength(1));

    await expect(prompt(control.opened[0] as Record<string, unknown>)).rejects.toThrow();
    expect(callbacks.waiting).toEqual([true, false]);

    control.finish();
    await run;
  });
});
