/**
 * Prompt composer.
 *
 * The controls that change what the agent will do — model, effort, permission
 * mode — sit inline with the input rather than in a settings page, because they
 * are per-message decisions. Defaults come from the workspace, and "Auto" hands
 * the choice to the learned policy.
 */

import {
  Brain,
  ChevronDown,
  CornerDownLeft,
  Gauge,
  Loader2,
  Network,
  Paperclip,
  Shield,
  Square,
  Wand2,
  Wrench,
  X,
  Zap,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ATTACHMENT_LIMITS,
  PERMISSION_MODE_INFO,
  type ClaudeCatalogue,
  type EffortLevel,
  type PermissionMode,
  type ToolControls,
} from '@metaclaude/shared';
import { Button, Tooltip } from '@/components/ui/primitives';
import { ATTACHMENT_ACCEPT, type PendingAttachment } from '@/lib/attachments';
import { cycleMcpServer, mcpServerState, steeredCount, toggleRequiredSkill } from '@/lib/tool-controls';
import { effortOptions, modelOptions, supportsUltracode } from '@/lib/claude-catalogue';
import { cn, formatBytes, isModifier } from '@/lib/utils';
import { Menu, MenuItem, MenuLabel, MenuSeparator } from '@/components/ui/Menu';

const MODES: PermissionMode[] = ['plan', 'default', 'acceptEdits', 'auto', 'dontAsk'];

export interface ComposerValue {
  model: string;
  effort: EffortLevel | null;
  permissionMode: PermissionMode;
  /** Standing multi-agent orchestration for this message. See supportsUltracode. */
  ultracode: boolean;
  /** Per-message tool steering from the Tools picker; null means Auto. */
  toolControls: ToolControls | null;
}

/** What the Tools picker can offer — the workspace's own catalogue. */
export interface ToolPickerOptions {
  skills: string[];
  mcpServers: string[];
}

export function Composer({
  value,
  onChange,
  onSubmit,
  onInterrupt,
  isRunning,
  disabled,
  allowBypass,
  catalogue,
  attachments = [],
  onAttachFiles,
  onRemoveAttachment,
  toolOptions,
  placeholder = 'Ask Metaclaude to do something…',
}: {
  value: ComposerValue;
  onChange: (value: ComposerValue) => void;
  onSubmit: (prompt: string) => void;
  onInterrupt: () => void;
  isRunning: boolean;
  disabled?: boolean;
  allowBypass?: boolean;
  /** What the CLI offers here. Absent until it answers, and after it fails. */
  catalogue?: ClaudeCatalogue;
  /** Files pending on the next message; the page owns the upload flow. */
  attachments?: PendingAttachment[];
  onAttachFiles?: (files: File[]) => void;
  onRemoveAttachment?: (key: string) => void;
  /** The workspace's skills and MCP servers, for the Tools picker. */
  toolOptions?: ToolPickerOptions;
  placeholder?: string;
}) {
  const [text, setText] = useState('');
  const [dragging, setDragging] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploading = attachments.some((item) => item.status === 'uploading');

  // Grow with the content up to a cap, then scroll. Recomputed on every change
  // because there is no CSS-only way to auto-size a textarea.
  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 320)}px`;
  }, [text]);

  const submit = (): void => {
    const prompt = text.trim();
    // A message never leaves while an upload is in flight: sending would drop
    // the file silently, which is worse than a moment's wait.
    if (!prompt || disabled || isRunning || uploading) return;
    onSubmit(prompt);
    setText('');
    // Reset the height immediately so the composer does not stay tall and empty.
    requestAnimationFrame(() => {
      if (textareaRef.current) textareaRef.current.style.height = 'auto';
    });
  };

  const pickFiles = (list: FileList | null): void => {
    if (!list || !onAttachFiles) return;
    const files = Array.from(list);
    if (files.length > 0) onAttachFiles(files);
  };

  /* -- Tool steering — transitions live in lib/tool-controls -------------- */

  const controls = value.toolControls;
  const steered = steeredCount(controls);
  const toggleSkill = (name: string): void =>
    onChange({ ...value, toolControls: toggleRequiredSkill(controls, name) });
  const cycleServer = (name: string): void =>
    onChange({ ...value, toolControls: cycleMcpServer(controls, name) });

  const offerTools =
    toolOptions !== undefined && (toolOptions.skills.length > 0 || toolOptions.mcpServers.length > 0);

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    // Enter sends; Shift+Enter and ⌘/Ctrl+Enter insert a newline. This matches
    // every chat tool people already use, and the modifier escape hatch means a
    // multi-line prompt is never lost to muscle memory.
    if (event.key === 'Enter' && !event.shiftKey && !isModifier(event)) {
      event.preventDefault();
      submit();
    }
  };

  const modes = allowBypass ? [...MODES, 'bypassPermissions' as PermissionMode] : MODES;

  // Built from what the CLI reports rather than from a list written when this
  // component was. `catalogue` is optional throughout: a composer that cannot
  // offer a model is a session nobody can start, so a CLI that could not be
  // reached costs the extra detail and nothing else.
  const models = useMemo(() => modelOptions(catalogue), [catalogue]);
  const efforts = useMemo(() => effortOptions(catalogue, value.model), [catalogue, value.model]);
  const offerUltracode = supportsUltracode(catalogue, value.model);

  const activeModel =
    models.find((m) => m.value === value.model) ??
    // A model the catalogue has not enumerated is still a valid choice — an
    // operator can name a dated id. Showing it is better than silently
    // displaying someone else's label.
    (value.model === 'default' ? models[0] : { value: value.model, label: value.model, hint: '' });
  const activeEffort = efforts.find((e) => e.value === value.effort) ?? efforts[0];
  const activeMode = PERMISSION_MODE_INFO[value.permissionMode];

  return (
    <div className="border-t border-line bg-surface/80 backdrop-blur">
      <div className="mx-auto max-w-4xl px-3 py-3 sm:px-6">
        <div
          className={cn(
            'rounded-2xl border bg-surface transition-colors',
            'focus-within:border-accent',
            dragging
              ? 'border-accent bg-accent-soft/40'
              : value.permissionMode === 'bypassPermissions'
                ? 'border-danger'
                : 'border-line',
          )}
          onDragOver={(event) => {
            if (!onAttachFiles) return;
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            if (!onAttachFiles) return;
            event.preventDefault();
            setDragging(false);
            pickFiles(event.dataTransfer.files);
          }}
        >
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={onKeyDown}
            onPaste={(event) => {
              // A screenshot pasted from the clipboard is the single most
              // common way to show the agent something.
              if (onAttachFiles && event.clipboardData.files.length > 0) {
                event.preventDefault();
                pickFiles(event.clipboardData.files);
              }
            }}
            placeholder={placeholder}
            disabled={disabled}
            rows={1}
            aria-label="Prompt"
            className={cn(
              'block w-full resize-none bg-transparent px-4 pt-3 pb-2',
              'text-[15px] leading-relaxed text-ink placeholder:text-subtle',
              'focus:outline-none disabled:opacity-60',
            )}
          />

          {attachments.length > 0 ? (
            <ul className="flex flex-wrap gap-1.5 px-3 pb-1.5" aria-label="Pending attachments">
              {attachments.map((item) => (
                <li
                  key={item.key}
                  className={cn(
                    'inline-flex max-w-full items-center gap-1.5 rounded-lg border px-2 py-1 text-[12px]',
                    item.status === 'error'
                      ? 'border-danger bg-danger-soft text-danger'
                      : 'border-line bg-raised text-muted',
                  )}
                >
                  {item.status === 'uploading' ? (
                    <Loader2 className="size-3.5 shrink-0 animate-spin" aria-label="Uploading" />
                  ) : (
                    <Paperclip className="size-3.5 shrink-0" aria-hidden />
                  )}
                  <span className="truncate" title={item.name}>
                    {item.name}
                  </span>
                  <span className="shrink-0 text-subtle">
                    {item.status === 'error' ? (item.error ?? 'failed') : formatBytes(item.bytes)}
                  </span>
                  {onRemoveAttachment ? (
                    <button
                      type="button"
                      onClick={() => onRemoveAttachment(item.key)}
                      aria-label={`Remove ${item.name}`}
                      className="shrink-0 rounded p-0.5 hover:bg-surface hover:text-ink"
                    >
                      <X className="size-3" aria-hidden />
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}

          <div className="flex flex-wrap items-center gap-1.5 px-2.5 pb-2.5">
            {/* Attach ----------------------------------------------------- */}
            {onAttachFiles ? (
              <>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept={ATTACHMENT_ACCEPT}
                  className="hidden"
                  aria-hidden
                  tabIndex={-1}
                  onChange={(event) => {
                    pickFiles(event.target.files);
                    // Same file picked twice must fire change twice.
                    event.target.value = '';
                  }}
                />
                <Tooltip
                  content={`Attach files — up to ${ATTACHMENT_LIMITS.maxPerMessage} per message. Drag & drop and pasted screenshots work too.`}
                >
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={disabled || attachments.length >= ATTACHMENT_LIMITS.maxPerMessage}
                    aria-label="Attach files"
                    className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium text-muted hover:bg-raised hover:text-ink disabled:opacity-50"
                  >
                    <Paperclip className="size-3.5" aria-hidden />
                    {attachments.length > 0 ? attachments.length : null}
                  </button>
                </Tooltip>
              </>
            ) : null}

            {/* Model ------------------------------------------------------ */}
            <Menu
              trigger={
                <button
                  type="button"
                  className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium text-muted hover:bg-raised hover:text-ink"
                >
                  <Wand2 className="size-3.5" aria-hidden />
                  {activeModel?.label}
                  <ChevronDown className="size-3" aria-hidden />
                </button>
              }
            >
              {models.map((model) => (
                <MenuItem
                  key={model.value}
                  selected={model.value === value.model}
                  onSelect={() => onChange({ ...value, model: model.value })}
                  description={model.hint}
                >
                  {model.label}
                </MenuItem>
              ))}
            </Menu>

            {/* Effort ----------------------------------------------------- */}
            <Menu
              trigger={
                <button
                  type="button"
                  className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium text-muted hover:bg-raised hover:text-ink"
                >
                  <Gauge className="size-3.5" aria-hidden />
                  {activeEffort?.label}
                  <ChevronDown className="size-3" aria-hidden />
                </button>
              }
            >
              {efforts.map((effort) => (
                <MenuItem
                  key={effort.label}
                  selected={effort.value === value.effort}
                  onSelect={() => onChange({ ...value, effort: effort.value })}
                >
                  {effort.label}
                </MenuItem>
              ))}
            </Menu>

            {/* Permission mode -------------------------------------------- */}
            <Menu
              trigger={
                <button
                  type="button"
                  className={cn(
                    'inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium',
                    value.permissionMode === 'bypassPermissions'
                      ? 'bg-danger-soft text-danger'
                      : value.permissionMode === 'plan'
                        ? 'bg-info-soft text-info'
                        : 'text-muted hover:bg-raised hover:text-ink',
                  )}
                >
                  <Shield className="size-3.5" aria-hidden />
                  {activeMode.label}
                  <ChevronDown className="size-3" aria-hidden />
                </button>
              }
            >
              {modes.map((mode) => (
                <MenuItem
                  key={mode}
                  selected={mode === value.permissionMode}
                  onSelect={() => onChange({ ...value, permissionMode: mode })}
                  description={PERMISSION_MODE_INFO[mode].description}
                  tone={PERMISSION_MODE_INFO[mode].risk === 'high' ? 'danger' : undefined}
                >
                  {PERMISSION_MODE_INFO[mode].label}
                </MenuItem>
              ))}
            </Menu>

            {/* Ultracode --------------------------------------------------- */}
            {offerUltracode ? (
              <Tooltip content="Fan the work out across sub-agents that explore, verify and contradict each other. Maximum effort — and token spend to match.">
                <button
                  type="button"
                  aria-pressed={value.ultracode}
                  onClick={() => onChange({ ...value, ultracode: !value.ultracode })}
                  className={cn(
                    'inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium',
                    value.ultracode
                      ? 'bg-accent-soft text-accent'
                      : 'text-muted hover:bg-raised hover:text-ink',
                  )}
                >
                  <Network className="size-3.5" aria-hidden />
                  Ultracode
                </button>
              </Tooltip>
            ) : value.model === 'default' ? (
              // Withheld under Auto is a design decision; withheld *silently*
              // was how it read as missing. The inert button says why.
              <Tooltip content="Ultracode needs a model that can orchestrate — under Auto the learner may pick one that cannot. Choose a model (Fable, Opus…) to enable it.">
                <button
                  type="button"
                  aria-disabled="true"
                  className="inline-flex h-7 cursor-not-allowed items-center gap-1.5 rounded-md px-2 text-[12px] font-medium text-subtle opacity-70"
                >
                  <Network className="size-3.5" aria-hidden />
                  Ultracode
                </button>
              </Tooltip>
            ) : null}

            {/* Tools -------------------------------------------------------- */}
            {offerTools ? (
              <Menu
                trigger={
                  <button
                    type="button"
                    aria-label="Tools"
                    className={cn(
                      'inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium',
                      steered > 0
                        ? 'bg-accent-soft text-accent'
                        : 'text-muted hover:bg-raised hover:text-ink',
                    )}
                  >
                    <Wrench className="size-3.5" aria-hidden />
                    Tools
                    {steered > 0 ? <span>{steered}</span> : null}
                    <ChevronDown className="size-3" aria-hidden />
                  </button>
                }
              >
                {toolOptions.skills.length > 0 ? (
                  <>
                    <MenuLabel>Require skills</MenuLabel>
                    {toolOptions.skills.map((skill) => (
                      <MenuItem
                        key={skill}
                        keepOpen
                        selected={controls?.requiredSkills.includes(skill) ?? false}
                        onSelect={() => toggleSkill(skill)}
                      >
                        {skill}
                      </MenuItem>
                    ))}
                  </>
                ) : null}
                {toolOptions.skills.length > 0 && toolOptions.mcpServers.length > 0 ? (
                  <MenuSeparator />
                ) : null}
                {toolOptions.mcpServers.length > 0 ? (
                  <>
                    <MenuLabel>MCP servers</MenuLabel>
                    {toolOptions.mcpServers.map((server) => {
                      const state = mcpServerState(controls, server);
                      return (
                        <MenuItem
                          key={server}
                          keepOpen
                          selected={state !== 'auto'}
                          onSelect={() => cycleServer(server)}
                          description={
                            state === 'preferred'
                              ? 'Preferred — the agent is asked to reach for it first'
                              : state === 'off'
                                ? 'Off — not mounted for this message'
                                : 'Auto — the agent decides'
                          }
                        >
                          {state === 'off' ? <s>{server}</s> : server}
                        </MenuItem>
                      );
                    })}
                  </>
                ) : null}
                {steered > 0 ? (
                  <>
                    <MenuSeparator />
                    <MenuItem onSelect={() => onChange({ ...value, toolControls: null })}>
                      Reset — back to Auto
                    </MenuItem>
                  </>
                ) : null}
              </Menu>
            ) : null}

            <div className="ml-auto flex items-center gap-2">
              {isRunning ? (
                <Button variant="danger" size="sm" onClick={onInterrupt}>
                  <Square className="size-3.5 fill-current" aria-hidden />
                  Stop
                </Button>
              ) : (
                <Tooltip
                  content={
                    uploading ? 'Waiting for the upload to finish' : 'Enter to send · Shift+Enter for a new line'
                  }
                >
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={submit}
                    disabled={!text.trim() || disabled || uploading}
                    aria-label="Send"
                  >
                    <CornerDownLeft className="size-3.5" aria-hidden />
                    Send
                  </Button>
                </Tooltip>
              )}
            </div>
          </div>
        </div>

        {value.ultracode && offerUltracode ? (
          <p className="mt-2 flex items-center gap-1.5 text-[11.5px] text-accent">
            <Network className="size-3" aria-hidden />
            Ultracode: this message fans out across sub-agents at maximum effort. Expect
            multi-agent token spend.
          </p>
        ) : null}
        {steered > 0 ? (
          <p className="mt-2 flex flex-wrap items-center gap-1.5 text-[11.5px] text-accent">
            <Wrench className="size-3" aria-hidden />
            {[
              controls && controls.requiredSkills.length > 0
                ? `Skills required: ${controls.requiredSkills.join(', ')}`
                : null,
              controls && controls.preferredMcpServers.length > 0
                ? `MCP preferred: ${controls.preferredMcpServers.join(', ')}`
                : null,
              controls && controls.excludedMcpServers.length > 0
                ? `MCP off: ${controls.excludedMcpServers.join(', ')}`
                : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        ) : null}
        {value.permissionMode === 'bypassPermissions' ? (
          <p className="mt-2 flex items-center gap-1.5 text-[11.5px] text-danger">
            <Zap className="size-3" aria-hidden />
            Bypass mode: the agent will run commands and edit files without asking.
          </p>
        ) : value.permissionMode === 'plan' ? (
          <p className="mt-2 flex items-center gap-1.5 text-[11.5px] text-muted">
            <Brain className="size-3" aria-hidden />
            Plan mode: the agent will research and propose, but execute nothing.
          </p>
        ) : null}
      </div>
    </div>
  );
}
