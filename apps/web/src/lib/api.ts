/**
 * Typed API client.
 *
 * A thin wrapper over `fetch` that handles the two cross-cutting concerns:
 * attaching the CSRF token to mutating requests, and turning a 401 into a
 * single, coordinated redirect to the login screen rather than a cascade of
 * failed queries each doing their own thing.
 */

import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import {
  CSRF_COOKIE,
  type AdvisorProposal,
  type AgentDefinitionRecord,
  type AnalyticsSummary,
  type ApprovalRequest,
  type Attachment,
  type AuditEntry,
  type ClaudeCredentialStatus,
  type ClaudePairingStart,
  type ClaudePairingState,
  type PushStatus,
  type RunGenesis,
  type PushSubscriptionInput,
  type ConnectRepositoryResult,
  type PluginRecord,
  type AuthSessionInfo,
  type Automation,
  type AutomationTrigger,
  type BoardTask,
  type TaskActivity,
  type TaskComment,
  type TaskPriority,
  type TaskStatus,
  type CreateMemoryRequest,
  type FileEntry,
  type GitStatus,
  type Insight,
  type ConnectorListingEntry,
  type GoogleConnectionState,
  type GoogleGrant,
  type KnowledgeDocumentMeta,
  type KnowledgeSearchHit,
  type SaveKnowledgeRequest,
  type LibraryListingEntry,
  type McpServerRecord,
  type Memory,
  type MemoryKind,
  type NoteBacklink,
  type NotesIndex,
  type MemorySearchResult,
  type PolicyArm,
  type ClaudeCatalogue,
  type ClaudeCliSession,
  type Brief,
  type ClaudeUsage,
  type DoctorReport,
  type Marketplace,
  type UpdateApplyStatus,
  type UpdateCheck,
  type MarketplaceCatalogue,
  type MarketplaceInput,
  type LoginResponse,
  type PasskeyRecord,
  type RewindResult,
  type Run,
  type Session,
  type SkillDefinition,
  type SystemHealth,
  type ToolControls,
  type TranscriptEvent,
  type UsagePoint,
  type User,
  type UserRole,
  type Workspace,
  type WorkspaceSettings,
} from '@metaclaude/shared';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  get isAuthError(): boolean {
    return this.status === 401;
  }
}

/** Registered by the app shell so a 401 anywhere lands on the login screen. */
let onUnauthenticated: (() => void) | null = null;
export function setUnauthenticatedHandler(handler: () => void): void {
  onUnauthenticated = handler;
}

/** Where an attachment's bytes are served — same-origin, cookie-authenticated. */
export function attachmentUrl(id: string): string {
  return `/api/attachments/${id}`;
}

/** Read the CSRF token the server set as a readable cookie at login. */
export function readCsrfToken(): string | null {
  const match = document.cookie.match(new RegExp(`(?:^|; )${CSRF_COOKIE}=([^;]*)`));
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

interface RequestOptions {
  method?: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  /** Suppress the global 401 handler — used by the session probe on boot. */
  quiet?: boolean;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json' };

  if (options.body !== undefined) headers['content-type'] = 'application/json';

  if (method !== 'GET' && method !== 'HEAD') {
    const csrf = readCsrfToken();
    if (csrf) headers['x-metaclaude-csrf'] = csrf;
  }

  const response = await fetch(path, {
    method,
    headers,
    // Same-origin only: the API and the app are served from one host.
    credentials: 'same-origin',
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { error: text.slice(0, 500) };
    }
  }

  if (!response.ok) {
    const detail = payload as { error?: string; code?: string } | null;
    const error = new ApiError(
      response.status,
      detail?.error ?? `Request failed with ${response.status}.`,
      detail?.code ?? 'error',
    );
    if (error.isAuthError && !options.quiet) onUnauthenticated?.();
    throw error;
  }

  return payload as T;
}

/** Build a query string, dropping undefined and empty values. */
function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const rendered = search.toString();
  return rendered ? `?${rendered}` : '';
}

/* -------------------------------------------------------------------------- */
/* Endpoints                                                                   */
/* -------------------------------------------------------------------------- */

export interface MeResponse {
  user: User;
  csrfToken: string | null;
  recoveryCodesRemaining: number;
}

export const api = {
  /* ------------------------------- Auth ------------------------------- */
  bootstrapStatus: () =>
    request<{ needsBootstrap: boolean; passkeysEnrolled: boolean }>('/api/auth/bootstrap-status'),

  login: (body: { username: string; password: string; totp?: string }) =>
    request<LoginResponse>('/api/auth/login', { method: 'POST', body }),

  logout: () => request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),

  me: (options?: { quiet?: boolean }) =>
    request<MeResponse>('/api/auth/me', { quiet: options?.quiet ?? false }),

  authSessions: () => request<{ sessions: AuthSessionInfo[] }>('/api/auth/sessions'),

  revokeAuthSession: (id: string) =>
    request<{ ok: boolean }>(`/api/auth/sessions/${id}`, { method: 'DELETE' }),

  revokeOtherSessions: () =>
    request<{ revoked: number }>('/api/auth/sessions/revoke-others', { method: 'POST' }),

  changePassword: (body: { currentPassword: string; newPassword: string }) =>
    request<{ ok: boolean; reauthenticate: boolean }>('/api/auth/password', {
      method: 'POST',
      body,
    }),

  // Enrolment replaces the second factor, so it costs a password just like
  // removing one does.
  totpBegin: (password: string) =>
    request<{ secret: string; uri: string }>('/api/auth/totp/begin', {
      method: 'POST',
      body: { password },
    }),
  totpCancel: () => request<{ ok: boolean }>('/api/auth/totp/cancel', { method: 'POST' }),
  totpConfirm: (code: string) =>
    request<{ recoveryCodes: string[] }>('/api/auth/totp/confirm', { method: 'POST', body: { code } }),
  totpDisable: (password: string) =>
    request<{ ok: boolean }>('/api/auth/totp/disable', { method: 'POST', body: { password } }),

  // Passkeys. The `response` payloads are whatever @simplewebauthn/browser
  // produced — passed through untouched, verified server-side.
  passkeys: {
    list: () => request<{ passkeys: PasskeyRecord[] }>('/api/auth/passkeys'),
    begin: (password: string) =>
      request<{ options: PublicKeyCredentialCreationOptionsJSON }>('/api/auth/passkeys/begin', {
        method: 'POST',
        body: { password },
      }),
    finish: (label: string, response: unknown) =>
      request<{ passkey: PasskeyRecord }>('/api/auth/passkeys/finish', {
        method: 'POST',
        body: { label, response },
      }),
    remove: (id: string, password: string) =>
      request<{ ok: boolean }>(`/api/auth/passkeys/${id}`, {
        method: 'DELETE',
        body: { password },
      }),
    loginBegin: () =>
      request<{ ceremonyId: string; options: PublicKeyCredentialRequestOptionsJSON }>(
        '/api/auth/passkey/begin',
        { method: 'POST' },
      ),
    loginFinish: (ceremonyId: string, response: unknown) =>
      request<{ status: 'ok'; user: User; csrfToken: string }>('/api/auth/passkey/finish', {
        method: 'POST',
        body: { ceremonyId, response },
      }),
  },

  users: () => request<{ users: User[] }>('/api/users'),
  createUser: (body: {
    username: string;
    password: string;
    role: UserRole;
    displayName?: string;
  }) =>
    request<{ user: User }>('/api/users', { method: 'POST', body }),

  /* ---------------------------- Workspaces ---------------------------- */
  workspaces: (includeArchived = false) =>
    request<{ workspaces: Workspace[] }>(`/api/workspaces${qs({ archived: includeArchived })}`),

  workspace: (id: string) =>
    request<{
      workspace: Workspace;
      gitStatus: GitStatus | null;
      sessions: Session[];
      memoryStats: Record<MemoryKind, number>;
    }>(`/api/workspaces/${id}`),

  createWorkspace: (body: {
    name: string;
    description?: string;
    color?: string;
    icon?: string;
    gitUrl?: string;
  }) => request<{ workspace: Workspace }>('/api/workspaces', { method: 'POST', body }),

  updateWorkspace: (
    id: string,
    body: Partial<Pick<Workspace, 'name' | 'description' | 'color' | 'icon' | 'archived'>> & {
      settings?: Partial<WorkspaceSettings>;
    },
  ) => request<{ workspace: Workspace }>(`/api/workspaces/${id}`, { method: 'PATCH', body }),

  deleteWorkspace: (id: string, purge: boolean) =>
    request<{ ok: boolean }>(`/api/workspaces/${id}${qs({ purge })}`, { method: 'DELETE' }),

  /* ------------------------------ Sessions ---------------------------- */
  createSession: (body: {
    workspaceId: string;
    title?: string;
    model?: string;
    effort?: string | null;
    permissionMode?: string;
    agentName?: string | null;
  }) => request<{ session: Session }>('/api/sessions', { method: 'POST', body }),

  session: (id: string) =>
    request<{
      session: Session;
      runs: Run[];
      events: TranscriptEvent[];
      pendingApprovals: ApprovalRequest[];
      isRunning: boolean;
    }>(`/api/sessions/${id}`),

  updateSession: (id: string, body: Record<string, unknown>) =>
    request<{ session: Session }>(`/api/sessions/${id}`, { method: 'PATCH', body }),

  deleteSession: (id: string) =>
    request<{ ok: boolean }>(`/api/sessions/${id}`, { method: 'DELETE' }),

  submitRun: (
    sessionId: string,
    body: {
      prompt: string;
      model?: string;
      effort?: string | null;
      permissionMode?: string;
      agentName?: string | null;
      ultracode?: boolean;
      toolControls?: ToolControls;
      attachmentIds?: string[];
    },
  ) => request<{ run: Run }>(`/api/sessions/${sessionId}/runs`, { method: 'POST', body }),

  /* ------------------------------- Board ------------------------------- */

  board: (workspaceId: string) =>
    request<{ tasks: BoardTask[] }>(`/api/workspaces/${workspaceId}/board`),

  workBoard: (workspaceId: string) =>
    request<{ started: BoardTask | null; reason: 'started' | 'busy' | 'empty' | 'quota' | 'off' }>(
      `/api/workspaces/${workspaceId}/board/work`,
      { method: 'POST', body: {} },
    ),

  tasks: (params: {
    workspaceId?: string;
    status?: TaskStatus;
    assignee?: 'user' | 'agent';
    archived?: boolean;
    limit?: number;
    offset?: number;
  }) => request<{ tasks: BoardTask[] }>(`/api/tasks${qs(params)}`),

  task: (id: string) =>
    request<{
      task: BoardTask;
      run: Run | null;
      comments: TaskComment[];
      activity: TaskActivity[];
      children: BoardTask[];
    }>(`/api/tasks/${id}`),

  runTask: (id: string) =>
    request<{ run: Run; task: BoardTask }>(`/api/tasks/${id}/run`, { method: 'POST' }),

  createTask: (
    workspaceId: string,
    body: {
      title: string;
      description?: string;
      status?: TaskStatus;
      priority?: TaskPriority;
      parentId?: string | null;
      assignee?: 'user' | 'agent' | null;
      dueAt?: number | null;
    },
  ) => request<{ task: BoardTask }>(`/api/workspaces/${workspaceId}/tasks`, { method: 'POST', body }),

  updateTask: (
    id: string,
    body: {
      title?: string;
      description?: string;
      priority?: TaskPriority;
      assignee?: 'user' | 'agent' | null;
      dueAt?: number | null;
      blockedReason?: string | null;
    },
  ) => request<{ task: BoardTask }>(`/api/tasks/${id}`, { method: 'PATCH', body }),

  moveTask: (id: string, body: { status: TaskStatus; afterId?: string | null }) =>
    request<{ task: BoardTask }>(`/api/tasks/${id}/move`, { method: 'POST', body }),

  archiveTask: (id: string) =>
    request<{ task: BoardTask }>(`/api/tasks/${id}/archive`, { method: 'POST' }),

  restoreTask: (id: string) =>
    request<{ task: BoardTask }>(`/api/tasks/${id}/restore`, { method: 'POST' }),

  deleteTask: (id: string) => request<{ ok: boolean }>(`/api/tasks/${id}`, { method: 'DELETE' }),

  commentTask: (id: string, body: string) =>
    request<{ comment: TaskComment }>(`/api/tasks/${id}/comments`, { method: 'POST', body: { body } }),

  uploadAttachment: (sessionId: string, body: { name: string; mime: string; data: string }) =>
    request<{ attachment: Attachment }>(`/api/sessions/${sessionId}/attachments`, {
      method: 'POST',
      body,
    }),

  deleteAttachment: (id: string) =>
    request<{ ok: boolean }>(`/api/attachments/${id}`, { method: 'DELETE' }),

  interrupt: (sessionId: string) =>
    request<{ interrupted: boolean }>(`/api/sessions/${sessionId}/interrupt`, { method: 'POST' }),

  run: (id: string) => request<{ run: Run; events: TranscriptEvent[] }>(`/api/runs/${id}`),

  rateRun: (id: string, rating: number) =>
    request<{ run: Run }>(`/api/runs/${id}/rate`, { method: 'POST', body: { rating } }),

  /**
   * What the CLI itself offers here: models, commands, subagents, MCP status.
   *
   * `refresh` skips the server's cache — for the operator who has just fixed an
   * MCP server's command and wants to know whether it worked.
   */
  claudeCatalogue: (params: { workspaceId?: string; refresh?: boolean } = {}) =>
    request<ClaudeCatalogue>(`/api/claude/catalogue${qs(params)}`),

  /** The subscription's quota windows, as the CLI itself reports them. */
  claudeUsage: (params: { workspaceId?: string; refresh?: boolean } = {}) =>
    request<ClaudeUsage>(`/api/claude/usage${qs(params)}`),

  /** Every self-check the system knows how to run, in one report. Owner-only. */
  doctor: () => request<DoctorReport>('/api/system/doctor'),

  /** The morning brief — what happened, what needs a human. Owner-only. */
  brief: () => request<Brief>('/api/brief'),

  /** Is a newer release published? Informational only — deploys stay tag-driven. */
  updateApplyStatus: () => request<UpdateApplyStatus>('/api/system/update-apply'),

  applyUpdate: (version: string) =>
    request<{ ok: boolean }>('/api/system/update-apply', { method: 'POST', body: { version } }),

  updateCheck: (refresh = false) =>
    request<UpdateCheck | { disabled: true }>(`/api/system/update-check${qs({ refresh })}`),

  /**
   * The CLI's own transcript store for a workspace's directory — including
   * sessions that never went through Metaclaude — and adoption, which binds
   * one to a fresh Metaclaude session.
   */
  claudeCliSessions: (workspaceId: string) =>
    request<{ sessions: ClaudeCliSession[] }>(`/api/claude/sessions${qs({ workspaceId })}`),

  adoptCliSession: (workspaceId: string, claudeSessionId: string) =>
    request<{ session: Session }>('/api/claude/sessions/adopt', {
      method: 'POST',
      body: { workspaceId, claudeSessionId },
    }),

  /** Preview (`dryRun`) or perform the restore of a run's file changes. */
  rewindRun: (id: string, dryRun: boolean) =>
    request<RewindResult>(`/api/runs/${id}/rewind`, { method: 'POST', body: { dryRun } }),

  runs: (params: { workspaceId?: string; limit?: number; since?: number } = {}) =>
    request<{ runs: Run[] }>(`/api/runs${qs(params)}`),

  /* ----------------------------- Approvals ---------------------------- */
  approvals: () => request<{ approvals: ApprovalRequest[] }>('/api/approvals'),

  decideApproval: (id: string, body: { approved: boolean; remember?: boolean; reason?: string }) =>
    request<{ ok: boolean }>(`/api/approvals/${id}`, { method: 'POST', body }),

  /* ------------------------------- Files ------------------------------ */
  files: (workspaceId: string, path = '', hidden = false) =>
    request<{ path: string; entries: FileEntry[] }>(
      `/api/workspaces/${workspaceId}/files${qs({ path, hidden })}`,
    ),

  readFile: (workspaceId: string, path: string) =>
    request<{
      path: string;
      content: string;
      language: string | null;
      size: number;
      truncated: boolean;
      modifiedAt: number;
    }>(`/api/workspaces/${workspaceId}/file${qs({ path })}`),

  writeFile: (workspaceId: string, path: string, content: string) =>
    request<{ entry: FileEntry }>(`/api/workspaces/${workspaceId}/file`, {
      method: 'PUT',
      body: { path, content },
    }),

  deleteFile: (workspaceId: string, path: string) =>
    request<{ ok: boolean }>(`/api/workspaces/${workspaceId}/file${qs({ path })}`, {
      method: 'DELETE',
    }),

  createDirectory: (workspaceId: string, path: string) =>
    request<{ ok: boolean }>(`/api/workspaces/${workspaceId}/directory`, {
      method: 'POST',
      body: { path },
    }),

  searchFiles: (workspaceId: string, q: string, limit = 40) =>
    request<{ entries: FileEntry[] }>(`/api/workspaces/${workspaceId}/search${qs({ q, limit })}`),

  /* ------------------------------- Notes ------------------------------- */
  notesGraph: (workspaceId: string) =>
    request<NotesIndex>(`/api/workspaces/${workspaceId}/notes/graph`),

  noteBacklinks: (workspaceId: string, path: string) =>
    request<{ backlinks: NoteBacklink[] }>(
      `/api/workspaces/${workspaceId}/notes/backlinks${qs({ path })}`,
    ),

  /* -------------------------------- Git ------------------------------- */
  gitStatus: (workspaceId: string) =>
    request<GitStatus>(`/api/workspaces/${workspaceId}/git/status`),

  gitDiff: (workspaceId: string, params: { path?: string; staged?: boolean } = {}) =>
    request<{ diff: string; files: Array<{ path: string; additions: number; deletions: number }> }>(
      `/api/workspaces/${workspaceId}/git/diff${qs(params)}`,
    ),

  gitLog: (workspaceId: string, limit = 30) =>
    request<{ commits: Array<{ hash: string; author: string; date: number; subject: string }> }>(
      `/api/workspaces/${workspaceId}/git/log${qs({ limit })}`,
    ),

  gitStage: (workspaceId: string, paths: string[]) =>
    request<{ ok: boolean }>(`/api/workspaces/${workspaceId}/git/stage`, {
      method: 'POST',
      body: { paths },
    }),

  gitUnstage: (workspaceId: string, paths: string[]) =>
    request<{ ok: boolean }>(`/api/workspaces/${workspaceId}/git/unstage`, {
      method: 'POST',
      body: { paths },
    }),

  gitCommit: (workspaceId: string, message: string) =>
    request<{ hash: string }>(`/api/workspaces/${workspaceId}/git/commit`, {
      method: 'POST',
      body: { message },
    }),

  /* ------------------------------ Memory ------------------------------ */
  memory: (
    params: {
      workspaceId?: string;
      kind?: MemoryKind;
      search?: string;
      limit?: number;
      offset?: number;
      scope?: 'global';
    } = {},
  ) =>
    request<{ memories: Memory[]; stats: Record<MemoryKind, number>; total: number }>(
      `/api/memory${qs(params)}`,
    ),

  searchMemory: (q: string, workspaceId?: string, limit = 10) =>
    request<{ results: MemorySearchResult[] }>(`/api/memory/search${qs({ q, workspaceId, limit })}`),

  createMemory: (body: CreateMemoryRequest) =>
    request<{ memory: Memory; merged: boolean }>('/api/memory', { method: 'POST', body }),

  updateMemory: (id: string, body: Partial<Memory>) =>
    request<{ memory: Memory }>(`/api/memory/${id}`, { method: 'PATCH', body }),

  deleteMemory: (id: string) => request<{ ok: boolean }>(`/api/memory/${id}`, { method: 'DELETE' }),

  memoryMaintenance: (action: 'decay' | 'collect' | 'reindex') =>
    request<{ affected: number }>('/api/memory/maintenance', { method: 'POST', body: { action } }),

  /* ----------------------------- Insights ----------------------------- */
  insights: (params: { workspaceId?: string; status?: string; limit?: number } = {}) =>
    request<{ insights: Insight[] }>(`/api/insights${qs(params)}`),

  setInsightStatus: (id: string, status: Insight['status']) =>
    request<{ ok: boolean }>(`/api/insights/${id}/status`, { method: 'POST', body: { status } }),

  installSkillFromInsight: (id: string) =>
    request<{ skill: SkillDefinition }>(`/api/insights/${id}/install-skill`, { method: 'POST' }),

  /**
   * Distil a workspace's accumulated procedures into a proposed skill.
   * Resolves undefined on a 204 — the model judged they do not cohere.
   */
  synthesiseSkill: (workspaceId: string) =>
    request<{ insight: Insight } | undefined>(`/api/workspaces/${workspaceId}/synthesise-skill`, {
      method: 'POST',
    }),

  /* ------------------------------ Policy ------------------------------ */
  policy: (params: { workspaceId?: string; category?: string } = {}) =>
    request<{
      categories: Array<{ category: string; trials: number }>;
      arms: PolicyArm[];
      explanations: Record<string, string>;
      classifierDistribution: Array<{ category: string; count: number }>;
    }>(`/api/policy${qs(params)}`),

  resetPolicy: (body: { workspaceId: string | null; category?: string; includeClassifier?: boolean }) =>
    request<{ arms: number; exemplars: number }>('/api/policy/reset', { method: 'POST', body }),

  previewPolicy: (body: { prompt: string; workspaceId: string | null }) =>
    request<{
      classification: { category: string; confidence: number; reason: string };
      selection: { arm: { model: string; effort: string | null }; confidence: number } | null;
      explanation: string;
      memories: Array<{
        id: string;
        title: string;
        kind: MemoryKind;
        score: number;
        confidence: number;
      }>;
    }>('/api/policy/preview', { method: 'POST', body }),

  /** Why one run was shaped as it was. Immutable once the run has started. */
  runGenesis: (runId: string) => request<RunGenesis>(`/api/runs/${runId}/genesis`),

  /* ------------------------------ Advisor ------------------------------ */
  askAdvisor: (workspaceId: string) =>
    request<{ runId: string; sessionId: string }>('/api/advisor/ask', {
      method: 'POST',
      body: { workspaceId },
    }),
  advisorProposals: (workspaceId?: string) =>
    request<{ proposals: AdvisorProposal[] }>(`/api/advisor/proposals${qs({ workspaceId })}`),
  acceptAdvisorProposal: (id: string) =>
    request<{ proposal: AdvisorProposal; appliedId: string | null }>(
      `/api/advisor/proposals/${id}/accept`,
      { method: 'POST' },
    ),
  dismissAdvisorProposal: (id: string) =>
    request<{ proposal: AdvisorProposal }>(`/api/advisor/proposals/${id}/dismiss`, {
      method: 'POST',
    }),

  /* ----------------------------- Registry ----------------------------- */
  skills: (workspaceId?: string) =>
    request<{ skills: SkillDefinition[] }>(`/api/skills${qs({ workspaceId })}`),
  saveSkill: (body: Record<string, unknown>) =>
    request<{ skill: SkillDefinition }>('/api/skills', { method: 'POST', body }),
  deleteSkill: (id: string) => request<{ ok: boolean }>(`/api/skills/${id}`, { method: 'DELETE' }),

  agents: (workspaceId?: string) =>
    request<{ agents: AgentDefinitionRecord[] }>(`/api/agents${qs({ workspaceId })}`),
  saveAgent: (body: Record<string, unknown>) =>
    request<{ agent: AgentDefinitionRecord }>('/api/agents', { method: 'POST', body }),
  deleteAgent: (id: string) => request<{ ok: boolean }>(`/api/agents/${id}`, { method: 'DELETE' }),

  library: () => request<{ entries: LibraryListingEntry[] }>('/api/library'),
  installLibraryEntry: (name: string) =>
    request<{ id: string; entry: LibraryListingEntry }>('/api/library/install', {
      method: 'POST',
      body: { name },
    }),

  google: {
    get: () => request<GoogleConnectionState>('/api/integrations/google'),
    // The secret goes up once and never comes back: no read path returns it,
    // so reconnecting asks for it again. That is the cost of not keeping a
    // copy anywhere a page could reach.
    connect: (body: { clientId: string; clientSecret: string; grants: GoogleGrant[] }) =>
      request<{ authorizationUrl: string; redirectUri: string }>(
        '/api/integrations/google/connect',
        { method: 'POST', body },
      ),
    disconnect: () =>
      request<{ ok: boolean; removed: boolean }>('/api/integrations/google', { method: 'DELETE' }),
  },

  connectors: () => request<{ connectors: ConnectorListingEntry[] }>('/api/connectors'),
  // `secret` is whatever the operator pasted, without the scheme word — the
  // directory owns that. It goes straight into the vault and no read path
  // returns it, here or anywhere.
  installConnector: (name: string, secret?: string) =>
    request<{ id: string; connector: ConnectorListingEntry }>('/api/connectors/install', {
      method: 'POST',
      body: secret ? { name, secret } : { name },
    }),

  mcpServers: (workspaceId?: string) =>
    request<{ servers: McpServerRecord[] }>(`/api/mcp${qs({ workspaceId })}`),
  saveMcpServer: (body: Record<string, unknown>) =>
    request<{ server: McpServerRecord }>('/api/mcp', { method: 'POST', body }),
  deleteMcpServer: (id: string) => request<{ ok: boolean }>(`/api/mcp/${id}`, { method: 'DELETE' }),

  /* ---------------------------- Knowledge ------------------------------ */
  knowledge: {
    list: (options?: { workspaceId?: string; scope?: 'global' }) =>
      request<{ documents: KnowledgeDocumentMeta[] }>(
        `/api/knowledge${qs({ workspaceId: options?.workspaceId, scope: options?.scope })}`,
      ),
    get: (id: string) =>
      request<{ document: KnowledgeDocumentMeta & { content: string } }>(`/api/knowledge/${id}`),
    save: (body: SaveKnowledgeRequest) =>
      request<{ document: KnowledgeDocumentMeta }>('/api/knowledge', { method: 'POST', body }),
    delete: (id: string) => request<{ ok: boolean }>(`/api/knowledge/${id}`, { method: 'DELETE' }),
    search: (q: string, workspaceId?: string) =>
      request<{ results: KnowledgeSearchHit[] }>(`/api/knowledge/search${qs({ q, workspaceId })}`),
    reindex: () => request<{ affected: number }>('/api/knowledge/reindex', { method: 'POST' }),
  },

  /* --------------------------- Automations ---------------------------- */
  automations: (workspaceId?: string) =>
    request<{ automations: Automation[] }>(`/api/automations${qs({ workspaceId })}`),

  createAutomation: (body: {
    workspaceId: string;
    name: string;
    description?: string;
    prompt: string;
    trigger: AutomationTrigger;
    policy?: Record<string, unknown>;
    continuous?: boolean;
    maxConsecutiveFailures?: number;
    enabled?: boolean;
  }) => request<{ automation: Automation }>('/api/automations', { method: 'POST', body }),

  updateAutomation: (id: string, body: Record<string, unknown>) =>
    request<{ automation: Automation }>(`/api/automations/${id}`, { method: 'PATCH', body }),

  deleteAutomation: (id: string) =>
    request<{ ok: boolean }>(`/api/automations/${id}`, { method: 'DELETE' }),

  fireAutomation: (id: string) =>
    request<{ runId: string }>(`/api/automations/${id}/fire`, { method: 'POST' }),

  /* ------------------------------ System ------------------------------ */
  system: () => request<SystemHealth>('/api/system'),

  connectRepository: (workspaceId: string, gitUrl: string | null) =>
    request<ConnectRepositoryResult>(`/api/workspaces/${workspaceId}/git/connect`, {
      method: 'POST',
      body: { gitUrl },
    }),

  plugins: {
    list: () => request<PluginRecord[]>('/api/plugins'),
    install: (source: string) =>
      request<PluginRecord>('/api/plugins', { method: 'POST', body: { source } }),
    setEnabled: (id: string, enabled: boolean) =>
      request<PluginRecord>(`/api/plugins/${id}`, { method: 'PATCH', body: { enabled } }),
    remove: (id: string) => request<void>(`/api/plugins/${id}`, { method: 'DELETE' }),
  },

  /** Plugin marketplaces — sources the CLI itself installs from. */
  marketplaces: {
    list: () => request<{ marketplaces: Marketplace[] }>('/api/marketplaces'),
    add: (input: MarketplaceInput) =>
      request<{ marketplace: Marketplace }>('/api/marketplaces', { method: 'POST', body: input }),
    setEnabled: (id: string, enabled: boolean) =>
      request<{ marketplace: Marketplace }>(`/api/marketplaces/${id}`, {
        method: 'PATCH',
        body: { enabled },
      }),
    remove: (id: string) => request<{ ok: boolean }>(`/api/marketplaces/${id}`, { method: 'DELETE' }),
    catalogue: (id: string, refresh = false) =>
      request<MarketplaceCatalogue>(`/api/marketplaces/${id}/catalogue${qs({ refresh })}`),
  },

  claudeCredential: {
    get: () => request<ClaudeCredentialStatus>('/api/claude/credential'),
    save: (value: string) =>
      request<ClaudeCredentialStatus>('/api/claude/credential', {
        method: 'PUT',
        body: { value },
      }),
    clear: () =>
      request<ClaudeCredentialStatus>('/api/claude/credential', { method: 'DELETE' }),
  },

  push: {
    status: () => request<PushStatus>('/api/push'),
    subscribe: (input: PushSubscriptionInput) =>
      request<{ devices: number }>('/api/push/subscriptions', { method: 'POST', body: input }),
    unsubscribe: (endpoint: string) =>
      request<{ removed: boolean; devices: number }>(
        `/api/push/subscriptions?endpoint=${encodeURIComponent(endpoint)}`,
        { method: 'DELETE' },
      ),
    test: () => request<{ devices: number; sent: number; pruned: number; lastError: string | null }>('/api/push/test', { method: 'POST', body: {} }),
  },

  claudePairing: {
    begin: (account: 'claudeai' | 'console' = 'claudeai') =>
      request<ClaudePairingStart>('/api/claude/pairing', { method: 'POST', body: { account } }),
    complete: (code: string) =>
      request<ClaudeCredentialStatus>('/api/claude/pairing/code', {
        method: 'POST',
        body: { code },
      }),
    cancel: () => request<ClaudePairingState>('/api/claude/pairing', { method: 'DELETE' }),
  },

  analytics: (params: { workspaceId?: string; days?: number; granularity?: string } = {}) =>
    // The summary's shape lives in `packages/shared`. It used to be written out
    // here as well as in the service, and the two had already started to drift.
    request<{ summary: AnalyticsSummary; series: UsagePoint[] }>(`/api/analytics${qs(params)}`),

  audit: (params: { limit?: number; before?: number; action?: string } = {}) =>
    request<{ entries: AuditEntry[] }>(`/api/audit${qs(params)}`),

  verifyAudit: () =>
    request<{ ok: boolean; entries: number; brokenAt?: string }>('/api/audit/verify'),
};
