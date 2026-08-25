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

import { query, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type {
  RunPolicy,
  RunUsage,
  TranscriptEvent,
  Workspace,
} from '@metaclaude/shared';
import { MAX_TOOL_RESULT_CHARS, newId } from '@metaclaude/shared';
import { createHash } from 'node:crypto';
import type { PermissionBroker } from './permissions.js';

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
  abortSignal: AbortSignal;
}

export interface RunOutcome {
  status: 'succeeded' | 'failed' | 'interrupted';
  usage: RunUsage;
  error: string | null;
  /** The assistant's final message, used for reflexion and previews. */
  finalText: string;
  claudeSessionId: string | null;
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
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
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

  /** Build the SDK options for a run. Exported shape is covered by tests. */
  buildOptions(request: RunRequest): Options {
    const { workspace, policy } = request;
    const settings = workspace.settings;

    const permissionMode =
      policy.permissionMode === 'bypassPermissions' && !this.deps.allowBypassPermissions
        ? 'default'
        : policy.permissionMode;

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
      env: this.deps.env,

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
    if (settings.additionalDirectories.length > 0) {
      options.additionalDirectories = settings.additionalDirectories;
    }
    if (settings.checkpointing) options.enableFileCheckpointing = true;

    if (Object.keys(request.mcpServers).length > 0) {
      options.mcpServers = request.mcpServers as Options['mcpServers'];
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
   * Execute a run to completion.
   *
   * Never throws for an agent-side failure — a failed run is a normal outcome
   * that must be recorded, not an exception that unwinds the kernel.
   */
  async execute(request: RunRequest, callbacks: SupervisorCallbacks): Promise<RunOutcome> {
    const startedAt = Date.now();
    const controller = new AbortController();

    // Chain the caller's signal into ours so either can stop the run.
    const onExternalAbort = (): void => controller.abort();
    request.abortSignal.addEventListener('abort', onExternalAbort, { once: true });

    const timeout = setTimeout(() => controller.abort(), this.deps.runTimeoutMs);
    timeout.unref?.();

    const options = this.buildOptions(request);
    options.abortController = controller;

    const state = new StreamState(request, callbacks);
    let claudeSessionId: string | null = null;
    let usage: RunUsage = { ...EMPTY_USAGE };
    let error: string | null = null;
    let status: RunOutcome['status'] = 'succeeded';
    let timedOut = false;

    const timeoutWatcher = setTimeout(() => {
      timedOut = true;
    }, this.deps.runTimeoutMs);
    timeoutWatcher.unref?.();

    try {
      for await (const message of query({ prompt: request.prompt, options })) {
        const captured = state.handle(message);
        if (captured.claudeSessionId) {
          claudeSessionId = captured.claudeSessionId;
          callbacks.onClaudeSessionId(captured.claudeSessionId);
        }
        if (captured.usage) usage = captured.usage;
        if (captured.error) {
          error = captured.error;
          status = 'failed';
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
      clearTimeout(timeoutWatcher);
      request.abortSignal.removeEventListener('abort', onExternalAbort);
      state.finalise();
    }

    // The SDK reports API duration; wall-clock is what the operator experiences.
    usage.durationMs = Date.now() - startedAt;

    return { status, usage, error, finalText: state.finalText, claudeSessionId };
  }
}

/* -------------------------------------------------------------------------- */
/* Stream translation                                                          */
/* -------------------------------------------------------------------------- */

interface Captured {
  claudeSessionId?: string;
  usage?: RunUsage;
  error?: string;
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
  /** Message id currently being streamed, from the last `message_start`. */
  private streamingMessageId: string | null = null;
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
      attachments: [],
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
        return {};
    }
  }

  /* ------------------------------------------------------------------ */

  private handleSystem(message: Extract<SDKMessage, { type: 'system' }>): Captured {
    if (message.subtype === 'init') {
      return { claudeSessionId: message.session_id };
    }
    if (message.subtype === 'permission_denied') {
      const denied = message as unknown as { tool_name: string; message: string; tool_use_id: string };
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
    }
    return {};
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
    const content = message.message.content;
    if (typeof content === 'string' || !Array.isArray(content)) return {};

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
    return {};
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

    if (event.type === 'message_start') {
      this.streamingMessageId = event.message?.id ?? null;
      return {};
    }

    if (event.type === 'content_block_delta' && typeof event.index === 'number') {
      const messageId = this.streamingMessageId;
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

    if (message.subtype === 'success') {
      if (message.result.trim()) this.finalText = message.result;
      return { usage, claudeSessionId: message.session_id };
    }

    return {
      usage,
      claudeSessionId: message.session_id,
      error: describeResultError(message),
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
  const detail = (message as { result?: string }).result;
  switch (subtype) {
    case 'error_max_turns':
      return 'The run stopped after reaching its maximum number of turns. Raise the limit in workspace settings or narrow the task.';
    case 'error_max_budget':
      return 'The run stopped after reaching its cost ceiling for this workspace.';
    case 'error_during_execution':
      return detail?.trim() || 'The agent stopped with an execution error.';
    default:
      return detail?.trim() || `The run ended with status "${subtype}".`;
  }
}
