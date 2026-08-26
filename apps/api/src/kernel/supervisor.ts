/**
 * Agent supervisor — the bridge between the Claude Agent SDK and Metaclaude.
 *
 * Responsibilities:
 *  - Translate a `RunPolicy` plus workspace settings into SDK `Options`.
 *  - Consume the `SDKMessage` stream and turn it into persisted transcript
 *    events plus ephemeral streaming deltas.
 *  - Route permission prompts to the broker.
 *  - Enforce the wall-clock timeout and support cooperative interruption.
 *
 * The SDK spawns the real Claude CLI, so everything the operator's subscription
 * grants — models, skills, plugins, MCP — is available exactly as it is in the
 * terminal. Metaclaude never talks to the Anthropic API directly.
 */

import {
  createSdkMcpServer,
  query as sdkQuery,
  tool as sdkTool,
  type Options,
  type Query,
  type SDKMessage,
  type SDKControlGetContextUsageResponse,
  type SDKControlGetUsageResponse,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  ClaudeCatalogue,
  ClaudeUsage,
  MarketplaceSource,
  RewindResult,
  Run,
  RunPolicy,
  RunUsage,
  TranscriptEvent,
  Workspace,
} from '@metaclaude/shared';
import { ATTACHMENT_LIMITS, MAX_TOOL_RESULT_CHARS, newId } from '@metaclaude/shared';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { DirectoryPolicy } from '../security/directories.js';
import { reviewAdditionalDirectories } from '../security/directories.js';
import type { PermissionBroker } from './permissions.js';
import { resolvePermissionMode } from './permissions.js';
import { narrate } from './sdk-narrator.js';

/* -------------------------------------------------------------------------- */
/* Public surface                                                              */
/* -------------------------------------------------------------------------- */

export interface SupervisorCallbacks {
  /** A transcript event was created or updated; persist and broadcast it. */
  onEvent: (event: TranscriptEvent, isUpdate: boolean) => void;
  /** Ephemeral streaming text; broadcast only, never persisted. */
  onDelta: (eventId: string, channel: 'assistant_text' | 'thinking', text: string) => void;
  /** The CLI reported its session id — persist it so the session can resume. */
  onClaudeSessionId: (claudeSessionId: string) => void;
  /** The run entered or left the "waiting for a human" state. */
  onWaitingChange: (waiting: boolean) => void;
}

/** A file the message carries, resolved to its place inside the workspace. */
export interface RunAttachment {
  id: string;
  name: string;
  /** Workspace-relative path — what the agent's own tools open. */
  path: string;
  mime: string;
  bytes: number;
  absolutePath: string;
}

export interface RunRequest {
  runId: string;
  sessionId: string;
  workspace: Workspace;
  prompt: string;
  policy: RunPolicy;
  /** Claude CLI session id to resume, when this is not the first run. */
  resumeSessionId: string | null;
  /** Extra system-prompt text: retrieved memory, workspace conventions. */
  systemPromptAppend: string;
  /** MCP servers already resolved with their secrets. */
  mcpServers: Record<string, unknown>;
  /** Custom agents available to this run. */
  agents: Record<string, { description: string; prompt: string; tools?: string[]; model?: string }>;
  /** Enabled plugin marketplaces, keyed by name — the extraKnownMarketplaces value. */
  marketplaces: Record<string, { source: MarketplaceSource }>;
  /** What started this run — a delegated run must not delegate again. */
  triggeredBy: Run['triggeredBy'];
  /** Files this message carries; empty for automations and delegations. */
  attachments: RunAttachment[];
  abortSignal: AbortSignal;
}

export interface RunOutcome {
  status: 'succeeded' | 'failed' | 'interrupted';
  usage: RunUsage;
  error: string | null;
  /** The assistant's final message, used for reflexion and previews. */
  finalText: string;
  claudeSessionId: string | null;
  /** The model that actually served, from the CLI's init message; null if unsaid. */
  servedModel: string | null;
  /**
   * The CLI's uuid for the user message that opened this run, or null.
   *
   * The anchor a rewind restores to. It exists only on the wire — the CLI
   * acknowledges the prompt with it and never mentions it again — so a run that
   * does not capture it here can never be rewound, whatever its checkpoints say.
   */
  rewindPoint: string | null;
}

export interface SupervisorDeps {
  /**
   * Resolved lazily: the kernel owns the broker and the supervisor is one of the
   * kernel's dependencies, so the two are mutually referential. A getter breaks
   * the construction cycle without anyone reaching into another object's fields.
   */
  broker: () => PermissionBroker;
  allowBypassPermissions: boolean;
  claudeBinPath: string | null;
  runTimeoutMs: number;
  /** Extra environment handed to the CLI subprocess (auth token lives here). */
  env: Record<string, string>;
  /** Bounds on what `additionalDirectories` may grant. */
  directoryPolicy: DirectoryPolicy;
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
  /**
   * The SDK entry point, injectable so this module can be tested at all.
   *
   * It had no tests for exactly this reason — "it needs a live CLI" — which was
   * never true and left the code deciding what the transcript says, what a
   * timeout reports, and whether a run can be steered entirely unverified.
   */
  query?: typeof sdkQuery;
  /**
   * Run a prompt in another workspace and wait for its answer — the kernel's
   * `delegate`, handed in lazily like the broker (mutual construction). When
   * absent, runs simply never see the delegation tool.
   */
  delegate?: (input: {
    fromWorkspaceId: string;
    fromTriggeredBy: Run['triggeredBy'];
    target: string;
    prompt: string;
  }) => Promise<{ status: Run['status']; finalText: string; error: string | null }>;
}

/**
 * A live run's control surface.
 *
 * The SDK's 27 control methods are documented "only supported when streaming
 * input is used", and the handle carrying them used to be discarded at the
 * `for await`. Holding it is what makes a run steerable rather than merely
 * watchable.
 */
interface LiveRun {
  handle: Query;
  /** Push another user turn into the run. Resolves false once the run is over. */
  send: (text: string) => boolean;
  /** Close the input iterable. Idempotent — see `PromptStream`. */
  close: () => void;
  /**
   * Set when the operator asked for a clean stop.
   *
   * The CLI reports an interrupted turn as an errored result, which the outcome
   * mapping would otherwise record as `failed` — and a failed run is what the
   * bandit learns from. Stopping a run yourself would have taught the learner
   * that the model and effort it chose were bad.
   */
  interruptRequested: boolean;
}

/**
 * The streaming-input side of a run.
 *
 * A queue with one waiter. The two failure modes are equal and opposite:
 * closing twice makes the iterator throw inside the SDK, and never closing
 * leaves the subprocess waiting for input that is not coming — so `close` is
 * idempotent and every exit path calls it.
 */
/**
 * A user message's content: a plain string, or the Messages-API block array
 * carrying inline images and documents beside the text. Derived from the
 * SDK's own type so a renamed field fails compilation here, not a live run.
 */
export type UserContent = SDKUserMessage['message']['content'];

const INLINE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

function inlineImageType(mime: string): 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | null {
  return INLINE_IMAGE_TYPES.has(mime)
    ? (mime as 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif')
    : null;
}

/**
 * The prompt as the model receives it.
 *
 * Attachments always reach the model as named workspace paths — the robust
 * channel at any size, since the agent's Read tool handles images and PDFs
 * natively and everything else goes through its ordinary tooling. Small
 * images and PDFs additionally ride inline as content blocks, so the model
 * sees them without a tool round-trip. A file that cannot be read any more is
 * listed as missing rather than failing the run: the message is the user's,
 * and it must go out.
 */
export async function buildUserContent(
  prompt: string,
  attachments: RunAttachment[],
  readBytes: (path: string) => Promise<Buffer> = (path) => readFile(path),
): Promise<UserContent> {
  if (attachments.length === 0) return prompt;

  const blocks: Exclude<UserContent, string> = [];
  const lines: string[] = [];
  for (const attachment of attachments) {
    const imageType =
      attachment.bytes <= ATTACHMENT_LIMITS.inlineImageBytes ? inlineImageType(attachment.mime) : null;
    const inlinePdf =
      attachment.mime === 'application/pdf' && attachment.bytes <= ATTACHMENT_LIMITS.inlinePdfBytes;

    let note = '';
    if (imageType || inlinePdf) {
      try {
        const data = (await readBytes(attachment.absolutePath)).toString('base64');
        blocks.push(
          imageType
            ? { type: 'image', source: { type: 'base64', media_type: imageType, data } }
            : { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } },
        );
      } catch {
        note = ' — missing on disk';
      }
    }
    const kb = Math.max(1, Math.round(attachment.bytes / 1024));
    lines.push(`- ${attachment.path} (${attachment.mime}, ${kb} KB)${note}`);
  }

  blocks.push({
    type: 'text',
    text: `${prompt}\n\nAttached files, stored in this workspace:\n${lines.join('\n')}`,
  });
  return blocks;
}

class PromptStream {
  private readonly queued: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private closed = false;

  push(content: UserContent): boolean {
    if (this.closed) return false;
    // No cast: this object *is* an `SDKUserMessage`, and saying so lets the
    // compiler notice when the SDK renames a field rather than waiting for a
    // run to fail.
    const message: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: '',
    };
    this.queued.push(message);
    this.wake?.();
    return true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    for (;;) {
      while (this.queued.length > 0) yield this.queued.shift() as SDKUserMessage;
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.wake = () => {
          this.wake = null;
          resolve();
        };
      });
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Deterministic transcript-event id for a streamed content block.
 *
 * Deltas arrive before the block completes, so the client needs a stable key to
 * accumulate into. Deriving the id from (message id, block index) means the
 * eventual authoritative event carries the same id and simply replaces the
 * client's streaming buffer.
 */
function streamEventId(messageId: string, blockIndex: number): string {
  const digest = createHash('sha256').update(`${messageId}:${blockIndex}`).digest('base64url');
  return `ev_${digest.slice(0, 22)}`;
}

function truncateResult(value: string): string {
  if (value.length <= MAX_TOOL_RESULT_CHARS) return value;
  const omitted = value.length - MAX_TOOL_RESULT_CHARS;
  return `${value.slice(0, MAX_TOOL_RESULT_CHARS)}\n\n… [${omitted.toLocaleString()} more characters omitted]`;
}

/** Render an Anthropic tool_result content payload as display text. */
function renderToolResult(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === 'string') return block;
        if (block && typeof block === 'object') {
          const typed = block as { type?: string; text?: string };
          if (typed.type === 'text' && typeof typed.text === 'string') return typed.text;
          if (typed.type === 'image') return '[image]';
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (content === null || content === undefined) return '';
  return JSON.stringify(content, null, 2);
}

const EMPTY_USAGE: RunUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  costUsd: 0,
  durationMs: 0,
  turns: 0,
};

/* -------------------------------------------------------------------------- */
/* Supervisor                                                                  */
/* -------------------------------------------------------------------------- */

export class AgentSupervisor {
  constructor(private readonly deps: SupervisorDeps) {}

  /** Build the SDK options for a run. See the `buildOptions` describe in supervisor.test.ts. */
  buildOptions(request: RunRequest): Options {
    const { workspace, policy } = request;
    const settings = workspace.settings;

    // Marketplace plugins. Enablement keeps only entries switched on *and*
    // whose marketplace half names a known source: disabling or removing a
    // marketplace severs its plugins rather than leaving enabledPlugins
    // naming a source the CLI cannot resolve. Entries switched off are
    // omitted, not sent as false — absence is neutral, false is an override.
    const enabledPlugins = Object.fromEntries(
      Object.entries(settings.enabledPlugins).filter(
        ([key, on]) => on && request.marketplaces[key.split('@')[1] ?? ''] !== undefined,
      ),
    );
    const wantsPlugins = Object.keys(enabledPlugins).length > 0;

    // The last line of defence, and the only one that sees a mode persisted
    // *before* the deployment turned bypass off — a workspace default or an
    // automation policy the routes gated when it was written and cannot gate
    // again now. `resolvePermissionMode` is the same rule the routes enforce,
    // shared rather than restated: it had been written and left with no caller,
    // which is how the inline copy here drifted out of anyone's sight.
    const permissionMode = resolvePermissionMode(
      policy.permissionMode,
      this.deps.allowBypassPermissions,
    );

    const options: Options = {
      cwd: workspace.path,
      // Preset + append keeps every Claude Code behaviour the operator relies on
      // (CLAUDE.md discovery, skills, tool descriptions) and layers ours on top.
      systemPrompt: request.systemPromptAppend
        ? { type: 'preset', preset: 'claude_code', append: request.systemPromptAppend }
        : { type: 'preset', preset: 'claude_code' },
      permissionMode,
      includePartialMessages: true,
      // Surface subagent output so the transcript shows delegated work instead
      // of an opaque "Task" tool call.
      forwardSubagentText: true,
      agentProgressSummaries: true,
      // The sync-install flag lets a headless session install what is enabled
      // but not yet present; the CLI narrates it as plugin_install messages.
      env: wantsPlugins
        ? { ...this.deps.env, CLAUDE_CODE_SYNC_PLUGIN_INSTALL: '1' }
        : this.deps.env,

      // The settings payload rides the flag tier, which project settings
      // cannot override — so a cloned repository's own settings.json can
      // smuggle neither orchestration nor plugin sources past the owner.
      //
      // Ultracode: the CLI's standing multi-agent orchestration — xhigh effort
      // plus dynamic workflows by default. Session-scoped in the CLI, so it is
      // handed over at open time rather than through a mid-turn control
      // request, which could land after the turn it was meant to shape. Absent
      // rather than `{ ultracode: false }` when off: an explicit false is
      // still a settings payload for the CLI to merge, and every run that
      // never asked must stay byte-identical to before the field existed.
      // The same absence rule covers the plugin keys.
      ...(policy.ultracode || wantsPlugins
        ? {
            settings: {
              ...(policy.ultracode ? { ultracode: true } : {}),
              ...(wantsPlugins
                ? { extraKnownMarketplaces: request.marketplaces, enabledPlugins }
                : {}),
            },
          }
        : {}),

      // `project` is required for the CLI to discover `CLAUDE.md` and the
      // workspace's `.claude/skills/` — both of which Metaclaude actively
      // writes and advertises. `user` and `local` are excluded: they would read
      // the container's own home directory, which is not the operator's.
      settingSources: ['project'],

      // Loading project settings means a cloned repository's `.claude/settings.json`
      // is read, and left alone it could pre-approve tools, register hooks or add
      // MCP servers — silently defeating the approval flow. These managed locks
      // pin all three at the policy tier, which project settings cannot override.
      // Project *context* is trusted; project *policy* is not.
      managedSettings: {
        allowManagedPermissionRulesOnly: true,
        allowManagedHooksOnly: true,
        allowManagedMcpServersOnly: true,
      },

      strictMcpConfig: true,
      stderr: (data) => this.deps.log('debug', `[cli] ${data.trim()}`),
    };

    if (policy.model && policy.model !== 'default') options.model = policy.model;
    if (policy.effort) options.effort = policy.effort;
    if (policy.agentName) options.agent = policy.agentName;

    if (policy.thinking === 'disabled') {
      options.thinking = { type: 'disabled' };
    } else if (policy.thinking === 'enabled') {
      options.thinking = policy.thinkingBudgetTokens
        ? { type: 'enabled', budgetTokens: policy.thinkingBudgetTokens }
        : { type: 'enabled' };
    } else {
      options.thinking = { type: 'adaptive' };
    }

    if (settings.maxTurns !== null) options.maxTurns = settings.maxTurns;
    if (settings.maxBudgetUsd !== null) options.maxBudgetUsd = settings.maxBudgetUsd;
    if (settings.allowedTools.length > 0) options.allowedTools = settings.allowedTools;
    if (settings.disallowedTools.length > 0) options.disallowedTools = settings.disallowedTools;
    // Re-checked here, not just where the setting is saved: this is the call
    // that actually widens the agent's filesystem scope, and a row written
    // before the rule existed (or by any future path into the settings) must
    // not slip through. Invalid entries are dropped, never fatal.
    if (settings.additionalDirectories.length > 0) {
      const review = reviewAdditionalDirectories(
        settings.additionalDirectories,
        this.deps.directoryPolicy,
      );
      for (const { path, reason } of review.rejected) {
        this.deps.log('warn', `refusing additional directory "${path}": it ${reason}`);
      }
      if (review.allowed.length > 0) options.additionalDirectories = review.allowed;
    }
    if (settings.checkpointing) options.enableFileCheckpointing = true;

    // The delegation tool: an in-process MCP server, offered only to runs a
    // human (or an automation) started — a delegated run never sees it, so
    // the affordance matches the kernel's depth-one rule instead of dangling
    // a tool that would only ever be refused.
    const delegationServer: NonNullable<Options['mcpServers']> =
      this.deps.delegate && request.triggeredBy !== 'delegation'
        ? { metaclaude: this.buildDelegationServer(request) }
        : {};
    if (Object.keys(request.mcpServers).length > 0 || Object.keys(delegationServer).length > 0) {
      options.mcpServers = {
        ...(request.mcpServers as Options['mcpServers']),
        ...delegationServer,
      };
    }
    if (Object.keys(request.agents).length > 0) {
      options.agents = request.agents as Options['agents'];
    }
    // Enable every skill the CLI discovers in the workspace. Metaclaude
    // materialises only the enabled ones to disk before each run, so the
    // filtering has already happened.
    options.skills = 'all';
    if (this.deps.claudeBinPath) options.pathToClaudeCodeExecutable = this.deps.claudeBinPath;

    if (request.resumeSessionId) options.resume = request.resumeSessionId;

    // `bypassPermissions` is inert unless the CLI is also told to allow it.
    if (permissionMode === 'bypassPermissions') {
      options.allowDangerouslySkipPermissions = true;
    } else {
      options.canUseTool = async (toolName, input, opts) =>
        this.deps.broker().request({
          runId: request.runId,
          sessionId: request.sessionId,
          workspaceId: workspace.id,
          toolUseId: opts.toolUseID,
          toolName,
          toolInput: input,
          ...(opts.title ? { title: opts.title } : {}),
          ...(opts.decisionReason ? { decisionReason: opts.decisionReason } : {}),
          signal: opts.signal,
        });
    }

    return options;
  }

  /**
   * Runs currently in flight, by run id.
   *
   * Entries are removed in `execute`'s `finally`, so a finished run cannot
   * retain its handle, its options and its abort controller for the life of the
   * process — and a control call arriving a moment late is a no-op rather than
   * an action on a dead subprocess.
   */
  private readonly live = new Map<string, LiveRun>();

  /** Queue another user turn on a live run. False when the run is not live. */
  async send(runId: string, text: string): Promise<boolean> {
    const run = this.live.get(runId);
    if (!run) return false;
    return run.send(text);
  }

  /**
   * Stop the current turn cleanly.
   *
   * Not the abort controller: that is a SIGKILL where the CLI offers a turn
   * stop that flushes the transcript and returns a receipt naming any messages
   * still queued. The controller stays as the hard kill for timeouts.
   */
  async interrupt(runId: string): Promise<boolean> {
    const run = this.live.get(runId);
    if (!run) return false;
    run.interruptRequested = true;
    try {
      await run.handle.interrupt();
    } finally {
      // Nothing more will be typed into a run being stopped, and leaving the
      // iterable open holds the subprocess on stdin after its last turn — on
      // the one path where the operator is actively trying to stop it.
      run.close();
    }
    return true;
  }

  async setModel(runId: string, model: string): Promise<boolean> {
    const run = this.live.get(runId);
    if (!run) return false;
    await run.handle.setModel(model);
    return true;
  }

  async setPermissionMode(runId: string, mode: RunPolicy['permissionMode']): Promise<boolean> {
    const run = this.live.get(runId);
    if (!run) return false;
    await run.handle.setPermissionMode(mode);
    return true;
  }

  /**
   * How much of the context window this run has spent, or null if not live.
   *
   * The SDK's own shape is returned rather than a reduction of it: it carries
   * per-category token counts, which is the difference between a progress bar
   * and being able to see that the context is 70% one file read.
   */
  async contextUsage(runId: string): Promise<SDKControlGetContextUsageResponse | null> {
    const run = this.live.get(runId);
    if (!run) return null;
    return run.handle.getContextUsage();
  }

  /**
   * Execute a run to completion.
   *
   * Never throws for an agent-side failure — a failed run is a normal outcome
   * that must be recorded, not an exception that unwinds the kernel.
   */
  async execute(request: RunRequest, callbacks: SupervisorCallbacks): Promise<RunOutcome> {
    const startedAt = Date.now();
    const controller = new AbortController();

    let timedOut = false;
    // One timer, and it sets the flag *before* aborting. With a second timer at
    // the same delay the abort could settle the iterator and reach the catch
    // block while the flag was still false, reporting a timeout as an operator
    // interrupt.
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.deps.runTimeoutMs);
    timeout.unref?.();

    // Chain the caller's signal into ours so either can stop the run. An
    // already-aborted signal never fires 'abort', and the kernel can abort
    // during memory retrieval — before this point — so the flag is checked too.
    const onExternalAbort = (): void => controller.abort();
    if (request.abortSignal.aborted) {
      controller.abort();
    } else {
      request.abortSignal.addEventListener('abort', onExternalAbort, { once: true });
    }

    // Closing the input on abort is separate from closing it in the `finally`.
    // The SDK tears down its side when the controller fires, and a subprocess
    // still blocked reading stdin does not notice; the `finally` runs only
    // after the iterator has settled, which is exactly what is being waited on.
    // Declared here and captured by the abort listener below rather than looked
    // up in `this.live`: the listener is registered before the map entry
    // exists, so a lookup would silently find nothing in exactly the window
    // where an early abort has to be handled.
    const stream = new PromptStream();
    controller.signal.addEventListener('abort', () => stream.close(), { once: true });

    const options = this.buildOptions(request);
    options.abortController = controller;

    /*
     * Bracket the permission prompt so the run's status says so.
     *
     * `onWaitingChange` was declared here, implemented by the kernel — which
     * flips the run and its session between `running` and `waiting_approval` —
     * and called by nothing. The broker raises `waiting_approval` when it asks,
     * and nothing lowered it again: the first prompt in a run left it showing as
     * blocked on the operator for the rest of its life, while the agent worked.
     *
     * Wrapped here rather than in `buildOptions` because the callbacks arrive
     * with `execute`, and because `buildOptions` is tested for the shape it
     * produces — not for behaviour that depends on a live run.
     *
     * The counter is what makes it correct under parallel tool calls: a plain
     * true/false pair around each prompt reports "no longer waiting" the moment
     * the *first* of several is answered, while the operator is still looking at
     * the rest. `finally` covers the denial, the abort and the throwing broker,
     * because a run left permanently marked as waiting is the same bug wearing
     * a different hat.
     */
    const ask = options.canUseTool;
    if (ask) {
      let outstanding = 0;
      options.canUseTool = async (...args: Parameters<typeof ask>) => {
        if (outstanding++ === 0) callbacks.onWaitingChange(true);
        try {
          return await ask(...args);
        } finally {
          if (--outstanding === 0) callbacks.onWaitingChange(false);
        }
      };
    }

    const state = new StreamState(request, callbacks);
    let claudeSessionId: string | null = null;
    let servedModel: string | null = null;
    let rewindPoint: string | null = null;
    let usage: RunUsage = { ...EMPTY_USAGE };
    let error: string | null = null;
    let status: RunOutcome['status'] = 'succeeded';

    // Streaming input rather than a string prompt. Every SDK control method is
    // documented as streaming-input only, so this is what makes the handle
    // below worth holding. Attachments ride the first message as content
    // blocks beside the text; see buildUserContent for the rules.
    stream.push(await buildUserContent(request.prompt, request.attachments));

    const handle = (this.deps.query ?? sdkQuery)({ prompt: stream, options });
    const entry: LiveRun = {
      handle,
      send: (text) => stream.push(text),
      close: () => stream.close(),
      interruptRequested: false,
    };
    this.live.set(request.runId, entry);

    try {
      for await (const message of handle) {
        const captured = state.handle(message);
        if (captured.claudeSessionId) {
          claudeSessionId = captured.claudeSessionId;
          callbacks.onClaudeSessionId(captured.claudeSessionId);
        }
        // First acknowledgement only. A run is steerable, so the operator can
        // type a follow-up into it and the CLI acknowledges that too; letting
        // the anchor move forward would silently shrink what "undo this run"
        // restores to whatever happened after the last thing they said.
        if (captured.rewindPoint && rewindPoint === null) rewindPoint = captured.rewindPoint;
        if (captured.servedModel) servedModel = captured.servedModel;
        if (captured.usage) usage = captured.usage;
        if (captured.error) {
          error = captured.error;
          status = entry.interruptRequested ? 'interrupted' : 'failed';
          if (entry.interruptRequested) error = 'The run was stopped.';
        }
        // The turn is over, so the run is over.
        //
        // This loop used to wait for the generator to end by itself, which is
        // what a *string* prompt does: the CLI answers and exits. Streaming
        // input does not work that way — the session stays open for the next
        // user message, so the generator waits for input while the loop waits
        // for the generator. Every run hung: the answer arrived, the tools ran,
        // and the badge said `Working` until the 45-minute timeout marked it
        // interrupted. Closing the stream first lets the CLI wrap up; breaking
        // means a CLI that lingers cannot hold the run open anyway.
        //
        // Steering is untouched — that happens *during* the turn, before the
        // result. A follow-up afterwards opens a new run which resumes the same
        // CLI session, so the thread continues with an honest status and its
        // cost attributed to the right run.
        if (captured.finished) {
          stream.close();
          break;
        }
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      if (controller.signal.aborted) {
        status = 'interrupted';
        error = timedOut
          ? `The run exceeded its ${Math.round(this.deps.runTimeoutMs / 60_000)} minute time limit and was stopped.`
          : 'The run was interrupted.';
      } else {
        status = 'failed';
        error = message;
        this.deps.log('error', `run ${request.runId} failed`, { message });
      }
    } finally {
      clearTimeout(timeout);
      request.abortSignal.removeEventListener('abort', onExternalAbort);
      // Order matters on the way out: stop accepting input, then forget the
      // run, then flush the transcript. Closing the stream is what lets the
      // subprocess exit; `close` is idempotent so the abort path may have
      // already done it.
      stream.close();
      this.live.delete(request.runId);
      state.finalise();
    }

    // A stop the operator asked for is an interruption, however politely the
    // CLI ended.
    //
    // `status` starts as `succeeded` and only moves when a result arrives
    // carrying an error or the iterator throws. A CLI that honours `interrupt()`
    // by simply wrapping up the turn — no error, no throw — left the run
    // recorded as a success. That is not just a wrong badge: `computeReward`
    // scores the run from its status, so stopping a run yourself taught the
    // bandit that the model and effort it had chosen were good ones.
    if (entry.interruptRequested && status === 'succeeded') {
      status = 'interrupted';
      error = error ?? 'The run was stopped.';
    }

    // The SDK reports API duration; wall-clock is what the operator experiences.
    usage.durationMs = Date.now() - startedAt;

    return {
      status,
      usage,
      error,
      finalText: state.finalText,
      claudeSessionId,
      servedModel,
      rewindPoint,
    };
  }

  /**
   * Restore a finished run's files, or preview what that would do.
   *
   * The interesting constraint is that the run is over. Every other control
   * method here acts on a handle in `this.live`, which by definition only
   * exists while the subprocess is running — and an operator does not know a
   * run made a mess until it has finished. So this opens a *new* session,
   * resumed onto the same CLI session id, purely to issue one control request.
   * The checkpoints live with the session rather than with the process, which
   * is what makes that work.
   *
   * Three options are load-bearing and none is optional: `resume` names the
   * session the checkpoints belong to, `cwd` is the directory their paths are
   * recorded against, and the CLI will not serve a rewind for a session it did
   * not open with checkpointing enabled.
   *
   * Never throws. It is reached from a button the operator pressed to recover
   * from something that had already gone wrong; a rejected promise there
   * becomes a 500 on top of the mess they were trying to clean up.
   */
  async rewind(params: {
    claudeSessionId: string;
    rewindPoint: string;
    workspacePath: string;
    dryRun: boolean;
  }): Promise<RewindResult> {
    try {
      return await this.probe(
        {
          cwd: params.workspacePath,
          resume: params.claudeSessionId,
          enableFileCheckpointing: true,
        },
        async (handle) => {
          const result = await handle.rewindFiles(params.rewindPoint, { dryRun: params.dryRun });
          return {
            canRewind: result.canRewind,
            error: result.error ?? null,
            filesChanged: result.filesChanged ?? [],
            insertions: result.insertions ?? 0,
            deletions: result.deletions ?? 0,
            // Only a real rewind can report this; the SDK never sets it on a
            // preview, and inventing a zero there would read as "nothing was
            // skipped" for a question that was not asked.
            skippedLinks: params.dryRun ? 0 : (result.skippedLinks ?? 0),
            applied: !params.dryRun && result.canRewind,
          };
        },
      );
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      this.deps.log('warn', 'rewind failed', { message });
      return {
        canRewind: false,
        error: message,
        filesChanged: [],
        insertions: 0,
        deletions: 0,
        skippedLinks: 0,
        applied: false,
      };
    }
  }

  /**
   * What this CLI offers in this workspace.
   *
   * Metaclaude used to describe Claude's capabilities from a list written when
   * the page was built — three model names and their prices. The CLI knows the
   * real answer, and it changes without a Metaclaude release: which models the
   * subscription grants and which take an effort level, which slash commands
   * and subagents exist here, and — the one nothing else could tell an operator
   * — whether each configured MCP server actually connected.
   *
   * Asked in the workspace directory, because that is what the answer depends
   * on: skills, subagents and MCP servers are all discovered relative to `cwd`.
   *
   * Every question is asked independently and a failure costs only its own
   * answer. An older CLI supports some of these control requests and not
   * others, and losing the whole catalogue to one missing method is the wrong
   * trade. What failed is reported by name rather than swallowed, because an
   * empty list means something different depending on which it was.
   */
  async catalogue(workspacePath: string): Promise<ClaudeCatalogue> {
    const unavailable: string[] = [];
    const empty: ClaudeCatalogue = {
      models: [],
      commands: [],
      agents: [],
      mcpServers: [],
      account: null,
      unavailable,
      fetchedAt: Date.now(),
    };

    /** Ask one question; on failure record its name and carry on. */
    const ask = async <T>(name: string, read: () => Promise<T>): Promise<T | null> => {
      try {
        return await read();
      } catch (error) {
        unavailable.push(name);
        this.deps.log('debug', `the CLI could not answer "${name}"`, {
          message: (error as Error).message,
        });
        return null;
      }
    };

    try {
      return await this.probe({ cwd: workspacePath }, async (handle) => {
        // Concurrent: these are independent control requests on one channel,
        // and asking in series would multiply the round trips by five for no
        // benefit.
        const [models, commands, agents, mcpServers, account] = await Promise.all([
          ask('models', () => handle.supportedModels()),
          ask('commands', () => handle.supportedCommands()),
          ask('agents', () => handle.supportedAgents()),
          ask('mcpServers', () => handle.mcpServerStatus()),
          ask('account', () => handle.accountInfo()),
        ]);

        return {
          models: (models ?? []).map((model) => ({
            value: model.value,
            displayName: model.displayName,
            description: model.description ?? '',
            resolvedModel: model.resolvedModel ?? null,
            supportsEffort: model.supportsEffort ?? false,
            supportedEffortLevels: (model.supportedEffortLevels ?? []) as ClaudeCatalogue['models'][number]['supportedEffortLevels'],
            supportsAdaptiveThinking: model.supportsAdaptiveThinking ?? false,
          })),
          commands: (commands ?? []).map((command) => ({
            name: command.name,
            description: command.description ?? '',
            argumentHint: command.argumentHint ?? '',
            aliases: command.aliases ?? [],
          })),
          agents: (agents ?? []).map((agent) => ({
            name: agent.name,
            description: agent.description ?? '',
            model: agent.model ?? null,
          })),
          mcpServers: (mcpServers ?? []).map((server) => ({
            name: server.name,
            status: server.status ?? 'unknown',
            error: server.error ?? null,
            serverName: server.serverInfo?.name ?? null,
            serverVersion: server.serverInfo?.version ?? null,
            scope: server.scope ?? null,
            tools: (server.tools ?? []).map((tool) => ({
              name: tool.name,
              description: tool.description ?? '',
              readOnly: tool.annotations?.readOnly ?? null,
              destructive: tool.annotations?.destructive ?? null,
            })),
          })),
          // Narrowed on purpose. The account also carries the token source and
          // the API-key source, which describe how the credential was obtained
          // rather than which account it is — nothing an operator can act on,
          // and both are closer to the secret than to a fact about it.
          account: account
            ? {
                email: account.email ?? null,
                organization: account.organization ?? null,
                subscriptionType: account.subscriptionType ?? null,
                apiProvider: account.apiProvider ?? null,
              }
            : null,
          unavailable,
          fetchedAt: Date.now(),
        };
      });
    } catch (caught) {
      // The session itself could not be opened — no CLI on PATH, no
      // credentials. Reached from a page load, so an empty catalogue is a
      // missing panel and a rejection is a broken screen.
      this.deps.log('warn', 'could not read the CLI catalogue', {
        message: (caught as Error).message,
      });
      unavailable.push('session');
      return empty;
    }
  }

  /**
   * The in-process MCP server carrying the delegation tool.
   *
   * The tool call itself still flows through `canUseTool` like any other, so
   * the permission prompt shows exactly which workspace is being asked and
   * what — a delegation is a full run of someone else's agent, and the
   * human gets to say no to each one.
   */
  private buildDelegationServer(request: RunRequest): ReturnType<typeof createSdkMcpServer> {
    return createSdkMcpServer({
      name: 'metaclaude',
      version: '1.0.0',
      tools: [
        sdkTool(
          'delegate',
          'Ask another workspace of this Metaclaude instance to work on something and return its answer. ' +
            'The target runs with its own memory, skills, conventions and permission mode — use this to ' +
            'consult a project through its own agent rather than reading its files cold. Costs a full run ' +
            'there, and the answer can take minutes. The target cannot delegate further.',
          {
            workspace: z.string().describe("The target workspace's slug, exactly as listed."),
            prompt: z
              .string()
              .describe('What to ask. Self-contained — the target does not see this conversation.'),
          },
          async (args) => {
            try {
              const result = await this.deps.delegate!({
                fromWorkspaceId: request.workspace.id,
                fromTriggeredBy: request.triggeredBy,
                target: args.workspace,
                prompt: args.prompt,
              });
              if (result.status !== 'succeeded') {
                return {
                  content: [
                    {
                      type: 'text',
                      text: `The delegated run ${result.status}${result.error ? `: ${result.error}` : '.'}`,
                    },
                  ],
                  isError: true,
                };
              }
              return {
                content: [
                  {
                    type: 'text',
                    text: result.finalText || 'The delegated run finished without a final message.',
                  },
                ],
              };
            } catch (error) {
              return {
                content: [{ type: 'text', text: (error as Error).message }],
                isError: true,
              };
            }
          },
        ),
      ],
    });
  }

  /**
   * The subscription's quota picture, from the CLI's own usage endpoint.
   *
   * The SDK method is experimental and says so in its name; this wrapper is
   * the one place allowed to call it, and it maps the answer into the stable
   * `ClaudeUsage` contract so a shape change lands here, in one file with
   * tests, rather than in the screen. A CLI without the method is a missing
   * panel (`unavailable: ['usage']`), never a broken screen.
   */
  async usage(workspacePath: string): Promise<ClaudeUsage> {
    const unavailable: string[] = [];
    const empty: ClaudeUsage = {
      subscriptionType: null,
      windows: [],
      extraUsage: null,
      behaviors: null,
      unavailable,
      fetchedAt: Date.now(),
    };

    /** ISO 8601 or null → epoch millis or null; a malformed stamp is null too. */
    const at = (iso: string | null | undefined): number | null => {
      if (!iso) return null;
      const parsed = Date.parse(iso);
      return Number.isNaN(parsed) ? null : parsed;
    };

    const share = (
      entries: Array<{ name: string; pct: number }> | undefined,
    ): Array<{ name: string; pct: number }> =>
      (entries ?? []).map(({ name, pct }) => ({ name, pct }));

    try {
      return await this.probe({ cwd: workspacePath }, async (handle) => {
        let answer: SDKControlGetUsageResponse;
        try {
          answer = await handle.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET();
        } catch (error) {
          unavailable.push('usage');
          this.deps.log('debug', 'the CLI could not answer "usage"', {
            message: (error as Error).message,
          });
          return { ...empty, fetchedAt: Date.now() };
        }

        const limits = answer.rate_limits;
        const windows: ClaudeUsage['windows'] = [];
        if (!answer.rate_limits_available || !limits) {
          // API key, Bedrock, Vertex — plans without windows. Named so the
          // screen can say "does not apply" instead of rendering nothing.
          unavailable.push('rate_limits');
        } else {
          const named: Array<[key: string, label: string]> = [
            ['five_hour', 'Session (5 h)'],
            ['seven_day', 'Week — all models'],
            ['seven_day_oauth_apps', 'Week — connected apps'],
            ['seven_day_opus', 'Week — Opus'],
            ['seven_day_sonnet', 'Week — Sonnet'],
          ];
          for (const [key, label] of named) {
            const window = limits[key as 'five_hour'];
            // null and absent both mean "no such bucket on this plan" — which
            // is not a bucket at 0%.
            if (!window) continue;
            windows.push({
              key,
              label,
              utilization: window.utilization ?? null,
              resetsAt: at(window.resets_at),
            });
          }
          for (const bucket of limits.model_scoped ?? []) {
            windows.push({
              key: `model:${bucket.display_name}`,
              label: bucket.display_name,
              utilization: bucket.utilization ?? null,
              resetsAt: at(bucket.resets_at),
            });
          }
        }

        const behaviorWindow = (
          window: NonNullable<SDKControlGetUsageResponse['behaviors']>['day'],
        ): NonNullable<ClaudeUsage['behaviors']>['day'] => ({
          requestCount: window.request_count,
          sessionCount: window.session_count,
          behaviors: window.behaviors.map(({ key, pct, count }) => ({ key, pct, count })),
          agents: share(window.agents),
          skills: share(window.skills),
          plugins: share(window.plugins),
          mcpServers: share(window.mcp_servers),
        });

        return {
          subscriptionType: answer.subscription_type,
          windows,
          extraUsage:
            limits?.extra_usage != null
              ? {
                  isEnabled: limits.extra_usage.is_enabled,
                  monthlyLimit: limits.extra_usage.monthly_limit,
                  usedCredits: limits.extra_usage.used_credits,
                  utilization: limits.extra_usage.utilization,
                }
              : null,
          behaviors: answer.behaviors
            ? { day: behaviorWindow(answer.behaviors.day), week: behaviorWindow(answer.behaviors.week) }
            : null,
          unavailable,
          fetchedAt: Date.now(),
        };
      });
    } catch (caught) {
      this.deps.log('warn', 'could not read the CLI usage', {
        message: (caught as Error).message,
      });
      unavailable.push('session');
      return { ...empty, fetchedAt: Date.now() };
    }
  }

  /**
   * Open a short-lived session, ask it something, and make sure it goes away.
   *
   * Shared by `rewind` and `catalogue`, which have the same awkward shape: the
   * SDK's control methods live on a `Query` handle, every one of them is
   * documented "only supported when streaming input is used", and both of these
   * questions are asked when no run is in flight.
   *
   * Two details are not obvious and both are load-bearing. The message stream
   * has to be *drained*, because that is what pumps the control channel — a
   * request issued against an un-iterated handle waits forever on a reply
   * nobody is reading. And the session has to be aborted, not merely closed:
   * closing the input asks the subprocess to exit, and the first version of
   * this awaited the message stream ending as proof it had. It hung.
   */
  private async probe<T>(
    options: Pick<Options, 'cwd' | 'resume' | 'enableFileCheckpointing'>,
    ask: (handle: Query) => Promise<T>,
  ): Promise<T> {
    const stream = new PromptStream();
    const controller = new AbortController();

    const handle = (this.deps.query ?? sdkQuery)({
      prompt: stream,
      options: {
        ...options,
        abortController: controller,
        env: this.deps.env,
        ...(this.deps.claudeBinPath ? { pathToClaudeCodeExecutable: this.deps.claudeBinPath } : {}),
      },
    });

    const drained = (async () => {
      try {
        for await (const message of handle) void message;
      } catch (error) {
        // Ends on the abort below; that is the expected way out, not a fault.
        this.deps.log('debug', 'probe session ended', { message: (error as Error).message });
      }
    })();

    try {
      return await ask(handle);
    } finally {
      // Close first so a CLI that exits cleanly does; abort so one that does
      // not still goes. Awaiting the drain after both keeps the subprocess from
      // outliving the request that spawned it.
      stream.close();
      controller.abort();
      await drained;
    }
  }

}

/* -------------------------------------------------------------------------- */
/* Stream translation                                                          */
/* -------------------------------------------------------------------------- */

interface Captured {
  claudeSessionId?: string;
  servedModel?: string;
  usage?: RunUsage;
  error?: string;
  rewindPoint?: string;
  /**
   * The turn is over — a `result` arrived.
   *
   * `Query` is an AsyncGenerator, and under streaming input the CLI does not
   * end it when a turn finishes: it waits for the next user message. So the
   * loop cannot wait for the generator to end on its own, and this is what
   * tells it the run is done.
   */
  finished?: boolean;
}

/**
 * Converts the SDK message stream into transcript events.
 *
 * Kept as a separate class so it can be unit-tested against recorded message
 * fixtures without spawning a CLI.
 */
export class StreamState {
  /** Tool calls awaiting their result, keyed by `tool_use_id`. */
  private readonly openToolCalls = new Map<string, TranscriptEvent & { kind: 'tool_call' }>();
  /** Block counter per assistant message id, to reconstruct stream indices. */
  private readonly blockIndex = new Map<string, number>();
  /**
   * Message id currently streaming, **per agent**.
   *
   * Keyed by `parent_tool_use_id` because subagents stream concurrently: with a
   * single shared value, subagent A's `message_start` followed by subagent B's
   * delta keys B's text under A's message id. The authoritative event then
   * arrives under B's id, so the client never evicts the orphaned buffer and
   * the text renders twice, interleaved.
   */
  private readonly streamingMessageIds = new Map<string, string>();
  private seq = 0;
  finalText = '';

  constructor(
    private readonly request: RunRequest,
    private readonly callbacks: SupervisorCallbacks,
  ) {
    // The user's own prompt opens the transcript.
    this.emit({
      kind: 'user_message',
      id: newId('event'),
      runId: request.runId,
      seq: this.seq++,
      at: Date.now(),
      text: request.prompt,
      attachments: request.attachments.map((attachment) => ({
        name: attachment.name,
        path: attachment.path,
        bytes: attachment.bytes,
        attachmentId: attachment.id,
        mime: attachment.mime,
      })),
    });
  }

  handle(message: SDKMessage): Captured {
    switch (message.type) {
      case 'system':
        return this.handleSystem(message);
      case 'assistant':
        return this.handleAssistant(message);
      case 'user':
        return this.handleUser(message);
      case 'stream_event':
        return this.handleStreamEvent(message);
      case 'result':
        return this.handleResult(message);
      default:
        // Everything else the CLI says about itself. This used to be a bare
        // `return {}`, which is how a run that stalled on an API retry, lost
        // its context to a compaction, or stopped working because a
        // subscription limit was reached all looked like faults in Metaclaude:
        // the explanation arrived and was thrown away. `narrate` decides what
        // is worth a line and what is a heartbeat.
        return this.narrateAside(message);
    }
  }

  /**
   * Record an out-of-band CLI message, if it says anything.
   *
   * Shared by the `default` branch and by `handleSystem`, because the CLI puts
   * most of these behind `type: 'system'` with a distinct subtype rather than
   * at the top level.
   */
  private narrateAside(message: SDKMessage): Captured {
    const note = narrate(message);
    if (!note) return {};

    this.emit({
      kind: 'system',
      id: newId('event'),
      runId: this.request.runId,
      seq: this.seq++,
      at: Date.now(),
      level: note.level,
      message: note.message,
      ...(note.data ? { data: note.data } : {}),
    });
    return {};
  }

  /* ------------------------------------------------------------------ */

  private handleSystem(message: Extract<SDKMessage, { type: 'system' }>): Captured {
    if (message.subtype === 'init') {
      return { claudeSessionId: message.session_id, servedModel: message.model };
    }
    if (message.subtype === 'permission_denied') {
      // The narrowing above already gives this the SDK's own
      // `SDKPermissionDeniedMessage`, with `tool_name`, `tool_use_id` and
      // `message` on it. Restating that shape as a cast bought nothing and hid
      // a rename: `as unknown as` silences exactly the error worth having.
      const denied = message;
      const open = this.openToolCalls.get(denied.tool_use_id);
      if (open) {
        open.status = 'denied';
        open.result = denied.message;
        open.resultIsError = true;
        this.openToolCalls.delete(denied.tool_use_id);
        this.emit(open, true);
      } else {
        this.emit({
          kind: 'system',
          id: newId('event'),
          runId: this.request.runId,
          seq: this.seq++,
          at: Date.now(),
          level: 'warn',
          message: `${denied.tool_name} was denied: ${denied.message}`,
        });
      }
      return {};
    }
    // Every other system subtype — retries, compaction, refusals, hooks,
    // background tasks. `init` and `permission_denied` are handled above and
    // are on the narrator's ignore list, so they cannot be reported twice.
    return this.narrateAside(message);
  }

  private handleAssistant(message: Extract<SDKMessage, { type: 'assistant' }>): Captured {
    const messageId = message.message.id;
    const isSubagent = message.parent_tool_use_id !== null;

    for (const block of message.message.content) {
      const index = this.blockIndex.get(messageId) ?? 0;
      this.blockIndex.set(messageId, index + 1);
      const at = Date.now();

      if (block.type === 'text') {
        const text = block.text;
        if (!text.trim()) continue;
        // Subagent chatter is informative but must not be mistaken for the main
        // agent's answer, which is what reflexion and previews read.
        if (!isSubagent) this.finalText = text;
        this.emit({
          kind: 'assistant_text',
          id: streamEventId(messageId, index),
          runId: this.request.runId,
          seq: this.seq++,
          at,
          text,
          streaming: false,
        });
      } else if (block.type === 'thinking') {
        const thinking = (block as { thinking?: string }).thinking ?? '';
        if (!thinking.trim()) continue;
        this.emit({
          kind: 'thinking',
          id: streamEventId(messageId, index),
          runId: this.request.runId,
          seq: this.seq++,
          at,
          text: thinking,
          streaming: false,
        });
      } else if (block.type === 'tool_use') {
        const event: TranscriptEvent & { kind: 'tool_call' } = {
          kind: 'tool_call',
          id: newId('event'),
          runId: this.request.runId,
          seq: this.seq++,
          at,
          toolUseId: block.id,
          name: block.name,
          input: block.input,
          status: 'running',
          result: null,
          resultIsError: false,
          durationMs: null,
        };
        this.openToolCalls.set(block.id, event);
        this.emit(event);
      }
    }

    if (message.error) {
      return { error: `Model error: ${message.error}` };
    }
    return {};
  }

  private handleUser(message: Extract<SDKMessage, { type: 'user' }>): Captured {
    // The replay acknowledgement: the CLI echoing back a user message with the
    // uuid it filed it under. That uuid is the only thing a rewind can be
    // addressed to, and it is never repeated, so it is picked up here on the
    // way past. Tool results arrive as `type: 'user'` too — hence the flag
    // rather than "the first user message we see", which would anchor a rewind
    // to the middle of the run.
    const replay = message as { isReplay?: boolean; uuid?: string };
    const captured: Captured =
      replay.isReplay === true && typeof replay.uuid === 'string'
        ? { rewindPoint: replay.uuid }
        : {};

    const content = message.message.content;
    if (typeof content === 'string' || !Array.isArray(content)) return captured;

    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const typed = block as {
        type?: string;
        tool_use_id?: string;
        content?: unknown;
        is_error?: boolean;
      };
      if (typed.type !== 'tool_result' || !typed.tool_use_id) continue;

      const open = this.openToolCalls.get(typed.tool_use_id);
      if (!open) continue;

      open.status = typed.is_error ? 'error' : 'ok';
      open.result = truncateResult(renderToolResult(typed.content));
      open.resultIsError = Boolean(typed.is_error);
      open.durationMs = Date.now() - open.at;
      this.openToolCalls.delete(typed.tool_use_id);
      this.emit(open, true);

      // TodoWrite carries the agent's plan; surface it as its own event so the
      // UI can render a live checklist rather than a wall of JSON.
      if (open.name === 'TodoWrite') this.emitTodo(open.input);
    }
    return captured;
  }

  private emitTodo(input: unknown): void {
    const todos = (input as { todos?: unknown })?.todos;
    if (!Array.isArray(todos)) return;
    const items = todos
      .filter((t): t is Record<string, unknown> => typeof t === 'object' && t !== null)
      .map((t) => ({
        content: String(t.content ?? ''),
        status: (['pending', 'in_progress', 'completed'] as const).includes(
          t.status as 'pending' | 'in_progress' | 'completed',
        )
          ? (t.status as 'pending' | 'in_progress' | 'completed')
          : ('pending' as const),
        ...(typeof t.activeForm === 'string' ? { activeForm: t.activeForm } : {}),
      }));
    if (items.length === 0) return;

    this.emit({
      kind: 'todo',
      id: newId('event'),
      runId: this.request.runId,
      seq: this.seq++,
      at: Date.now(),
      items,
    });
  }

  private handleStreamEvent(message: Extract<SDKMessage, { type: 'stream_event' }>): Captured {
    const event = message.event as {
      type?: string;
      index?: number;
      message?: { id?: string };
      delta?: { type?: string; text?: string; thinking?: string };
    };

    // '' is the main agent; a subagent is keyed by the Task call that spawned it.
    const agent = message.parent_tool_use_id ?? '';

    if (event.type === 'message_start') {
      const id = event.message?.id;
      if (id) this.streamingMessageIds.set(agent, id);
      else this.streamingMessageIds.delete(agent);
      return {};
    }

    if (event.type === 'content_block_delta' && typeof event.index === 'number') {
      const messageId = this.streamingMessageIds.get(agent);
      if (!messageId) return {};
      const eventId = streamEventId(messageId, event.index);

      if (event.delta?.type === 'text_delta' && event.delta.text) {
        this.callbacks.onDelta(eventId, 'assistant_text', event.delta.text);
      } else if (event.delta?.type === 'thinking_delta' && event.delta.thinking) {
        this.callbacks.onDelta(eventId, 'thinking', event.delta.thinking);
      }
    }
    return {};
  }

  private handleResult(message: Extract<SDKMessage, { type: 'result' }>): Captured {
    // `modelUsage` covers subagents and internal calls; `usage` is main-loop
    // only. We report the former, which is what actually gets billed.
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheCreationTokens = 0;

    for (const entry of Object.values(message.modelUsage ?? {})) {
      inputTokens += entry.inputTokens ?? 0;
      outputTokens += entry.outputTokens ?? 0;
      cacheReadTokens += entry.cacheReadInputTokens ?? 0;
      cacheCreationTokens += entry.cacheCreationInputTokens ?? 0;
    }

    // Fall back to the main-loop `usage` field when `modelUsage` is absent,
    // which happens on crash results and on older CLI builds.
    if (inputTokens === 0 && outputTokens === 0 && message.usage) {
      inputTokens = message.usage.input_tokens ?? 0;
      outputTokens = message.usage.output_tokens ?? 0;
      cacheReadTokens = message.usage.cache_read_input_tokens ?? 0;
      cacheCreationTokens = message.usage.cache_creation_input_tokens ?? 0;
    }

    const usage: RunUsage = {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      costUsd: message.total_cost_usd ?? 0,
      durationMs: message.duration_ms ?? 0,
      turns: message.num_turns ?? 0,
    };

    // `subtype: 'success'` only means the turn completed the protocol — it can
    // still carry `is_error: true`, with the API's error text in `result`.
    // Treating that as a success recorded the error message as the assistant's
    // answer, gave the run a 0.8 quality score, taught the bandit the arm
    // worked, and fed the error string to reflexion as a lesson.
    if (message.subtype === 'success' && !message.is_error) {
      if (message.result.trim()) this.finalText = message.result;
      return { usage, claudeSessionId: message.session_id, finished: true };
    }

    return {
      usage,
      claudeSessionId: message.session_id,
      error: describeResultError(message),
      finished: true,
    };
  }

  /** Close out any tool call still marked running when the stream ended. */
  finalise(): void {
    for (const open of this.openToolCalls.values()) {
      open.status = 'error';
      open.result = 'The run ended before this tool produced a result.';
      open.resultIsError = true;
      this.emit(open, true);
    }
    this.openToolCalls.clear();
  }

  private emit(event: TranscriptEvent, isUpdate = false): void {
    this.callbacks.onEvent(event, isUpdate);
  }

  /** Next sequence number, for the kernel's own `result` event. */
  nextSeq(): number {
    return this.seq++;
  }
}

function describeResultError(message: Extract<SDKMessage, { type: 'result' }>): string {
  const subtype = (message as { subtype?: string }).subtype ?? 'error';

  // The detail lives in different places depending on the shape: a successful
  // turn that carried an API error puts it in `result`, while an error result
  // carries `errors[]` and has no `result` field at all. Reading only `result`
  // discarded every genuine diagnostic.
  const detail =
    (message as { result?: string }).result?.trim() ||
    ((message as { errors?: string[] }).errors ?? []).join('; ').trim() ||
    '';

  switch (subtype) {
    case 'error_max_turns':
      return 'The run stopped after reaching its maximum number of turns. Raise the limit in workspace settings or narrow the task.';
    // The SDK's subtype is `error_max_budget_usd`; the shorter spelling never
    // matched, so budget exhaustion fell through to the generic message.
    case 'error_max_budget_usd':
    case 'error_max_budget':
      return 'The run stopped after reaching its cost ceiling for this workspace.';
    case 'error_during_execution':
      return detail || 'The agent stopped with an execution error.';
    default:
      return detail || `The run ended with status "${subtype}".`;
  }
}
