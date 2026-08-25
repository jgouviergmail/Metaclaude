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

import type {
  ApprovalRequest,
  Run,
  Session,
  Topic,
  TranscriptEvent,
  User,
} from '@metaclaude/shared';
import { sessionTopic } from '@metaclaude/shared';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ConnectionState } from './socket';

/* -------------------------------------------------------------------------- */
/* Auth                                                                        */
/* -------------------------------------------------------------------------- */

interface AuthState {
  user: User | null;
  status: 'loading' | 'authenticated' | 'anonymous';
  recoveryCodesRemaining: number;
  setUser: (user: User | null, recoveryCodesRemaining?: number) => void;
  setStatus: (status: AuthState['status']) => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  status: 'loading',
  recoveryCodesRemaining: 0,
  setUser: (user, recoveryCodesRemaining = 0) =>
    set({
      user,
      recoveryCodesRemaining,
      status: user ? 'authenticated' : 'anonymous',
    }),
  setStatus: (status) => set({ status }),
}));

/* -------------------------------------------------------------------------- */
/* Live session                                                                */
/* -------------------------------------------------------------------------- */

export interface StreamingBlock {
  eventId: string;
  channel: 'assistant_text' | 'thinking';
  text: string;
}

interface SessionState {
  sessionId: string | null;
  session: Session | null;
  /** Ordered transcript. Events are replaced in place when updated. */
  events: TranscriptEvent[];
  runs: Run[];
  /** In-flight text blocks, keyed by the id the authoritative event will carry. */
  streaming: Map<string, StreamingBlock>;
  approvals: ApprovalRequest[];
  isRunning: boolean;
  connection: ConnectionState;

  load: (payload: {
    session: Session;
    events: TranscriptEvent[];
    runs: Run[];
    approvals: ApprovalRequest[];
    isRunning: boolean;
  }) => void;
  clear: () => void;
  /**
   * The `topic` argument on the transcript actions is the session guard.
   *
   * A `TranscriptEvent` carries no session id — only a run id — so without the
   * frame's topic there is nothing to check it against, and an event belonging
   * to another session (a workspace-topic frame, or a session topic still
   * attached mid-navigation) would be appended straight into whatever
   * transcript happens to be open.
   */
  applyEvent: (topic: Topic, event: TranscriptEvent) => void;
  applyDelta: (
    topic: Topic,
    eventId: string,
    channel: StreamingBlock['channel'],
    text: string,
  ) => void;
  applyRun: (run: Run) => void;
  applySession: (session: Session) => void;
  addApproval: (approval: ApprovalRequest) => void;
  resolveApproval: (approvalId: string) => void;
  setConnection: (state: ConnectionState) => void;
}

/** True while at least one run in the session is still occupying the agent. */
function anyRunActive(runs: Run[]): boolean {
  return runs.some((run) => run.status === 'running' || run.status === 'waiting_approval');
}

/** True when a frame's topic addresses the session currently loaded. */
function isOwnTopic(sessionId: string | null, topic: Topic): boolean {
  return sessionId !== null && topic === sessionTopic(sessionId);
}

export const useSessionStore = create<SessionState>((set) => ({
  sessionId: null,
  session: null,
  events: [],
  runs: [],
  streaming: new Map(),
  approvals: [],
  isRunning: false,
  connection: 'closed',

  load: ({ session, events, runs, approvals, isRunning }) =>
    set({
      sessionId: session.id,
      session,
      events,
      runs,
      approvals,
      isRunning,
      streaming: new Map(),
    }),

  clear: () =>
    set({
      sessionId: null,
      session: null,
      events: [],
      runs: [],
      streaming: new Map(),
      approvals: [],
      isRunning: false,
    }),

  applyEvent: (topic, event) =>
    set((state) => {
      if (!isOwnTopic(state.sessionId, topic)) return state;

      // The authoritative event supersedes whatever was streamed under its id.
      const streaming = state.streaming.has(event.id)
        ? new Map([...state.streaming].filter(([id]) => id !== event.id))
        : state.streaming;

      const index = state.events.findIndex((existing) => existing.id === event.id);
      const events =
        index >= 0
          ? state.events.map((existing, i) => (i === index ? event : existing))
          : [...state.events, event];

      // A run's terminal event clears any orphaned streaming buffers: without
      // this a delta whose block never completed would linger forever. Whether
      // the session is still busy is read from the runs, not assumed from this
      // event — a replayed result for an earlier run must not blank the badge
      // while a later one is live.
      if (event.kind === 'result') {
        return { events, streaming: new Map(), isRunning: anyRunActive(state.runs) };
      }
      return { events, streaming };
    }),

  applyDelta: (topic, eventId, channel, text) =>
    set((state) => {
      if (!isOwnTopic(state.sessionId, topic)) return state;

      const streaming = new Map(state.streaming);
      const existing = streaming.get(eventId);
      streaming.set(eventId, {
        eventId,
        channel,
        text: existing ? existing.text + text : text,
      });
      return { streaming };
    }),

  applyRun: (run) =>
    set((state) => {
      if (state.sessionId !== run.sessionId) return state;
      const index = state.runs.findIndex((existing) => existing.id === run.id);
      const runs =
        index >= 0 ? state.runs.map((r, i) => (i === index ? run : r)) : [...state.runs, run];
      // Derived from the whole set, not from this frame: frames can arrive out
      // of order (a reconnect replays a window of them), and taking the last
      // one at face value paints a live session as idle.
      return { runs, isRunning: anyRunActive(runs) };
    }),

  applySession: (session) =>
    set((state) => (state.sessionId === session.id ? { session } : state)),

  addApproval: (approval) =>
    set((state) => {
      if (state.sessionId !== approval.sessionId) return state;
      if (state.approvals.some((existing) => existing.id === approval.id)) return state;
      return { approvals: [...state.approvals, approval] };
    }),

  resolveApproval: (approvalId) =>
    set((state) => ({ approvals: state.approvals.filter((a) => a.id !== approvalId) })),

  setConnection: (connection) => set({ connection }),
}));

/* -------------------------------------------------------------------------- */
/* UI preferences                                                              */
/* -------------------------------------------------------------------------- */

export type ThemeMode = 'light' | 'dark' | 'system';

interface UiState {
  theme: ThemeMode;
  sidebarOpen: boolean;
  /** Collapse reasoning blocks by default; some people find them noisy. */
  showThinking: boolean;
  /** Render tool calls expanded rather than as one-line summaries. */
  expandTools: boolean;
  /** Last workspace opened, so the app resumes where it left off. */
  lastWorkspaceId: string | null;

  setTheme: (theme: ThemeMode) => void;
  toggleSidebar: () => void;
  setSidebar: (open: boolean) => void;
  setShowThinking: (value: boolean) => void;
  setExpandTools: (value: boolean) => void;
  setLastWorkspace: (id: string | null) => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
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
    }),
    {
      name: 'metaclaude.ui',
      version: 1,
      // `theme` is also written to a standalone key by the inline script in
      // index.html, which runs before this store hydrates.
      onRehydrateStorage: () => (state) => {
        if (state) applyTheme(state.theme);
      },
    },
  ),
);

/** Reflect the theme choice onto the document and the pre-paint storage key. */
export function applyTheme(theme: ThemeMode): void {
  const dark =
    theme === 'dark' ||
    (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);

  document.documentElement.classList.toggle('dark', dark);
  try {
    localStorage.setItem('metaclaude.theme', theme === 'system' ? 'system' : theme);
  } catch {
    // Storage can be unavailable in private mode; the class is already applied.
  }
}

/* -------------------------------------------------------------------------- */
/* Notifications                                                               */
/* -------------------------------------------------------------------------- */

export interface AppNotification {
  id: string;
  level: 'info' | 'success' | 'warning' | 'error';
  title: string;
  message: string;
  href: string | null;
  at: number;
  read: boolean;
}

interface NotificationState {
  items: AppNotification[];
  add: (notification: Omit<AppNotification, 'id' | 'at' | 'read'>) => void;
  markAllRead: () => void;
  clear: () => void;
}

export const useNotificationStore = create<NotificationState>((set) => ({
  items: [],
  add: (notification) =>
    set((state) => ({
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
