/**
 * Help — the product explaining itself.
 *
 * Three surfaces in one place, all fed from the repository rather than from
 * strings written here: the user guide (docs/guide/, bundled per-chapter as
 * lazy chunks), the changelog (CHANGELOG.md), and "Ask Metaclaude" — an
 * ordinary plan-mode session in a workspace seeded with this same guide, so
 * the assistant answers from the documents the reader is looking at.
 *
 * Search is a conjunction over chapters, computed client-side: the corpus is
 * nine small files, and instant results beat a round-trip.
 */

import { useQuery } from '@tanstack/react-query';
import { BookOpen, ChevronRight, History, Search, Send, Sparkles } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { AppShell, ContentHeader } from '@/components/layout/AppShell';
import { Button, Card, Input, Skeleton, Spinner } from '@/components/ui/primitives';
import { api } from '@/lib/api';
import {
  ensureHelpSession,
  guideChapters,
  loadChangelog,
  searchGuide,
  titleOf,
} from '@/lib/help';
import { renderMarkdown } from '@/lib/markdown';
import { Page } from '@/components/ui/layout';
import { TabPanel, Tabs, TabStrip, TabTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { APP_VERSION } from '@metaclaude/shared';
import { useT } from '@/lib/i18n';

type Tab = 'guide' | 'changelog';

// Same treatment as the Settings tabs, so the two screens read as one product.
export function HelpPage() {
  const t = useT();
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>('guide');
  const [active, setActive] = useState(guideChapters[0]?.slug ?? '');
  const [query, setQuery] = useState('');
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);

  /* ------------------------------- Corpus -------------------------------- */

  // The whole guide, loaded once: search needs every chapter, and nine small
  // chunks arrive faster than a reader can type a query.
  const corpus = useQuery({
    queryKey: ['help', 'guide'],
    staleTime: Infinity,
    queryFn: async () =>
      Promise.all(
        guideChapters.map(async (chapter) => {
          const body = await chapter.load();
          return { slug: chapter.slug, title: titleOf(body, chapter.title), body };
        }),
      ),
  });

  const changelog = useQuery({
    queryKey: ['help', 'changelog'],
    staleTime: Infinity,
    queryFn: loadChangelog,
    enabled: tab === 'changelog',
  });

  const hits = useMemo(
    () => (corpus.data && query.trim() ? searchGuide(corpus.data, query) : []),
    [corpus.data, query],
  );

  const activeChapter = corpus.data?.find((chapter) => chapter.slug === active);
  const activeHtml = useMemo(
    () => (activeChapter ? renderMarkdown(activeChapter.body) : ''),
    [activeChapter],
  );
  const changelogHtml = useMemo(
    () => (changelog.data ? renderMarkdown(changelog.data) : ''),
    [changelog.data],
  );

  /* ----------------------------- Ask flow -------------------------------- */

  const ask = async () => {
    const trimmed = question.trim();
    if (!trimmed || asking) return;
    setAsking(true);
    try {
      const { workspaceId, sessionId } = await ensureHelpSession(api, trimmed);
      navigate(`/w/${workspaceId}/s/${sessionId}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('Could not start the help session.'));
      setAsking(false);
    }
  };

  /* -------------------------------- View --------------------------------- */

  return (
    <AppShell>
      <ContentHeader
        title={t('Help')}
        subtitle={t('You are on Metaclaude {version}. The guide below ships with it.', {
          version: APP_VERSION,
        })}
      />

      {/* The standard page scroll container: without it the content column
          fights the AppShell's flex column instead of scrolling, and on a
          phone the bottom navigation covers the tail of the guide. */}
      <Page width="standard">
          {/* Ask Metaclaude ------------------------------------------------- */}
          <Card className="p-4">
            <div className="mb-2 flex items-center gap-2 text-[13px] font-medium text-ink">
              <Sparkles className="size-4 text-accent" aria-hidden />
              {t('Ask Metaclaude about itself')}
            </div>
            <p className="mb-3 text-[12.5px] text-muted">
              {t(
                'Opens a plan-mode session in a workspace seeded with this guide — the assistant answers from these pages, with citations, and can execute nothing.',
              )}
            </p>
            <form
              className="flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void ask();
              }}
            >
              <Input
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                placeholder={t('How do automations avoid overlapping runs?')}
                aria-label={t('Question for the help assistant')}
                disabled={asking}
              />
              <Button type="submit" variant="primary" disabled={!question.trim() || asking}>
                {asking ? <Spinner className="size-3.5" /> : <Send className="size-3.5" aria-hidden />}
                {t('Ask')}
              </Button>
            </form>
          </Card>

          {/* Tabs ----------------------------------------------------------- */}
          <Tabs value={tab} onValueChange={(value) => setTab(value as Tab)}>
            <TabStrip label={t('Help sections',)}>
              <TabTrigger value="guide">
                <BookOpen className="mr-1.5 inline size-3.5" aria-hidden />
                {t('User guide')}
              </TabTrigger>
              <TabTrigger value="changelog">
                <History className="mr-1.5 inline size-3.5" aria-hidden />
                {t("What's new")}
              </TabTrigger>
            </TabStrip>

            <TabPanel value="guide">
              <div className="grid gap-4 md:grid-cols-[220px_1fr]">
                {/* Chapters + search ----------------------------------------- */}
                <div className="space-y-3">
                  <div className="relative">
                    <Search
                      className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-subtle"
                      aria-hidden
                    />
                    <Input
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      placeholder={t('Search the guide')}
                      aria-label={t('Search the guide')}
                      className="pl-8"
                    />
                  </div>

                  {query.trim() ? (
                    <div className="space-y-1" aria-label={t('Search results')}>
                      {hits.length === 0 ? (
                        <p className="px-1 text-[12.5px] text-subtle">
                          {t('Nothing in the guide matches all of those words.')}
                        </p>
                      ) : (
                        hits.map((hit) => (
                          <button
                            key={hit.slug}
                            type="button"
                            onClick={() => {
                              setActive(hit.slug);
                              setQuery('');
                            }}
                            className="block w-full rounded-md px-2 py-1.5 text-left hover:bg-raised"
                          >
                            <span className="block text-[13px] font-medium text-ink">{hit.title}</span>
                            <span className="block truncate text-[12px] text-muted">{hit.excerpt}</span>
                          </button>
                        ))
                      )}
                    </div>
                  ) : (
                    <nav aria-label={t('Guide chapters')} className="space-y-0.5">
                      {(corpus.data ?? guideChapters).map((chapter) => (
                        <button
                          key={chapter.slug}
                          type="button"
                          aria-current={active === chapter.slug ? 'page' : undefined}
                          onClick={() => setActive(chapter.slug)}
                          className={cn(
                            'flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[13px]',
                            active === chapter.slug
                              ? 'bg-accent-soft font-medium text-accent'
                              : 'text-muted hover:bg-raised hover:text-ink',
                          )}
                        >
                          <ChevronRight
                            className={cn('size-3 flex-none', active === chapter.slug ? '' : 'opacity-40')}
                            aria-hidden
                          />
                          {chapter.title}
                        </button>
                      ))}
                    </nav>
                  )}
                </div>

                {/* Chapter body ---------------------------------------------- */}
                <Card className="min-w-0 p-5">
                  {corpus.isLoading ? (
                    <div className="space-y-3">
                      <Skeleton className="h-6 w-1/3" />
                      <Skeleton className="h-4 w-full" />
                      <Skeleton className="h-4 w-5/6" />
                    </div>
                  ) : activeChapter ? (
                    <article
                      className="prose-mc max-w-none"
                      // Rendered through the same sanitising pipeline as agent output.
                      dangerouslySetInnerHTML={{ __html: activeHtml }}
                    />
                  ) : (
                    <p className="text-[13px] text-muted">{t('The guide could not be loaded.')}</p>
                  )}
                </Card>
              </div>
            </TabPanel>

            <TabPanel value="changelog">
              <Card className="p-5">
                {changelog.isLoading ? (
                  <div className="space-y-3">
                    <Skeleton className="h-6 w-1/3" />
                    <Skeleton className="h-4 w-full" />
                  </div>
                ) : (
                  <article
                    className="prose-mc max-w-none"
                    dangerouslySetInnerHTML={{ __html: changelogHtml }}
                  />
                )}
              </Card>
            </TabPanel>
          </Tabs>
      </Page>
    </AppShell>
  );
}
