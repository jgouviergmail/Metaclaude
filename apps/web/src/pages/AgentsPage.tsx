/**
 * Agents & skills — the extension registry.
 *
 * Three kinds of extension, one registry: skills (instructions the CLI
 * discovers), subagents (named prompts with their own tool budget) and MCP
 * servers (outside tools). They share a page because they share a lifecycle —
 * each is materialised into the workspace immediately before a run, and each is
 * scoped either to one workspace or to every workspace at once.
 */

import * as Tabs from '@radix-ui/react-tabs';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BookOpen,
  Bot,
  ChevronDown,
  Download,
  Filter,
  Plug,
  Plus,
  Wand2,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import type {
  AgentDefinitionRecord,
  LibraryCategory,
  LibraryListingEntry,
  McpServerRecord,
  SkillDefinition,
} from '@metaclaude/shared';
import { LIBRARY_CATEGORIES } from '@metaclaude/shared';
import { AppShell, ContentHeader } from '@/components/layout/AppShell';
import { ClaudeCataloguePanel } from '@/components/registry/ClaudeCataloguePanel';
import { CheckboxField, Switch } from '@/components/ui/controls';
import { Menu, MenuItem, MenuLabel, MenuSeparator } from '@/components/ui/Menu';
import { ConfirmDialog, Modal } from '@/components/ui/Modal';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  Label,
  Skeleton,
  Textarea,
} from '@/components/ui/primitives';
import { api, ApiError } from '@/lib/api';
import { interpolate, useT } from '@/lib/i18n';
import { cn, formatRelative } from '@/lib/utils';

type TabKey = 'skills' | 'agents' | 'mcp' | 'library' | 'claude';

/** English display names as data; `t()` translates at render. */
const CATEGORY_LABELS: Record<LibraryCategory, string> = {
  engineering: 'Engineering',
  writing: 'Writing',
  data: 'Data',
  ops: 'Ops',
  research: 'Research',
  product: 'Product',
  general: 'General',
};

const SKILL_NAME = /^[a-z0-9][a-z0-9-]*$/;
const AGENT_NAME = /^[a-z0-9][a-z0-9-]*$/;
const MCP_NAME = /^[a-zA-Z0-9_-]+$/;

const MCP_STATUS_TONE: Record<McpServerRecord['status'], 'success' | 'danger' | 'neutral'> = {
  connected: 'success',
  failed: 'danger',
  disabled: 'neutral',
  unknown: 'neutral',
};

export function AgentsPage() {
  const queryClient = useQueryClient();
  const t = useT();

  /** `global` = unscoped definitions only; a workspace id = that workspace plus globals. */
  const [scope, setScope] = useState<string>('global');
  const [tab, setTab] = useState<TabKey>('skills');

  const workspaceId = scope === 'global' ? undefined : scope;

  const workspacesQuery = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => api.workspaces(),
    staleTime: 60_000,
  });

  const scopeLabel =
    scope === 'global'
      ? 'Global'
      : (workspacesQuery.data?.workspaces.find((w) => w.id === scope)?.name ?? 'Workspace');

  const invalidate = (key: string): void => {
    void queryClient.invalidateQueries({ queryKey: [key] });
  };

  return (
    <AppShell>
      <ContentHeader
        title={t('Agents & skills')}
        subtitle={scopeLabel}
        showSidebarToggle={false}
        icon={<Bot />}
        actions={
          <Menu
            side="bottom"
            align="end"
            trigger={
              <Button variant="ghost" size="sm" aria-label={`Scope: ${scopeLabel}`}>
                <Filter className="size-4" />
                <span className="hidden sm:inline">{scopeLabel}</span>
                <ChevronDown className="size-3.5" aria-hidden />
              </Button>
            }
          >
            <MenuLabel>Scope</MenuLabel>
            <MenuItem
              selected={scope === 'global'}
              description="Available in every workspace"
              onSelect={() => setScope('global')}
            >
              Global
            </MenuItem>
            {(workspacesQuery.data?.workspaces.length ?? 0) > 0 ? <MenuSeparator /> : null}
            {workspacesQuery.data?.workspaces.map((workspace) => (
              <MenuItem
                key={workspace.id}
                selected={scope === workspace.id}
                description="Its own definitions, plus the global ones"
                onSelect={() => setScope(workspace.id)}
                icon={
                  <span
                    className="mt-0.5 block size-3 rounded-[4px]"
                    style={{ background: workspace.color }}
                    aria-hidden
                  />
                }
              >
                {workspace.name}
              </MenuItem>
            ))}
          </Menu>
        }
      />

      <div className="flex-1 overflow-y-auto">
        <Tabs.Root value={tab} onValueChange={(value) => setTab(value as TabKey)}>
          <Tabs.List
            aria-label="Extension type"
            className="sticky top-0 z-10 flex gap-1 overflow-x-auto border-b border-line bg-bg px-3 sm:px-6"
          >
            {(
              [
                { value: 'skills', label: 'Skills', icon: <Sparkles className="size-4" /> },
                { value: 'agents', label: 'Subagents', icon: <Bot className="size-4" /> },
                { value: 'mcp', label: 'MCP servers', icon: <Plug className="size-4" /> },
                // The built-in shelf: curated in the repository, installed on
                // a click, disabled until switched on.
                { value: 'library', label: 'Library', icon: <BookOpen className="size-4" /> },
                // What the CLI itself offers, as opposed to what Metaclaude
                // defines. Same conceptual space, so it belongs beside them
                // rather than on a page of its own.
                { value: 'claude', label: 'From Claude', icon: <Wand2 className="size-4" /> },
              ] as const
            ).map((entry) => (
              <Tabs.Trigger
                key={entry.value}
                value={entry.value}
                className={cn(
                  'flex items-center gap-1.5 whitespace-nowrap border-b-2 border-transparent px-2.5 py-3',
                  'text-[13px] font-medium text-muted transition-colors hover:text-ink',
                  'data-[state=active]:border-accent data-[state=active]:text-accent',
                )}
              >
                {entry.icon}
                {t(entry.label)}
              </Tabs.Trigger>
            ))}
          </Tabs.List>

          <div className="mx-auto w-full max-w-5xl px-3 py-4 sm:px-6 sm:py-6">
            <Tabs.Content value="skills" className="focus-visible:outline-none">
              <SkillsTab workspaceId={workspaceId} onChanged={() => invalidate('skills')} />
            </Tabs.Content>

            <Tabs.Content value="agents" className="focus-visible:outline-none">
              <AgentsTab workspaceId={workspaceId} onChanged={() => invalidate('agents')} />
            </Tabs.Content>

            <Tabs.Content value="mcp" className="focus-visible:outline-none">
              <McpTab workspaceId={workspaceId} onChanged={() => invalidate('mcp-servers')} />
            </Tabs.Content>

            <Tabs.Content value="library" className="focus-visible:outline-none">
              <LibraryTab
                onInstalled={() => {
                  invalidate('skills');
                  invalidate('agents');
                }}
              />
            </Tabs.Content>

            <Tabs.Content value="claude" className="focus-visible:outline-none">
              <ClaudeTab workspaceId={workspaceId} />
            </Tabs.Content>
          </div>
        </Tabs.Root>
      </div>
    </AppShell>
  );
}

/* -------------------------------------------------------------------------- */
/* Skills                                                                      */
/* -------------------------------------------------------------------------- */

interface SkillDraft {
  id?: string;
  name: string;
  description: string;
  body: string;
  category: LibraryCategory;
  enabled: boolean;
}

function SkillsTab({
  workspaceId,
  onChanged,
}: {
  workspaceId: string | undefined;
  onChanged: () => void;
}) {
  const t = useT();
  const [editing, setEditing] = useState<SkillDraft | null>(null);
  const [deleting, setDeleting] = useState<SkillDefinition | null>(null);

  const query = useQuery({
    queryKey: ['skills', workspaceId ?? null],
    queryFn: () => api.skills(workspaceId),
  });

  const save = useMutation({
    mutationFn: (draft: SkillDraft) =>
      api.saveSkill({
        ...(draft.id ? { id: draft.id } : {}),
        workspaceId: workspaceId ?? null,
        name: draft.name.trim(),
        description: draft.description.trim(),
        body: draft.body,
        category: draft.category,
        enabled: draft.enabled,
      }),
    onSuccess: (result) => {
      onChanged();
      setEditing(null);
      toast.success(`Saved “${result.skill.name}”`);
    },
    onError: (error) => toast.error(messageFor(error, 'Could not save that skill.')),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteSkill(id),
    onSuccess: () => {
      onChanged();
      toast.success('Skill deleted');
    },
    onError: (error) => toast.error(messageFor(error, 'Could not delete that skill.')),
  });

  const toggle = useMutation({
    mutationFn: (skill: SkillDefinition) =>
      api.saveSkill({
        id: skill.id,
        workspaceId: skill.workspaceId,
        name: skill.name,
        description: skill.description,
        body: skill.body,
        enabled: !skill.enabled,
      }),
    onSuccess: () => onChanged(),
    onError: (error) => toast.error(messageFor(error, 'Could not change that skill.')),
  });

  const skills = query.data?.skills ?? [];

  return (
    <div className="space-y-4">
      <SectionIntro
        description="Enabled skills are written into the workspace's .claude/skills/ directory before every run, which is how the Claude CLI discovers them — nothing is injected into the prompt."
        action={
          <Button
            variant="primary"
            size="sm"
            onClick={() =>
              setEditing({ name: '', description: '', body: SKILL_TEMPLATE, category: 'general', enabled: true })
            }
          >
            <Plus className="size-4" />
            New skill
          </Button>
        }
      />

      {query.isLoading ? (
        <ListSkeleton />
      ) : skills.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Sparkles />}
            title="No skills in this scope"
            description="Write one, or accept a skill proposal from the Memory page — the reflexion pass drafts them from runs that went well."
          />
        </Card>
      ) : (
        <div className="space-y-3">
          {skills.map((skill) => (
            <Card key={skill.id} className="p-4">
              {/* At 375px the action cluster and the description cannot share a
                  row without truncating both, so they stack instead. */}
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="font-mono text-[13px] font-medium text-ink">{skill.name}</code>
                    {skill.autoGenerated ? <Badge tone="thinking">auto-generated</Badge> : null}
                    {skill.category !== 'general' ? (
                      <Badge tone="info">{t(CATEGORY_LABELS[skill.category])}</Badge>
                    ) : null}
                    {skill.workspaceId === null ? <Badge tone="neutral">global</Badge> : null}
                    {!skill.enabled ? <Badge tone="neutral">disabled</Badge> : null}
                  </div>
                  <p className="text-[13px] leading-relaxed text-muted">{skill.description}</p>
                  <p className="text-[11.5px] tabular-nums text-subtle">
                    used {skill.useCount}× · updated {formatRelative(skill.updatedAt)}
                  </p>
                </div>

                <div className="flex items-center gap-2 sm:shrink-0">
                  <Switch
                    checked={skill.enabled}
                    onChange={() => toggle.mutate(skill)}
                    label={`${skill.enabled ? 'Disable' : 'Enable'} skill ${skill.name}`}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      setEditing({
                        id: skill.id,
                        name: skill.name,
                        description: skill.description,
                        body: skill.body,
                        category: skill.category,
                        enabled: skill.enabled,
                      })
                    }
                  >
                    Edit
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Delete skill ${skill.name}`}
                    onClick={() => setDeleting(skill)}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      <SkillEditor
        draft={editing}
        busy={save.isPending}
        onClose={() => setEditing(null)}
        onSubmit={(draft) => save.mutate(draft)}
      />

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title="Delete this skill?"
        description={
          <>
            <span className="font-mono text-ink">{deleting?.name}</span> is removed from the registry
            and will not be written into any workspace again.
          </>
        }
        confirmLabel="Delete skill"
        danger
        onConfirm={async () => {
          if (deleting) await remove.mutateAsync(deleting.id);
          setDeleting(null);
        }}
      />
    </div>
  );
}

const SKILL_TEMPLATE = `# When to use this

Describe the situation that should trigger this skill.

# How to do it

1. …
`;

function SkillEditor({
  draft,
  busy,
  onClose,
  onSubmit,
}: {
  draft: SkillDraft | null;
  busy: boolean;
  onClose: () => void;
  onSubmit: (draft: SkillDraft) => void;
}) {
  const t = useT();
  const [value, setValue] = useState<SkillDraft>(
    draft ?? { name: '', description: '', body: '', category: 'general', enabled: true },
  );

  useEffect(() => {
    if (draft) setValue(draft);
  }, [draft]);

  const nameError =
    value.name.length > 0 && !SKILL_NAME.test(value.name)
      ? 'Use lowercase letters, digits and dashes only, starting with a letter or digit — for example “review-migrations”. It becomes a directory name.'
      : null;
  const valid =
    SKILL_NAME.test(value.name) && value.description.trim().length > 0 && !busy;

  return (
    <Modal
      open={draft !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={draft?.id ? 'Edit skill' : 'New skill'}
      description="The description is what the model reads when deciding whether to open the skill, so make it say when to use it."
      size="lg"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            loading={busy}
            disabled={!valid}
            onClick={() => onSubmit(value)}
          >
            Save skill
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Label htmlFor="skill-name" hint="Lowercase and dashes; this is the directory name.">
          Name
          <Input
            id="skill-name"
            value={value.name}
            onChange={(event) => setValue({ ...value, name: event.target.value })}
            placeholder="review-migrations"
            className="mt-1.5 font-mono"
            aria-invalid={nameError !== null}
            aria-describedby={nameError ? 'skill-name-error' : undefined}
            maxLength={64}
          />
        </Label>
        {nameError ? (
          <p id="skill-name-error" role="alert" className="-mt-2 text-xs leading-relaxed text-danger">
            {nameError}
          </p>
        ) : null}

        <Label htmlFor="skill-description" hint="One sentence, written as a trigger condition.">
          Description
          <Input
            id="skill-description"
            value={value.description}
            onChange={(event) => setValue({ ...value, description: event.target.value })}
            placeholder="Use when reviewing a database migration before it ships."
            className="mt-1.5"
            maxLength={1024}
          />
        </Label>

        <Label
          htmlFor="skill-category"
          hint={t('Groups the registry lists; pick General when nothing fits.')}
        >
          {t('Category')}
          <select
            id="skill-category"
            value={value.category}
            onChange={(event) =>
              setValue({ ...value, category: event.target.value as LibraryCategory })
            }
            className="mt-1.5 h-9 w-full rounded-lg border border-line bg-surface px-3 text-sm text-ink focus:border-accent focus:outline-none"
          >
            {LIBRARY_CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {t(CATEGORY_LABELS[category])}
              </option>
            ))}
          </select>
        </Label>

        <Label htmlFor="skill-body" hint="Markdown. Written verbatim to SKILL.md.">
          Body
          <Textarea
            id="skill-body"
            value={value.body}
            onChange={(event) => setValue({ ...value, body: event.target.value })}
            rows={16}
            className="mt-1.5 font-mono text-[12.5px]"
            spellCheck={false}
          />
        </Label>

        <CheckboxField
          checked={value.enabled}
          onChange={(enabled) => setValue({ ...value, enabled })}
          label="Enabled"
          hint="Disabled skills stay in the registry but are not written to disk."
        />
      </div>
    </Modal>
  );
}

/* -------------------------------------------------------------------------- */
/* Subagents                                                                   */
/* -------------------------------------------------------------------------- */

interface AgentDraft {
  id?: string;
  name: string;
  description: string;
  prompt: string;
  /** Comma-separated; blank means "inherit every tool". */
  tools: string;
  /** Blank means "inherit the parent run's model". */
  model: string;
  category: LibraryCategory;
  enabled: boolean;
}

const AGENT_MODELS = ['default', 'opus', 'sonnet', 'haiku'] as const;

function AgentsTab({
  workspaceId,
  onChanged,
}: {
  workspaceId: string | undefined;
  onChanged: () => void;
}) {
  const t = useT();
  const [editing, setEditing] = useState<AgentDraft | null>(null);
  const [deleting, setDeleting] = useState<AgentDefinitionRecord | null>(null);

  const query = useQuery({
    queryKey: ['agents', workspaceId ?? null],
    queryFn: () => api.agents(workspaceId),
  });

  const save = useMutation({
    mutationFn: (draft: AgentDraft) =>
      api.saveAgent({
        ...(draft.id ? { id: draft.id } : {}),
        workspaceId: workspaceId ?? null,
        name: draft.name.trim(),
        description: draft.description.trim(),
        prompt: draft.prompt,
        // Null and [] mean different things here: null inherits every tool,
        // an empty list would hand the subagent nothing at all.
        tools: parseList(draft.tools),
        model: draft.model.trim() === '' ? null : draft.model.trim(),
        category: draft.category,
        enabled: draft.enabled,
      }),
    onSuccess: (result) => {
      onChanged();
      setEditing(null);
      toast.success(`Saved “${result.agent.name}”`);
    },
    onError: (error) => toast.error(messageFor(error, 'Could not save that subagent.')),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteAgent(id),
    onSuccess: () => {
      onChanged();
      toast.success('Subagent deleted');
    },
    onError: (error) => toast.error(messageFor(error, 'Could not delete that subagent.')),
  });

  const toggle = useMutation({
    mutationFn: (agent: AgentDefinitionRecord) =>
      api.saveAgent({
        id: agent.id,
        workspaceId: agent.workspaceId,
        name: agent.name,
        description: agent.description,
        prompt: agent.prompt,
        tools: agent.tools,
        model: agent.model,
        enabled: !agent.enabled,
      }),
    onSuccess: () => onChanged(),
    onError: (error) => toast.error(messageFor(error, 'Could not change that subagent.')),
  });

  const agents = query.data?.agents ?? [];

  return (
    <div className="space-y-4">
      <SectionIntro
        description="A subagent runs in its own context window with its own prompt and tool budget, and reports a summary back. Use them to keep long side-quests out of the main transcript."
        action={
          <Button
            variant="primary"
            size="sm"
            onClick={() =>
              setEditing({
                name: '',
                description: '',
                prompt: '',
                tools: '',
                model: '',
                category: 'general',
                enabled: true,
              })
            }
          >
            <Plus className="size-4" />
            New subagent
          </Button>
        }
      />

      {query.isLoading ? (
        <ListSkeleton />
      ) : agents.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Bot />}
            title="No subagents in this scope"
            description="Define one to give a recurring job — code review, release notes, dependency triage — its own instructions."
          />
        </Card>
      ) : (
        <div className="space-y-3">
          {agents.map((agent) => (
            <Card key={agent.id} className="p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="font-mono text-[13px] font-medium text-ink">{agent.name}</code>
                    {agent.category !== 'general' ? (
                      <Badge tone="info">{t(CATEGORY_LABELS[agent.category])}</Badge>
                    ) : null}
                    {agent.workspaceId === null ? <Badge tone="neutral">global</Badge> : null}
                    {!agent.enabled ? <Badge tone="neutral">disabled</Badge> : null}
                  </div>
                  <p className="text-[13px] leading-relaxed text-muted">{agent.description}</p>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-subtle">
                    <span>
                      model: <span className="text-muted">{agent.model ?? 'inherit'}</span>
                    </span>
                    <span>
                      tools:{' '}
                      <span className="text-muted">
                        {agent.tools === null ? 'all tools' : agent.tools.join(', ') || 'none'}
                      </span>
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-2 sm:shrink-0">
                  <Switch
                    checked={agent.enabled}
                    onChange={() => toggle.mutate(agent)}
                    label={`${agent.enabled ? 'Disable' : 'Enable'} subagent ${agent.name}`}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      setEditing({
                        id: agent.id,
                        name: agent.name,
                        description: agent.description,
                        prompt: agent.prompt,
                        tools: agent.tools === null ? '' : agent.tools.join(', '),
                        model: agent.model === null ? '' : String(agent.model),
                        category: agent.category,
                        enabled: agent.enabled,
                      })
                    }
                  >
                    Edit
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Delete subagent ${agent.name}`}
                    onClick={() => setDeleting(agent)}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      <AgentEditor
        draft={editing}
        busy={save.isPending}
        onClose={() => setEditing(null)}
        onSubmit={(draft) => save.mutate(draft)}
      />

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title="Delete this subagent?"
        description={
          <>
            <span className="font-mono text-ink">{deleting?.name}</span> is removed from the
            registry. Sessions that name it will fall back to the main agent.
          </>
        }
        confirmLabel="Delete subagent"
        danger
        onConfirm={async () => {
          if (deleting) await remove.mutateAsync(deleting.id);
          setDeleting(null);
        }}
      />
    </div>
  );
}

function AgentEditor({
  draft,
  busy,
  onClose,
  onSubmit,
}: {
  draft: AgentDraft | null;
  busy: boolean;
  onClose: () => void;
  onSubmit: (draft: AgentDraft) => void;
}) {
  const t = useT();
  const [value, setValue] = useState<AgentDraft>(
    draft ?? {
      name: '',
      description: '',
      prompt: '',
      tools: '',
      model: '',
      category: 'general',
      enabled: true,
    },
  );

  useEffect(() => {
    if (draft) setValue(draft);
  }, [draft]);

  const nameError =
    value.name.length > 0 && !AGENT_NAME.test(value.name)
      ? 'Use lowercase letters, digits and dashes only — for example “release-notes”. This is the name a run refers to.'
      : null;
  const valid =
    AGENT_NAME.test(value.name) &&
    value.description.trim().length > 0 &&
    value.prompt.trim().length > 0 &&
    !busy;

  return (
    <Modal
      open={draft !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={draft?.id ? 'Edit subagent' : 'New subagent'}
      description="The description tells the main agent when to delegate; the prompt is the subagent's entire system prompt."
      size="lg"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            loading={busy}
            disabled={!valid}
            onClick={() => onSubmit(value)}
          >
            Save subagent
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Label htmlFor="agent-name" hint="Lowercase and dashes.">
          Name
          <Input
            id="agent-name"
            value={value.name}
            onChange={(event) => setValue({ ...value, name: event.target.value })}
            placeholder="release-notes"
            className="mt-1.5 font-mono"
            aria-invalid={nameError !== null}
            aria-describedby={nameError ? 'agent-name-error' : undefined}
            maxLength={64}
          />
        </Label>
        {nameError ? (
          <p id="agent-name-error" role="alert" className="-mt-2 text-xs leading-relaxed text-danger">
            {nameError}
          </p>
        ) : null}

        <Label htmlFor="agent-description" hint="When should the main agent hand work to this one?">
          Description
          <Input
            id="agent-description"
            value={value.description}
            onChange={(event) => setValue({ ...value, description: event.target.value })}
            placeholder="Summarises merged pull requests into release notes."
            className="mt-1.5"
            maxLength={1024}
          />
        </Label>

        <Label htmlFor="agent-prompt" hint="The subagent's system prompt, in full.">
          Prompt
          <Textarea
            id="agent-prompt"
            value={value.prompt}
            onChange={(event) => setValue({ ...value, prompt: event.target.value })}
            rows={14}
            className="mt-1.5"
          />
        </Label>

        <Label
          htmlFor="agent-category"
          hint={t('Groups the registry lists; pick General when nothing fits.')}
        >
          {t('Category')}
          <select
            id="agent-category"
            value={value.category}
            onChange={(event) =>
              setValue({ ...value, category: event.target.value as LibraryCategory })
            }
            className="mt-1.5 h-9 w-full rounded-lg border border-line bg-surface px-3 text-sm text-ink focus:border-accent focus:outline-none"
          >
            {LIBRARY_CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {t(CATEGORY_LABELS[category])}
              </option>
            ))}
          </select>
        </Label>

        <Label htmlFor="agent-model" hint="Leave blank to inherit whatever the parent run is using.">
          Model
          <select
            id="agent-model"
            value={value.model}
            onChange={(event) => setValue({ ...value, model: event.target.value })}
            className="mt-1.5 h-9 w-full rounded-lg border border-line bg-surface px-3 text-sm text-ink focus:border-accent focus:outline-none"
          >
            <option value="">Inherit</option>
            {AGENT_MODELS.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
        </Label>

        <Label
          htmlFor="agent-tools"
          hint="Comma separated, e.g. Read, Grep, Glob. Leave blank to allow every tool the run has."
        >
          Tools
          <Input
            id="agent-tools"
            value={value.tools}
            onChange={(event) => setValue({ ...value, tools: event.target.value })}
            placeholder="Read, Grep, Glob"
            className="mt-1.5 font-mono"
          />
        </Label>

        <CheckboxField
          checked={value.enabled}
          onChange={(enabled) => setValue({ ...value, enabled })}
          label="Enabled"
          hint="Disabled subagents cannot be selected by a run."
        />
      </div>
    </Modal>
  );
}

/* -------------------------------------------------------------------------- */
/* Library                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The built-in shelf. Everything on it ships with Metaclaude itself — read,
 * versioned and reviewed in the repository, never fetched from a store —
 * which is the trust story. Installing copies an entry into the *global*
 * registry, disabled, where it becomes the operator's own record; the scope
 * selector above deliberately does not apply here.
 */
function LibraryTab({ onInstalled }: { onInstalled: () => void }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [category, setCategory] = useState<LibraryCategory | 'all'>('all');

  const query = useQuery({ queryKey: ['library'], queryFn: () => api.library() });

  const install = useMutation({
    mutationFn: (name: string) => api.installLibraryEntry(name),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['library'] });
      onInstalled();
      toast.success(interpolate(t('Installed “{name}”'), { name: result.entry.name }), {
        description:
          result.entry.kind === 'agent'
            ? t('Find it under Subagents, in the global scope — disabled until you switch it on.')
            : t('Find it under Skills, in the global scope — disabled until you switch it on.'),
      });
    },
    onError: (error) => toast.error(messageFor(error, t('Could not install that entry.'))),
  });

  const entries = query.data?.entries ?? [];
  const filtered = category === 'all' ? entries : entries.filter((entry) => entry.category === category);

  return (
    <div className="space-y-4">
      <SectionIntro
        description={t(
          'A starter shelf of skills and subagents, curated in this repository and versioned with it. Installing copies one into the global registry, disabled — switch it on when you want runs to see it, edit it like anything you wrote yourself.',
        )}
        action={null}
      />

      <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('Filter by category')}>
        <CategoryChip active={category === 'all'} onClick={() => setCategory('all')}>
          {t('All')}
        </CategoryChip>
        {LIBRARY_CATEGORIES.map((value) => (
          <CategoryChip key={value} active={category === value} onClick={() => setCategory(value)}>
            {t(CATEGORY_LABELS[value])}
          </CategoryChip>
        ))}
      </div>

      {query.isLoading ? (
        <ListSkeleton />
      ) : query.isError ? (
        <Card>
          <EmptyState
            icon={<BookOpen />}
            title={t('The library could not be read')}
            description={t('Reload the page, or check the server logs if it keeps failing.')}
          />
        </Card>
      ) : (
        <div className="space-y-3">
          {filtered.map((entry) => (
            <LibraryEntryCard
              key={entry.name}
              entry={entry}
              installing={install.isPending && install.variables === entry.name}
              busy={install.isPending}
              onInstall={() => install.mutate(entry.name)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function LibraryEntryCard({
  entry,
  installing,
  busy,
  onInstall,
}: {
  entry: LibraryListingEntry;
  installing: boolean;
  busy: boolean;
  onInstall: () => void;
}) {
  const t = useT();
  return (
    <Card className="p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <code className="font-mono text-[13px] font-medium text-ink">{entry.name}</code>
            <Badge tone="thinking">{entry.kind === 'agent' ? t('subagent') : t('skill')}</Badge>
            <Badge tone="info">{t(CATEGORY_LABELS[entry.category])}</Badge>
          </div>
          <p className="text-[13px] leading-relaxed text-muted">{entry.description}</p>
        </div>

        <div className="flex items-center gap-2 sm:shrink-0">
          {entry.installed ? (
            <Badge tone="success">{t('Installed')}</Badge>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              loading={installing}
              disabled={busy}
              onClick={onInstall}
              aria-label={interpolate(t('Install “{name}”'), { name: entry.name })}
            >
              <Download className="size-4" />
              {t('Install')}
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

function CategoryChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'rounded-full border px-2.5 py-1 text-[12px] font-medium transition-colors',
        active
          ? 'border-accent bg-accent-soft text-accent'
          : 'border-line text-muted hover:text-ink',
      )}
    >
      {children}
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/* MCP servers                                                                 */
/* -------------------------------------------------------------------------- */

interface McpDraft {
  id?: string;
  name: string;
  transport: McpServerRecord['transport'];
  command: string;
  /** Whitespace or newline separated. */
  args: string;
  url: string;
  env: Pair[];
  headers: Pair[];
  enabled: boolean;
}

interface Pair {
  key: string;
  value: string;
}

function McpTab({
  workspaceId,
  onChanged,
}: {
  workspaceId: string | undefined;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState<McpDraft | null>(null);
  const [deleting, setDeleting] = useState<McpServerRecord | null>(null);

  const query = useQuery({
    queryKey: ['mcp-servers', workspaceId ?? null],
    queryFn: () => api.mcpServers(workspaceId),
  });

  const save = useMutation({
    mutationFn: (draft: McpDraft) => {
      // Blank values mean "keep what is stored", so deleting a row has to be
      // reported explicitly — otherwise a removed key would look like an
      // untouched one and survive the save.
      const original = draft.id
        ? (query.data?.servers ?? []).find((server) => server.id === draft.id)
        : undefined;
      const dropped = (before: string[], after: Pair[]) => {
        const kept = new Set(after.map((pair) => pair.key.trim()).filter(Boolean));
        return before.filter((key) => !kept.has(key));
      };

      return api.saveMcpServer({
        ...(draft.id ? { id: draft.id } : {}),
        workspaceId: workspaceId ?? null,
        name: draft.name.trim(),
        transport: draft.transport,
        command: draft.transport === 'stdio' ? draft.command.trim() : null,
        args: draft.transport === 'stdio' ? parseArgs(draft.args) : [],
        url: draft.transport === 'stdio' ? null : draft.url.trim(),
        env: pairsToRecord(draft.env),
        removeEnvKeys: dropped(original?.envKeys ?? [], draft.env),
        headers: pairsToRecord(draft.headers),
        removeHeaderKeys: dropped(original?.headerKeys ?? [], draft.headers),
        enabled: draft.enabled,
      });
    },
    onSuccess: (result) => {
      onChanged();
      setEditing(null);
      toast.success(`Saved “${result.server.name}”`, {
        description: 'The connection is retried on the next run in this workspace.',
      });
    },
    onError: (error) => toast.error(messageFor(error, 'Could not save that server.')),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteMcpServer(id),
    onSuccess: () => {
      onChanged();
      toast.success('Server deleted', { description: 'Its stored secrets were deleted with it.' });
    },
    onError: (error) => toast.error(messageFor(error, 'Could not delete that server.')),
  });

  const servers = query.data?.servers ?? [];

  return (
    <div className="space-y-4">
      <SectionIntro
        description="Each enabled server is started or connected at the beginning of a run, and its tools join the agent's tool list. A server that fails to connect is skipped rather than failing the run."
        action={
          <Button
            variant="primary"
            size="sm"
            onClick={() =>
              setEditing({
                name: '',
                transport: 'stdio',
                command: '',
                args: '',
                url: '',
                env: [],
                headers: [],
                enabled: true,
              })
            }
          >
            <Plus className="size-4" />
            New server
          </Button>
        }
      />

      {query.isLoading ? (
        <ListSkeleton />
      ) : servers.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Plug />}
            title="No MCP servers in this scope"
            description="Connect one to give the agent tools this system does not ship with — a database, an issue tracker, an internal API."
          />
        </Card>
      ) : (
        <div className="space-y-3">
          {servers.map((server) => (
            <Card key={server.id} className="p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="font-mono text-[13px] font-medium text-ink">{server.name}</code>
                    <Badge tone="info">{server.transport}</Badge>
                    <Badge tone={MCP_STATUS_TONE[server.status]}>{server.status}</Badge>
                    {server.workspaceId === null ? <Badge tone="neutral">global</Badge> : null}
                  </div>

                  <p className="break-all font-mono text-[12px] leading-relaxed text-muted">
                    {server.transport === 'stdio'
                      ? [server.command, ...server.args].filter(Boolean).join(' ') || '—'
                      : (server.url ?? '—')}
                  </p>

                  {server.envKeys.length > 0 ? (
                    <p className="flex flex-wrap items-center gap-1 text-[11.5px] text-subtle">
                      <ShieldCheck className="size-3.5" aria-hidden />
                      {server.envKeys.length} encrypted secret
                      {server.envKeys.length === 1 ? '' : 's'}: {server.envKeys.join(', ')}
                    </p>
                  ) : null}

                  {server.lastError ? (
                    <p className="rounded-lg border border-danger/25 bg-danger-soft px-2.5 py-1.5 text-[12px] leading-relaxed text-danger">
                      {server.lastError}
                    </p>
                  ) : null}
                </div>

                <div className="flex items-center gap-2 sm:shrink-0">
                  {/* Unlike the other tabs this cannot save straight away: the
                      write endpoint replaces the whole secret set, so flipping
                      the switch opens the editor rather than silently dropping
                      this server's credentials. */}
                  <Switch
                    checked={server.enabled}
                    onChange={() =>
                      setEditing({
                        ...draftFromServer(server),
                        enabled: !server.enabled,
                      })
                    }
                    label={`${server.enabled ? 'Disable' : 'Enable'} server ${server.name}`}
                    tooltip={`${server.enabled ? 'Disable' : 'Enable'} ${server.name} — opens the editor, because saving replaces this server's stored secrets`}
                  />
                  <Button variant="ghost" size="sm" onClick={() => setEditing(draftFromServer(server))}>
                    Edit
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Delete server ${server.name}`}
                    onClick={() => setDeleting(server)}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      <McpEditor
        draft={editing}
        busy={save.isPending}
        onClose={() => setEditing(null)}
        onSubmit={(draft) => save.mutate(draft)}
      />

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title="Delete this MCP server?"
        description={
          <>
            <span className="font-mono text-ink">{deleting?.name}</span> is removed and its stored
            secrets are erased from the vault. Its tools disappear from every run in this scope.
          </>
        }
        confirmLabel="Delete server"
        danger
        onConfirm={async () => {
          if (deleting) await remove.mutateAsync(deleting.id);
          setDeleting(null);
        }}
      />
    </div>
  );
}

/**
 * Secret *values* are never returned by the API, so an existing server's env
 * rows come back key-only with an empty value — see the notice in the editor.
 */
function draftFromServer(server: McpServerRecord): McpDraft {
  return {
    id: server.id,
    name: server.name,
    transport: server.transport,
    command: server.command ?? '',
    args: server.args.join(' '),
    url: server.url ?? '',
    env: server.envKeys.map((key) => ({ key, value: '' })),
    headers: server.headerKeys.map((key) => ({ key, value: '' })),
    enabled: server.enabled,
  };
}

function McpEditor({
  draft,
  busy,
  onClose,
  onSubmit,
}: {
  draft: McpDraft | null;
  busy: boolean;
  onClose: () => void;
  onSubmit: (draft: McpDraft) => void;
}) {
  const [value, setValue] = useState<McpDraft>(
    draft ?? {
      name: '',
      transport: 'stdio',
      command: '',
      args: '',
      url: '',
      env: [],
      headers: [],
      enabled: true,
    },
  );

  useEffect(() => {
    if (draft) setValue(draft);
  }, [draft]);

  const nameError =
    value.name.length > 0 && !MCP_NAME.test(value.name)
      ? 'Letters, digits, dashes and underscores only — this becomes the tool prefix the agent sees.'
      : null;
  const valid =
    MCP_NAME.test(value.name) &&
    (value.transport === 'stdio' ? value.command.trim().length > 0 : value.url.trim().length > 0) &&
    !busy;

  const isStdio = value.transport === 'stdio';

  return (
    <Modal
      open={draft !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={draft?.id ? 'Edit MCP server' : 'New MCP server'}
      description="Connection details are stored in the clear so they stay auditable; anything secret goes to the encrypted vault."
      size="lg"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            loading={busy}
            disabled={!valid}
            onClick={() => onSubmit(value)}
          >
            Save server
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Label htmlFor="mcp-name" hint="Prefixes every tool this server exposes.">
          Name
          <Input
            id="mcp-name"
            value={value.name}
            onChange={(event) => setValue({ ...value, name: event.target.value })}
            placeholder="linear"
            className="mt-1.5 font-mono"
            aria-invalid={nameError !== null}
            aria-describedby={nameError ? 'mcp-name-error' : undefined}
            maxLength={64}
          />
        </Label>
        {nameError ? (
          <p id="mcp-name-error" role="alert" className="-mt-2 text-xs leading-relaxed text-danger">
            {nameError}
          </p>
        ) : null}

        <Label htmlFor="mcp-transport" hint="stdio launches a local process; sse and http reach a remote one.">
          Transport
          <select
            id="mcp-transport"
            value={value.transport}
            onChange={(event) =>
              setValue({ ...value, transport: event.target.value as McpDraft['transport'] })
            }
            className="mt-1.5 h-9 w-full rounded-lg border border-line bg-surface px-3 text-sm text-ink focus:border-accent focus:outline-none"
          >
            <option value="stdio">stdio — local process</option>
            <option value="sse">sse — server-sent events</option>
            <option value="http">http — streamable HTTP</option>
          </select>
        </Label>

        {isStdio ? (
          <>
            <Label htmlFor="mcp-command" hint="The executable, without its arguments.">
              Command
              <Input
                id="mcp-command"
                value={value.command}
                onChange={(event) => setValue({ ...value, command: event.target.value })}
                placeholder="npx"
                className="mt-1.5 font-mono"
                spellCheck={false}
              />
            </Label>

            <Label htmlFor="mcp-args" hint="One per line, or separated by spaces.">
              Arguments
              <Textarea
                id="mcp-args"
                value={value.args}
                onChange={(event) => setValue({ ...value, args: event.target.value })}
                rows={3}
                className="mt-1.5 font-mono text-[12.5px]"
                placeholder={'-y\n@modelcontextprotocol/server-linear'}
                spellCheck={false}
              />
            </Label>
          </>
        ) : (
          <Label htmlFor="mcp-url" hint="Must be http or https.">
            URL
            <Input
              id="mcp-url"
              value={value.url}
              onChange={(event) => setValue({ ...value, url: event.target.value })}
              placeholder="https://mcp.example.com/sse"
              className="mt-1.5 font-mono"
              spellCheck={false}
              inputMode="url"
            />
          </Label>
        )}

        {/* The one thing an operator must understand before pressing save. */}
        <div className="space-y-3 rounded-xl border border-warning/30 bg-warning-soft/40 p-3">
          <div className="flex items-start gap-2">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
            <div className="space-y-1 text-[12.5px] leading-relaxed">
              <p className="font-medium text-ink">Secrets are encrypted and never read back</p>
              <p className="text-muted">
                Values go into the encrypted vault; only the key names are stored on the record and
                only key names are ever returned. That is why every value box below is blank on an
                existing server — the value cannot be shown, not even to you.
              </p>
              <p className="text-muted">
                A value left blank keeps whatever is stored, so you only re-enter the ones you want
                to change. Delete a row to remove that key and its value for good.
              </p>
            </div>
          </div>

          <PairEditor
            idPrefix="mcp-env"
            legend="Environment secrets"
            keyPlaceholder="LINEAR_API_KEY"
            valuePlaceholder="Paste the value"
            secret
            pairs={value.env}
            onChange={(env) => setValue({ ...value, env })}
          />

          <PairEditor
            idPrefix="mcp-headers"
            legend="Headers"
            hint="Sent with every request. Sealed like the secrets above — an HTTP server usually authenticates with one."
            keyPlaceholder="Authorization"
            valuePlaceholder="Bearer …"
            secret
            pairs={value.headers}
            onChange={(headers) => setValue({ ...value, headers })}
          />
        </div>

        <CheckboxField
          checked={value.enabled}
          onChange={(enabled) => setValue({ ...value, enabled })}
          label="Enabled"
          hint="Disabled servers are skipped when a run starts."
        />
      </div>
    </Modal>
  );
}

/* -------------------------------------------------------------------------- */
/* Shared bits                                                                 */
/* -------------------------------------------------------------------------- */

function SectionIntro({
  description,
  action,
}: {
  description: string;
  action: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <p className="max-w-2xl text-xs leading-relaxed text-muted">{description}</p>
      <div className="shrink-0">{action}</div>
    </div>
  );
}

function ListSkeleton() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 3 }, (_, index) => (
        <Skeleton key={index} className="h-24 rounded-xl" />
      ))}
    </div>
  );
}

/** Editable key/value list, used for both env secrets and plain headers. */
function PairEditor({
  idPrefix,
  legend,
  hint,
  keyPlaceholder,
  valuePlaceholder,
  secret,
  pairs,
  onChange,
}: {
  idPrefix: string;
  legend: string;
  hint?: string;
  keyPlaceholder: string;
  valuePlaceholder: string;
  secret?: boolean;
  pairs: Pair[];
  onChange: (pairs: Pair[]) => void;
}) {
  const update = (index: number, patch: Partial<Pair>): void => {
    onChange(pairs.map((pair, i) => (i === index ? { ...pair, ...patch } : pair)));
  };

  return (
    <fieldset className="space-y-2">
      <legend className="text-[13px] font-medium text-ink">{legend}</legend>
      {hint ? <p className="text-xs leading-relaxed text-muted">{hint}</p> : null}

      {pairs.length === 0 ? (
        <p className="text-xs text-subtle">None.</p>
      ) : (
        <ul className="space-y-2">
          {pairs.map((pair, index) => (
            <li key={index} className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <Input
                value={pair.key}
                onChange={(event) => update(index, { key: event.target.value })}
                placeholder={keyPlaceholder}
                aria-label={`${legend} name ${index + 1}`}
                className="font-mono text-[12.5px] sm:flex-1"
              />
              <Input
                value={pair.value}
                onChange={(event) => update(index, { value: event.target.value })}
                placeholder={valuePlaceholder}
                aria-label={`${legend} value ${index + 1}`}
                type={secret ? 'password' : 'text'}
                autoComplete={secret ? 'new-password' : 'off'}
                className="font-mono text-[12.5px] sm:flex-1"
              />
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove ${pair.key || `entry ${index + 1}`}`}
                onClick={() => onChange(pairs.filter((_, i) => i !== index))}
                className="self-end sm:self-auto"
              >
                <X className="size-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      <Button
        variant="secondary"
        size="xs"
        onClick={() => onChange([...pairs, { key: '', value: '' }])}
        id={`${idPrefix}-add`}
      >
        <Plus className="size-3.5" />
        Add {legend.toLowerCase()}
      </Button>
    </fieldset>
  );
}

/* -------------------------------------------------------------------------- */
/* Parsing                                                                     */
/* -------------------------------------------------------------------------- */

/** Comma-separated list, or `null` when blank — the two mean different things. */
function parseList(raw: string): string[] | null {
  const items = raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : null;
}

function parseArgs(raw: string): string[] {
  return raw.split(/\s+/).filter(Boolean);
}

/** Drop incomplete rows: a key with no value would blank the stored secret. */
function pairsToRecord(pairs: Pair[]): Record<string, string> {
  const record: Record<string, string> = {};
  for (const pair of pairs) {
    const key = pair.key.trim();
    if (key && pair.value !== '') record[key] = pair.value;
  }
  return record;
}

function messageFor(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

export { AgentsPage as default };

/* -------------------------------------------------------------------------- */
/* From Claude                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * What the CLI reports, as opposed to what Metaclaude defines.
 *
 * Read on demand rather than with the rest of the page: it spawns a CLI
 * subprocess, so paying for it when the operator is on the Skills tab would tax
 * every visit for a panel most of them are not looking at.
 */
function ClaudeTab({ workspaceId }: { workspaceId: string | undefined }) {
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);

  const query = useQuery({
    queryKey: ['claude-catalogue', workspaceId ?? null],
    queryFn: () => api.claudeCatalogue(workspaceId ? { workspaceId } : {}),
    retry: false,
    staleTime: 5 * 60_000,
  });

  const refresh = async (): Promise<void> => {
    setRefreshing(true);
    try {
      // `refresh` skips the server's cache, which is the whole point: the
      // operator has just changed an MCP server's command and wants to know
      // whether it worked, not what it looked like a minute ago.
      const fresh = await api.claudeCatalogue({
        ...(workspaceId ? { workspaceId } : {}),
        refresh: true,
      });
      queryClient.setQueryData(['claude-catalogue', workspaceId ?? null], fresh);
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not read what Claude offers.');
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <ClaudeCataloguePanel
      catalogue={query.data}
      // `isLoading` is first-fetch only, so a refresh replaces the numbers
      // without blanking the panel the operator is reading.
      loading={query.isLoading || refreshing}
      onRefresh={() => void refresh()}
    />
  );
}
