/**
 * Typed API client.
 *
 * A thin wrapper over `fetch` that handles the two cross-cutting concerns:
 * attaching the CSRF token to mutating requests, and turning a 401 into a
 * single, coordinated redirect to the login screen rather than a cascade of
 * failed queries each doing their own thing.
 */

import {
  CSRF_COOKIE,
  type AgentDefinitionRecord,
  type ApprovalRequest,
  type AuditEntry,
  type ClaudeCredentialStatus,
  type Automation,
  type AutomationTrigger,
  type CreateMemoryRequest,
  type FileEntry,
  type GitStatus,
  type Insight,
  type McpServerRecord,
  type Memory,
  type MemoryKind,
  type MemorySearchResult,
  type PolicyArm,
  type Run,
  type Session,
  type SkillDefinition,
  type SystemHealth,
  type TranscriptEvent,
  type UsagePoint,
  type User,
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
  bootstrapStatus: () => request<{ needsBootstrap: boolean }>('/api/auth/bootstrap-status'),

  login: (body: { username: string; password: string; totp?: string }) =>
    request<
      | { status: 'ok'; user: User; csrfToken: string }
      | { status: 'totp_required' }
    >('/api/auth/login', { method: 'POST', body }),

  logout: () => request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),

  me: (options?: { quiet?: boolean }) =>
    request<MeResponse>('/api/auth/me', { quiet: options?.quiet ?? false }),

  authSessions: () =>
    request<{
      sessions: Array<{
        id: string;
        createdAt: number;
        lastSeenAt: number;
        expiresAt: number;
        userAgent: string | null;
        ipAddress: string | null;
        current: boolean;
      }>;
    }>('/api/auth/sessions'),

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

  users: () => request<{ users: User[] }>('/api/users'),
  createUser: (body: { username: string; password: string; role: string; displayName?: string }) =>
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
    },
  ) => request<{ run: Run }>(`/api/sessions/${sessionId}/runs`, { method: 'POST', body }),

  interrupt: (sessionId: string) =>
    request<{ interrupted: boolean }>(`/api/sessions/${sessionId}/interrupt`, { method: 'POST' }),

  run: (id: string) => request<{ run: Run; events: TranscriptEvent[] }>(`/api/runs/${id}`),

  rateRun: (id: string, rating: number) =>
    request<{ run: Run }>(`/api/runs/${id}/rate`, { method: 'POST', body: { rating } }),

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

  mcpServers: (workspaceId?: string) =>
    request<{ servers: McpServerRecord[] }>(`/api/mcp${qs({ workspaceId })}`),
  saveMcpServer: (body: Record<string, unknown>) =>
    request<{ server: McpServerRecord }>('/api/mcp', { method: 'POST', body }),
  deleteMcpServer: (id: string) => request<{ ok: boolean }>(`/api/mcp/${id}`, { method: 'DELETE' }),

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

  analytics: (params: { workspaceId?: string; days?: number; granularity?: string } = {}) =>
    request<{
      summary: {
        totalRuns: number;
        successRate: number;
        totalCostUsd: number;
        totalInputTokens: number;
        totalOutputTokens: number;
        medianDurationMs: number;
        p95DurationMs: number;
        averageReward: number | null;
        byModel: Array<{ model: string; runs: number; costUsd: number; successRate: number }>;
        byCategory: Array<{ category: string; runs: number; averageReward: number | null }>;
      };
      series: UsagePoint[];
    }>(`/api/analytics${qs(params)}`),

  audit: (params: { limit?: number; before?: number; action?: string } = {}) =>
    request<{ entries: AuditEntry[] }>(`/api/audit${qs(params)}`),

  verifyAudit: () =>
    request<{ ok: boolean; entries: number; brokenAt?: string }>('/api/audit/verify'),
};
