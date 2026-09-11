/**
 * The Claude CLI's own tools, and which of them this deployment refuses.
 *
 * A capability screen rather than a settings one, which is why it sits in
 * System beside automations, agents and plugins: those three are what an
 * operator *adds* to the agent, and this is the layer underneath — what the
 * CLI brings before anybody adds anything. Metaclaude mounted all of it, and
 * the CLI is written for a person at a terminal signed in to claude.ai:
 * `Artifact` publishes a page there from inside a run, `CronCreate` schedules
 * work in the CLI's own scheduler, outside the automations screen and outside
 * its quota guard. No screen said either was possible.
 *
 * The list is **measured, not written down**. It comes from the CLI's own
 * opening frame, because the set is platform-dependent — `PowerShell` on
 * Windows against `Bash` elsewhere — and moves with every bump. A screen built
 * on a hard-coded list is a screen that lies the day the CLI changes, with
 * nothing to notice. The notes below are the one hand-written half, and a tool
 * with no note still gets a row: an undescribed capability is better than an
 * invisible one.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock, RotateCcw, Sparkles, Wrench } from 'lucide-react';
import { toast } from 'sonner';
import type { CliSkillRecord, CliToolRecord } from '@metaclaude/shared';
import { AppShell, ContentHeader } from '@/components/layout/AppShell';
import { SystemTabs } from '@/components/layout/SystemTabs';
import { CheckboxField } from '@/components/ui/controls';
import { Page, Section } from '@/components/ui/layout';
import { Badge, Button, Card, EmptyState, Spinner } from '@/components/ui/primitives';
import { api, ApiError } from '@/lib/api';
import { usePlural, useT } from '@/lib/i18n';
import { formatRelative } from '@/lib/utils';

/**
 * What each tool actually does, in one line an operator can decide on.
 *
 * A table of copy, so every value here is translated — the `halfTranslatedTables`
 * ratchet holds it to that. The keys are the CLI's own tool names and are
 * deliberately *not* copy: they are the literal strings the CLI reports, shown
 * as code for the same reason `CheckboxField` documents.
 *
 * Incomplete by design. A tool the CLI adds tomorrow appears on the screen with
 * no note rather than not appearing, because the list is measured off the CLI
 * and this is only the commentary on it.
 */
const TOOL_NOTES: Record<string, string> = {
  Artifact: 'Publishes a web page to claude.ai from inside a run.',
  AskUserQuestion: 'Puts a multiple-choice question to whoever is watching.',
  Bash: 'Runs shell commands in the workspace.',
  CronCreate: 'Schedules recurring work in the CLI’s own scheduler, outside Automations.',
  CronDelete: 'Removes a schedule from the CLI’s own scheduler.',
  CronList: 'Lists the CLI’s own schedules.',
  DesignSync: 'Syncs a design canvas with claude.ai.',
  Edit: 'Changes an existing file.',
  EnterPlanMode: 'Switches the run into planning, where nothing is executed.',
  EnterWorktree: 'Moves the run into a separate git worktree.',
  ExitPlanMode: 'Leaves planning and asks to proceed.',
  ExitWorktree: 'Leaves a git worktree.',
  Glob: 'Finds files by name pattern.',
  Grep: 'Searches file contents.',
  ListAgents: 'Lists the agents this session can send messages to.',
  Monitor: 'Waits for a condition before carrying on.',
  NotebookEdit: 'Changes a cell in a Jupyter notebook.',
  PowerShell: 'Runs PowerShell commands. Windows hosts only.',
  PushNotification: 'Sends a notification through the CLI’s own channel, not Metaclaude’s.',
  Read: 'Reads a file, an image or a PDF.',
  RemoteTrigger: 'Starts work on another machine through the CLI’s remote control.',
  ReportFindings: 'Returns review findings in the shape the CLI’s review screens render.',
  ScheduleWakeup: 'Schedules the run to resume itself later.',
  SendMessage: 'Sends a message to another agent or session.',
  Skill: 'Opens one of this workspace’s skills. Turning it off disables skills entirely.',
  Task: 'Delegates to a subagent. Reported as “Agent” in a transcript; turning it off disables custom agents.',
  TaskOutput: 'Reads what a background task has produced so far.',
  TaskStop: 'Stops a background task.',
  TodoWrite: 'Keeps a task list for the run.',
  ToolSearch: 'Loads the other tools on demand, so their descriptions stay out of every prompt.',
  WebFetch: 'Fetches a web page.',
  WebSearch: 'Searches the web.',
  Workflow: 'Runs a multi-agent workflow. Used by Ultracode.',
  Write: 'Creates or replaces a file.',
};

export function CliToolsPage() {
  const t = useT();
  const plural = usePlural();
  const queryClient = useQueryClient();

  const query = useQuery({ queryKey: ['cli-tools'], queryFn: () => api.cliTools() });
  const report = query.data;

  const save = useMutation({
    mutationFn: (disabled: string[] | null) => api.setCliTools(disabled),
    onSuccess: (next) => {
      queryClient.setQueryData(['cli-tools'], next);
      // The catalogue answers "what does the CLI offer here", and this changes
      // it — leaving the cached one would make the composer's pickers describe
      // the deployment as it was a moment ago.
      void queryClient.invalidateQueries({ queryKey: ['claude-catalogue'] });
    },
    onError: (error) =>
      toast.error(
        error instanceof ApiError ? error.message : t('That change could not be saved.'),
      ),
  });

  /** The refused set as it stands, with one name flipped. */
  const toggle = (tool: CliToolRecord): void => {
    const refused = new Set((report?.tools ?? []).filter((row) => row.disabled).map((row) => row.name));
    if (refused.has(tool.name)) refused.delete(tool.name);
    else refused.add(tool.name);
    save.mutate([...refused].sort());
  };

  const refusedCount = (report?.tools ?? []).filter((tool) => tool.disabled).length;

  return (
    <AppShell>
      <ContentHeader
        tabs={<SystemTabs />}
        title={t('CLI tools')}
        subtitle={t(
          'What the Claude CLI itself brings to the agent, before any skill, agent or plugin of yours is added: its tools, and its own skills. What you switch here applies to every run of this deployment.',
        )}
      />

      <Page width="list">
        <Section
          title={t('Tools')}
          icon={<Wrench className="text-muted" />}
          description={t(
            'The list comes from the CLI itself, so it follows the platform and the installed version rather than anything written down here. A tool that is off is removed from the agent’s tool list outright — the model is never offered it, rather than being refused it.',
          )}
          actions={
            report ? (
              <>
                <Badge tone={report.source === 'stored' ? 'accent' : 'neutral'}>
                  {report.source === 'stored'
                    ? plural(refusedCount, '{n} tool switched off', '{n} tools switched off')
                    : t('Deployment default')}
                </Badge>
                {report.source === 'stored' ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={save.isPending}
                    onClick={() => save.mutate(null)}
                  >
                    <RotateCcw className="size-4" aria-hidden />
                    {t('Restore defaults')}
                  </Button>
                ) : null}
              </>
            ) : null
          }
        >
          {query.isLoading ? (
            <div className="flex justify-center py-10">
              <Spinner />
            </div>
          ) : !report || report.tools.length === 0 ? (
            <Card>
              <EmptyState
                icon={<Wrench />}
                title={t('No run has reported what the CLI offers yet')}
                description={t(
                  'The CLI names its tools when a run starts, and nowhere else. The list appears here after the first run since the server started.',
                )}
              />
            </Card>
          ) : (
            <div className="space-y-3">
              {/* Said once, at the top, rather than repeated on every row.
                  The list is learned from runs — the CLI names its tools only
                  on the frame it emits with a first message — so before one
                  has happened the rows below are only what this deployment
                  refuses, with nothing to say about what exists. */}
              {!report.probed ? (
                <Card className="border-warning/25 bg-warning-soft">
                  <p className="text-body text-ink">
                    {t(
                      'No run has reported what the CLI offers since the server started, so this is only what the deployment refuses. The full list appears after the first run.',
                    )}
                  </p>
                </Card>
              ) : report.seenAt !== null ? (
                <p className="text-caption text-muted">
                  {t('As the CLI offered them to the last run, {when}.', {
                    when: formatRelative(report.seenAt),
                  })}
                </p>
              ) : null}

              {report.tools.map((tool) => {
                // Read once and named: a tool the CLI has just started
                // offering has no note here, and `TOOL_NOTES[...]` typed as a
                // bare index is exactly where a cast creeps in to hide that.
                const note = TOOL_NOTES[tool.name];
                /*
                 * Absent, not empty — and a fragment is truthy, which is the
                 * whole trap. `CheckboxField` points `aria-describedby` at
                 * whatever it is given and its own comment says why a blank
                 * one is worse than none: the reader announces the name and
                 * then silence. Composing this inline handed it an empty
                 * element for every tool with no note, which is every tool the
                 * CLI adds after today — the list is measured, the notes are
                 * written by hand, and they will not stay in step.
                 */
                const hint =
                  note || tool.locked ? (
                    <>
                      {note ? t(note) : null}
                      {tool.locked ? (
                        <span className="mt-1 flex items-start gap-1.5 text-muted">
                          <Lock className="mt-0.5 size-3 shrink-0" aria-hidden />
                          {t(
                            'Always on: it is how the CLI loads every other tool on demand, so switching it off would put all of their descriptions back into every prompt.',
                          )}
                        </span>
                      ) : null}
                    </>
                  ) : undefined;
                return (
                <Card key={tool.name} className="flex items-start justify-between gap-4">
                  <CheckboxField
                    checked={!tool.disabled}
                    disabled={tool.locked !== null || save.isPending}
                    onChange={() => toggle(tool)}
                    label={<code className="text-body font-medium">{tool.name}</code>}
                    {...(hint ? { hint } : {})}
                  />
                  {/* `shrink-0`, not decoration: a flex child shrinks before
                      it overflows, and a `whitespace-nowrap` badge that is
                      allowed to shrink pushes itself out of a 390px row
                      instead of letting the label beside it wrap. */}
                  {!tool.offered ? (
                    <Badge tone="neutral" className="shrink-0">
                      {t('No longer offered')}
                    </Badge>
                  ) : null}
                </Card>
                );
              })}
            </div>
          )}
        </Section>

        <CliSkillsSection />
      </Page>
    </AppShell>
  );
}

/* -------------------------------------------------------------------------- */
/* The CLI's own skills                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The seventeen skills the CLI ships inside itself, governed the way the
 * operator's own are: a list, a box each, off unless chosen.
 *
 * They are not registry rows and cannot be made into some — the body of each
 * lives in the CLI's binary and is not exposed — so what a box here changes is
 * which of them a run is *told about*. Nothing is copied; the skill stays the
 * CLI's and stays current with it.
 *
 * Off by default, and that default is the safe shape: with nothing chosen the
 * run carries one flag that refuses the lot, including whatever a future CLI
 * ships. Choosing even one switches the run to naming every known skill one by
 * one, because — measured — an exception cannot climb back over that flag.
 * The cost on each row is what carrying the skill's description would add to
 * a prompt, approximate on purpose: the same skill measured 362 tokens against
 * one model and 482 against another.
 */
function CliSkillsSection() {
  const t = useT();
  const plural = usePlural();
  const queryClient = useQueryClient();

  const query = useQuery({ queryKey: ['cli-skills'], queryFn: () => api.cliSkills() });
  const report = query.data;

  const save = useMutation({
    mutationFn: (enabled: string[] | null) => api.setCliSkills(enabled),
    onSuccess: (next) => {
      queryClient.setQueryData(['cli-skills'], next);
      // Which skills a run carries is part of what the composer's slash menu
      // lists, so the catalogue behind it is stale the moment this changes.
      void queryClient.invalidateQueries({ queryKey: ['claude-catalogue'] });
    },
    onError: (error) =>
      toast.error(
        error instanceof ApiError ? error.message : t('That change could not be saved.'),
      ),
  });

  /** The chosen set as it stands, with one name flipped. */
  const toggle = (skill: CliSkillRecord): void => {
    const chosen = new Set(
      (report?.skills ?? []).filter((row) => row.enabled).map((row) => row.name),
    );
    if (chosen.has(skill.name)) chosen.delete(skill.name);
    else chosen.add(skill.name);
    save.mutate([...chosen].sort());
  };

  const chosenCount = (report?.skills ?? []).filter((skill) => skill.enabled).length;

  return (
    <Section
      title={t('Skills')}
      icon={<Sparkles className="text-muted" />}
      description={t(
        'Skills the CLI ships inside itself, for a terminal and for claude.ai. None is offered to a run unless you switch it on here; your own skills are managed under Agents & skills. The figure on each row is roughly what its description would add to every prompt.',
      )}
      actions={
        report ? (
          <>
            <Badge tone={report.source === 'stored' ? 'accent' : 'neutral'}>
              {report.source === 'stored'
                ? plural(chosenCount, '{n} skill offered', '{n} skills offered')
                : t('None offered')}
            </Badge>
            {report.source === 'stored' ? (
              <Button
                variant="secondary"
                size="sm"
                disabled={save.isPending}
                onClick={() => save.mutate(null)}
              >
                <RotateCcw className="size-4" aria-hidden />
                {t('Offer none')}
              </Button>
            ) : null}
          </>
        ) : null
      }
    >
      {query.isLoading ? (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      ) : !report || report.skills.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Sparkles />}
            title={t('The CLI could not be asked which skills it ships')}
            description={t(
              'This list is read from the Claude CLI when it starts. Check the CLI’s credentials on the Server screen, then reload.',
            )}
          />
        </Card>
      ) : (
        <div className="space-y-3">
          {!report.probed ? (
            <Card className="border-warning/25 bg-warning-soft">
              <p className="text-body text-ink">
                {t(
                  'The CLI could not be asked which skills it ships, so this is what it was last seen to ship. Nothing here says whether these still exist.',
                )}
              </p>
            </Card>
          ) : null}

          {report.skills.map((skill) => (
            <Card key={skill.name} className="flex items-start justify-between gap-4">
              <CheckboxField
                checked={skill.enabled}
                disabled={save.isPending}
                onChange={() => toggle(skill)}
                label={<code className="text-body font-medium">{skill.name}</code>}
                {...(skill.tokens !== null
                  ? {
                      hint: t('About {n} tokens in every prompt that carries it.', {
                        n: skill.tokens,
                      }),
                    }
                  : {})}
              />
              {!skill.offered ? (
                <Badge tone="neutral" className="shrink-0">
                  {t('No longer offered')}
                </Badge>
              ) : null}
            </Card>
          ))}
        </div>
      )}
    </Section>
  );
}
