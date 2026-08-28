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
import {
  AgentSupervisor,
  buildUserContent,
  type RunAttachment,
  type RunRequest,
  type SupervisorCallbacks,
} from './supervisor.js';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const workspace: Workspace = {
  id: 'ws_1',
  name: 'Test',
  slug: 'test',
  description: '',
  path: '/srv/metaclaude/workspaces/test',
  color: '#6366f1',
  icon: 'folder',
  archived: false,
  settings: {
    defaultModel: 'default',
    defaultEffort: null,
    defaultPermissionMode: 'default',
    language: 'auto',
    thinking: 'adaptive',
    thinkingBudgetTokens: null,
    maxTurns: 40,
    maxBudgetUsd: null,
    allowedTools: [],
    disallowedTools: [],
    additionalDirectories: [],
    systemPromptAppend: '',
    memoryEnabled: true,
    knowledgeEnabled: true,
    autoPolicyEnabled: false,
    reflexionEnabled: false,
    checkpointing: true,
    mirrorSessions: false,
    autoWorkBoard: false,
    enabledPlugins: {},
    advisorAuto: false,
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
      thinking: 'adaptive',
      thinkingBudgetTokens: null,
      agentName: null,
      ultracode: false,
      source: 'explicit',
    },
    resumeSessionId: null,
    systemPromptAppend: '',
    mcpServers: {},
    agents: {},
    marketplaces: {},
    triggeredBy: 'user',
    attachments: [],
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
  /** True once the supervisor's input iterable ended — the real end-of-session. */
  inputEnded: boolean;
  /** Catalogue answers. Trailing underscore: `models` is already the setModel log. */
  models_: Array<Record<string, unknown>>;
  commands_: Array<Record<string, unknown>>;
  agents_: Array<Record<string, unknown>>;
  mcp_: Array<Record<string, unknown>>;
  /** Make `supportedCommands` throw, the way an older CLI would. */
  failCommands: boolean;
  /** What the experimental usage method answers. */
  usageResponse: Record<string, unknown>;
  /** Make the usage method throw, the way a CLI without it would. */
  failUsage: boolean;
  /**
   * When true, `interrupt()` only records the call — it does not end the turn
   * with an error result. That is what a CLI which honours the stop by simply
   * wrapping up looks like, and it is the case the supervisor got wrong.
   */
  interruptEndsCleanly: boolean;
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
    inputEnded: false,
    models_: [{ value: 'sonnet', displayName: 'Sonnet', description: 'Balanced' }],
    commands_: [{ name: 'review', description: 'Review the diff', argumentHint: '[path]' }],
    agents_: [{ name: 'explorer', description: 'Reads widely' }],
    mcp_: [],
    failCommands: false,
    usageResponse: {
      subscription_type: 'max',
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 42, resets_at: '2026-08-26T15:00:00.000Z' },
        seven_day: { utilization: 61, resets_at: '2026-08-30T00:00:00.000Z' },
        seven_day_opus: null,
        model_scoped: [
          { display_name: 'Fable', utilization: 12, resets_at: '2026-08-30T00:00:00.000Z' },
        ],
        extra_usage: { is_enabled: true, monthly_limit: 50, used_credits: 3.5, utilization: 7 },
      },
      behaviors: {
        day: {
          request_count: 120,
          session_count: 6,
          behaviors: [{ key: 'subagent_heavy', pct: 34, count: 41 }],
          agents: [{ name: 'explorer', pct: 20 }],
          skills: [],
          plugins: [],
          mcp_servers: [{ name: 'github', pct: 9 }],
        },
        week: {
          request_count: 900,
          session_count: 40,
          behaviors: [],
          agents: [],
          skills: [],
          plugins: [],
          mcp_servers: [],
        },
      },
    },
    failUsage: false,
    interruptEndsCleanly: false,
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
  // Emits the turn's result — and deliberately does *not* end the generator.
  //
  // This used to set `done`, and that one line was the whole reason a run that
  // never completes in production completed in every test. `Query` is an
  // AsyncGenerator, and under streaming input the CLI does not close it when a
  // turn ends: it waits for the next user message. The stream ends when the
  // *input* ends. A fake that returns on `result` is a fake that answers a
  // question the real SDK is never asked, and it certified a supervisor that
  // hung forever on the happy path.
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
    // Drain whatever the supervisor gives us, so queued turns are observable —
    // and note when that input ends, because *that* is what ends the session.
    void (async () => {
      const prompt = params.prompt as AsyncIterable<unknown> | string;
      if (typeof prompt === 'string') {
        control.received.push(prompt);
        control.inputEnded = true;
        done = true;
        wake?.();
        return;
      }
      for await (const message of prompt) control.received.push(message);
      control.inputEnded = true;
      done = true;
      wake?.();
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
        if (control.interruptEndsCleanly) return undefined;
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
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => {
        if (control.failUsage) throw new Error('unsupported control request');
        return control.usageResponse;
      },
    });
  };

  return { query, control };
}

function makeSupervisor(
  query: unknown,
  broker?: { request: () => Promise<unknown> },
  extra: { delegate?: () => Promise<never>; board?: unknown } = {},
) {
  return new AgentSupervisor({
    broker: () => (broker ?? { request: async () => ({ behavior: 'allow' }) }) as never,
    allowBypassPermissions: false,
    claudeBinPath: null,
    runTimeoutMs: 60_000,
    env: {},
    directoryPolicy: { workspacesDir: '/srv/metaclaude/workspaces', dataDir: '/var/lib/metaclaude' },
    log: () => {},
    query: query as never,
    ...(extra.delegate ? { delegate: extra.delegate as never } : {}),
    ...(extra.board ? { board: extra.board as never } : {}),
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

  it('announces the message’s attachments on the opening transcript event', async () => {
    // The web renders the user's bubble from this event alone; an attachment
    // the event does not name is one the operator sent and can never see.
    const { query, control } = fakeQuery();
    const supervisor = makeSupervisor(query);
    const callbacks = makeCallbacks();

    const run = supervisor.execute(
      makeRequest({
        attachments: [
          {
            id: 'att_1',
            name: 'plan.png',
            path: 'attachments/abc-plan.png',
            mime: 'image/png',
            bytes: 123,
            absolutePath: '/nowhere/abc-plan.png',
          },
        ],
      }),
      callbacks,
    );
    await vi.waitFor(() => expect(control.received.length).toBe(1));
    control.finish();
    await run;

    expect(callbacks.events[0]).toMatchObject({
      kind: 'user_message',
      attachments: [
        {
          name: 'plan.png',
          path: 'attachments/abc-plan.png',
          bytes: 123,
          attachmentId: 'att_1',
          mime: 'image/png',
        },
      ],
    });
  });
});

describe('buildUserContent', () => {
  const attachment = (over: Partial<RunAttachment> = {}): RunAttachment => ({
    id: 'att_1',
    name: 'shot.png',
    path: 'attachments/abc-shot.png',
    mime: 'image/png',
    bytes: 10,
    absolutePath: '/ws/attachments/abc-shot.png',
    ...over,
  });

  it('stays a plain string when the message carries nothing', async () => {
    await expect(buildUserContent('hello', [])).resolves.toBe('hello');
  });

  it('inlines a small image as a block and names its path in the text', async () => {
    const content = await buildUserContent('look at this', [attachment()], async () =>
      Buffer.from('png-bytes'),
    );

    expect(Array.isArray(content)).toBe(true);
    const blocks = content as Exclude<typeof content, string>;
    expect(blocks[0]).toEqual({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/png',
        data: Buffer.from('png-bytes').toString('base64'),
      },
    });
    const tail = blocks.at(-1) as { type: string; text: string };
    expect(tail.type).toBe('text');
    expect(tail.text).toContain('look at this');
    expect(tail.text).toContain('attachments/abc-shot.png');
  });

  it('sends an oversized image by path only — the agent reads it from disk', async () => {
    const reads: string[] = [];
    const content = await buildUserContent(
      'big one',
      [attachment({ bytes: 50 * 1024 * 1024 })],
      async (path) => {
        reads.push(path);
        return Buffer.alloc(0);
      },
    );

    const blocks = content as Exclude<typeof content, string>;
    expect(reads).toHaveLength(0);
    expect(blocks).toHaveLength(1);
    expect((blocks[0] as { type: string }).type).toBe('text');
  });

  it('inlines a small PDF as a document block', async () => {
    const content = await buildUserContent(
      'read it',
      [attachment({ mime: 'application/pdf', name: 'doc.pdf', path: 'attachments/x-doc.pdf' })],
      async () => Buffer.from('%PDF'),
    );

    const blocks = content as Exclude<typeof content, string>;
    expect(blocks[0]).toMatchObject({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf' },
    });
  });

  it('marks a file that vanished from disk instead of failing the run', async () => {
    const content = await buildUserContent('gone', [attachment()], async () => {
      throw new Error('ENOENT');
    });

    const blocks = content as Exclude<typeof content, string>;
    expect(blocks).toHaveLength(1);
    expect((blocks[0] as { text: string }).text).toContain('missing on disk');
  });
});

describe('the served model is captured off the wire', () => {
  // The policy records what Metaclaude asked for; under Auto that can be
  // literally 'default', with the CLI choosing. The init message is the one
  // place the CLI names its choice, and it exists only on the wire.
  it('reads it from the init message and reports it in the outcome', async () => {
    const { query, control } = fakeQuery();
    const supervisor = makeSupervisor(query);

    const run = supervisor.execute(makeRequest(), makeCallbacks());
    await vi.waitFor(() => expect(control.received.length).toBe(1));
    control.emit({ type: 'system', subtype: 'init', session_id: 'sdk-session', model: 'claude-opus-5' });
    control.finish();

    const outcome = await run;
    expect(outcome.servedModel).toBe('claude-opus-5');
  });

  it('reports null when the CLI never said', async () => {
    const { query, control } = fakeQuery();
    const supervisor = makeSupervisor(query);

    const run = supervisor.execute(makeRequest(), makeCallbacks());
    await vi.waitFor(() => expect(control.received.length).toBe(1));
    control.finish();

    const outcome = await run;
    expect(outcome.servedModel).toBeNull();
  });
});

describe('a turn that produces a result ends the run', () => {
  /**
   * The bug this pins down shipped and reached a real deployment: the answer
   * arrived, the tools ran, the file was written — and the badge said
   * `Working` until the 45-minute timeout marked the run interrupted.
   *
   * `Query` is an AsyncGenerator. Under a *string* prompt the CLI answers and
   * exits, so `for await` ends on its own; under streaming input the session
   * stays open for the next user message. So the loop waited for the generator
   * while the generator waited for input, and nothing closed the input.
   *
   * Every test here passed anyway, because the fake ended its generator on
   * `finish()` — a double more helpful than the thing it doubles. It no longer
   * does, which is what makes this case meaningful.
   */
  it('resolves as soon as the result arrives, rather than waiting for the CLI to exit', async () => {
    const { query, control } = fakeQuery();
    const supervisor = makeSupervisor(query);

    const run = supervisor.execute(makeRequest(), makeCallbacks());
    await vi.waitFor(() => expect(control.received.length).toBe(1));

    control.finish();

    // Raced rather than awaited: an unfixed supervisor never settles this
    // promise, and a bare `await` would surface as a whole-file timeout naming
    // no case at all.
    const outcome = await Promise.race([
      run,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error('the run never ended after its result — its input stream was left open')),
          2_000,
        ),
      ),
    ]);

    expect(outcome.status).toBe('succeeded');
  });

  it('closes the input stream, so the CLI subprocess can exit', async () => {
    const { query, control } = fakeQuery();
    const supervisor = makeSupervisor(query);

    const run = supervisor.execute(makeRequest(), makeCallbacks());
    await vi.waitFor(() => expect(control.received.length).toBe(1));
    control.finish();
    await run;

    // The fake's drain loop only ends when the iterable ends, so this is the
    // input side actually being closed rather than a flag being set.
    expect(control.inputEnded).toBe(true);
  });

  it('refuses a follow-up once the turn is over', async () => {
    const { query, control } = fakeQuery();
    const supervisor = makeSupervisor(query);

    const run = supervisor.execute(makeRequest(), makeCallbacks());
    await vi.waitFor(() => expect(control.received.length).toBe(1));
    control.finish();
    await run;

    // Not a regression in steering: that happens during the turn. Afterwards
    // the run is finished, and saying so is what sends the operator's next
    // message to a new run resuming the same CLI session.
    await expect(supervisor.send('run_1', 'et maintenant ?')).resolves.toBe(false);
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
    workspacePath: '/srv/metaclaude/workspaces/test',
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
      cwd: '/srv/metaclaude/workspaces/test',
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
  const WORKSPACE = '/srv/metaclaude/workspaces/test';

  it('asks in the workspace, because the answer is per-directory', async () => {
    // Skills, subagents and MCP servers are discovered relative to `cwd`.
    // Asking from anywhere else answers a different question.
    const { query, control } = fakeQuery();
    const supervisor = makeSupervisor(query);

    await supervisor.catalogue(WORKSPACE);

    expect(control.opened[0]).toMatchObject({ cwd: WORKSPACE });
  });

  it('probes under the posture runs get, mounting what runs would mount', async () => {
    // The panel's promise is "what Claude offers *here*" — and here means in
    // a run. A probe that loaded servers runs never see, or missed the ones
    // they do, would answer a different question convincingly.
    const { query, control } = fakeQuery();
    const supervisor = makeSupervisor(query);

    await supervisor.catalogue(WORKSPACE, {
      mcpServers: { docs: { type: 'http', url: 'https://docs.example/mcp' } },
      agents: { reviewer: { description: 'Reviews changes', prompt: 'Review.' } },
    });

    expect(control.opened[0]).toMatchObject({
      cwd: WORKSPACE,
      strictMcpConfig: true,
      settingSources: ['project'],
      mcpServers: { docs: { type: 'http', url: 'https://docs.example/mcp' } },
      agents: { reviewer: { description: 'Reviews changes' } },
      // The same policy locks as buildOptions: a probe that read project
      // hooks would *run* them, on every dashboard load.
      managedSettings: { allowManagedHooksOnly: true, allowManagedMcpServersOnly: true },
    });
  });

  it('stays strict with nothing to mount, so the CLI cannot volunteer servers runs never see', async () => {
    const { query, control } = fakeQuery();
    const supervisor = makeSupervisor(query);

    await supervisor.catalogue(WORKSPACE);

    expect(control.opened[0]).toMatchObject({ strictMcpConfig: true, settingSources: ['project'] });
    const opened = control.opened[0] as { mcpServers?: unknown; agents?: unknown };
    expect(opened.mcpServers).toBeUndefined();
    expect(opened.agents).toBeUndefined();
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

describe('reading the subscription quota', () => {
  const WORKSPACE = '/srv/metaclaude/workspaces/test';

  it('normalises every window — session, weekly, and per-model buckets — into one list', async () => {
    const { query } = fakeQuery();
    const supervisor = makeSupervisor(query);

    const usage = await supervisor.usage(WORKSPACE);

    expect(usage.subscriptionType).toBe('max');
    expect(usage.windows).toEqual([
      {
        key: 'five_hour',
        label: 'Session (5 h)',
        utilization: 42,
        resetsAt: Date.parse('2026-08-26T15:00:00.000Z'),
      },
      {
        key: 'seven_day',
        label: 'Week — all models',
        utilization: 61,
        resetsAt: Date.parse('2026-08-30T00:00:00.000Z'),
      },
      {
        key: 'model:Fable',
        label: 'Fable',
        utilization: 12,
        resetsAt: Date.parse('2026-08-30T00:00:00.000Z'),
      },
    ]);
    expect(usage.extraUsage).toEqual({
      isEnabled: true,
      monthlyLimit: 50,
      usedCredits: 3.5,
      utilization: 7,
    });
    expect(usage.behaviors?.day.behaviors[0]).toEqual({
      key: 'subagent_heavy',
      pct: 34,
      count: 41,
    });
    expect(usage.behaviors?.day.mcpServers[0]).toEqual({ name: 'github', pct: 9 });
  });

  it('leaves a null window out rather than rendering an empty row', async () => {
    // `seven_day_opus: null` in the fixture — the server said "no such
    // bucket", which is not a bucket at 0%. Asserted against the windows that
    // *are* there: an empty list would satisfy a bare not-contains while
    // proving only that everything broke.
    const { query } = fakeQuery();
    const supervisor = makeSupervisor(query);

    const usage = await supervisor.usage(WORKSPACE);
    const keys = usage.windows.map((window) => window.key);
    expect(keys).toContain('five_hour');
    expect(keys).not.toContain('seven_day_opus');
  });

  it('answers with what it has when the CLI lacks the usage method', async () => {
    // The method is experimental and named as such; a CLI without it is a
    // missing panel, not a broken screen.
    const { query, control } = fakeQuery();
    control.failUsage = true;
    const supervisor = makeSupervisor(query);

    const usage = await supervisor.usage(WORKSPACE);

    expect(usage.windows).toEqual([]);
    expect(usage.unavailable).toContain('usage');
  });

  it('reports rate limits as unavailable when the plan has none', async () => {
    const { query, control } = fakeQuery();
    control.usageResponse = {
      subscription_type: null,
      rate_limits_available: false,
      rate_limits: null,
      behaviors: null,
    };
    const supervisor = makeSupervisor(query);

    const usage = await supervisor.usage(WORKSPACE);

    expect(usage.windows).toEqual([]);
    expect(usage.subscriptionType).toBeNull();
    expect(usage.unavailable).toContain('rate_limits');
  });

  it('tears the probe session down', async () => {
    const { query, control } = fakeQuery();
    const supervisor = makeSupervisor(query);

    await supervisor.usage(WORKSPACE);
    expect(control.torndown).toBe(true);
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

describe('a run the operator stopped is never recorded as a success', () => {
  it('reports interrupted even when the CLI ends its stream cleanly', async () => {
    // `status` starts as 'succeeded' and only moves when a result arrives
    // carrying an error, or when the iterator throws. A CLI that honours
    // `interrupt()` by simply ending the turn — no error, no throw — therefore
    // left the run recorded as a success.
    //
    // That is not only a wrong badge in the UI. `computeReward` feeds the
    // bandit from the run's status, so stopping a run yourself taught the
    // learner that the model and effort it had chosen were good ones.
    const { query, control } = fakeQuery();
    // The CLI wraps up quietly instead of erroring — the well-behaved case.
    control.interruptEndsCleanly = true;
    const supervisor = makeSupervisor(query);

    const run = supervisor.execute(makeRequest(), makeCallbacks());
    await vi.waitFor(() => expect(control.received.length).toBe(1));

    // Ask for the stop, then have the CLI finish *successfully* — which is
    // exactly what a well-behaved one does when told to wrap up.
    const stopping = supervisor.interrupt('run_1');
    control.finish({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'stopped cleanly',
      duration_ms: 1,
      num_turns: 1,
      total_cost_usd: 0,
      usage: {},
      session_id: 'sdk-session',
    });
    await stopping;

    const outcome = await run;
    expect(outcome.status).toBe('interrupted');
  });

  it('still reports a genuine success as a success', () => {
    // The other half: this must not turn every run into an interruption.
    const { query, control } = fakeQuery();
    const supervisor = makeSupervisor(query);

    const run = supervisor.execute(makeRequest(), makeCallbacks());
    return vi
      .waitFor(() => expect(control.received.length).toBe(1))
      .then(async () => {
        control.finish();
        expect((await run).status).toBe('succeeded');
      });
  });
});

/* -------------------------------------------------------------------------- */
/* The options handed to the SDK                                               */
/* -------------------------------------------------------------------------- */

/**
 * `buildOptions` is where every SDK-level safety setting is decided, and two
 * comments in the source claimed it was covered while `grep buildOptions` over
 * the tests returned nothing. It *ran* on the execute path, but the only
 * assertions on `control.opened[0]` were about `resume`, `cwd` and
 * `enableFileCheckpointing` — so `managedSettings`, `settingSources` and
 * `maxBudgetUsd` were executed and never checked, and the `additionalDirectories`
 * branch was not even entered.
 */
describe('buildOptions', () => {
  it('pins the three managed-settings locks a cloned repository could otherwise defeat', () => {
    // Loading `settingSources: ['project']` means a cloned repo's
    // `.claude/settings.json` is read. Left alone it could pre-approve tools,
    // register hooks or add MCP servers, silently defeating the approval flow.
    const supervisor = makeSupervisor(fakeQuery().query);
    const options = supervisor.buildOptions(makeRequest());

    expect(options.managedSettings).toEqual({
      allowManagedPermissionRulesOnly: true,
      allowManagedHooksOnly: true,
      allowManagedMcpServersOnly: true,
    });
  });

  it('reads project settings and nothing above them', () => {
    // `project` is required for CLAUDE.md and `.claude/skills` discovery, both
    // of which this product writes. `user` and `local` would read the
    // container's own home directory, which is not the operator's.
    const supervisor = makeSupervisor(fakeQuery().query);
    expect(supervisor.buildOptions(makeRequest()).settingSources).toEqual(['project']);
  });

  it('forwards a budget ceiling and omits it when there is none', () => {
    const supervisor = makeSupervisor(fakeQuery().query);
    expect(supervisor.buildOptions(makeRequest()).maxBudgetUsd).toBeUndefined();

    const capped = makeRequest();
    capped.workspace = {
      ...capped.workspace,
      settings: { ...capped.workspace.settings, maxBudgetUsd: 2.5 },
    };
    expect(supervisor.buildOptions(capped).maxBudgetUsd).toBe(2.5);
  });

  it('omits empty tool lists rather than sending them', () => {
    // An empty `allowedTools` is not "allow nothing" to the SDK, and sending
    // one would be a different policy from sending none.
    const supervisor = makeSupervisor(fakeQuery().query);
    const bare = supervisor.buildOptions(makeRequest());
    expect(bare.allowedTools).toBeUndefined();
    expect(bare.disallowedTools).toBeUndefined();

    const restricted = makeRequest();
    restricted.workspace = {
      ...restricted.workspace,
      settings: {
        ...restricted.workspace.settings,
        allowedTools: ['Read'],
        disallowedTools: ['Bash'],
      },
    };
    const options = supervisor.buildOptions(restricted);
    expect(options.allowedTools).toEqual(['Read']);
    expect(options.disallowedTools).toEqual(['Bash']);
  });

  it('honours the thinking mode, both branches of it', () => {
    // Neither branch had ever been entered: every fixture said `thinking: 'off'`,
    // which is not a ThinkingMode member, so both fell through to the adaptive
    // `else` and the two real modes were dead to the suite.
    const supervisor = makeSupervisor(fakeQuery().query);

    const off = makeRequest();
    off.policy = { ...off.policy, thinking: 'disabled' };
    expect(supervisor.buildOptions(off).thinking).toEqual({ type: 'disabled' });

    const on = makeRequest();
    on.policy = { ...on.policy, thinking: 'enabled', thinkingBudgetTokens: 8000 };
    expect(supervisor.buildOptions(on).thinking).toEqual({ type: 'enabled', budgetTokens: 8000 });

    const adaptive = makeRequest();
    adaptive.policy = { ...adaptive.policy, thinking: 'adaptive' };
    expect(supervisor.buildOptions(adaptive).thinking).toEqual({ type: 'adaptive' });
  });

  it('re-checks additional directories here, not only where they are saved', () => {
    // The comment in the source says this is deliberate: this is the call that
    // actually widens the agent's filesystem scope, so a row written before the
    // rule existed must not slip through. The branch was never entered — the
    // fixture's list is empty.
    const supervisor = makeSupervisor(fakeQuery().query);
    const widened = makeRequest();
    widened.workspace = {
      ...widened.workspace,
      settings: {
        ...widened.workspace.settings,
        additionalDirectories: ['/etc', widened.workspace.path],
      },
    };

    const options = supervisor.buildOptions(widened);
    expect(options.additionalDirectories).not.toContain('/etc');
  });

  it('downgrades a stored bypass mode when the deployment forbids it', () => {
    // The routes refuse the mode at every write, but a workspace default or an
    // automation policy persisted *while the flag was on* reaches the supervisor
    // unchallenged after it is turned off. This is the only thing that catches
    // it, and it is the reason `canUseTool` must still be installed.
    const supervisor = makeSupervisor(fakeQuery().query);
    const reckless = makeRequest();
    reckless.policy = { ...reckless.policy, permissionMode: 'bypassPermissions' };

    const options = supervisor.buildOptions(reckless);
    expect(options.permissionMode).toBe('default');
  });
});

describe('buildOptions — ultracode', () => {
  it('passes the setting to the CLI when the policy asks for it', () => {
    const supervisor = makeSupervisor(fakeQuery().query);
    const request = makeRequest();
    request.policy = { ...request.policy, ultracode: true };

    expect(supervisor.buildOptions(request).settings).toEqual({ ultracode: true });
  });

  it('sends no settings payload at all otherwise', () => {
    // Absence, not `{ ultracode: false }`: an explicit false would still be a
    // settings payload for the CLI to merge, and the pre-ultracode behaviour
    // must stay byte-identical for every run that never asked.
    const supervisor = makeSupervisor(fakeQuery().query);
    expect(supervisor.buildOptions(makeRequest()).settings).toBeUndefined();
  });
});

describe('buildOptions — mirroring sessions to claude.ai', () => {
  /** A fresh workspace replaced whole — the fixture's is shared across tests. */
  const withMirror = (request: ReturnType<typeof makeRequest>) => {
    request.workspace = {
      ...request.workspace,
      settings: { ...request.workspace.settings, mirrorSessions: true },
    };
    return request;
  };

  it('asks the CLI to upload sessions when the workspace opted in', () => {
    const supervisor = makeSupervisor(fakeQuery().query);

    expect(supervisor.buildOptions(withMirror(makeRequest())).settings).toEqual({
      autoUploadSessions: true,
    });
  });

  it('stays absent when off, and composes with ultracode when both are on', () => {
    // The same absence rule as ultracode: off means no key at all, and the
    // two share the one flag-tier payload rather than clobbering each other.
    const supervisor = makeSupervisor(fakeQuery().query);
    expect(supervisor.buildOptions(makeRequest()).settings).toBeUndefined();

    const both = withMirror(makeRequest());
    both.policy = { ...both.policy, ultracode: true };
    expect(supervisor.buildOptions(both).settings).toEqual({
      ultracode: true,
      autoUploadSessions: true,
    });
  });
});

describe('buildOptions — the delegation tool', () => {
  const delegate = async (): Promise<never> => {
    throw new Error('not called in these tests');
  };

  it('offers the metaclaude server when delegation is wired', () => {
    const supervisor = makeSupervisor(fakeQuery().query, undefined, { delegate });
    const options = supervisor.buildOptions(makeRequest());

    expect(Object.keys(options.mcpServers ?? {})).toContain('metaclaude');
  });

  it('withholds it from a run that is itself a delegation — depth is one', () => {
    // The kernel refuses chained delegation too; withholding the tool means
    // the model never sees an affordance it would only be refused on.
    const supervisor = makeSupervisor(fakeQuery().query, undefined, { delegate });
    const options = supervisor.buildOptions(makeRequest({ triggeredBy: 'delegation' }));

    expect(Object.keys(options.mcpServers ?? {})).not.toContain('metaclaude');
  });

  it('offers nothing when delegation is not wired at all', () => {
    const supervisor = makeSupervisor(fakeQuery().query);
    const options = supervisor.buildOptions(makeRequest());

    expect(Object.keys(options.mcpServers ?? {})).not.toContain('metaclaude');
  });

  it('keeps the configured MCP servers beside it', () => {
    const supervisor = makeSupervisor(fakeQuery().query, undefined, { delegate });
    const options = supervisor.buildOptions(
      makeRequest({ mcpServers: { github: { command: 'npx' } } }),
    );

    expect(Object.keys(options.mcpServers ?? {}).sort()).toEqual(['github', 'metaclaude']);
  });
});

describe('buildOptions — the board tools', () => {
  // Never called while options are merely built; mounting is what is under test.
  const board = {};

  it('mounts metaclaude_board when the board is wired', () => {
    const supervisor = makeSupervisor(fakeQuery().query, undefined, { board });
    const options = supervisor.buildOptions(makeRequest());

    expect(Object.keys(options.mcpServers ?? {})).toContain('metaclaude_board');
  });

  it('mounts it for delegated runs too — the board is how delegated work reports', () => {
    // Unlike `delegate`, which enforces depth one by absence, the board has no
    // depth rule: a delegated run updating the cards it works is the point.
    const supervisor = makeSupervisor(fakeQuery().query, undefined, { board });
    const options = supervisor.buildOptions(makeRequest({ triggeredBy: 'delegation' }));

    expect(Object.keys(options.mcpServers ?? {})).toContain('metaclaude_board');
  });

  it('offers nothing when the board is not wired', () => {
    const supervisor = makeSupervisor(fakeQuery().query);
    const options = supervisor.buildOptions(makeRequest());

    expect(Object.keys(options.mcpServers ?? {})).not.toContain('metaclaude_board');
  });

  it('cannot be stripped by the tools picker', () => {
    // Kernel machinery, like the delegation server: merged after the exclusion
    // filter, so a composer exclusion silently does nothing.
    const supervisor = makeSupervisor(fakeQuery().query, undefined, { board });
    const request = makeRequest();
    request.policy = {
      ...request.policy,
      toolControls: { requiredSkills: [], excludedMcpServers: ['metaclaude_board'], preferredMcpServers: [] },
    };

    expect(Object.keys(supervisor.buildOptions(request).mcpServers ?? {})).toContain(
      'metaclaude_board',
    );
  });
});

describe('buildOptions — tool controls', () => {
  const withControls = (
    toolControls: NonNullable<RunRequest['policy']['toolControls']>,
    over: Partial<RunRequest> = {},
  ): RunRequest => {
    const request = makeRequest(over);
    request.policy = { ...request.policy, toolControls };
    return request;
  };

  it('narrows the loaded skills to exactly the required ones, and says so in the prompt', () => {
    const supervisor = makeSupervisor(fakeQuery().query);
    const options = supervisor.buildOptions(
      withControls({ requiredSkills: ['deploy', 'review'], excludedMcpServers: [], preferredMcpServers: [] }),
    );

    expect(options.skills).toEqual(['deploy', 'review']);
    const prompt = options.systemPrompt as { append?: string };
    expect(prompt.append).toContain('deploy');
    expect(prompt.append).toContain('review');
  });

  it('loads every skill when nothing is required', () => {
    const supervisor = makeSupervisor(fakeQuery().query);
    expect(supervisor.buildOptions(makeRequest()).skills).toBe('all');
  });

  it('does not mount an excluded MCP server at all', () => {
    // Absence is the honest hard lever: a server that is not mounted cannot
    // be called, whatever the model decides.
    const supervisor = makeSupervisor(fakeQuery().query);
    const options = supervisor.buildOptions(
      withControls(
        { requiredSkills: [], excludedMcpServers: ['docs'], preferredMcpServers: [] },
        { mcpServers: { docs: { type: 'http', url: 'https://x' }, github: { type: 'http', url: 'https://y' } } },
      ),
    );

    expect(Object.keys(options.mcpServers ?? {})).toEqual(['github']);
  });

  it('cannot strip the internal delegation server', () => {
    // The metaclaude server is merged after the exclusion filter on purpose:
    // it is kernel machinery with its own depth rule, not a workspace server.
    const delegate = async (): Promise<never> => {
      throw new Error('not called');
    };
    const supervisor = makeSupervisor(fakeQuery().query, undefined, { delegate });
    const options = supervisor.buildOptions(
      withControls({ requiredSkills: [], excludedMcpServers: ['metaclaude'], preferredMcpServers: [] }),
    );

    expect(Object.keys(options.mcpServers ?? {})).toContain('metaclaude');
  });

  it('keeps a preferred server mounted and writes the preference into the prompt', () => {
    // Availability can force absence; only words can ask for use.
    const supervisor = makeSupervisor(fakeQuery().query);
    const options = supervisor.buildOptions(
      withControls(
        { requiredSkills: [], excludedMcpServers: [], preferredMcpServers: ['github'] },
        {
          mcpServers: { github: { type: 'http', url: 'https://y' } },
          systemPromptAppend: 'existing context',
        },
      ),
    );

    expect(Object.keys(options.mcpServers ?? {})).toContain('github');
    const prompt = options.systemPrompt as { append?: string };
    expect(prompt.append).toContain('existing context');
    expect(prompt.append).toContain('github');
  });
});

describe('buildOptions — marketplace plugins', () => {
  const marketplaces = { tools: { source: { source: 'github' as const, repo: 'a/b' } } };

  const withPlugins = (
    enabledPlugins: Record<string, boolean>,
    requestMarketplaces = marketplaces,
  ): RunRequest =>
    makeRequest({
      workspace: { ...workspace, settings: { ...workspace.settings, enabledPlugins } },
      marketplaces: requestMarketplaces,
    });

  it('hands sources and enablement to the CLI, with headless sync install switched on', () => {
    const supervisor = makeSupervisor(fakeQuery().query);
    const options = supervisor.buildOptions(
      withPlugins({ 'formatter@tools': true, 'linter@tools': false }),
    );

    // The flag tier — the same channel as ultracode — so a cloned repo's own
    // settings.json cannot smuggle sources past the owner's list. An entry
    // switched off is omitted rather than sent as false: absence is the
    // neutral statement, false is an instruction to override lower tiers.
    expect(options.settings).toEqual({
      extraKnownMarketplaces: marketplaces,
      enabledPlugins: { 'formatter@tools': true },
    });
    expect((options.env as Record<string, string>).CLAUDE_CODE_SYNC_PLUGIN_INSTALL).toBe('1');
  });

  it('drops a plugin whose marketplace is not among the known sources', () => {
    // Disabling or removing a marketplace must sever its plugins, not leave
    // enabledPlugins naming a source the CLI cannot resolve.
    const supervisor = makeSupervisor(fakeQuery().query);
    const options = supervisor.buildOptions(withPlugins({ 'formatter@gone': true }));

    expect(options.settings).toBeUndefined();
    expect((options.env as Record<string, string>).CLAUDE_CODE_SYNC_PLUGIN_INSTALL).toBeUndefined();
  });

  it('sends nothing when no plugin is enabled, keeping the run byte-identical', () => {
    const supervisor = makeSupervisor(fakeQuery().query);
    const options = supervisor.buildOptions(withPlugins({}));

    expect(options.settings).toBeUndefined();
    expect((options.env as Record<string, string>).CLAUDE_CODE_SYNC_PLUGIN_INSTALL).toBeUndefined();
  });

  it('composes with ultracode in one settings payload', () => {
    const supervisor = makeSupervisor(fakeQuery().query);
    const request = withPlugins({ 'formatter@tools': true });
    request.policy = { ...request.policy, ultracode: true };

    expect(supervisor.buildOptions(request).settings).toEqual({
      ultracode: true,
      extraKnownMarketplaces: marketplaces,
      enabledPlugins: { 'formatter@tools': true },
    });
  });
});
