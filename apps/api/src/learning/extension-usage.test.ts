/**
 * What a run actually did with the extensions it was given.
 *
 * Every fixture here is built from the shape *measured* against Claude Code
 * on 2026-09-10 rather than from the SDK's declarations, because the SDK has
 * no declaration for one of the two tools and the repository was wrong about
 * the name of the other: a skill call is `Skill` with `{skill}`, a delegation
 * is `Agent` with `{description, subagent_type, prompt}`. A fixture written
 * from memory here would pass against the very defect it exists to catch —
 * the `fakeQuery` that emitted a replay acknowledgement the CLI never sends.
 */

import type { TranscriptEvent } from '@metaclaude/shared';
import { describe, expect, it } from 'vitest';
import { collectExtensionUsage, type AvailableExtension } from './extension-usage.js';

let seq = 0;

function toolCall(
  name: string,
  input: Record<string, unknown>,
  extra: { resultIsError?: boolean; status?: TranscriptEvent extends never ? never : string } = {},
): TranscriptEvent {
  seq += 1;
  return {
    kind: 'tool_call',
    id: `ev_${seq}`,
    runId: 'run_1',
    seq,
    at: 1000 + seq,
    toolUseId: `tu_${seq}`,
    name,
    input,
    status: (extra.status as 'ok' | 'error' | 'denied') ?? (extra.resultIsError ? 'error' : 'ok'),
    result: null,
    resultIsError: extra.resultIsError ?? false,
    durationMs: null,
  };
}

/** A skill invocation exactly as the CLI emits it. */
const skillCall = (name: string, extra?: { resultIsError?: boolean; status?: string }) =>
  toolCall('Skill', { skill: name }, extra);

/** A delegation exactly as the CLI emits it. */
const agentCall = (name: string | undefined, extra?: { resultIsError?: boolean; status?: string }) =>
  toolCall(
    'Agent',
    {
      description: 'Do the thing',
      ...(name === undefined ? {} : { subagent_type: name }),
      prompt: 'the prompt',
    },
    extra,
  );

const available: AvailableExtension[] = [
  { kind: 'skill', id: 'skl_1', name: 'review-migrations' },
  { kind: 'skill', id: 'skl_2', name: 'postmortem' },
  { kind: 'agent', id: 'agt_1', name: 'code-reviewer' },
];

const find = (rows: ReturnType<typeof collectExtensionUsage>, kind: string, name: string) =>
  rows.find((row) => row.kind === kind && row.name === name);

describe('collectExtensionUsage', () => {
  it('reports every available extension, invoked or not', () => {
    const rows = collectExtensionUsage(available, []);

    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row).toMatchObject({ available: true, invoked: 0, failed: 0 });
      expect(row.extensionId).not.toBeNull();
    }
  });

  it('counts a skill invocation against the skill it names', () => {
    const rows = collectExtensionUsage(available, [skillCall('review-migrations')]);

    expect(find(rows, 'skill', 'review-migrations')).toMatchObject({
      extensionId: 'skl_1',
      available: true,
      invoked: 1,
      failed: 0,
    });
    expect(find(rows, 'skill', 'postmortem')).toMatchObject({ invoked: 0 });
  });

  it('counts a delegation against the subagent it names', () => {
    const rows = collectExtensionUsage(available, [agentCall('code-reviewer')]);

    expect(find(rows, 'agent', 'code-reviewer')).toMatchObject({
      extensionId: 'agt_1',
      available: true,
      invoked: 1,
      failed: 0,
    });
  });

  /**
   * `Task` is the name this repository believed in for four releases and the
   * CLI has never used. Accepting both costs one array entry; refusing the
   * alias would make every invocation invisible the day a CLI renames it back.
   */
  it('accepts the Task alias for a delegation', () => {
    const rows = collectExtensionUsage(available, [
      toolCall('Task', { description: 'x', subagent_type: 'code-reviewer', prompt: 'p' }),
    ]);

    expect(find(rows, 'agent', 'code-reviewer')).toMatchObject({ invoked: 1 });
  });

  it('adds up repeated invocations of one extension', () => {
    const rows = collectExtensionUsage(available, [
      skillCall('review-migrations'),
      skillCall('review-migrations'),
      skillCall('postmortem'),
    ]);

    expect(find(rows, 'skill', 'review-migrations')).toMatchObject({ invoked: 2 });
    expect(find(rows, 'skill', 'postmortem')).toMatchObject({ invoked: 1 });
  });

  /**
   * A failure is still an invocation. The two counters answer different
   * questions — "does the model ever reach for this" and "does it work when it
   * does" — and folding them would make an agent that fails every time look
   * exactly like one nobody calls, which is the opposite prescription.
   */
  it('counts a failed invocation as both invoked and failed', () => {
    const rows = collectExtensionUsage(available, [
      agentCall('code-reviewer', { resultIsError: true }),
      agentCall('code-reviewer'),
    ]);

    expect(find(rows, 'agent', 'code-reviewer')).toMatchObject({ invoked: 2, failed: 1 });
  });

  it('counts a denied invocation as failed', () => {
    const rows = collectExtensionUsage(available, [skillCall('postmortem', { status: 'denied' })]);

    expect(find(rows, 'skill', 'postmortem')).toMatchObject({ invoked: 1, failed: 1 });
  });

  /**
   * A skill from a plugin, or a subagent type the CLI ships (`general-purpose`,
   * `Explore`), is a real invocation that no registry row owns. Dropping it
   * would understate what the run did; giving it an id it does not have would
   * make the doctor's join report a dead extension as alive.
   */
  it('records an invocation of something not in the registry, with no id', () => {
    const rows = collectExtensionUsage(available, [
      skillCall('pdf'),
      agentCall('general-purpose'),
    ]);

    expect(find(rows, 'skill', 'pdf')).toMatchObject({
      extensionId: null,
      available: false,
      invoked: 1,
    });
    expect(find(rows, 'agent', 'general-purpose')).toMatchObject({
      extensionId: null,
      available: false,
      invoked: 1,
    });
  });

  it('ignores a delegation that names no subagent type', () => {
    const rows = collectExtensionUsage(available, [agentCall(undefined)]);

    expect(rows.filter((row) => row.invoked > 0)).toEqual([]);
  });

  it('ignores a skill call whose field is missing, empty or not a string', () => {
    const rows = collectExtensionUsage(available, [
      toolCall('Skill', {}),
      toolCall('Skill', { skill: '   ' }),
      toolCall('Skill', { skill: 42 }),
      toolCall('Skill', { skill: null }),
    ]);

    expect(rows.filter((row) => row.invoked > 0)).toEqual([]);
    expect(rows).toHaveLength(3);
  });

  it('ignores a tool call with no input at all', () => {
    const rows = collectExtensionUsage(available, [
      { ...toolCall('Skill', {}), input: null } as TranscriptEvent,
      { ...toolCall('Agent', {}), input: undefined } as TranscriptEvent,
    ]);

    expect(rows.filter((row) => row.invoked > 0)).toEqual([]);
  });

  /**
   * `mcp__server__Skill` is another server's tool that happens to share a
   * name. The built-ins are bare; anything prefixed belongs to whoever offers
   * it, and counting it here would credit a skill that was never opened.
   */
  it('ignores an MCP tool whose bare name collides with a built-in', () => {
    const rows = collectExtensionUsage(available, [
      toolCall('mcp__somewhere__Skill', { skill: 'review-migrations' }),
      toolCall('mcp__somewhere__Agent', { subagent_type: 'code-reviewer' }),
    ]);

    expect(rows.filter((row) => row.invoked > 0)).toEqual([]);
  });

  it('ignores every other kind of event', () => {
    const rows = collectExtensionUsage(available, [
      {
        kind: 'assistant_text',
        id: 'ev_a',
        runId: 'run_1',
        seq: 900,
        at: 1,
        text: 'Skill review-migrations',
        streaming: false,
      },
      {
        kind: 'user_message',
        id: 'ev_u',
        runId: 'run_1',
        seq: 901,
        at: 2,
        text: 'use the postmortem skill',
        attachments: [],
      },
    ]);

    expect(rows.filter((row) => row.invoked > 0)).toEqual([]);
  });

  it('trims the name the CLI reported before matching', () => {
    const rows = collectExtensionUsage(available, [skillCall('  postmortem  ')]);

    expect(find(rows, 'skill', 'postmortem')).toMatchObject({ invoked: 1, available: true });
  });

  /**
   * A skill and a subagent may legitimately share a name — they are different
   * registries with different unique indexes — so the kind has to be part of
   * the identity or one would absorb the other's count.
   */
  it('keeps a skill and a subagent of the same name apart', () => {
    const rows = collectExtensionUsage(
      [
        { kind: 'skill', id: 'skl_x', name: 'reviewer' },
        { kind: 'agent', id: 'agt_x', name: 'reviewer' },
      ],
      [skillCall('reviewer'), agentCall('reviewer'), agentCall('reviewer')],
    );

    expect(find(rows, 'skill', 'reviewer')).toMatchObject({ extensionId: 'skl_x', invoked: 1 });
    expect(find(rows, 'agent', 'reviewer')).toMatchObject({ extensionId: 'agt_x', invoked: 2 });
  });

  it('returns nothing at all when there is nothing to say', () => {
    expect(collectExtensionUsage([], [])).toEqual([]);
  });
});
