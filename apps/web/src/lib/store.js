/**
 * Client state.
 *
 * Split by lifetime rather than by feature:
 *  - `useAuthStore`    — who is signed in. Survives navigation, cleared on logout.
 *  - `useSessionStore` — live transcript state for the session on screen. This is
 *    the only genuinely hot path: streaming deltas arrive many times a second,
 *    so it is kept out of React Query and updated with targeted mutations.
 *  - `useUiStore`      — layout preferences, persisted to localStorage.
 *
 * Server-owned collections (workspaces, memories, analytics) live in React Query,
 * not here, so there is exactly one cache for them.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
export const useAuthStore = create((set) => ({
    user: null,
    status: 'loading',
    recoveryCodesRemaining: 0,
    setUser: (user, recoveryCodesRemaining = 0) => set({
        user,
        recoveryCodesRemaining,
        status: user ? 'authenticated' : 'anonymous',
    }),
    setStatus: (status) => set({ status }),
}));
export const useSessionStore = create((set) => ({
    sessionId: null,
    session: null,
    events: [],
    runs: [],
    streaming: new Map(),
    approvals: [],
    isRunning: false,
    connection: 'closed',
    load: ({ session, events, runs, approvals, isRunning }) => set({
        sessionId: session.id,
        session,
        events,
        runs,
        approvals,
        isRunning,
        streaming: new Map(),
    }),
    clear: () => set({
        sessionId: null,
        session: null,
        events: [],
        runs: [],
        streaming: new Map(),
        approvals: [],
        isRunning: false,
    }),
    applyEvent: (event) => set((state) => {
        // The authoritative event supersedes whatever was streamed under its id.
        const streaming = state.streaming.has(event.id)
            ? new Map([...state.streaming].filter(([id]) => id !== event.id))
            : state.streaming;
        const index = state.events.findIndex((existing) => existing.id === event.id);
        const events = index >= 0
            ? state.events.map((existing, i) => (i === index ? event : existing))
            : [...state.events, event];
        // A run's terminal event clears any orphaned streaming buffers: without
        // this a delta whose block never completed would linger forever.
        if (event.kind === 'result') {
            return { events, streaming: new Map(), isRunning: false };
        }
        return { events, streaming };
    }),
    applyDelta: (eventId, channel, text) => set((state) => {
        const streaming = new Map(state.streaming);
        const existing = streaming.get(eventId);
        streaming.set(eventId, {
            eventId,
            channel,
            text: existing ? existing.text + text : text,
        });
        return { streaming };
    }),
    applyRun: (run) => set((state) => {
        if (state.sessionId !== run.sessionId)
            return state;
        const index = state.runs.findIndex((existing) => existing.id === run.id);
        const runs = index >= 0 ? state.runs.map((r, i) => (i === index ? run : r)) : [...state.runs, run];
        return { runs, isRunning: run.status === 'running' || run.status === 'waiting_approval' };
    }),
    applySession: (session) => set((state) => (state.sessionId === session.id ? { session } : state)),
    addApproval: (approval) => set((state) => {
        if (state.sessionId !== approval.sessionId)
            return state;
        if (state.approvals.some((existing) => existing.id === approval.id))
            return state;
        return { approvals: [...state.approvals, approval] };
    }),
    resolveApproval: (approvalId) => set((state) => ({ approvals: state.approvals.filter((a) => a.id !== approvalId) })),
    setConnection: (connection) => set({ connection }),
}));
export const useUiStore = create()(persist((set) => ({
    theme: 'system',
    sidebarOpen: true,
    showThinking: true,
    expandTools: false,
    lastWorkspaceId: null,
    setTheme: (theme) => {
        applyTheme(theme);
        set({ theme });
    },
    toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
    setSidebar: (sidebarOpen) => set({ sidebarOpen }),
    setShowThinking: (showThinking) => set({ showThinking }),
    setExpandTools: (expandTools) => set({ expandTools }),
    setLastWorkspace: (lastWorkspaceId) => set({ lastWorkspaceId }),
}), {
    name: 'metaclaude.ui',
    version: 1,
    // `theme` is also written to a standalone key by the inline script in
    // index.html, which runs before this store hydrates.
    onRehydrateStorage: () => (state) => {
        if (state)
            applyTheme(state.theme);
    },
}));
/** Reflect the theme choice onto the document and the pre-paint storage key. */
export function applyTheme(theme) {
    const dark = theme === 'dark' ||
        (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.classList.toggle('dark', dark);
    try {
        localStorage.setItem('metaclaude.theme', theme === 'system' ? 'system' : theme);
    }
    catch {
        // Storage can be unavailable in private mode; the class is already applied.
    }
}
export const useNotificationStore = create((set) => ({
    items: [],
    add: (notification) => set((state) => ({
        items: [
            {
                ...notification,
                id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                at: Date.now(),
                read: false,
            },
            // Bounded: this is a live feed, not an archive. History is in the runs list.
            ...state.items,
        ].slice(0, 50),
    })),
    markAllRead: () => set((state) => ({ items: state.items.map((i) => ({ ...i, read: true })) })),
    clear: () => set({ items: [] }),
}));
//# sourceMappingURL=store.js.map