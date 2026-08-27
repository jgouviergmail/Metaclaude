/**
 * The Tools picker's state transitions, as pure functions.
 *
 * Extracted from the composer so every transition is testable without
 * opening a Radix menu in a test DOM — and so `null` stays the single
 * representation of "nothing steered": every transition normalises an
 * all-empty value back to null, which is what lets the submit payload omit
 * the field entirely.
 */

import type { ToolControls } from '@metaclaude/shared';

export const EMPTY_CONTROLS: ToolControls = {
  requiredSkills: [],
  excludedMcpServers: [],
  preferredMcpServers: [],
};

export function steeredCount(controls: ToolControls | null): number {
  if (!controls) return 0;
  return (
    controls.requiredSkills.length +
    controls.excludedMcpServers.length +
    controls.preferredMcpServers.length
  );
}

function normalise(controls: ToolControls): ToolControls | null {
  return steeredCount(controls) === 0 ? null : controls;
}

export function toggleRequiredSkill(
  controls: ToolControls | null,
  name: string,
): ToolControls | null {
  const current = controls ?? EMPTY_CONTROLS;
  return normalise({
    ...current,
    requiredSkills: current.requiredSkills.includes(name)
      ? current.requiredSkills.filter((skill) => skill !== name)
      : [...current.requiredSkills, name],
  });
}

export type McpServerState = 'auto' | 'preferred' | 'off';

export function mcpServerState(controls: ToolControls | null, name: string): McpServerState {
  if (controls?.preferredMcpServers.includes(name)) return 'preferred';
  if (controls?.excludedMcpServers.includes(name)) return 'off';
  return 'auto';
}

/** One state per click: auto → preferred → off → auto. */
export function cycleMcpServer(controls: ToolControls | null, name: string): ToolControls | null {
  const current = controls ?? EMPTY_CONTROLS;
  const state = mcpServerState(controls, name);
  return normalise({
    ...current,
    preferredMcpServers:
      state === 'auto'
        ? [...current.preferredMcpServers, name]
        : current.preferredMcpServers.filter((server) => server !== name),
    excludedMcpServers:
      state === 'preferred'
        ? [...current.excludedMcpServers, name]
        : current.excludedMcpServers.filter((server) => server !== name),
  });
}
