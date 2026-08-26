/**
 * Turning the CLI's out-of-band messages into something an operator can read.
 *
 * The supervisor used to translate five of the SDK's message types and drop the
 * rest on the floor with `default: return {}`. The dropped ones are not
 * incidental: they are the messages that explain a run's behaviour. A stalled
 * run was an API retry nobody mentioned; an agent that forgot the conversation
 * was a compaction nobody mentioned; a session that suddenly failed everything
 * was an expired login nobody mentioned. Silence made all three look like bugs
 * in Metaclaude.
 *
 * Two rules are worth stating because they pull against each other. Anything
 * that explains behaviour must be recorded — and anything that arrives many
 * times a second must not be, or the transcript becomes unreadable and the
 * database grows without bound. `IGNORED` is the second rule written down, so
 * that "we dropped it" is a decision on the record rather than an omission.
 */

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HANDLED_SDK_MESSAGES, IGNORED_SDK_MESSAGES, narrate } from './sdk-narrator.js';

/** Build a `type: 'system'` message with the given subtype. */
const sys = (subtype: string, rest: Record<string, unknown> = {}) => ({
  type: 'system',
  subtype,
  uuid: 'u',
  session_id: 's',
  ...rest,
});

describe('what the supervisor already owns', () => {
  it('says nothing about messages another branch translates', () => {
    // Narrating these too would duplicate every assistant turn as a system note.
    for (const message of [
      { type: 'assistant', message: { content: [] } },
      { type: 'user', message: { content: [] } },
      { type: 'result', subtype: 'success' },
      { type: 'stream_event', event: {} },
      sys('init'),
      sys('permission_denied'),
    ]) {
      expect(narrate(message)).toBeNull();
    }
  });
});

describe('why a run appears stuck', () => {
  it('explains an API retry, with how long and which attempt', () => {
    // Without this the operator watches a run sit still for half a minute and
    // reasonably concludes the server has hung.
    const note = narrate(
      sys('api_retry', { attempt: 2, max_retries: 5, retry_delay_ms: 3000, error_status: 529 }),
    );

    expect(note?.level).toBe('warn');
    expect(note?.message).toContain('529');
    expect(note?.message).toContain('2');
    expect(note?.message).toContain('5');
  });

  it('survives an api_retry with no status', () => {
    // `error_status` is nullable — a transport failure has no HTTP status.
    expect(narrate(sys('api_retry', { attempt: 1, max_retries: 3, retry_delay_ms: 500, error_status: null }))
      ?.level).toBe('warn');
  });
});

describe('subscription rate limits', () => {
  it('stays quiet while usage is simply allowed', () => {
    // A note per request would drown the transcript to say "nothing is wrong".
    expect(narrate({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } })).toBeNull();
  });

  it('warns on the approach', () => {
    const note = narrate({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.92 },
    });

    expect(note?.level).toBe('warn');
    expect(note?.message).toMatch(/92%/);
  });

  it('reports a rejection as an error, and says when it lifts', () => {
    // The single most useful fact when a subscription limit bites is the time
    // it resets — without it the operator has no idea whether to wait or stop.
    const resetsAt = 1_800_000_000;
    const note = narrate({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected', rateLimitType: 'seven_day', resetsAt },
    });

    expect(note?.level).toBe('error');
    expect((note?.data as { resetsAt?: number })?.resetsAt).toBe(resetsAt * 1000);
  });
});

describe('why the agent forgot', () => {
  it('records a compaction and what it cost', () => {
    const note = narrate(
      sys('compact_boundary', {
        compact_metadata: { trigger: 'auto', pre_tokens: 152_000, post_tokens: 38_000 },
      }),
    );

    expect(note?.level).toBe('info');
    expect(note?.message).toMatch(/compact/i);
    expect(note?.message).toContain('152');
    expect(note?.message).toContain('38');
  });

  it('handles a compaction that reports no post-token count', () => {
    expect(
      narrate(sys('compact_boundary', { compact_metadata: { trigger: 'manual', pre_tokens: 90_000 } }))?.level,
    ).toBe('info');
  });
});

describe('why the model changed, or refused', () => {
  it('names both models when the CLI falls back', () => {
    const note = narrate(
      sys('model_refusal_fallback', {
        original_model: 'claude-opus-5',
        fallback_model: 'claude-sonnet-5',
        api_refusal_category: 'cyber',
        direction: 'retry',
      }),
    );

    expect(note?.level).toBe('warn');
    expect(note?.message).toContain('claude-opus-5');
    expect(note?.message).toContain('claude-sonnet-5');
    expect(note?.message).toContain('cyber');
  });

  it('treats a refusal with no fallback as an error and quotes it', () => {
    const note = narrate(
      sys('model_refusal_no_fallback', {
        original_model: 'claude-opus-5',
        content: 'I can’t help with that.',
      }),
    );

    expect(note?.level).toBe('error');
    expect(note?.message).toContain('I can’t help with that.');
  });
});

describe('authentication', () => {
  it('reports an auth failure as an error', () => {
    // On a subscription this is the difference between "Metaclaude is broken"
    // and "log in again".
    const note = narrate({ type: 'auth_status', isAuthenticating: false, output: [], error: 'Token expired' });

    expect(note?.level).toBe('error');
    expect(note?.message).toContain('Token expired');
  });

  it('says nothing while authentication is merely in progress', () => {
    expect(narrate({ type: 'auth_status', isAuthenticating: true, output: [] })).toBeNull();
  });
});

describe('the rest of the surface', () => {
  it('maps a notification’s priority onto a level', () => {
    expect(narrate(sys('notification', { text: 'x', priority: 'low' }))?.level).toBe('info');
    expect(narrate(sys('notification', { text: 'x', priority: 'immediate' }))?.level).toBe('warn');
  });

  it('maps an informational message’s own level, including "notice"', () => {
    // The CLI's vocabulary is wider than the transcript's; an unmapped value
    // must not become `undefined` in a persisted row.
    expect(narrate(sys('informational', { content: 'x', level: 'warning' }))?.level).toBe('warn');
    expect(narrate(sys('informational', { content: 'x', level: 'notice' }))?.level).toBe('info');
    expect(narrate(sys('informational', { content: 'x', level: 'suggestion' }))?.level).toBe('info');
  });

  it('drops a note that would have nothing to say', () => {
    // An empty message still renders: a bordered box with no text in it, which
    // reads as a rendering bug rather than as the absence of news.
    expect(narrate(sys('informational', { content: '', level: 'info' }))).toBeNull();
    expect(narrate(sys('notification', { text: '', priority: 'low' }))).toBeNull();
  });

  it('reports a hook that failed, and stays quiet about one that worked', () => {
    // A hook is the operator's own code. When it fails silently they debug the
    // agent instead of the hook.
    expect(
      narrate(sys('hook_response', { hook_name: 'pre-commit', outcome: 'error', stderr: 'boom' }))?.level,
    ).toBe('warn');
    expect(narrate(sys('hook_response', { hook_name: 'pre-commit', outcome: 'success' }))).toBeNull();
  });

  it('records background task bookends', () => {
    expect(narrate(sys('task_started', { task_id: 't1', description: 'index the repo' }))?.message).toContain(
      'index the repo',
    );
    const done = narrate(sys('task_notification', { task_id: 't1', status: 'failed', summary: 'crashed' }));
    expect(done?.level).toBe('warn');
  });

  it('reports a failed plugin install and ignores its progress', () => {
    expect(narrate(sys('plugin_install', { status: 'failed', name: 'p', error: 'bad manifest' }))?.level).toBe(
      'warn',
    );
    expect(narrate(sys('plugin_install', { status: 'started', name: 'p' }))).toBeNull();
  });

  it('warns when the CLI worker is going away', () => {
    expect(narrate(sys('worker_shutting_down', { reason: 'idle timeout' }))?.level).toBe('warn');
  });
});

describe('what is deliberately not recorded', () => {
  it('drops the high-frequency signals rather than filling the transcript', () => {
    // `tool_progress` is a heartbeat and `thinking_tokens` a running total.
    // Persisting either turns one long run into thousands of rows.
    for (const message of [
      { type: 'tool_progress', tool_use_id: 'x', elapsed_time_seconds: 4 },
      sys('thinking_tokens', { estimated_tokens: 900, estimated_tokens_delta: 12 }),
      sys('status', { status: {} }),
    ]) {
      expect(narrate(message)).toBeNull();
    }
  });

  it('says nothing about a message type it has never seen', () => {
    // Forward compatibility: a newer CLI must not be able to inject an
    // unrecognised payload into the transcript.
    expect(narrate({ type: 'something_invented_later', payload: 'x' })).toBeNull();
    expect(narrate(sys('a_new_subtype'))).toBeNull();
  });

  it('is unbothered by input that is not a message at all', () => {
    for (const junk of [null, undefined, 'string', 42, [], {}]) {
      expect(narrate(junk)).toBeNull();
    }
  });
});

/* -------------------------------------------------------------------------- */

describe('coverage of the SDK’s own union', () => {
  /**
   * Read the type names out of the installed SDK.
   *
   * This is the test that stops the original bug recurring. Dropping messages
   * was not a decision anyone made — it was a `default:` branch that quietly
   * absorbed whatever the SDK added next. Reading the union from the package on
   * disk means an upgrade that introduces a message type fails here, with its
   * name, instead of going unnoticed for a release.
   */
  function unionMembers(): string[] {
    const require = createRequire(import.meta.url);
    const entry = require.resolve('@anthropic-ai/claude-agent-sdk');
    const declaration = readFileSync(join(dirname(entry), 'sdk.d.ts'), 'utf8');

    const union = /declare type SDKMessage = ([^;]+);/.exec(declaration);
    if (!union) throw new Error('SDKMessage union not found — has the SDK layout changed?');
    return (union[1] as string).split('|').map((name) => name.trim());
  }

  /** `SDKTaskStartedMessage` → the `type`/`subtype` literals it declares. */
  function discriminators(typeName: string): { type: string; subtype?: string } | null {
    const require = createRequire(import.meta.url);
    const entry = require.resolve('@anthropic-ai/claude-agent-sdk');
    const declaration = readFileSync(join(dirname(entry), 'sdk.d.ts'), 'utf8');

    const body = new RegExp(`declare type ${typeName} = \\{([\\s\\S]*?)\\n\\};`).exec(declaration);
    if (!body) return null;
    const type = /\n\s+type: '([^']+)'/.exec(body[1] as string);
    if (!type) return null;
    const subtype = /\n\s+subtype: '([^']+)'/.exec(body[1] as string);
    return subtype ? { type: type[1] as string, subtype: subtype[1] as string } : { type: type[1] as string };
  }

  it('actually reads the union, rather than passing on an empty list', () => {
    // Without this, a regex that stopped matching after an SDK reformat would
    // turn the coverage test below into a no-op that reports success forever —
    // the same silent-absorption failure it exists to prevent, one level up.
    const members = unionMembers();
    expect(members.length).toBeGreaterThan(20);
    expect(members).toContain('SDKAssistantMessage');

    const shaped = members.map(discriminators).filter(Boolean);
    expect(shaped.length).toBeGreaterThan(20);
  });

  it('accounts for every member of SDKMessage', () => {
    const unaccounted: string[] = [];

    for (const member of unionMembers()) {
      const shape = discriminators(member);
      if (!shape) continue; // A member whose body this crude parse cannot read.

      const key = shape.subtype ? `${shape.type}:${shape.subtype}` : shape.type;

      // Accounted for = someone decided about it. Deliberately *not* "a probe
      // payload makes it produce a note": several handlers are conditional by
      // design — a plugin install is reported only when it fails — and judging
      // those by a synthetic payload would report a decision as a gap.
      if (!HANDLED_SDK_MESSAGES.has(key) && !IGNORED_SDK_MESSAGES.has(key)) {
        unaccounted.push(`${member} (${key})`);
      }
    }

    expect(unaccounted).toEqual([]);
  });
});
