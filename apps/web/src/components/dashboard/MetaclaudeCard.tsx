/**
 * Talking to Metaclaude, from the Dashboard.
 *
 * A composer rather than a chat: the answer is a run of the system workspace,
 * so the card hands the prompt over and takes the operator to the session,
 * where the transcript streams, the approval cards appear and the run can be
 * steered like any other. One standing conversation — a busy one is opened
 * rather than doubled. Owner and operator only: a viewer may read the
 * conversation but cannot start one, and a composer that only 403s is worse
 * than none.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Bot, MessageSquare } from 'lucide-react';
import { useState, type KeyboardEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Badge, Button, Card, QUIET_LINK, Textarea } from '@/components/ui/primitives';
import { api, ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { useAuthStore } from '@/lib/store';
import { cn, formatRelative } from '@/lib/utils';

const sessionPath = (workspaceId: string, sessionId: string) => `/w/${workspaceId}/s/${sessionId}`;

export function MetaclaudeCard() {
  const t = useT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const user = useAuthStore((state) => state.user);
  const canAct = user?.role === 'owner' || user?.role === 'operator';
  const [prompt, setPrompt] = useState('');

  const state = useQuery({
    queryKey: ['metaclaude'],
    queryFn: () => api.metaclaude(),
    enabled: canAct,
    refetchInterval: 30_000,
  });

  const ask = useMutation({
    mutationFn: (text: string) => api.askMetaclaude({ prompt: text }),
    onSuccess: (result) => {
      setPrompt('');
      void queryClient.invalidateQueries({ queryKey: ['metaclaude'] });
      navigate(sessionPath(result.workspaceId, result.sessionId));
    },
    onError: async (error) => {
      // Still answering: not a failure, a place to go. The server names the
      // busy session in its body; the state query carries the same answer.
      if (error instanceof ApiError && error.status === 409) {
        const current = await queryClient.fetchQuery({ queryKey: ['metaclaude'], queryFn: () => api.metaclaude() });
        toast.info(t('Metaclaude is still answering — opening the conversation.'));
        if (current.workspaceId && current.session) {
          navigate(sessionPath(current.workspaceId, current.session.id));
        }
        return;
      }
      toast.error(error instanceof ApiError ? error.message : t('Could not reach Metaclaude.'));
    },
  });

  if (!canAct) return null;

  const ready = state.data ? state.data.workspaceId !== null : true;
  const text = prompt.trim();
  const submit = (): void => {
    if (text.length === 0 || ask.isPending || !ready) return;
    ask.mutate(text);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submit();
    }
  };

  const conversation =
    state.data?.workspaceId && state.data.session
      ? { href: sessionPath(state.data.workspaceId, state.data.session.id), running: state.data.running, lastRun: state.data.lastRun }
      : null;

  return (
    <Card>
      <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
        <div className="flex items-center gap-2">
          <Bot className="size-4 text-accent" aria-hidden />
          <h2 className="text-body font-semibold text-ink">Metaclaude</h2>
          {conversation?.running ? <Badge tone="thinking">{t('answering')}</Badge> : null}
        </div>
        {conversation ? (
          <Link
            to={conversation.href}
            className={cn('inline-flex items-center gap-1 text-caption font-medium', QUIET_LINK)}
          >
            <MessageSquare className="size-3.5" aria-hidden />
            {t('Open the conversation')}
            <ArrowRight className="size-3.5" aria-hidden />
          </Link>
        ) : null}
      </div>

      <div className="space-y-3 px-4 py-3">
        <Textarea
          aria-label={t('Ask Metaclaude')}
          placeholder={t('Ask about this deployment, or hand over something to do…')}
          rows={2}
          value={prompt}
          disabled={!ready || ask.isPending}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-caption leading-relaxed text-muted">
            {ready
              ? t('It reads everything, changes what is reversible, and asks before anything irreversible.')
              : t('The system workspace is not ready. See the server log.')}
            {conversation?.lastRun?.finishedAt ? (
              <span className="text-subtle">
                {' · '}
                {t('last exchange {when}', { when: formatRelative(conversation.lastRun.finishedAt) })}
              </span>
            ) : null}
          </p>
          <Button
            variant="primary"
            size="sm"
            className="sm:shrink-0"
            loading={ask.isPending}
            disabled={text.length === 0 || !ready}
            onClick={submit}
          >
            {t('Ask')}
          </Button>
        </div>
      </div>
    </Card>
  );
}
