/**
 * Session view — the main screen.
 *
 * Left: the workspace's sessions. Centre: the transcript and composer.
 * The page subscribes to its session's topic while mounted, so every token,
 * tool call and permission prompt arrives without a poll.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Files, GitBranch, Plus, Sparkles, Trash2 } from 'lucide-react';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import {
  sessionTopic,
  workspaceTopic,
  type EffortLevel,
  type PermissionMode,
} from '@metaclaude/shared';
import { AppShell, ContentHeader } from '@/components/layout/AppShell';
import { Composer, type ComposerValue } from '@/components/transcript/Composer';
import { MessageStream } from '@/components/transcript/MessageStream';
import { RewindDialog } from '@/components/transcript/RewindDialog';
import { Button, Spinner, Tooltip } from '@/components/ui/primitives';
import { ConfirmDialog } from '@/components/ui/Modal';
// CodeMirror is 265 kB gzipped — more than the rest of the application put
// together — and it is only ever needed once someone opens the file browser.
// Imported statically it landed in index.html as a modulepreload, so a phone
// downloaded a code editor to reach the sign-in screen.
const FilesPanel = lazy(async () => ({
  default: (await import('@/components/workspace/FilesPanel')).FilesPanel,
}));

/** Holds the panel's shape while the editor chunk arrives, so nothing reflows. */
function PanelLoading() {
  return (
    <div className="flex h-full items-center justify-center" role="status" aria-label="Loading the editor">
      <Spinner className="size-5" />
    </div>
  );
}
import { GitPanel } from '@/components/workspace/GitPanel';
import { SessionList } from '@/components/workspace/SessionList';
import { api, ApiError } from '@/lib/api';
import { socket } from '@/lib/socket';
import { useSessionStore, useUiStore } from '@/lib/store';
import { cn } from '@/lib/utils';

type SidePanel = 'none' | 'files' | 'git';

export function SessionPage() {
  const { workspaceId = '', sessionId = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const setLastWorkspace = useUiStore((state) => state.setLastWorkspace);

  const [panel, setPanel] = useState<SidePanel>('none');
  const [confirmDelete, setConfirmDelete] = useState(false);
  /** The run whose file changes the operator is considering undoing. */
  const [rewinding, setRewinding] = useState<string | null>(null);

  // Selected field by field rather than `useSessionStore()`, which subscribes to
  // the whole store: streaming deltas land many times a second, and taking the
  // whole store would re-render this page — and everything under it — on each
  // one, including the file tree and the git panel that never read the store.
  const storeSession = useSessionStore((state) => state.session);
  const events = useSessionStore((state) => state.events);
  const runs = useSessionStore((state) => state.runs);
  const streaming = useSessionStore((state) => state.streaming);
  const approvals = useSessionStore((state) => state.approvals);
  const isRunning = useSessionStore((state) => state.isRunning);
  const connection = useSessionStore((state) => state.connection);
  const loadSession = useSessionStore((state) => state.load);

  /* ------------------------------- Data ---------------------------------- */

  const workspaceQuery = useQuery({
    queryKey: ['workspace', workspaceId],
    queryFn: () => api.workspace(workspaceId),
    enabled: Boolean(workspaceId),
  });

  /**
   * What the CLI offers in this workspace.
   *
   * Feeds the composer's model and effort pickers, which used to be a list
   * written when the component was. Failure is not retried and not surfaced:
   * the pickers fall back to a static list, so the cost of the CLI being
   * unreachable is the extra detail, never a composer nobody can use.
   */
  const catalogueQuery = useQuery({
    queryKey: ['claude-catalogue', workspaceId],
    queryFn: () => api.claudeCatalogue({ workspaceId }),
    enabled: Boolean(workspaceId),
    retry: false,
    staleTime: 5 * 60_000,
  });

  const sessionQuery = useQuery({
    queryKey: ['session', sessionId],
    queryFn: () => api.session(sessionId),
    enabled: Boolean(sessionId),
    // The socket keeps this fresh while it is connected, so polling would only
    // fight the live state. Reconnection is handled explicitly below.
    staleTime: Infinity,
  });

  // Hydrate the live store whenever a different session is loaded, or the query
  // refetches after a reconnect.
  useEffect(() => {
    if (!sessionQuery.data) return;
    loadSession({
      session: sessionQuery.data.session,
      events: sessionQuery.data.events,
      runs: sessionQuery.data.runs,
      approvals: sessionQuery.data.pendingApprovals,
      isRunning: sessionQuery.data.isRunning,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionQuery.data?.session.id, sessionQuery.dataUpdatedAt]);

  /*
   * Resync after the socket comes back.
   *
   * `staleTime: Infinity` with nothing to invalidate it means a disconnect
   * longer than the server's replay window leaves this page showing whatever it
   * had when the socket died — a run stuck at "running", a transcript missing
   * its tail — until the user navigates away and back. The server replays a
   * short gap; anything longer needs a refetch, and reconnecting is the signal
   * for it.
   */
  const wasConnected = useRef(false);
  useEffect(() => {
    if (connection !== 'open') return;
    // The first `open` is the initial connection, which the query already
    // covers; every later one is a reconnection and needs the refetch.
    if (wasConnected.current) {
      void queryClient.invalidateQueries({ queryKey: ['session', sessionId] });
    }
    wasConnected.current = true;
  }, [connection, sessionId, queryClient]);

  useEffect(() => {
    if (workspaceId) setLastWorkspace(workspaceId);
  }, [workspaceId, setLastWorkspace]);

  // Topic subscriptions, released on unmount so the server stops fanning out.
  useEffect(() => {
    if (!sessionId || !workspaceId) return;
    const release = [socket.subscribe(sessionTopic(sessionId)), socket.subscribe(workspaceTopic(workspaceId))];
    return () => release.forEach((fn) => fn());
  }, [sessionId, workspaceId]);

  useEffect(() => () => useSessionStore.getState().clear(), []);

  /* ------------------------------ Composer -------------------------------- */

  const workspace = workspaceQuery.data?.workspace;
  const session = storeSession ?? sessionQuery.data?.session;

  const [composer, setComposer] = useState<ComposerValue>({
    model: 'default',
    effort: null,
    permissionMode: 'default',
  });

  // Seed the composer from the session's own settings once it loads.
  useEffect(() => {
    if (!session) return;
    setComposer({
      model: String(session.model),
      effort: (session.effort as EffortLevel | null) ?? null,
      permissionMode: session.permissionMode as PermissionMode,
    });
  }, [session?.id]);

  /* ------------------------------ Mutations ------------------------------- */

  const submitRun = useMutation({
    mutationFn: (prompt: string) =>
      api.submitRun(sessionId, {
        prompt,
        model: composer.model,
        effort: composer.effort,
        permissionMode: composer.permissionMode,
      }),
    onError: (error) => {
      toast.error(error instanceof ApiError ? error.message : 'Could not start the run.');
    },
  });

  const rateRun = useMutation({
    mutationFn: ({ runId, rating }: { runId: string; rating: number }) =>
      api.rateRun(runId, rating),
    onSuccess: () => toast.success('Thanks — Metaclaude will factor that in.'),
  });

  const deleteSession = useMutation({
    mutationFn: () => api.deleteSession(sessionId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['workspace', workspaceId] });
      navigate(`/w/${workspaceId}`, { replace: true });
      toast.success('Session deleted');
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : 'Could not delete the session.'),
  });

  const newSession = useMutation({
    mutationFn: () => api.createSession({ workspaceId }),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: ['workspace', workspaceId] });
      navigate(`/w/${workspaceId}/s/${data.session.id}`);
    },
  });

  /* -------------------------------- Render -------------------------------- */

  const sidebar = useMemo(
    () => (
      <SessionList
        workspaceId={workspaceId}
        activeSessionId={sessionId}
        sessions={workspaceQuery.data?.sessions ?? []}
        onCreate={() => newSession.mutate()}
        creating={newSession.isPending}
      />
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [workspaceId, sessionId, workspaceQuery.data?.sessions, newSession.isPending],
  );

  if (sessionQuery.isLoading || workspaceQuery.isLoading) {
    return (
      <AppShell sidebar={sidebar}>
        <div className="flex flex-1 items-center justify-center">
          <Spinner className="size-6" />
        </div>
      </AppShell>
    );
  }

  if (sessionQuery.isError || !session || !workspace) {
    return (
      <AppShell sidebar={sidebar}>
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
          <p className="text-sm text-muted">That session could not be loaded.</p>
          <Button variant="secondary" size="sm" onClick={() => navigate(`/w/${workspaceId}`)}>
            <ArrowLeft className="size-4" />
            Back to the workspace
          </Button>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell sidebar={sidebar}>
      <ContentHeader
        title={session.title || 'New session'}
        subtitle={
          <span className="flex items-center gap-1.5">
            <span
              className="inline-block size-2 rounded-[3px]"
              style={{ background: workspace.color }}
              aria-hidden
            />
            {workspace.name}
          </span>
        }
        actions={
          <>
            <Tooltip content="Files">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Files"
                aria-pressed={panel === 'files'}
                onClick={() => setPanel(panel === 'files' ? 'none' : 'files')}
                className={cn(panel === 'files' && 'bg-accent-soft text-accent')}
              >
                <Files className="size-4" />
              </Button>
            </Tooltip>

            <Tooltip content="Source control">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Source control"
                aria-pressed={panel === 'git'}
                onClick={() => setPanel(panel === 'git' ? 'none' : 'git')}
                className={cn(panel === 'git' && 'bg-accent-soft text-accent')}
              >
                <GitBranch className="size-4" />
              </Button>
            </Tooltip>

            <Tooltip content="New session">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="New session"
                onClick={() => newSession.mutate()}
                loading={newSession.isPending}
              >
                <Plus className="size-4" />
              </Button>
            </Tooltip>

            <Tooltip content="Delete session">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Delete session"
                onClick={() => setConfirmDelete(true)}
              >
                <Trash2 className="size-4" />
              </Button>
            </Tooltip>
          </>
        }
      />

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <MessageStream
            events={events}
            runs={runs}
            streaming={streaming}
            approvals={approvals}
            isRunning={isRunning || submitRun.isPending}
            onRate={(runId, rating) => rateRun.mutate({ runId, rating })}
            onRewind={setRewinding}
            onDecideApproval={(approvalId, approved, remember) =>
              socket.approve(approvalId, approved, remember)
            }
            emptyHint={
              <div className="flex flex-wrap justify-center gap-2">
                {SUGGESTIONS.map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    onClick={() => submitRun.mutate(suggestion)}
                    className="rounded-full border border-line bg-surface px-3 py-1.5 text-[12.5px] text-muted transition-colors hover:border-accent hover:text-ink"
                  >
                    <Sparkles className="mr-1 inline size-3" aria-hidden />
                    {suggestion}
                  </button>
                ))}
              </div>
            }
          />

          <Composer
            value={composer}
            onChange={setComposer}
            onSubmit={(prompt) => submitRun.mutate(prompt)}
            {...(catalogueQuery.data ? { catalogue: catalogueQuery.data } : {})}
            onInterrupt={() => {
              socket.interrupt(sessionId);
              void api.interrupt(sessionId).catch(() => undefined);
            }}
            isRunning={isRunning}
            disabled={submitRun.isPending}
            allowBypass={workspace.settings.defaultPermissionMode === 'bypassPermissions'}
          />
        </div>

        {panel !== 'none' ? (
          <aside className="hidden w-[26rem] shrink-0 border-l border-line bg-surface xl:flex xl:flex-col">
            {panel === 'files' ? (
              <Suspense fallback={<PanelLoading />}>
                <FilesPanel workspaceId={workspaceId} onClose={() => setPanel('none')} />
              </Suspense>
            ) : (
              <GitPanel workspaceId={workspaceId} onClose={() => setPanel('none')} />
            )}
          </aside>
        ) : null}
      </div>

      {/* Below `xl` the panels take over the screen instead of squeezing the chat. */}
      {panel !== 'none' ? (
        <div className="fixed inset-0 z-40 flex flex-col bg-surface xl:hidden">
          {panel === 'files' ? (
            <Suspense fallback={<PanelLoading />}>
              <FilesPanel workspaceId={workspaceId} onClose={() => setPanel('none')} />
            </Suspense>
          ) : (
            <GitPanel workspaceId={workspaceId} onClose={() => setPanel('none')} />
          )}
        </div>
      ) : null}

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete this session?"
        description="The transcript and its run history are removed permanently. Files in the workspace are untouched."
        confirmLabel="Delete session"
        danger
        onConfirm={async () => {
          await deleteSession.mutateAsync();
        }}
      />

      {/* Mounted only while a run is selected, which is what narrows `rewinding`
          to a string inside these callbacks — the alternative was a cast that
          claims something the type system cannot check. */}
      {rewinding ? (
        <RewindDialog
          open
          onOpenChange={(open) => !open && setRewinding(null)}
          onPreview={() => api.rewindRun(rewinding, true)}
          onApply={async () => {
            const result = await api.rewindRun(rewinding, false);
            // The file browser and the source-control panel are both views of
            // the tree that just changed underneath them, and neither receives
            // a frame for a rewind — it happens outside any run.
            for (const key of ['files', 'file', 'workspace'] as const) {
              void queryClient.invalidateQueries({ queryKey: [key] });
            }
            return result;
          }}
        />
      ) : null}
    </AppShell>
  );
}

const SUGGESTIONS = [
  'Explain how this project is structured',
  'Find and fix any failing tests',
  'Review my recent changes',
];

export { SessionPage as default };
