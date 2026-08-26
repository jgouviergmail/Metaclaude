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
  Shield,
  Square,
  Wand2,
  Zap,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  PERMISSION_MODE_INFO,
  type ClaudeCatalogue,
  type EffortLevel,
  type PermissionMode,
} from '@metaclaude/shared';
import { Button, Tooltip } from '@/components/ui/primitives';
import { effortOptions, modelOptions } from '@/lib/claude-catalogue';
import { cn, isModifier } from '@/lib/utils';
import { Menu, MenuItem } from '@/components/ui/Menu';

const MODES: PermissionMode[] = ['plan', 'default', 'acceptEdits', 'auto', 'dontAsk'];

export interface ComposerValue {
  model: string;
  effort: EffortLevel | null;
  permissionMode: PermissionMode;
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
  placeholder?: string;
}) {
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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
    if (!prompt || disabled || isRunning) return;
    onSubmit(prompt);
    setText('');
    // Reset the height immediately so the composer does not stay tall and empty.
    requestAnimationFrame(() => {
      if (textareaRef.current) textareaRef.current.style.height = 'auto';
    });
  };

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
            value.permissionMode === 'bypassPermissions' ? 'border-danger' : 'border-line',
          )}
        >
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={onKeyDown}
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

          <div className="flex flex-wrap items-center gap-1.5 px-2.5 pb-2.5">
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

            <div className="ml-auto flex items-center gap-2">
              {isRunning ? (
                <Button variant="danger" size="sm" onClick={onInterrupt}>
                  <Square className="size-3.5 fill-current" aria-hidden />
                  Stop
                </Button>
              ) : (
                <Tooltip content="Enter to send · Shift+Enter for a new line">
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={submit}
                    disabled={!text.trim() || disabled}
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
