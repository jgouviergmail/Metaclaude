/**
 * Tool steering transitions. `null` must stay the single spelling of
 * "nothing steered" — the submit payload omits the field on null, and two
 * spellings of the same state would make that conditional lie.
 */

import { describe, expect, it } from 'vitest';
import {
  cycleMcpServer,
  mcpServerState,
  steeredCount,
  toggleRequiredSkill,
} from './tool-controls';

describe('toggleRequiredSkill', () => {
  it('requires, then releases, and collapses back to null', () => {
    const on = toggleRequiredSkill(null, 'deploy');
    expect(on?.requiredSkills).toEqual(['deploy']);

    const both = toggleRequiredSkill(on, 'review');
    expect(both?.requiredSkills).toEqual(['deploy', 'review']);

    const one = toggleRequiredSkill(both, 'deploy');
    expect(one?.requiredSkills).toEqual(['review']);

    expect(toggleRequiredSkill(one, 'review')).toBeNull();
  });

  it('leaves server steering untouched while toggling skills', () => {
    const withServer = cycleMcpServer(null, 'docs');
    const withSkill = toggleRequiredSkill(withServer, 'deploy');
    expect(withSkill?.preferredMcpServers).toEqual(['docs']);
    expect(toggleRequiredSkill(withSkill, 'deploy')?.preferredMcpServers).toEqual(['docs']);
  });
});

describe('cycleMcpServer', () => {
  it('walks auto → preferred → off → auto, one state per click', () => {
    expect(mcpServerState(null, 'docs')).toBe('auto');

    const preferred = cycleMcpServer(null, 'docs');
    expect(mcpServerState(preferred, 'docs')).toBe('preferred');
    expect(preferred?.preferredMcpServers).toEqual(['docs']);
    expect(preferred?.excludedMcpServers).toEqual([]);

    const off = cycleMcpServer(preferred, 'docs');
    expect(mcpServerState(off, 'docs')).toBe('off');
    expect(off?.preferredMcpServers).toEqual([]);
    expect(off?.excludedMcpServers).toEqual(['docs']);

    // The full cycle ends where it began — and at nothing steered, at null.
    expect(cycleMcpServer(off, 'docs')).toBeNull();
  });

  it('never lets one server be both preferred and off', () => {
    // The contract refuses the contradiction; the transitions must make it
    // unrepresentable in the first place.
    let controls = cycleMcpServer(null, 'docs');
    controls = cycleMcpServer(controls, 'github');
    controls = cycleMcpServer(controls, 'docs');

    expect(controls?.preferredMcpServers).toEqual(['github']);
    expect(controls?.excludedMcpServers).toEqual(['docs']);
    const overlap = controls?.preferredMcpServers.filter((name) =>
      controls?.excludedMcpServers.includes(name),
    );
    expect(overlap).toEqual([]);
  });

  it('steeredCount counts across all three lists', () => {
    let controls = cycleMcpServer(null, 'docs');
    controls = toggleRequiredSkill(controls, 'deploy');
    expect(steeredCount(controls)).toBe(2);
    expect(steeredCount(null)).toBe(0);
  });
});
