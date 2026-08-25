/**
 * Typed API client.
 *
 * A thin wrapper over `fetch` that handles the two cross-cutting concerns:
 * attaching the CSRF token to mutating requests, and turning a 401 into a
 * single, coordinated redirect to the login screen rather than a cascade of
 * failed queries each doing their own thing.
 */
import { CSRF_COOKIE, } from '@metaclaude/shared';
export class ApiError extends Error {
    status;
    code;
    constructor(status, message, code) {
        super(message);
        this.status = status;
        this.code = code;
        this.name = 'ApiError';
    }
    get isAuthError() {
        return this.status === 401;
    }
}
/** Registered by the app shell so a 401 anywhere lands on the login screen. */
let onUnauthenticated = null;
export function setUnauthenticatedHandler(handler) {
    onUnauthenticated = handler;
}
/** Read the CSRF token the server set as a readable cookie at login. */
export function readCsrfToken() {
    const match = document.cookie.match(new RegExp(`(?:^|; )${CSRF_COOKIE}=([^;]*)`));
    return match?.[1] ? decodeURIComponent(match[1]) : null;
}
async function request(path, options = {}) {
    const method = options.method ?? 'GET';
    const headers = { accept: 'application/json' };
    if (options.body !== undefined)
        headers['content-type'] = 'application/json';
    if (method !== 'GET' && method !== 'HEAD') {
        const csrf = readCsrfToken();
        if (csrf)
            headers['x-metaclaude-csrf'] = csrf;
    }
    const response = await fetch(path, {
        method,
        headers,
        // Same-origin only: the API and the app are served from one host.
        credentials: 'same-origin',
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
    });
    if (response.status === 204)
        return undefined;
    const text = await response.text();
    let payload = null;
    if (text) {
        try {
            payload = JSON.parse(text);
        }
        catch {
            payload = { error: text.slice(0, 500) };
        }
    }
    if (!response.ok) {
        const detail = payload;
        const error = new ApiError(response.status, detail?.error ?? `Request failed with ${response.status}.`, detail?.code ?? 'error');
        if (error.isAuthError && !options.quiet)
            onUnauthenticated?.();
        throw error;
    }
    return payload;
}
/** Build a query string, dropping undefined and empty values. */
function qs(params) {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null || value === '')
            continue;
        search.set(key, String(value));
    }
    const rendered = search.toString();
    return rendered ? `?${rendered}` : '';
}
export const api = {
    /* ------------------------------- Auth ------------------------------- */
    bootstrapStatus: () => request('/api/auth/bootstrap-status'),
    login: (body) => request('/api/auth/login', { method: 'POST', body }),
    logout: () => request('/api/auth/logout', { method: 'POST' }),
    me: (options) => request('/api/auth/me', { quiet: options?.quiet ?? false }),
    authSessions: () => request('/api/auth/sessions'),
    revokeAuthSession: (id) => request(`/api/auth/sessions/${id}`, { method: 'DELETE' }),
    revokeOtherSessions: () => request('/api/auth/sessions/revoke-others', { method: 'POST' }),
    changePassword: (body) => request('/api/auth/password', {
        method: 'POST',
        body,
    }),
    totpBegin: () => request('/api/auth/totp/begin', { method: 'POST' }),
    totpConfirm: (code) => request('/api/auth/totp/confirm', { method: 'POST', body: { code } }),
    totpDisable: (password) => request('/api/auth/totp/disable', { method: 'POST', body: { password } }),
    users: () => request('/api/users'),
    createUser: (body) => request('/api/users', { method: 'POST', body }),
    /* ---------------------------- Workspaces ---------------------------- */
    workspaces: (includeArchived = false) => request(`/api/workspaces${qs({ archived: includeArchived })}`),
    workspace: (id) => request(`/api/workspaces/${id}`),
    createWorkspace: (body) => request('/api/workspaces', { method: 'POST', body }),
    updateWorkspace: (id, body) => request(`/api/workspaces/${id}`, { method: 'PATCH', body }),
    deleteWorkspace: (id, purge) => request(`/api/workspaces/${id}${qs({ purge })}`, { method: 'DELETE' }),
    /* ------------------------------ Sessions ---------------------------- */
    createSession: (body) => request('/api/sessions', { method: 'POST', body }),
    session: (id) => request(`/api/sessions/${id}`),
    updateSession: (id, body) => request(`/api/sessions/${id}`, { method: 'PATCH', body }),
    deleteSession: (id) => request(`/api/sessions/${id}`, { method: 'DELETE' }),
    submitRun: (sessionId, body) => request(`/api/sessions/${sessionId}/runs`, { method: 'POST', body }),
    interrupt: (sessionId) => request(`/api/sessions/${sessionId}/interrupt`, { method: 'POST' }),
    run: (id) => request(`/api/runs/${id}`),
    rateRun: (id, rating) => request(`/api/runs/${id}/rate`, { method: 'POST', body: { rating } }),
    runs: (params = {}) => request(`/api/runs${qs(params)}`),
    /* ----------------------------- Approvals ---------------------------- */
    approvals: () => request('/api/approvals'),
    decideApproval: (id, body) => request(`/api/approvals/${id}`, { method: 'POST', body }),
    /* ------------------------------- Files ------------------------------ */
    files: (workspaceId, path = '', hidden = false) => request(`/api/workspaces/${workspaceId}/files${qs({ path, hidden })}`),
    readFile: (workspaceId, path) => request(`/api/workspaces/${workspaceId}/file${qs({ path })}`),
    writeFile: (workspaceId, path, content) => request(`/api/workspaces/${workspaceId}/file`, {
        method: 'PUT',
        body: { path, content },
    }),
    deleteFile: (workspaceId, path) => request(`/api/workspaces/${workspaceId}/file${qs({ path })}`, {
        method: 'DELETE',
    }),
    createDirectory: (workspaceId, path) => request(`/api/workspaces/${workspaceId}/directory`, {
        method: 'POST',
        body: { path },
    }),
    searchFiles: (workspaceId, q, limit = 40) => request(`/api/workspaces/${workspaceId}/search${qs({ q, limit })}`),
    /* -------------------------------- Git ------------------------------- */
    gitStatus: (workspaceId) => request(`/api/workspaces/${workspaceId}/git/status`),
    gitDiff: (workspaceId, params = {}) => request(`/api/workspaces/${workspaceId}/git/diff${qs(params)}`),
    gitLog: (workspaceId, limit = 30) => request(`/api/workspaces/${workspaceId}/git/log${qs({ limit })}`),
    gitStage: (workspaceId, paths) => request(`/api/workspaces/${workspaceId}/git/stage`, {
        method: 'POST',
        body: { paths },
    }),
    gitUnstage: (workspaceId, paths) => request(`/api/workspaces/${workspaceId}/git/unstage`, {
        method: 'POST',
        body: { paths },
    }),
    gitCommit: (workspaceId, message) => request(`/api/workspaces/${workspaceId}/git/commit`, {
        method: 'POST',
        body: { message },
    }),
    /* ------------------------------ Memory ------------------------------ */
    memory: (params = {}) => request(`/api/memory${qs(params)}`),
    searchMemory: (q, workspaceId, limit = 10) => request(`/api/memory/search${qs({ q, workspaceId, limit })}`),
    createMemory: (body) => request('/api/memory', { method: 'POST', body }),
    updateMemory: (id, body) => request(`/api/memory/${id}`, { method: 'PATCH', body }),
    deleteMemory: (id) => request(`/api/memory/${id}`, { method: 'DELETE' }),
    memoryMaintenance: (action) => request('/api/memory/maintenance', { method: 'POST', body: { action } }),
    /* ----------------------------- Insights ----------------------------- */
    insights: (params = {}) => request(`/api/insights${qs(params)}`),
    setInsightStatus: (id, status) => request(`/api/insights/${id}/status`, { method: 'POST', body: { status } }),
    installSkillFromInsight: (id) => request(`/api/insights/${id}/install-skill`, { method: 'POST' }),
    /* ------------------------------ Policy ------------------------------ */
    policy: (params = {}) => request(`/api/policy${qs(params)}`),
    resetPolicy: (body) => request('/api/policy/reset', { method: 'POST', body }),
    previewPolicy: (body) => request('/api/policy/preview', { method: 'POST', body }),
    /* ----------------------------- Registry ----------------------------- */
    skills: (workspaceId) => request(`/api/skills${qs({ workspaceId })}`),
    saveSkill: (body) => request('/api/skills', { method: 'POST', body }),
    deleteSkill: (id) => request(`/api/skills/${id}`, { method: 'DELETE' }),
    agents: (workspaceId) => request(`/api/agents${qs({ workspaceId })}`),
    saveAgent: (body) => request('/api/agents', { method: 'POST', body }),
    deleteAgent: (id) => request(`/api/agents/${id}`, { method: 'DELETE' }),
    mcpServers: (workspaceId) => request(`/api/mcp${qs({ workspaceId })}`),
    saveMcpServer: (body) => request('/api/mcp', { method: 'POST', body }),
    deleteMcpServer: (id) => request(`/api/mcp/${id}`, { method: 'DELETE' }),
    /* --------------------------- Automations ---------------------------- */
    automations: (workspaceId) => request(`/api/automations${qs({ workspaceId })}`),
    createAutomation: (body) => request('/api/automations', { method: 'POST', body }),
    updateAutomation: (id, body) => request(`/api/automations/${id}`, { method: 'PATCH', body }),
    deleteAutomation: (id) => request(`/api/automations/${id}`, { method: 'DELETE' }),
    fireAutomation: (id) => request(`/api/automations/${id}/fire`, { method: 'POST' }),
    /* ------------------------------ System ------------------------------ */
    system: () => request('/api/system'),
    analytics: (params = {}) => request(`/api/analytics${qs(params)}`),
    audit: (params = {}) => request(`/api/audit${qs(params)}`),
    verifyAudit: () => request('/api/audit/verify'),
};
//# sourceMappingURL=api.js.map