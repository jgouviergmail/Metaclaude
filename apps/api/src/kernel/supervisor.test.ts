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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workspace } from '@metaclaude/shared';
import { WorkspaceSettings } from '@metaclaude/shared';
import { boardToolNames } from './board-tools.js';
import { advisorToolNames } from './advisor-tools.js';
import {
  AgentSupervisor,
  buildContextPreamble,
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
  // Derived from the schema, never written out: the hand-written version listed
  // all twenty-one fields and had to be edited every time one was added, which
  // is the fixture trap CLAUDE.md names — a fixture written from memory fails
  // as a broken component rather than as a missing field. Only the three values
  // that differ from the defaults are named, and they are the point of the
  // fixture: a turn ceiling to exercise, and the two learning passes off so no
  // test accidentally depends on them.
  settings: WorkspaceSettings.parse({
    maxTurns: 40,
    autoPolicyEnabled: false,
    reflexionEnabled: false,
  }),
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
    contextPreamble: '',
    mcpServers: {},
    agents: {},
    marketplaces: {},
    triggeredBy: 'user',
    attachments: [],
    abortSignal: new AbortController().signal,
    ...overrides,
  };
}

/** A request whose workspace carries `patch` on top of the fixture's settings. */
function withSettings(patch: Partial<Workspace['settings']>): RunRequest {
  const request = makeRequest();
  request.workspace = {
    ...request.workspace,
    settings: { ...request.workspace.settings, ...patch },
  };
  return request;
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
  /** What the opening frame lists as available. MCP names included. */
  tools_: string[];
  /** What the opening frame says is serving. `undefined` omits the field. */
  model_: string | undefined;
  /** What `getContextUsage` reports the session's skills to be. */
  skillFrontmatter_: Array<{ name: string; source: string; tokens: number }>;
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
    /** What the opening frame says this CLI offers. MCP names included. */
    tools_: ['Bash', 'Read', 'Skill', 'ToolSearch', 'mcp__docs__search'],
    model_: 'claude-opus-5',
    skillFrontmatter_: [
      { name: 'dataviz', source: 'built-in', tokens: 362 },
      { name: 'code-review', source: 'built-in', tokens: 202 },
      { name: 'house-style', source: 'projectSettings', tokens: 4 },
    ],
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
    /*
     * The opening frame, when the real CLI sends it: with the first user
     * message, and not before.
     *
     * Measured on 2.1.267 — twenty seconds of listening with no prompt,
     * `reinitialize()` and `initializationResult()` all produced nothing; one
     * prompt produced `system/init` at 817 ms. An earlier version of this fake
     * emitted it on open, under a comment claiming that is what the CLI does,
     * and a feature built on that read the tool list off a probe that sends no
     * prompt. It passed every test and answered nothing in production. This
     * is the test-double trap with the sign reversed: emitting what the real
     * thing emits *later* proves a reading order the real thing never offers.
     */
    let initSent = false;
    const sendInit = () => {
      if (initSent) return;
      initSent = true;
      control.emit({
        type: 'system',
        subtype: 'init',
        session_id: 'sdk-session',
        tools: control.tools_,
        ...(control.model_ === undefined ? {} : { model: control.model_ }),
      });
    };
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
        sendInit();
        control.received.push(prompt);
        control.inputEnded = true;
        done = true;
        wake?.();
        return;
      }
      for await (const message of prompt) {
        sendInit();
        control.received.push(message);
      }
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
      getContextUsage: async () => ({
        totalTokens: 1234,
        maxTokens: 200_000,
        categories: [],
        rawMaxTokens: 200_000,
        percentage: 0.6,
        gridRows: [],
        // The frontmatter is where the CLI names its own skills and says what
        // each costs — the only place it does, and what the CLI-skills screen
        // is built on.
        skills: {
          totalSkills: control.skillFrontmatter_.length,
          includedSkills: control.skillFrontmatter_.length,
          tokens: control.skillFrontmatter_.reduce((sum, row) => sum + row.tokens, 0),
          skillFrontmatter: control.skillFrontmatter_,
        },
      }),
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
  extra: {
    delegation?: unknown;
    board?: unknown;
    advisor?: unknown;
    memory?: unknown;
    sessions?: unknown;
    steward?: unknown;
    runTimeoutMs?: number;
    idleTimeoutMs?: number;
    disabledCliTools?: readonly string[];
    cliSkills?: { kind: 'floor' } | { kind: 'overrides'; overrides: Record<string, 'on' | 'off'> };
    onCliTools?: (report: { tools: readonly string[]; forbidden: readonly string[] }) => void;
  } = {},
) {
  return new AgentSupervisor({
    broker: () => (broker ?? { request: async () => ({ behavior: 'allow' }) }) as never,
    allowBypassPermissions: false,
    claudeBinPath: null,
    runTimeoutMs: () => extra.runTimeoutMs ?? 60_000,
    idleTimeoutMs: () => extra.idleTimeoutMs ?? 0,
    env: {},
    directoryPolicy: { workspacesDir: '/srv/metaclaude/workspaces', dataDir: '/var/lib/metaclaude' },
    log: () => {},
    query: query as never,
    ...(extra.delegation ? { delegation: extra.delegation as never } : {}),
    ...(extra.board ? { board: extra.board as never } : {}),
    ...(extra.advisor ? { advisor: extra.advisor as never } : {}),
    ...(extra.memory ? { memory: extra.memory as never } : {}),
    ...(extra.sessions ? { sessions: extra.sessions as never } : {}),
    ...(extra.steward ? { steward: extra.steward as never } : {}),
    ...(extra.disabledCliTools
      ? { disabledCliTools: () => extra.disabledCliTools as readonly string[] }
      : {}),
    ...(extra.cliSkills ? { cliSkills: () => extra.cliSkills as never } : {}),
    ...(extra.onCliTools ? { onCliTools: extra.onCliTools } : {}),
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

  /**
   * The CLI's tool list, from the only place it exists.
   *
   * The `system/init` frame is the one message that names the tools, and the
   * CLI emits it only with the first user message — measured: a probe that
   * sends none listens for ever. So this is not read by a probe on a settings
   * screen; it is read here, on every run, where it costs nothing, and handed
   * to whoever keeps it together with what *this* run had refused, because the
   * frame lists the tools after the deny list took effect.
   */
  it('reports the tools the opening frame lists, with what the run refused', async () => {
    const reports: Array<{ tools: readonly string[]; forbidden: readonly string[] }> = [];
    const { query, control } = fakeQuery();
    control.tools_ = ['Bash', 'Read', 'mcp__docs__search'];
    const supervisor = makeSupervisor(query, undefined, {
      onCliTools: (report) => reports.push(report),
      disabledCliTools: ['Artifact'],
    });

    const run = supervisor.execute(withSettings({ disallowedTools: ['WebFetch'] }), makeCallbacks());
    await vi.waitFor(() => expect(control.received.length).toBe(1));
    control.finish();
    await run;

    expect(reports).toEqual([
      { tools: ['Bash', 'Read', 'mcp__docs__search'], forbidden: ['WebFetch', 'Artifact'] },
    ]);
  });

  it('reports null when the opening frame carries no model', async () => {
    // Not "no init frame": the CLI always sends one — measured, and the fake
    // now does too. What this guards is the field being absent from it, which
    // is what an older CLI would do and what the `?? null` in `handleSystem`
    // is actually for.
    const { query, control } = fakeQuery();
    control.model_ = undefined;
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
   * `Working` until a ceiling marked the run interrupted.
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

/**
 * Where a run can be rewound to.
 *
 * The anchor is the uuid of the user message that opened the turn, because
 * that is what `Query.rewindFiles(userMessageId)` takes. It used to be read
 * off a replay acknowledgement the CLI was expected to send back — and Claude
 * Code 2.1.218 sends no `type: 'user'` message at all in streaming-input mode,
 * measured over a real run. So `rewindPoint` was null for every run ever
 * recorded and the Rewind button, gated on that field, could never appear.
 *
 * These tests passed throughout, because the fake `query` here emitted the
 * acknowledgement the real CLI does not. That is the trap they now exist to
 * stop: the first case below asserts the anchor with the CLI saying *nothing*,
 * which is the only shape that could have failed against the defect.
 */
describe('a run records where it can be rewound to', () => {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  const replay = (uuid: string, text: string) => ({
    type: 'user',
    uuid,
    isReplay: true,
    session_id: 'sdk-session',
    parent_tool_use_id: null,
    message: { role: 'user', content: text },
  });

  it('anchors the run even when the CLI says nothing at all', async () => {
    // The case that matters, and the one nothing covered: the anchor is the
    // uuid we put on the message, so it exists before the CLI has spoken and
    // survives a CLI that never mentions it.
    const { query, control } = fakeQuery();
    const supervisor = makeSupervisor(query);

    const run = supervisor.execute(makeRequest(), makeCallbacks());
    await vi.waitFor(() => expect(control.received.length).toBe(1));
    control.finish();

    const point = (await run).rewindPoint;
    expect(point).not.toBeNull();
    expect(point).toMatch(UUID);
  });

  it('anchors on the very uuid it handed the CLI', async () => {
    // Not merely "some uuid": `rewindFiles` is addressed with this string, so
    // an anchor that does not match what the CLI was given restores nothing.
    const { query, control } = fakeQuery();
    const supervisor = makeSupervisor(query);

    const run = supervisor.execute(makeRequest(), makeCallbacks());
    await vi.waitFor(() => expect(control.received.length).toBe(1));
    control.finish();

    const sent = control.received[0] as { uuid?: string };
    expect(sent.uuid).toMatch(UUID);
    expect((await run).rewindPoint).toBe(sent.uuid);
  });

  it('gives two runs two different anchors', async () => {
    // A constant would restore the wrong run's files, and a single test of one
    // run cannot tell a fresh uuid from a hard-coded one.
    const points: (string | null)[] = [];
    for (let i = 0; i < 2; i += 1) {
      const { query, control } = fakeQuery();
      const supervisor = makeSupervisor(query);
      const run = supervisor.execute(makeRequest(), makeCallbacks());
      await vi.waitFor(() => expect(control.received.length).toBe(1));
      control.finish();
      points.push((await run).rewindPoint);
    }
    expect(points[0]).not.toBe(points[1]);
  });

  it('keeps the opening anchor when the run is steered', async () => {
    // A run is steerable: the operator can type a follow-up into it. Undoing
    // "the run" means undoing all of it, so a later turn must not move the
    // anchor forward and quietly shrink what a rewind restores.
    const { query, control } = fakeQuery();
    const supervisor = makeSupervisor(query);

    const run = supervisor.execute(makeRequest(), makeCallbacks());
    await vi.waitFor(() => expect(control.received.length).toBe(1));
    const opening = (control.received[0] as { uuid?: string }).uuid;

    await supervisor.send('run_1', 'and also this');
    await vi.waitFor(() => expect(control.received.length).toBe(2));
    const followUp = (control.received[1] as { uuid?: string }).uuid;
    control.finish();

    expect(followUp).not.toBe(opening);
    expect((await run).rewindPoint).toBe(opening);
  });

  it('lets no acknowledgement overwrite the anchor it already has', async () => {
    // The fallback path stays for a CLI that does send one, but it must not
    // win: the uuid we assigned is the one the CLI accepted as a target.
    const { query, control } = fakeQuery();
    const supervisor = makeSupervisor(query);

    const run = supervisor.execute(makeRequest(), makeCallbacks());
    await vi.waitFor(() => expect(control.received.length).toBe(1));
    const opening = (control.received[0] as { uuid?: string }).uuid;
    control.emit(replay('11111111-1111-4111-8111-111111111111', 'first turn'));
    control.finish();

    expect((await run).rewindPoint).toBe(opening);
  });

  it('offers no anchor when checkpointing is off for the workspace', async () => {
    // `rewindFiles` restores from checkpoints the CLI only writes when
    // `enableFileCheckpointing` was set. Anchoring anyway would put a button
    // on every run and have it fail at the press — `planRewind` says
    // "checkpointing was off for this workspace" so the operator knows what to
    // change, and that sentence has to stay reachable.
    const { query, control } = fakeQuery();
    const supervisor = makeSupervisor(query);

    const request = makeRequest();
    request.workspace = {
      ...request.workspace,
      settings: { ...request.workspace.settings, checkpointing: false },
    } as Workspace;

    const run = supervisor.execute(request, makeCallbacks());
    await vi.waitFor(() => expect(control.received.length).toBe(1));
    control.finish();

    expect((await run).rewindPoint).toBeNull();
  });

  it('never anchors on a tool result', async () => {
    // Tool results arrive as `type: 'user'` too. Treating one as the anchor
    // would rewind to the middle of the run — which the opening uuid already
    // prevents, so this pins the fallback's own guard rather than the outcome.
    const { query, control } = fakeQuery();
    const supervisor = makeSupervisor(query);

    const run = supervisor.execute(makeRequest(), makeCallbacks());
    await vi.waitFor(() => expect(control.received.length).toBe(1));
    const opening = (control.received[0] as { uuid?: string }).uuid;
    control.emit({
      type: 'user',
      uuid: '33333333-3333-4333-8333-333333333333',
      session_id: 'sdk-session',
      parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] },
    });
    control.finish();

    expect((await run).rewindPoint).toBe(opening);
    expect((await run).rewindPoint).not.toBe('33333333-3333-4333-8333-333333333333');
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

  /**
   * And the same flag-tier payload, derived rather than restated.
   *
   * A probe answers "what does Claude offer here", and the screens believe it:
   * the composer builds its slash menu from `commands`. Measured against CLI
   * 2.1.267, `supportedCommands()` returns 56 entries without
   * `disableBundledSkills` and 38 with it — so a probe in the wrong posture
   * offers eighteen commands the run would refuse, every one a bundled skill
   * this deployment no longer ships. Comparing against `buildOptions` rather
   * than against a literal is what stops the two drifting when a third flag
   * joins them.
   */
  it('carries the same flag settings a run does, so the menu cannot outrun the CLI', async () => {
    const { query, control } = fakeQuery();
    const supervisor = makeSupervisor(query);

    await supervisor.catalogue(WORKSPACE);

    expect(control.opened[0]?.settings).toEqual(supervisor.buildOptions(makeRequest()).settings);
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

describe('a workspace can pre-approve a tool', () => {
  /**
   * The lever this closes: `dontAsk` is the mode every unattended caller ends
   * up in — it is the MCP gateway's default ceiling — and the CLI answers it
   * with "denied, nothing is pre-approved". Measured: a run in that mode was
   * refused `WebSearch`, `Write` and every mutating shell command, while the
   * settings screen offered no way to pre-approve anything at all. The UI and
   * the guide both described a configuration that did not exist.
   *
   * The decision stays in the broker's seam rather than being handed to the
   * CLI, so it leaves a transcript line. A grant that silently authorises tool
   * calls is a grant nobody can audit — which was already written beside
   * `onGrantUsed`, a hook nothing had ever wired.
   */
  const askFor = (
    options: Record<string, unknown>,
    toolName: string,
    input: unknown = {},
  ): Promise<unknown> =>
    (options.canUseTool as (n: string, i: unknown, o: unknown) => Promise<unknown>)(
      toolName,
      input,
      { toolUseID: `tu_${toolName}`, signal: new AbortController().signal },
    );

  /** Runs a request to the point where its options are observable. */
  async function open(request: RunRequest) {
    const { query, control } = fakeQuery();
    const broker = heldBroker();
    const callbacks = makeCallbacks();
    const supervisor = makeSupervisor(query, broker);
    const run = supervisor.execute(request, callbacks);
    await vi.waitFor(() => expect(control.opened).toHaveLength(1));
    return {
      control,
      broker,
      callbacks,
      options: control.opened[0] as Record<string, unknown>,
      finish: async () => {
        control.finish();
        await run;
      },
    };
  }

  it('allows it without troubling the broker, and says so in the transcript', async () => {
    const request = withSettings({ allowedTools: ['WebSearch'] });
    const { options, broker, callbacks, finish } = await open(request);

    await expect(askFor(options, 'WebSearch', { query: 'node lts' })).resolves.toEqual({
      behavior: 'allow',
    });
    expect(broker.outstanding).toBe(0);
    // No card was raised, so the run never entered "waiting for you" either.
    expect(callbacks.waiting).toEqual([]);

    const notes = callbacks.events.filter(
      (event) => (event as { kind: string }).kind === 'system',
    ) as Array<{ level: string; message: string }>;
    expect(notes).toHaveLength(1);
    expect(notes[0]!.level).toBe('info');
    expect(notes[0]!.message).toMatch(/WebSearch/);
    expect(notes[0]!.message).toMatch(/pre-approv/i);

    await finish();
  });

  it('still asks about everything the operator did not pre-approve', async () => {
    const request = withSettings({ allowedTools: ['WebSearch'] });
    const { options, broker, finish } = await open(request);

    const asked = askFor(options, 'Bash', { command: 'rm -rf build' });
    await vi.waitFor(() => expect(broker.outstanding).toBe(1));
    broker.releaseAll();
    await asked;

    await finish();
  });

  /**
   * Plan mode promises that no tool is ever executed. A pre-approval must not
   * quietly become the one exception to it — so the list is not applied there
   * at all, and the CLI's own plan gate stays the only answer.
   */
  it('does not pre-approve anything in plan mode', async () => {
    const request = withSettings({ allowedTools: ['WebSearch'] });
    request.policy = { ...request.policy, permissionMode: 'plan' };
    const { options, broker, finish } = await open(request);

    const asked = askFor(options, 'WebSearch', { query: 'node lts' });
    await vi.waitFor(() => expect(broker.outstanding).toBe(1));
    broker.releaseAll();
    await asked;

    await finish();
  });

  it('does not let a forbidden tool be pre-approved by the same row', async () => {
    const request = withSettings({
      allowedTools: ['WebSearch'],
      disallowedTools: ['WebSearch'],
    });
    const { options, broker, finish } = await open(request);

    const asked = askFor(options, 'WebSearch', { query: 'node lts' });
    await vi.waitFor(() => expect(broker.outstanding).toBe(1));
    broker.releaseAll();
    await asked;

    await finish();
  });

  it('does not reach an MCP tool that merely ends with a pre-approved name', async () => {
    const request = withSettings({ allowedTools: ['search'] });
    const { options, broker, finish } = await open(request);

    const asked = askFor(options, 'mcp__github__search', { q: 'x' });
    await vi.waitFor(() => expect(broker.outstanding).toBe(1));
    broker.releaseAll();
    await asked;

    await finish();
  });
});

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
describe('the cached prefix', () => {
  /*
   * The invariant, stated rather than the mechanism that provides it: two runs
   * that differ only in what retrieval found must produce the *same* system
   * prompt. The prompt cache is a prefix match, so a system prompt that moves
   * invalidates everything after it.
   *
   * Measured against the real CLI (Claude Code, three runs in one resumed
   * session): the append is re-applied on resume and replaces what was there,
   * so a changed one rewrote the whole prefix — 11,498 cache-write tokens
   * against 163 for an identical one, same session, seconds apart. In
   * production the prefix is ~34k tokens with the MCP catalogues, and memory
   * retrieval is keyed on the prompt, so essentially every run paid it.
   */
  it('does not move when only the per-message context differs', () => {
    const supervisor = makeSupervisor(fakeQuery().query);

    const first = supervisor.buildOptions(
      makeRequest({ prompt: 'deploy', contextPreamble: '## Recalled context\n\n- Alpha' }),
    );
    const second = supervisor.buildOptions(
      makeRequest({ prompt: 'roll back', contextPreamble: '## Recalled context\n\n- Omega' }),
    );

    expect(second.systemPrompt).toEqual(first.systemPrompt);
    expect(JSON.stringify(first.systemPrompt)).not.toContain('Alpha');
    expect(JSON.stringify(second.systemPrompt)).not.toContain('Omega');
  });

  it('still moves when the session-stable context differs, which is the point of the split', () => {
    // Sabotage-proofing: a preamble that changed nothing anywhere would pass
    // the test above trivially. The stable half must still reach the prompt.
    const supervisor = makeSupervisor(fakeQuery().query);

    const bare = supervisor.buildOptions(makeRequest({ systemPromptAppend: '' }));
    const withConventions = supervisor.buildOptions(
      makeRequest({ systemPromptAppend: '## Standing conventions\n\n- Answer in French.' }),
    );

    expect(withConventions.systemPrompt).not.toEqual(bare.systemPrompt);
    expect(JSON.stringify(withConventions.systemPrompt)).toContain('Answer in French.');
  });

  it('keeps the git status out of the prompt, since an editing agent changes it', () => {
    const supervisor = makeSupervisor(fakeQuery().query);
    expect(supervisor.buildOptions(makeRequest())).toMatchObject({
      systemPrompt: { excludeDynamicSections: true },
    });
  });

  it('carries the per-message context to the model in the user message', async () => {
    // It must not merely be absent from the system prompt — it has to arrive.
    const { query, control } = fakeQuery();
    const supervisor = makeSupervisor(query);

    const run = supervisor.execute(
      makeRequest({ prompt: 'what is the notice period?', contextPreamble: '## Recalled context\n\n- 45 days' }),
      makeCallbacks(),
    );
    await vi.waitFor(() => expect(control.received.length).toBe(1));
    control.finish();
    await run;

    const sent = control.received[0] as { message: { content: string } };
    expect(sent.message.content).toContain('45 days');
    expect(sent.message.content).toContain('what is the notice period?');
    // The ask comes last, so nothing buries it.
    expect(sent.message.content.indexOf('45 days')).toBeLessThan(
      sent.message.content.indexOf('what is the notice period?'),
    );
  });

  it('sends the prompt alone when nothing was retrieved', () => {
    // No stray separator on the common path.
    expect(buildContextPreamble(makeRequest())).toBe('');
  });
});

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
  });

  /**
   * A forbidden tool is removed from the CLI's tool list outright, so it is
   * sent whatever the mode. Measured: with `disallowedTools`, `WebSearch` and
   * `WebFetch` vanish from the init message's `tools` and the model reports
   * the capability as absent rather than refused.
   */
  it('always sends the forbidden tools, because that removes them from the CLI', () => {
    const supervisor = makeSupervisor(fakeQuery().query);
    for (const permissionMode of ['default', 'dontAsk', 'plan'] as const) {
      const request = withSettings({ disallowedTools: ['Bash'] });
      request.policy = { ...request.policy, permissionMode };
      expect(supervisor.buildOptions(request).disallowedTools).toEqual(['Bash']);
    }
  });

  /* ---------------------------------------------------------------------- */
  /* The deployment's own deny list                                          */
  /* ---------------------------------------------------------------------- */

  /**
   * The CLI's tool set is not this deployment's tool set.
   *
   * Claude Code brings tools written for a person at a terminal signed in to
   * claude.ai, and Metaclaude mounted all of them. Most only cost tokens —
   * measured against CLI 2.1.267, the built-ins are 23,543 in-window tokens on
   * the cached prefix of every run, and refusing nine of them takes that to
   * 13,388. Three reach past the deployment outright: `CronCreate` and its
   * pair schedule work in the CLI's own scheduler, outside the automations
   * screen and its quota guard, and `Artifact` publishes a page to claude.ai
   * from inside a run. No screen said either was possible.
   */
  it('refuses the deployment’s list alongside the workspace’s own', () => {
    const supervisor = makeSupervisor(fakeQuery().query, undefined, {
      disabledCliTools: ['CronCreate', 'Artifact'],
    });

    expect(supervisor.buildOptions(withSettings({ disallowedTools: ['Bash'] })).disallowedTools)
      .toEqual(['Bash', 'CronCreate', 'Artifact']);
  });

  it('sends the deployment’s list on a workspace that forbids nothing', () => {
    const supervisor = makeSupervisor(fakeQuery().query, undefined, {
      disabledCliTools: ['Artifact'],
    });

    expect(supervisor.buildOptions(makeRequest()).disallowedTools).toEqual(['Artifact']);
  });

  it('names a tool once when both lists name it', () => {
    const supervisor = makeSupervisor(fakeQuery().query, undefined, {
      disabledCliTools: ['Artifact'],
    });

    expect(supervisor.buildOptions(withSettings({ disallowedTools: ['Artifact'] })).disallowedTools)
      .toEqual(['Artifact']);
  });

  /**
   * `ToolSearch` is how the CLI keeps every other tool's schema out of the
   * prompt until something needs it. Refusing it is a 15,500-token regression
   * on every run, measured, announced by nothing — so it is dropped here as
   * well as at the form, because this is the read every stored row goes
   * through and a row can predate the rule.
   */
  it('drops ToolSearch from either list rather than obeying it', () => {
    const supervisor = makeSupervisor(fakeQuery().query, undefined, {
      disabledCliTools: ['ToolSearch'],
    });

    expect(supervisor.buildOptions(makeRequest()).disallowedTools).toBeUndefined();
    expect(
      supervisor.buildOptions(withSettings({ disallowedTools: ['ToolSearch', 'Bash'] }))
        .disallowedTools,
    ).toEqual(['Bash']);
  });

  /**
   * A refused tool must not also be pre-approved.
   *
   * `resolvePreapproval` already cut the workspace's own forbidden names from
   * its pre-approval list; the deployment's list has to reach the same cut, or
   * a workspace that pre-approved `WebFetch` would hand the CLI a permission
   * rule for a tool the same options remove — an incoherence the CLI is under
   * no obligation to resolve the way we would guess.
   */
  it('cuts a pre-approval the deployment’s list refuses', () => {
    const supervisor = makeSupervisor(fakeQuery().query, undefined, {
      disabledCliTools: ['WebFetch'],
    });
    const request = withSettings({ allowedTools: ['WebFetch', 'WebSearch'] });
    request.policy = { ...request.policy, permissionMode: 'dontAsk' };

    const allow = (
      supervisor.buildOptions(request).managedSettings as {
        permissions?: { allow?: string[] };
      }
    ).permissions?.allow;
    expect(allow).toEqual(['WebSearch']);
  });

  /** The pre-approval, as the CLI is told about it in `dontAsk`. */
  const managedAllow = (options: ReturnType<AgentSupervisor['buildOptions']>): unknown =>
    (options.managedSettings as { permissions?: { allow?: unknown } } | undefined)?.permissions
      ?.allow;

  /**
   * The pre-approval reaches the CLI in exactly one mode, through exactly one
   * channel, and both halves of that were measured rather than assumed.
   *
   * **One mode.** A pre-approval the CLI knows about auto-approves the tool
   * *before* `canUseTool` is consulted — the SDK warns about it by name, and a
   * run in `default` mode with `allowedTools: ['WebFetch']` fetched a page
   * with no approval card at all. Telling the CLI in every mode would delete
   * the Ask mode's whole promise as a side effect of a settings checkbox.
   * `dontAsk` is the one mode where the broker never gets the question: the
   * CLI answers "denied, nothing pre-approved" on its own.
   *
   * **One channel.** `--allowedTools` looked like it, and it is not enough:
   * under `dontAsk` it let `WebFetch` through and left `WebSearch` refused.
   * `WebSearch` is executed upstream rather than by the CLI, and only a
   * *permission rule* covers it. The first measurement missed this because
   * the model, offered both, happened to reach for `WebFetch` every time — a
   * false positive that survived until an end-to-end run asked for the search
   * by name. A managed `permissions.allow` covers both kinds.
   */
  it('tells the CLI only in dontAsk, and through the rule channel that covers a server tool', () => {
    const supervisor = makeSupervisor(fakeQuery().query);

    for (const permissionMode of ['default', 'acceptEdits', 'auto', 'plan'] as const) {
      const request = withSettings({ allowedTools: ['WebSearch'] });
      request.policy = { ...request.policy, permissionMode };
      const options = supervisor.buildOptions(request);
      expect(managedAllow(options)).toBeUndefined();
      expect(options.allowedTools).toBeUndefined();
    }

    const unattended = withSettings({ allowedTools: ['WebSearch'] });
    unattended.policy = { ...unattended.policy, permissionMode: 'dontAsk' };
    const options = supervisor.buildOptions(unattended);
    expect(managedAllow(options)).toEqual(['WebSearch']);
    // The managed locks are not lost by carrying the rules: they are what
    // makes a project's own settings.json unable to add rules of its own.
    expect(options.managedSettings).toMatchObject({
      allowManagedPermissionRulesOnly: true,
      allowManagedHooksOnly: true,
      allowManagedMcpServersOnly: true,
    });
  });

  it('subtracts a forbidden tool from the pre-approval, whatever the row says', () => {
    // Re-checked here, not only where the setting is saved: this is the call
    // that actually widens what the agent may do, and a row written before the
    // rule existed must not slip through.
    const supervisor = makeSupervisor(fakeQuery().query);
    const request = withSettings({
      allowedTools: ['WebSearch', 'Bash'],
      disallowedTools: ['Bash'],
    });
    request.policy = { ...request.policy, permissionMode: 'dontAsk' };

    const options = supervisor.buildOptions(request);
    expect(managedAllow(options)).toEqual(['WebSearch']);
    expect(options.disallowedTools).toEqual(['Bash']);
  });

  /**
   * A scoped rule is refused rather than passed on, and the reason is now
   * consistency rather than only the measurement that started it.
   *
   * Measured: `WebFetch(domain:example.com)` in `--allowedTools`, under the
   * managed locks, allowed a fetch of *nodejs.org* — the opposite of what it
   * says. And even on the rule channel, where the CLI would honour the scope,
   * Metaclaude's own broker matches whole tool names: the same entry would
   * mean one thing in `dontAsk` and another in every other mode. One of those
   * is a trap and the other is a split brain, so neither ships.
   */
  it('drops a scoped rule instead of sending one that means two different things', () => {
    const warnings: string[] = [];
    const supervisor = new AgentSupervisor({
      broker: () => ({ request: async () => ({ behavior: 'allow' }) }) as never,
      allowBypassPermissions: false,
      claudeBinPath: null,
      runTimeoutMs: () => 60_000,
      idleTimeoutMs: () => 0,
      env: {},
      directoryPolicy: {
        workspacesDir: '/srv/metaclaude/workspaces',
        dataDir: '/var/lib/metaclaude',
      },
      log: (level, message) => {
        if (level === 'warn') warnings.push(message);
      },
      query: fakeQuery().query as never,
    });

    const request = withSettings({ allowedTools: ['WebFetch(domain:example.com)', 'WebSearch'] });
    request.policy = { ...request.policy, permissionMode: 'dontAsk' };

    expect(managedAllow(supervisor.buildOptions(request))).toEqual(['WebSearch']);
    expect(warnings.join(' ')).toMatch(/WebFetch\(domain:example\.com\)/);
    expect(warnings.join(' ')).toMatch(/widen/i);
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

describe('buildOptions — the CLI’s own skills', () => {
  /**
   * A workspace offers what its operator put there, and nothing else.
   *
   * The CLI ships seventeen skills of its own, written for a terminal and for
   * claude.ai. They were listed in every run's prompt and openable by the
   * agent, describing capabilities this deployment does not have — and an
   * operator who had switched every one of their own skills off still had
   * seventeen, none of them theirs, on a screen that said none.
   */
  it('always tells the CLI to leave its bundled skills out', () => {
    const supervisor = makeSupervisor(fakeQuery().query);
    expect(supervisor.buildOptions(makeRequest()).settings).toEqual({
      disableBundledSkills: true,
    });
  });

  /**
   * And the other shape, which exists because the two do not compose.
   *
   * Measured against CLI 2.1.267: with `disableBundledSkills` set, a
   * `skillOverrides: { 'code-review': 'on' }` beside it still left *zero*
   * built-in skills. The floor wins. So a deployment that wants one of the
   * CLI's skills cannot raise the floor at all — every other skill has to be
   * named `off` by hand — and the flag is kept only for the deployment that
   * has chosen nothing, where it is strictly better because it also covers a
   * skill the installed CLI does not ship yet.
   */
  it('names the skills one by one once the deployment has chosen some', () => {
    const supervisor = makeSupervisor(fakeQuery().query, undefined, {
      cliSkills: { kind: 'overrides', overrides: { 'code-review': 'on', dataviz: 'off' } },
    });

    const settings = supervisor.buildOptions(makeRequest()).settings;
    expect(settings).toHaveProperty('skillOverrides', { 'code-review': 'on', dataviz: 'off' });
    // Not both: the flag would win and the choice would be silently inert.
    expect(settings).not.toHaveProperty('disableBundledSkills');
  });

  it('falls back to the flag when nothing wires the policy in', () => {
    // A supervisor built without the dep behaves as every run did before the
    // screen existed, which is what makes the dep optional rather than a
    // second thing to remember.
    const supervisor = makeSupervisor(fakeQuery().query);
    expect(supervisor.buildOptions(makeRequest()).settings).toHaveProperty(
      'disableBundledSkills',
      true,
    );
  });

  /**
   * The tier is the measurement, not the reading.
   *
   * `disableBundledSkills` is declared on `Settings`, and `managedSettings` is
   * where every other policy here rides — and measured against CLI 2.1.267 it
   * does nothing there at all: the same 19 skills and 2,040 tokens as sending
   * nothing. Only the flag tier bites. This is what keeps it from drifting
   * back to the tier that reads more natural and does not work.
   */
  it('sends it in the flag tier, never in the managed one', () => {
    const supervisor = makeSupervisor(fakeQuery().query);
    const options = supervisor.buildOptions(makeRequest());

    expect(options.settings).toHaveProperty('disableBundledSkills', true);
    expect(options.managedSettings).not.toHaveProperty('disableBundledSkills');
  });
});

describe('buildOptions — ultracode', () => {
  it('passes the setting to the CLI when the policy asks for it', () => {
    const supervisor = makeSupervisor(fakeQuery().query);
    const request = makeRequest();
    request.policy = { ...request.policy, ultracode: true };

    expect(supervisor.buildOptions(request).settings).toEqual({
      disableBundledSkills: true,
      ultracode: true,
    });
  });

  it('says nothing about orchestration otherwise', () => {
    // Absence, not `{ ultracode: false }`: an explicit false would still be a
    // merge instruction for the CLI, and a run that never asked for
    // orchestration must not carry a key about it. The payload itself is no
    // longer optional — `disableBundledSkills` is on every run — so what is
    // asserted is the absent key rather than the absent object.
    const supervisor = makeSupervisor(fakeQuery().query);
    expect(supervisor.buildOptions(makeRequest()).settings).not.toHaveProperty('ultracode');
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
      disableBundledSkills: true,
      autoUploadSessions: true,
    });
  });

  it('stays absent when off, and composes with ultracode when both are on', () => {
    // The same absence rule as ultracode: off means no key at all, and the
    // three share the one flag-tier payload rather than clobbering each other.
    const supervisor = makeSupervisor(fakeQuery().query);
    expect(supervisor.buildOptions(makeRequest()).settings).not.toHaveProperty(
      'autoUploadSessions',
    );

    const both = withMirror(makeRequest());
    both.policy = { ...both.policy, ultracode: true };
    expect(supervisor.buildOptions(both).settings).toEqual({
      disableBundledSkills: true,
      ultracode: true,
      autoUploadSessions: true,
    });
  });
});

describe('buildOptions — the delegation tool and its directory', () => {
  /**
   * The pair this whole block is about: a tool is mounted, and the agent is
   * told who it may reach with it.
   *
   * `delegate` shipped for releases describing its argument as "the target
   * workspace's slug, exactly as listed" while nothing listed anything —
   * measured on this build before the fix, the options carried the
   * `metaclaude` server and a system-prompt append of the empty string. So the
   * tool was usable only by a run whose human had already typed a slug, which
   * is the one case where the agent needed no help at all. Every case below
   * asserts the two halves together, because either one alone is a defect: a
   * tool nobody is told about goes unused, and a briefing for a tool that is
   * not mounted sends the model at something that answers "no such tool".
   */
  const peerWorkspace = (slug: string, description = 'Invoicing and the monthly export.'): Workspace => ({
    ...workspace,
    id: `ws_${slug}`,
    slug,
    name: slug,
    description,
  });

  const wired = (peers: Workspace[] = [peerWorkspace('billing')], budget = 3000) => ({
    peers: () => peers,
    budget: () => budget,
    run: async () => {
      throw new Error('not called in these tests');
    },
  });

  const serversOf = (options: ReturnType<AgentSupervisor['buildOptions']>) =>
    Object.keys(options.mcpServers ?? {});
  const appendOf = (options: ReturnType<AgentSupervisor['buildOptions']>) =>
    String((options.systemPrompt as { append?: string } | undefined)?.append ?? '');
  /**
   * The tool *names* one mounted server actually registers.
   *
   * Which server is mounted stopped being the whole answer when it grew a
   * second verb: the cheap search and `delegate` are decided separately, so a
   * test that only asked "is `metaclaude` there" would pass on a run holding
   * the wrong one of the two.
   */
  const toolsOf = (options: ReturnType<AgentSupervisor['buildOptions']>, server: string) => {
    const mounted = (options.mcpServers ?? {})[server] as
      | { instance?: { _registeredTools?: Record<string, unknown> } }
      | undefined;
    return Object.keys(mounted?.instance?._registeredTools ?? {}).sort();
  };

  it('mounts the server and names the peers it may reach', () => {
    const supervisor = makeSupervisor(fakeQuery().query, undefined, { delegation: wired() });

    const options = supervisor.buildOptions(makeRequest());

    expect(serversOf(options)).toContain('metaclaude');
    expect(appendOf(options)).toContain('billing');
    expect(appendOf(options)).toContain('Invoicing and the monthly export.');
  });

  it('withholds both from a run that is itself a delegation — depth is one', () => {
    // The kernel refuses chained delegation too; withholding the tool means
    // the model never sees an affordance it would only be refused on, and
    // withholding the directory means it is not told about one either.
    const supervisor = makeSupervisor(fakeQuery().query, undefined, { delegation: wired() });

    const options = supervisor.buildOptions(makeRequest({ triggeredBy: 'delegation' }));

    expect(serversOf(options)).not.toContain('metaclaude');
    expect(appendOf(options)).not.toContain('billing');
  });

  /**
   * A gateway run gets both, exactly as a run started from the interface does.
   *
   * This used to be withheld, and the reason read well: a token names the
   * workspaces it may reach, so a tool that reaches *other* workspaces would
   * put that scope one prompt away. What it produced was an agent with no way
   * to answer a question whose answer this deployment holds — measured in
   * production, an application asked one and was told the deployment did not
   * know, while a pinned memory in the next workspace said otherwise, and the
   * run called no tool at all because it had none to call.
   *
   * The operator's rule, already written for the session tools one release
   * earlier: the token says which door an application may knock at, and behind
   * that door Metaclaude behaves as it does from the interface. Where the
   * information lives is Metaclaude's business, not the caller's. What still
   * bounds a gateway run is its *ceiling*, which the kernel now carries onto
   * the run it delegates — that one is about nobody being in the room, which
   * stays true whatever the capability.
   */
  it('gives a gateway run both, like any run started from the interface', () => {
    const supervisor = makeSupervisor(fakeQuery().query, undefined, { delegation: wired() });

    const options = supervisor.buildOptions(makeRequest({ triggeredBy: 'api' }));

    expect(serversOf(options)).toContain('metaclaude');
    expect(appendOf(options)).toContain('billing');
  });

  /**
   * The workspace's own settings decide, for a gateway run as for any other.
   *
   * `dontAsk` never reaches the broker, so an unticked `delegate` is refused
   * by the CLI rather than asked about — and being told about a tool that
   * cannot run is the defect this pair exists to prevent. The gateway does not
   * get an exemption from that: it gets the same answer the interface would.
   */
  it('gives a gateway run exactly what the workspace’s own settings allow', () => {
    const supervisor = makeSupervisor(fakeQuery().query, undefined, { delegation: wired() });

    const options = supervisor.buildOptions(
      makeRequest({
        triggeredBy: 'api',
        policy: { ...makeRequest().policy, permissionMode: 'dontAsk' },
      }),
    );

    // The same answer an automation of this workspace gets: the cheap read,
    // and not the verb whose tick the operator has not given. No exemption in
    // either direction — that is what "behaves as it does from the interface"
    // has to mean when the interface would have refused too.
    expect(toolsOf(options, 'metaclaude')).toEqual(['search_workspaces']);
    expect(appendOf(options)).not.toContain('`delegate`');
  });

  it('offers nothing when delegation is not wired at all', () => {
    const supervisor = makeSupervisor(fakeQuery().query);

    const options = supervisor.buildOptions(makeRequest());

    expect(serversOf(options)).not.toContain('metaclaude');
    expect(appendOf(options)).toBe('');
  });

  /**
   * A single-workspace deployment, or one where every peer opted out. The tool
   * could only ever fail there, and before this it was mounted anyway: schema
   * tokens spent on every run for an affordance with no target.
   */
  it('offers nothing when there is nobody to consult', () => {
    const supervisor = makeSupervisor(fakeQuery().query, undefined, { delegation: wired([]) });

    const options = supervisor.buildOptions(makeRequest());

    expect(serversOf(options)).not.toContain('metaclaude');
    expect(appendOf(options)).toBe('');
  });

  it('does not count the run’s own workspace as a peer', () => {
    // The list the deployment hands over is every workspace, this one included.
    const supervisor = makeSupervisor(fakeQuery().query, undefined, {
      delegation: wired([workspace]),
    });

    const options = supervisor.buildOptions(makeRequest());

    expect(serversOf(options)).not.toContain('metaclaude');
  });

  it('leaves out a workspace that declined to be consulted', () => {
    const closed: Workspace = {
      ...peerWorkspace('secrets'),
      settings: WorkspaceSettings.parse({ delegable: false }),
    };
    const supervisor = makeSupervisor(fakeQuery().query, undefined, {
      delegation: wired([peerWorkspace('billing'), closed]),
    });

    const options = supervisor.buildOptions(makeRequest());

    expect(appendOf(options)).toContain('billing');
    expect(appendOf(options)).not.toContain('secrets');
  });

  /**
   * Peers exist, none has said what it is for. The tool still works for a
   * person who names a slug, so it stays mounted — and saying nothing would
   * put us back exactly where this block started.
   */
  it('still mounts it when no peer is described, and says so', () => {
    const supervisor = makeSupervisor(fakeQuery().query, undefined, {
      delegation: wired([peerWorkspace('billing', ''), peerWorkspace('shop', '')]),
    });

    const options = supervisor.buildOptions(makeRequest());

    expect(serversOf(options)).toContain('metaclaude');
    expect(appendOf(options)).toContain('2 other workspaces');
  });

  /**
   * Plan mode keeps both, and that is a decision rather than an oversight.
   *
   * Nothing executes under plan, so `delegate` is a tool the CLI will refuse,
   * and withholding it looked right — this repository calls a briefing for a
   * tool that cannot run a defect, and `plan` became a *token ceiling* in this
   * release, so it stopped being only a person's choice in the composer.
   *
   * What plan produces is a proposal, and a proposal written by an agent that
   * does not know the billing workspace exists is a worse proposal. The
   * directory is context for planning, not a promise about this turn. Pinned
   * here so the next reader changes it on purpose, in either direction.
   */
  /**
   * Mounted *and* pre-approved, which is one fact and not two.
   *
   * A tool that is mounted and unticked is a card in `default` mode and a flat
   * refusal under `dontAsk` — the CLI answers there without ever reaching the
   * broker. The cheap search is the tool an unattended run most needs, so it
   * rides with its own mount the way `memory_search` does; `delegate` does not,
   * because it spends another workspace's quota.
   */
  it('pre-approves the search with its mount, and never delegate', () => {
    const supervisor = makeSupervisor(fakeQuery().query, undefined, { delegation: wired() });

    // `dontAsk` is where it is observable *and* where it matters: the CLI
    // answers there without reaching the broker, so a rule that is not in
    // `managedSettings.permissions.allow` is a flat refusal.
    const options = supervisor.buildOptions(
      makeRequest({ policy: { ...makeRequest().policy, permissionMode: 'dontAsk' } }),
    );

    const allowed =
      (options.managedSettings as { permissions?: { allow?: string[] } } | undefined)?.permissions
        ?.allow ?? [];
    expect(allowed).toContain('mcp__metaclaude__search_workspaces');
    expect(allowed).not.toContain('mcp__metaclaude__delegate');
  });

  it('keeps both under plan: a proposal is better for knowing who exists', () => {
    const supervisor = makeSupervisor(fakeQuery().query, undefined, { delegation: wired() });

    const options = supervisor.buildOptions(
      makeRequest({ policy: { ...makeRequest().policy, permissionMode: 'plan' } }),
    );

    expect(serversOf(options)).toContain('metaclaude');
    expect(appendOf(options)).toContain('billing');
  });

  /**
   * The operator's off switch. It has to skip the *mount*, not merely the
   * text: a ceiling whose 0 means "off" that still creates the thing is the
   * zero-delay-timer trap, and here it would leave the tool mounted with
   * nothing said about it — the original defect, restored by a setting.
   */
  it('a budget of zero switches the whole thing off, tool included', () => {
    const supervisor = makeSupervisor(fakeQuery().query, undefined, {
      delegation: wired([peerWorkspace('billing')], 0),
    });

    const options = supervisor.buildOptions(makeRequest());

    expect(serversOf(options)).not.toContain('metaclaude');
    expect(appendOf(options)).toBe('');
  });

  /**
   * A budget too small to say anything is raised to the floor rather than
   * obeyed. Obeying it would drop the sentence explaining why there is no
   * list, and leave the tool mounted and unexplained — which is precisely the
   * defect this pair exists to fix, reintroduced through a settings field.
   */
  it('raises a budget too small to hold a sentence, rather than falling silent', () => {
    const supervisor = makeSupervisor(fakeQuery().query, undefined, {
      delegation: wired([peerWorkspace('billing')], 120),
    });

    const options = supervisor.buildOptions(makeRequest());

    expect(serversOf(options)).toContain('metaclaude');
    expect(appendOf(options)).toContain('billing');
  });

  /**
   * `dontAsk` is the one mode where the broker is never asked: the CLI answers
   * "denied, nothing is pre-approved" itself. So a mounted `delegate` there is
   * refused rather than asked about, and briefing an automation about it every
   * hour would be this release's own defect upside down — words for a tool
   * that cannot run.
   *
   * The cheap search is a different case and gets the opposite answer: it
   * reads what is already written, executes nothing, and is pre-approved with
   * its own mount for exactly memory's reason — without that an automation
   * would carry a lookup tool and be refused it every night, silently, while
   * still landing as a success.
   */
  it('offers an unattended run the search and not the verb it would be refused', () => {
    const supervisor = makeSupervisor(fakeQuery().query, undefined, { delegation: wired() });
    const unattended = makeRequest();
    unattended.policy = { ...unattended.policy, permissionMode: 'dontAsk' };

    const options = supervisor.buildOptions(unattended);

    expect(serversOf(options)).toContain('metaclaude');
    expect(toolsOf(options, 'metaclaude')).toEqual(['search_workspaces']);
    // Named, since it is mounted; and the verb it does not have is not.
    expect(appendOf(options)).toContain('search_workspaces');
    expect(appendOf(options)).not.toContain('`delegate`');
    expect(appendOf(options)).toContain('billing');
  });

  /**
   * Unless the operator pre-approved it by name, which is a decision they are
   * entitled to make and the one thing that makes the tool live in that mode.
   * Pre-approving it *for* them would let an unattended run start work in
   * another workspace with nobody watching.
   */
  it('speaks up in dontAsk when the operator pre-approved delegation by name', () => {
    const supervisor = makeSupervisor(fakeQuery().query, undefined, { delegation: wired() });
    const unattended = withSettings({ allowedTools: ['mcp__metaclaude__delegate'] });
    unattended.policy = { ...unattended.policy, permissionMode: 'dontAsk' };

    const options = supervisor.buildOptions(unattended);

    expect(serversOf(options)).toContain('metaclaude');
    expect(appendOf(options)).toContain('billing');
  });

  it('keeps the configured MCP servers beside it', () => {
    const supervisor = makeSupervisor(fakeQuery().query, undefined, { delegation: wired() });

    const options = supervisor.buildOptions(
      makeRequest({ mcpServers: { github: { command: 'npx' } } }),
    );

    expect(serversOf(options).sort()).toEqual(['github', 'metaclaude']);
  });

  it('keeps the directory beside the context the kernel already built', () => {
    // The append is a stack: recalled memory and conventions come from the
    // kernel, the directory is added here, and neither may replace the other.
    const supervisor = makeSupervisor(fakeQuery().query, undefined, { delegation: wired() });

    const options = supervisor.buildOptions(
      makeRequest({ systemPromptAppend: '## Recalled context\n\nsomething remembered' }),
    );

    expect(appendOf(options)).toContain('something remembered');
    expect(appendOf(options)).toContain('billing');
  });
});

describe('buildOptions — the steward’s tools', () => {
  // The fixture's workspace is `ws_1`; the facade is never called while options are built.
  const steward = { workspaceId: () => 'ws_1', facade: () => ({}) };

  it('mounts metaclaude_system for a run of the system workspace', () => {
    const supervisor = makeSupervisor(fakeQuery().query, undefined, { steward });
    const options = supervisor.buildOptions(makeRequest());

    expect(Object.keys(options.mcpServers ?? {})).toContain('metaclaude_system');
  });

  it('withholds it from every other workspace', () => {
    const supervisor = makeSupervisor(fakeQuery().query, undefined, {
      steward: { ...steward, workspaceId: () => 'ws_other' },
    });
    const options = supervisor.buildOptions(makeRequest());

    expect(Object.keys(options.mcpServers ?? {})).not.toContain('metaclaude_system');
  });

  /**
   * Still withheld from a delegated run: a project's agent asking the steward a
   * question must not thereby steer the deployment. Its answer travels back to
   * another workspace, and these verbs change settings, decide approvals and
   * start runs anywhere.
   */
  it('withholds it from a delegated run, even there', () => {
    const supervisor = makeSupervisor(fakeQuery().query, undefined, { steward });

    const options = supervisor.buildOptions(makeRequest({ triggeredBy: 'delegation' }));

    expect(Object.keys(options.mcpServers ?? {})).not.toContain('metaclaude_system');
  });

  /**
   * A gateway run gets them, and this is the one that mattered in production.
   *
   * The system workspace's instructions — generated at boot, on disk, read by
   * every run there — tell the agent to start from `system_overview`. For a
   * gateway run the server was not mounted, so the tools the briefing named
   * did not exist. Measured: asked a question whose answer sat in another
   * workspace's memory, the run answered that it had found nothing "in
   * CLAUDE.md, NOTES.md, memories, `system_overview`" while calling no tool at
   * all. A briefing for tools that are not there does not produce a refusal,
   * it produces a fluent account of a search that never happened.
   *
   * Granting the system workspace to a token therefore grants what the steward
   * can do, under the token's ceiling — written down in docs/SECURITY.md,
   * because it is a consequence of the grant the person issuing it must know.
   */
  it('gives a gateway run the steward’s tools, so its briefing is true', () => {
    const supervisor = makeSupervisor(fakeQuery().query, undefined, { steward });

    const options = supervisor.buildOptions(makeRequest({ triggeredBy: 'api' }));

    expect(Object.keys(options.mcpServers ?? {})).toContain('metaclaude_system');
  });

  it('offers nothing when no steward is wired', () => {
    const options = makeSupervisor(fakeQuery().query).buildOptions(makeRequest());

    expect(Object.keys(options.mcpServers ?? {})).not.toContain('metaclaude_system');
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

  it('narrows the loaded skills to exactly the required ones, and says so per message', () => {
    const supervisor = makeSupervisor(fakeQuery().query);
    const request = withControls({
      requiredSkills: ['deploy', 'review'],
      excludedMcpServers: [],
      preferredMcpServers: [],
    });
    const options = supervisor.buildOptions(request);

    expect(options.skills).toEqual(['deploy', 'review']);
    // The words travel with the message, not in the cached prefix: the Tools
    // picker is a per-message decision, so two consecutive sends with
    // different pickers would otherwise rewrite the whole system prompt.
    const preamble = buildContextPreamble(request);
    expect(preamble).toContain('deploy');
    expect(preamble).toContain('review');
    expect(JSON.stringify(options.systemPrompt)).not.toContain('deploy');
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
    const delegation = {
      peers: () => [{ ...workspace, id: 'ws_peer', slug: 'peer', description: 'A peer.' }],
      budget: () => 3000,
      run: async (): Promise<never> => {
        throw new Error('not called');
      },
    };
    const supervisor = makeSupervisor(fakeQuery().query, undefined, { delegation });
    const options = supervisor.buildOptions(
      withControls({ requiredSkills: [], excludedMcpServers: ['metaclaude'], preferredMcpServers: [] }),
    );

    expect(Object.keys(options.mcpServers ?? {})).toContain('metaclaude');
  });

  it('keeps a preferred server mounted and asks for it in the message', () => {
    // Availability can force absence; only words can ask for use.
    const supervisor = makeSupervisor(fakeQuery().query);
    const request = withControls(
      { requiredSkills: [], excludedMcpServers: [], preferredMcpServers: ['github'] },
      {
        mcpServers: { github: { type: 'http', url: 'https://y' } },
        systemPromptAppend: 'existing context',
      },
    );
    const options = supervisor.buildOptions(request);

    expect(Object.keys(options.mcpServers ?? {})).toContain('github');
    // The session-stable half still rides the prefix; the per-message ask does not.
    const prompt = options.systemPrompt as { append?: string };
    expect(prompt.append).toContain('existing context');
    expect(prompt.append).not.toContain('github');
    expect(buildContextPreamble(request)).toContain('github');
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
      disableBundledSkills: true,
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

    expect(options.settings).not.toHaveProperty('enabledPlugins');
    expect(options.settings).not.toHaveProperty('extraKnownMarketplaces');
    expect((options.env as Record<string, string>).CLAUDE_CODE_SYNC_PLUGIN_INSTALL).toBeUndefined();
  });

  it('says nothing about plugins when none is enabled', () => {
    // The payload itself is no longer optional: `disableBundledSkills` rides
    // it on every run. What must stay absent is any *plugin* key, so a
    // deployment with no plugins never asks the CLI to resolve a source.
    const supervisor = makeSupervisor(fakeQuery().query);
    const options = supervisor.buildOptions(withPlugins({}));

    expect(options.settings).toEqual({ disableBundledSkills: true });
    expect((options.env as Record<string, string>).CLAUDE_CODE_SYNC_PLUGIN_INSTALL).toBeUndefined();
  });

  it('composes with ultracode in one settings payload', () => {
    const supervisor = makeSupervisor(fakeQuery().query);
    const request = withPlugins({ 'formatter@tools': true });
    request.policy = { ...request.policy, ultracode: true };

    expect(supervisor.buildOptions(request).settings).toEqual({
      disableBundledSkills: true,
      ultracode: true,
      extraKnownMarketplaces: marketplaces,
      enabledPlugins: { 'formatter@tools': true },
    });
  });
});

describe('a run whose tool calls were refused without a prompt', () => {
  /**
   * `result.permission_denials` is the CLI's authoritative record of what it
   * refused on its own — the `dontAsk` short-circuit, the auto-mode
   * classifier, a deny rule — and nothing read it. The only trace was whatever
   * the model chose to say in its closing paragraph, which for an unattended
   * run (an automation, a gateway call) nobody reads at all: the operator saw
   * a *successful* run that had quietly done half the work.
   *
   * One line, at the end, naming them. It does not guess at the cause: several
   * paths land here and the mode is on the run already.
   */
  const denial = (tool: string, id: string) => ({
    tool_name: tool,
    tool_use_id: id,
    tool_input: {},
  });

  /** A complete `result` message; `finish` replaces the default wholesale. */
  const resultMessage = (extra: Record<string, unknown>) => ({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'done',
    duration_ms: 1,
    num_turns: 1,
    total_cost_usd: 0,
    usage: {},
    session_id: 'sdk-session',
    ...extra,
  });

  async function runWith(extra: Record<string, unknown>) {
    const { query, control } = fakeQuery();
    const callbacks = makeCallbacks();
    const supervisor = makeSupervisor(query);
    const run = supervisor.execute(makeRequest(), callbacks);
    await vi.waitFor(() => expect(control.opened).toHaveLength(1));
    control.finish(resultMessage(extra));
    await run;
    return (callbacks.events as Array<{ kind: string; level?: string; message?: string }>).filter(
      (event) => event.kind === 'system',
    );
  }

  it('names them once, in one line, rather than one line each', async () => {
    const notes = await runWith({
      permission_denials: [
        denial('WebSearch', 'tu_1'),
        denial('Bash', 'tu_2'),
        denial('WebSearch', 'tu_3'),
      ],
    });

    expect(notes).toHaveLength(1);
    expect(notes[0]!.level).toBe('warn');
    expect(notes[0]!.message).toContain('WebSearch');
    expect(notes[0]!.message).toContain('Bash');
    // Three denials, two tools: the count is of calls, the list is of names.
    expect(notes[0]!.message).toMatch(/\b3\b/);
    expect(notes[0]!.message!.match(/WebSearch/g)).toHaveLength(1);
  });

  it('says nothing at all when nothing was refused', async () => {
    expect(await runWith({})).toHaveLength(0);
    expect(await runWith({ permission_denials: [] })).toHaveLength(0);
  });

  it('reports them on a failed run too, where they are most likely the reason', async () => {
    const notes = await runWith({
      subtype: 'error_max_turns',
      permission_denials: [denial('Write', 'tu_1')],
    });
    expect(notes).toHaveLength(1);
    expect(notes[0]!.message).toContain('Write');
  });
});

/**
 * When a run is stopped for taking too long, and what "too long" means.
 *
 * The wall clock had never been tested, and it was measuring the wrong thing:
 * a ceiling on total duration punishes a run for *working*, when what it is
 * there to catch is a run that has stopped working. A loop, a long refactor, an
 * automation that genuinely takes two hours are all indistinguishable from a
 * wedged subprocess to a clock that only counts elapsed time.
 *
 * Measured against the real CLI: during a tool call that ran for 100 seconds it
 * emitted `tool_progress` every 30 seconds, plus `task_started` and a rate
 * limit event. The stream is never silent for long while anything is happening,
 * which is what makes silence a usable signal and gives an idle ceiling of
 * minutes a factor of twenty of margin over the heartbeat.
 *
 * So there are two, and they answer different questions. The idle ceiling asks
 * "is this still alive?"; the absolute one is the backstop for a tool that
 * never returns at all. Either may be switched off with 0.
 */
describe('the two ceilings on a run', () => {
  /** Drives a run under fake timers; `emit` at each step keeps it talking. */
  async function runFor(
    ms: number,
    options: { runTimeoutMs?: number; idleTimeoutMs?: number; chatty?: boolean },
  ) {
    const { query, control } = fakeQuery();
    const supervisor = makeSupervisor(query, undefined, {
      ...(options.runTimeoutMs !== undefined ? { runTimeoutMs: options.runTimeoutMs } : {}),
      ...(options.idleTimeoutMs !== undefined ? { idleTimeoutMs: options.idleTimeoutMs } : {}),
    });
    const outcome = supervisor.execute(makeRequest(), makeCallbacks());
    await vi.waitFor(() => expect(control.opened).toHaveLength(1));

    // One step per minute; a chatty run says something on every one of them.
    const step = 60_000;
    for (let elapsed = 0; elapsed < ms; elapsed += step) {
      if (options.chatty) {
        control.emit({ type: 'system', subtype: 'tool_progress', session_id: 's' });
      }
      await vi.advanceTimersByTimeAsync(step);
    }
    return { outcome, control };
  }

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('stops a run that has gone silent, and says that is why', async () => {
    const { outcome } = await runFor(12 * 60_000, {
      idleTimeoutMs: 10 * 60_000,
      runTimeoutMs: 0,
    });
    const result = await outcome;

    expect(result.status).toBe('interrupted');
    expect(result.error).toMatch(/10 minutes/);
    expect(result.error).toMatch(/nothing|silent|no activity/i);
    // Not the other message: the two reasons must not be confusable.
    expect(result.error).not.toMatch(/time limit/);
  });

  /**
   * The property the whole change exists for. Ninety minutes of work, past an
   * idle ceiling of ten, with the CLI reporting as it did in the measurement —
   * and the run is left alone.
   */
  it('leaves a run alone however long it works, as long as it keeps reporting', async () => {
    const { outcome, control } = await runFor(90 * 60_000, {
      idleTimeoutMs: 10 * 60_000,
      runTimeoutMs: 0,
      chatty: true,
    });
    control.finish();
    const result = await outcome;

    expect(result.status).toBe('succeeded');
    expect(result.error).toBeNull();
  });

  /**
   * Found in production: a run asked for a `Glob` outside its workspace, the
   * card sat on the Dashboard with nobody there, and ten minutes later the
   * run was stopped "for reporting nothing" — the CLI is blocked inside
   * `canUseTool` while a card waits, so the silence was the operator's. The
   * card's own timeout is the same ten minutes and lost the race. A pending
   * approval holds the idle clock; an answered one hands it back.
   */
  it('does not count a pending approval card as silence, and resumes the clock once it is answered', async () => {
    let answer: ((outcome: unknown) => void) | null = null;
    const broker = {
      request: () =>
        new Promise<unknown>((resolve) => {
          answer = resolve;
        }),
    };
    const { query, control } = fakeQuery();
    const supervisor = makeSupervisor(query, broker, { idleTimeoutMs: 10 * 60_000, runTimeoutMs: 0 });
    const outcome = supervisor.execute(makeRequest(), makeCallbacks());
    let settled = false;
    void outcome.then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(control.opened).toHaveLength(1));
    const options = control.opened[0] as Record<string, unknown>;

    const asked = (options.canUseTool as (n: string, i: unknown, o: unknown) => Promise<unknown>)(
      'Glob',
      { pattern: '/opt/metaclaude/apps/api/dist/**' },
      { toolUseID: 'tu_glob', signal: new AbortController().signal },
    );
    // Twenty-five minutes with the card open and nobody answering.
    for (let minute = 0; minute < 25; minute += 1) await vi.advanceTimersByTimeAsync(60_000);
    expect(settled).toBe(false);

    answer!({ behavior: 'allow' });
    await asked;
    // Now the agent really says nothing: that is silence, and the clock runs again from here.
    for (let minute = 0; minute < 12; minute += 1) await vi.advanceTimersByTimeAsync(60_000);
    const result = await outcome;

    expect(result.status).toBe('interrupted');
    expect(result.error).toMatch(/10 minutes/);
  });

  it('still stops a chatty run at the absolute ceiling', async () => {
    const { outcome } = await runFor(70 * 60_000, {
      idleTimeoutMs: 10 * 60_000,
      runTimeoutMs: 60 * 60_000,
      chatty: true,
    });
    const result = await outcome;

    expect(result.status).toBe('interrupted');
    // "1 hour", not "60 minutes" — and never "its 60 minutes time limit",
    // which is what the first version of this message said. An attributive
    // number wants the singular in English, so the sentence puts the figure
    // after the noun instead of trying to inflect it into the phrase.
    expect(result.error).toMatch(/time limit of 1 hour and was stopped/);
    expect(result.error).not.toMatch(/minutes time limit/);
  });

  /**
   * An idle ceiling of 0 switches that clock off and nothing else: a run that
   * says nothing for half an hour is left alone, while the absolute ceiling it
   * still has stays armed.
   *
   * The first version of this case asserted the same thing for `runTimeoutMs:
   * 0` as well, and it could not be made to fail — a zero-delay timer aborts
   * before `query()` is called, and an already-aborted signal fires no
   * listener, so the fake never learned of it and the run finished as a
   * success either way. A case that passes whether or not the code is right is
   * worse than no case, so it asserts what it can actually see.
   */
  it('switches off only the clock it names when that clock is 0', async () => {
    const quiet = await runFor(30 * 60_000, { idleTimeoutMs: 0, runTimeoutMs: 60 * 60_000 });
    quiet.control.finish();
    const result = await quiet.outcome;

    expect(result.status).toBe('succeeded');
    expect(result.error).toBeNull();
  });
});

/**
 * The sentence a stopped run leaves behind, in words that parse.
 *
 * "The run exceeded its 45 minutes time limit" shipped in 0.41.0. English wants
 * the singular in an attributive position — "a 45-minute limit" — so a helper
 * that correctly writes "reported nothing for 10 minutes" writes nonsense the
 * moment the figure is moved in front of the noun. Naming the amount after the
 * noun avoids the inflection entirely, and lets hours be hours.
 */
describe('how a ceiling names itself', () => {
  const stoppedAt = async (runTimeoutMs: number) => {
    const { query, control } = fakeQuery();
    const supervisor = makeSupervisor(query, undefined, { runTimeoutMs, idleTimeoutMs: 0 });
    const outcome = supervisor.execute(makeRequest(), makeCallbacks());
    await vi.waitFor(() => expect(control.opened).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(runTimeoutMs + 1000);
    return (await outcome).error ?? '';
  };

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('says hours when the ceiling is hours', async () => {
    expect(await stoppedAt(4 * 60 * 60_000)).toContain('time limit of 4 hours');
  });

  it('says one hour, not 60 minutes', async () => {
    expect(await stoppedAt(60 * 60_000)).toContain('time limit of 1 hour');
  });

  it('keeps minutes when hours would not be whole', async () => {
    expect(await stoppedAt(45 * 60_000)).toContain('time limit of 45 minutes');
  });

  it('never leaves a plural in front of the noun', async () => {
    for (const ms of [45 * 60_000, 4 * 60 * 60_000, 90 * 60_000]) {
      expect(await stoppedAt(ms)).not.toMatch(/(minutes|hours) time limit/);
    }
  });
});

/**
 * The workspace's own memory: mounted, and said out loud.
 *
 * Both halves matter and only one of them is obvious. Recall reaches the model
 * as an unattributed block carrying "never mention this section", so an agent
 * that has just been told something worth keeping has no reason to believe a
 * store exists — it wrote Markdown files in the workspace instead, which is
 * correct behaviour for an agent that has only a filesystem, and a second
 * memory that nothing lists, decays or consolidates.
 */
describe('the memory tools', () => {
  const store = { search: async () => [], get: () => null, remember: async () => ({}), update: async () => null, retire: () => null };
  const serversOf = (opened: Record<string, unknown>) =>
    Object.keys((opened.mcpServers ?? {}) as Record<string, unknown>);
  const appended = (opened: Record<string, unknown>) =>
    String((opened.systemPrompt as { append?: string } | undefined)?.append ?? '');

  /** Open a run, let it settle, and hand back the options the CLI was given. */
  const optionsFor = async (
    request: RunRequest,
    extra: Parameters<typeof makeSupervisor>[2] = {},
  ): Promise<Record<string, unknown>> => {
    const { query, control } = fakeQuery();
    const run = makeSupervisor(query, undefined, extra).execute(request, makeCallbacks());
    await vi.waitFor(() => expect(control.received.length).toBe(1));
    control.finish();
    await run;
    return control.opened[0] as Record<string, unknown>;
  };

  it('mounts them for an ordinary workspace, and tells the agent they are there', async () => {
    const opened = await optionsFor(makeRequest(), { memory: store });
    expect(serversOf(opened)).toContain('metaclaude_memory');
    expect(appended(opened)).toContain('memory_write');
  });

  it('says nothing about a memory it did not mount', async () => {
    // A briefing without the tools is worse than silence: the agent is told to
    // use something that will answer "no such tool".
    const opened = await optionsFor(makeRequest());
    expect(serversOf(opened)).not.toContain('metaclaude_memory');
    expect(appended(opened)).not.toContain('memory_write');
  });

  it('leaves a workspace that recalls nothing alone', async () => {
    const opened = await optionsFor(withSettings({ memoryEnabled: false }), { memory: store });
    expect(serversOf(opened)).not.toContain('metaclaude_memory');
    expect(appended(opened)).not.toContain('memory_write');
  });

  /**
   * Reading and writing memory without a card, forgetting with one.
   *
   * Measured on the deployment this was built for: `default` mode with
   * `Write`, `Edit` and `Bash` pre-approved and nothing else. Writing a
   * Markdown file was therefore silent and writing a memory would have raised
   * an approval card every time — the system making the wrong thing
   * frictionless, which is how the second memory came to exist at all.
   */
  it('pre-approves reading and writing memory, but not forgetting', async () => {
    // In `default` mode the decision is made at the broker seam inside
    // `execute`, not in the CLI's managed settings, so what is asserted is
    // whether the broker was reached at all.
    const decisions: Array<{ tool: string; asked: boolean }> = [];
    for (const tool of [
      'mcp__metaclaude_memory__memory_search',
      'mcp__metaclaude_memory__memory_write',
      'mcp__metaclaude_memory__memory_forget',
    ]) {
      let reachedBroker = false;
      const { query, control } = fakeQuery();
      const supervisor = makeSupervisor(
        query,
        {
          request: async () => {
            reachedBroker = true;
            return { behavior: 'allow' };
          },
        },
        { memory: store },
      );
      const run = supervisor.execute(makeRequest(), makeCallbacks());
      await vi.waitFor(() => expect(control.received.length).toBe(1));
      const opts = control.opened[0] as {
        canUseTool: (name: string, input: unknown, extra: { toolUseID: string }) => Promise<unknown>;
      };
      await opts.canUseTool(tool, {}, { toolUseID: 'tu_1' });
      control.finish();
      await run;
      decisions.push({ tool, asked: reachedBroker });
    }

    expect(decisions).toEqual([
      { tool: 'mcp__metaclaude_memory__memory_search', asked: false },
      { tool: 'mcp__metaclaude_memory__memory_write', asked: false },
      { tool: 'mcp__metaclaude_memory__memory_forget', asked: true },
    ]);
  });

  it('does not mount them in the system workspace, whose steward has more', async () => {
    // `system_memory_write` does all of this and can file under any workspace.
    // Two ways to do one thing is how a model picks the weaker one.
    const opened = await optionsFor(makeRequest(), {
      memory: store,
      steward: { workspaceId: () => makeRequest().workspace.id, facade: () => ({}) },
    });
    expect(serversOf(opened)).not.toContain('metaclaude_memory');
  });
});

/**
 * The workspace's other sessions: mounted, said out loud, and fenced.
 *
 * Same three-way shape as memory, for the same reason — a briefing without a
 * mount tells the agent to call a tool that will answer "no such tool", and a
 * mount without a briefing is a tool nobody knows exists. The third reader is
 * the pre-approval: these are what an automation calls, and an automation runs
 * under `dontAsk`, where the CLI refuses anything not pre-approved without ever
 * reaching the broker. Un-approved, they would be dead exactly where they
 * matter most.
 *
 * The exclusions are the interesting half. A run started by a gateway token or
 * by another workspace's delegation is not the operator working in their own
 * project: it is an outside program, or another workspace's agent, and neither
 * should be able to read back the conversations held here.
 */
describe('the sessions tools', () => {
  const sessions = {
    listSessions: () => [],
    getSession: () => null,
    getRun: () => null,
    sessionEvents: () => [],
    runEvents: () => [],
  };
  const serversOf = (opened: Record<string, unknown>) =>
    Object.keys((opened.mcpServers ?? {}) as Record<string, unknown>);
  const appended = (opened: Record<string, unknown>) =>
    String((opened.systemPrompt as { append?: string } | undefined)?.append ?? '');

  const optionsFor = async (
    request: RunRequest,
    extra: Parameters<typeof makeSupervisor>[2] = {},
  ): Promise<Record<string, unknown>> => {
    const { query, control } = fakeQuery();
    const run = makeSupervisor(query, undefined, extra).execute(request, makeCallbacks());
    await vi.waitFor(() => expect(control.received.length).toBe(1));
    control.finish();
    await run;
    return control.opened[0] as Record<string, unknown>;
  };

  it('mounts them for an ordinary run, and tells the agent they are there', async () => {
    const opened = await optionsFor(makeRequest(), { sessions });
    expect(serversOf(opened)).toContain('metaclaude_sessions');
    expect(appended(opened)).toContain('session_read');
  });

  it('says nothing about tools it did not mount', async () => {
    const opened = await optionsFor(makeRequest());
    expect(serversOf(opened)).not.toContain('metaclaude_sessions');
    expect(appended(opened)).not.toContain('session_read');
  });

  /**
   * A gateway run gets them, because a token is a door rather than a leash.
   *
   * The operator's rule for the MCP gateway: the token says which workspace an
   * application may knock at, and behind that door Metaclaude behaves exactly
   * as it does from the interface. An application granted a workspace and then
   * unable to read what was said in it would be answering from less than the
   * screen shows — which is the gap this was measured against: a question
   * whose answer sat in a session the run could not open.
   */
  it('gives them to a gateway run, which stands in for the interface', async () => {
    const opened = await optionsFor(makeRequest({ triggeredBy: 'api' }), { sessions });
    expect(serversOf(opened)).toContain('metaclaude_sessions');
    expect(appended(opened)).toContain('session_read');
  });

  /**
   * A delegated run does not, and this is the one exclusion that stays.
   *
   * It is the only case where the party asking is not this workspace's
   * operator but another workspace's agent — and its answer travels back
   * there. A question phrased to extract would come home with the verbatim
   * record attached. Delegation is meant to consult a project through its own
   * agent, memory and conventions included; it is not meant to read its mail.
   */
  it('keeps them out of a delegated run, whose answer leaves the workspace', async () => {
    const opened = await optionsFor(makeRequest({ triggeredBy: 'delegation' }), { sessions });
    expect(serversOf(opened)).not.toContain('metaclaude_sessions');
    expect(appended(opened)).not.toContain('session_read');
  });

  it('gives them to a run an automation started, which is the point', async () => {
    for (const triggeredBy of ['automation', 'loop'] as const) {
      const opened = await optionsFor(makeRequest({ triggeredBy }), { sessions });
      expect(serversOf(opened)).toContain('metaclaude_sessions');
    }
  });

  it('does not mount them in the system workspace, whose steward reads more', async () => {
    const opened = await optionsFor(makeRequest(), {
      sessions,
      steward: { workspaceId: () => makeRequest().workspace.id, facade: () => ({}) },
    });
    expect(serversOf(opened)).not.toContain('metaclaude_sessions');
  });

  /**
   * All three pre-approved, because all three read.
   *
   * In `default` mode the decision is made at the broker seam, so what is
   * asserted is whether the broker was reached at all — reaching it is what
   * raises the card.
   */
  it('pre-approves all three, so an unattended firing can actually call them', async () => {
    const decisions: Array<{ tool: string; asked: boolean }> = [];
    for (const tool of [
      'mcp__metaclaude_sessions__session_list',
      'mcp__metaclaude_sessions__session_read',
      'mcp__metaclaude_sessions__run_result',
    ]) {
      let reachedBroker = false;
      const { query, control } = fakeQuery();
      const supervisor = makeSupervisor(
        query,
        {
          request: async () => {
            reachedBroker = true;
            return { behavior: 'allow' };
          },
        },
        { sessions },
      );
      const run = supervisor.execute(makeRequest(), makeCallbacks());
      await vi.waitFor(() => expect(control.received.length).toBe(1));
      const opts = control.opened[0] as {
        canUseTool: (name: string, input: unknown, extra: { toolUseID: string }) => Promise<unknown>;
      };
      await opts.canUseTool(tool, {}, { toolUseID: 'tu_1' });
      control.finish();
      await run;
      decisions.push({ tool, asked: reachedBroker });
    }

    expect(decisions.every((entry) => entry.asked === false)).toBe(true);
  });
});

/**
 * The board and the proposal tools run without a card, like memory.
 *
 * Measured on a live deployment, and invisible until someone looked: under
 * `Don't ask` a run receives its ticked built-ins plus the two memory tools
 * and *nothing else*, because the CLI answers "denied, nothing is
 * pre-approved" itself. So a scheduled automation in such a workspace could
 * not file a card on its own board, nor propose the automation it had just
 * concluded was needed — silently, every night, with the run still landing as
 * a success.
 *
 * The tier is the same one memory already sits in, and the reason is the same:
 * every write here is reversible and local to the workspace. A card lands on a
 * board the operator reads; a proposal lands in an inbox and an automation it
 * proposes arrives *disabled*. What replaces the approval card is the
 * transcript note the seam writes, so the run still says what it did without
 * asking.
 *
 * Deliberately not `delegate`, which is in the same in-process family and is
 * not in this tier: it spends another workspace's quota and starts a full run
 * there with nobody watching. That one stays an explicit tick.
 */
describe('the tools that never raise a card', () => {
  const board = { list: () => [], get: () => null, create: async () => ({}), update: async () => ({}) };
  const advisor = { propose: async () => ({}), proposeAutomation: async () => ({}) };

  /** Drive one tool through the seam and report whether the broker was reached. */
  const asks = async (
    tool: string,
    extra: Parameters<typeof makeSupervisor>[2],
  ): Promise<boolean> => {
    let reached = false;
    const { query, control } = fakeQuery();
    const supervisor = makeSupervisor(
      query,
      {
        request: async () => {
          reached = true;
          return { behavior: 'allow' };
        },
      },
      extra,
    );
    const run = supervisor.execute(makeRequest(), makeCallbacks());
    await vi.waitFor(() => expect(control.received.length).toBe(1));
    const opts = control.opened[0] as {
      canUseTool: (name: string, input: unknown, extra: { toolUseID: string }) => Promise<unknown>;
    };
    await opts.canUseTool(tool, {}, { toolUseID: 'tu_1' });
    control.finish();
    await run;
    return reached;
  };

  /*
   * Derived from the catalogues rather than listed here. A tool added to either
   * server tomorrow is covered the day it is added — which is the failure this
   * whole block exists for: a capability that is mounted, never pre-approved,
   * and refused in the one mode where nobody is there to be asked.
   */
  it.each(boardToolNames())('lets %s run without asking', async (tool) => {
    expect(await asks(tool, { board })).toBe(false);
  });

  it.each(advisorToolNames())('lets %s run without asking', async (tool) => {
    expect(await asks(tool, { advisor })).toBe(false);
  });

  it('still asks for a tool outside the tier', async () => {
    // The control that makes the cases above mean something: the seam is
    // reached at all, and it is the pre-approval that skips it.
    expect(await asks('Bash', { board, advisor })).toBe(true);
  });

  it('still asks before delegating, which spends another workspace’s quota', async () => {
    const delegation = {
      peers: () => [{ ...workspace, id: 'ws_peer', slug: 'peer', description: 'A peer.' }],
      budget: () => 3000,
      run: async () => {
        throw new Error('not called');
      },
    };
    expect(await asks('mcp__metaclaude__delegate', { delegation })).toBe(true);
  });

  it('says nothing about a board it did not mount', async () => {
    // Pre-approving a tool that is not there would put a name in the CLI's
    // managed settings for a server it cannot see, which is noise at best.
    expect(await asks(boardToolNames()[0]!, {})).toBe(true);
  });
});
