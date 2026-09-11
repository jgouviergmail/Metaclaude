#!/usr/bin/env node
/*
 * What the Claude Agent SDK *actually does*, measured against a live CLI.
 *
 * Not a test. Tests cannot see any of this: every fact below is a behaviour of
 * the real subprocess, and several concern fields the SDK's own type
 * declarations either omit or contradict. Each was found the hard way in one
 * session, and each holds up a shipped feature:
 *
 *   - `rate_limits` carries the declared object keys *and* a `limits` array. The
 *     per-model buckets live only in the array, so a screen reading the declared
 *     shape alone shows the global windows and nothing about the model that is
 *     actually spent.
 *   - `unifiedWindows` on a rejected rate-limit event is undeclared, and is the
 *     discriminator for "one model is spent" against "everything is".
 *   - `fallbackModel` is documented for a model that is "overloaded or
 *     unavailable" and, measured, does not cover quota at all.
 *   - `effort` is declared on the init frame and is not in the object, which is
 *     why there is no `served_effort` column.
 *   - a resumed run re-applies and *replaces* the system-prompt append, which is
 *     why per-message context may not live there.
 *
 * Run it before an SDK bump to freeze a baseline, and after to diff. A
 * difference is not automatically a regression — it may be the fix that lets
 * code be deleted — but an *unnoticed* difference is how a feature dies quietly.
 *
 *   node scripts/sdk-probe.mjs                     # measure, print JSON
 *   node scripts/sdk-probe.mjs --out b.json        # measure and save
 *   node scripts/sdk-probe.mjs --baseline b.json   # measure and diff
 *
 * Needs a working CLI credential, so it runs where one exists: the container,
 * or a signed-in machine. It spends a few hundred haiku tokens.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(name);
  return at === -1 ? null : (args[at + 1] ?? null);
};

const OK = 'measured';
const SKIP = 'not measurable here';

/**
 * Load the SDK from wherever it actually is.
 *
 * A plain import works from the repo. Inside the production image this script is
 * piped in from stdin with no package context, so the pnpm store is scanned
 * instead — platform packages are excluded because they carry the binary rather
 * than the module.
 */
async function loadSdk() {
  try {
    return await import('@anthropic-ai/claude-agent-sdk');
  } catch {
    const found = installedSdkDir();
    if (found) {
      return import(`${found}/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs`);
    }
    throw new Error('could not locate @anthropic-ai/claude-agent-sdk');
  }
}

/**
 * Where pnpm actually put the SDK.
 *
 * Shared by the loader and the version reader, because pnpm does not symlink a
 * transitive package into the top-level `node_modules` — resolving it by name
 * inside the production image fails for both. Platform packages are excluded:
 * they carry the binary, not the module.
 */
function installedSdkDir() {
  for (const root of ['/opt/metaclaude/node_modules/.pnpm', '/app/node_modules/.pnpm']) {
    if (!existsSync(root)) continue;
    const dir = readdirSync(root).find(
      (name) => name.startsWith('@anthropic-ai+claude-agent-') && !/linux|win32|darwin/.test(name),
    );
    if (dir) return `${root}/${dir}`;
  }
  return null;
}

/**
 * The installed SDK version.
 *
 * The first version of this returned "unknown" inside the container, and a
 * baseline whose version is unknown cannot be diffed against anything — which
 * makes the artefact worthless at exactly the moment it is needed.
 */
function sdkVersion() {
  try {
    const url = new URL(
      '../node_modules/@anthropic-ai/claude-agent-sdk/package.json',
      import.meta.url,
    );
    return JSON.parse(readFileSync(url, 'utf8')).version;
  } catch {
    /* not running from the repo */
  }
  const found = installedSdkDir();
  if (!found) return 'unknown';
  try {
    const path = `${found}/node_modules/@anthropic-ai/claude-agent-sdk/package.json`;
    return JSON.parse(readFileSync(path, 'utf8')).version;
  } catch {
    return 'unknown';
  }
}

class PromptStream {
  #queued = [];
  #wake = null;
  #closed = false;

  push(text) {
    this.#queued.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
      uuid: randomUUID(),
    });
    this.#wake?.();
  }

  close() {
    this.#closed = true;
    this.#wake?.();
  }

  async *[Symbol.asyncIterator]() {
    for (;;) {
      while (this.#queued.length > 0) yield this.#queued.shift();
      if (this.#closed) return;
      await new Promise((resolve) => {
        this.#wake = () => {
          this.#wake = null;
          resolve();
        };
      });
    }
  }
}

/** One turn, with everything worth recording captured off the wire. */
async function turn(query, { prompt, options = {} }) {
  const stream = new PromptStream();
  const controller = new AbortController();
  const seen = {
    initKeys: [],
    initModel: null,
    cliVersion: null,
    initHasEffort: false,
    sessionId: null,
    assistantModels: [],
    assistantErrors: [],
    rateLimits: [],
    result: null,
    text: '',
    usage: null,
    threw: null,
  };

  try {
    const handle = query({
      prompt: stream,
      options: { permissionMode: 'dontAsk', abortController: controller, ...options },
    });
    stream.push(prompt);
    stream.close();

    for await (const message of handle) {
      if (message.type === 'system' && message.subtype === 'init') {
        seen.initKeys = Object.keys(message).sort();
        seen.initModel = message.model ?? null;
        seen.cliVersion = message.claude_code_version ?? null;
        seen.initHasEffort = 'effort' in message;
        seen.sessionId = message.session_id ?? null;
      }
      if (message.type === 'assistant') {
        if (message.message?.model) seen.assistantModels.push(message.message.model);
        if (message.error) seen.assistantErrors.push(message.error);
        for (const block of message.message?.content ?? []) {
          if (block.type === 'text') seen.text += block.text;
        }
      }
      if (message.type === 'rate_limit_event') seen.rateLimits.push(message.rate_limit_info);
      if (message.type === 'result') {
        seen.sessionId = seen.sessionId ?? message.session_id ?? null;
        seen.result = {
          subtype: message.subtype,
          isError: message.is_error ?? null,
          text: String(message.result ?? '').slice(0, 200),
        };
        seen.usage = Object.values(message.modelUsage ?? {}).reduce(
          (total, entry) => ({
            in: total.in + (entry.inputTokens ?? 0),
            out: total.out + (entry.outputTokens ?? 0),
            cacheRead: total.cacheRead + (entry.cacheReadInputTokens ?? 0),
            cacheWrite: total.cacheWrite + (entry.cacheCreationInputTokens ?? 0),
          }),
          { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 },
        );
      }
    }
  } catch (error) {
    // A quota refusal exits the CLI non-zero. That is data, not a crash.
    seen.threw = String(error?.message ?? error).slice(0, 160);
  } finally {
    controller.abort();
  }

  return seen;
}

/* -------------------------------------------------------------------------- */
/* The probes                                                                  */
/* -------------------------------------------------------------------------- */

/** The shape of `rate_limits`: declared as an object, sent as an array. */
async function probeUsageShape(query, cwd) {
  const stream = new PromptStream();
  const controller = new AbortController();
  const handle = query({ prompt: stream, options: { cwd, abortController: controller } });
  const drained = (async () => {
    try {
      for await (const message of handle) void message;
    } catch {
      /* ends on the abort below */
    }
  })();

  try {
    const answer = await handle.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET();
    const limits = answer?.rate_limits;
    return {
      status: limits ? OK : SKIP,
      available: answer?.rate_limits_available ?? null,
      shape: Array.isArray(limits?.limits) ? 'array' : limits ? 'object' : 'absent',
      keys: limits ? Object.keys(limits).sort() : [],
      rowKeys: Array.isArray(limits?.limits) ? Object.keys(limits.limits[0] ?? {}).sort() : [],
      behaviourWindows: answer?.behaviors ? Object.keys(answer.behaviors).sort() : [],
    };
  } catch (error) {
    return { status: SKIP, reason: String(error?.message ?? error).slice(0, 120) };
  } finally {
    controller.abort();
    await drained.catch(() => {});
  }
}

/**
 * What a skill call and a delegation look like on the wire.
 *
 * Neither is a detail. The SDK's `ToolInputSchemas` union has an entry for
 * every built-in tool except `Skill`, so the field naming which skill was
 * opened is undeclared and can only be measured; and the delegation tool is
 * `Agent`, while this repository spelled it `Task` in three places for four
 * releases — the permission card's summary, the transcript's label, and a
 * comment reasoning about which tools only read. Nothing failed: the card just
 * printed raw JSON where it meant to print a sentence, and every invocation
 * went uncounted, which is the whole reason `run_extension_usages` exists.
 *
 * A real skill is written into a scratch workspace and the model is told to
 * use it, because a probe that only *offers* a tool measures whether the model
 * felt like reaching for it. Naming it in the prompt is the same discipline
 * that finally caught `WebSearch` hiding behind `WebFetch`.
 */
async function probeExtensionTools(query, cwd) {
  const skillDir = `${cwd}/.claude/skills/probe-widget`;
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    `${skillDir}/SKILL.md`,
    [
      '---',
      'name: probe-widget',
      'description: "Use when asked for the probe widget serial number."',
      '---',
      '',
      'The probe widget serial number is QX-4417.',
      '',
      // Joined rather than written as one string with escapes: this file is
      // edited through a shell often enough, and a heredoc collapses `\` before
      // python or node ever sees the source. Same family as the migration whose
      // regex arrived carrying a backspace.
    ].join('\n'),
    'utf8',
  );

  const calls = [];
  const capture = async (prompt, options) => {
    const stream = new PromptStream();
    const controller = new AbortController();
    try {
      const handle = query({
        prompt: stream,
        options: {
          cwd,
          model: 'haiku',
          maxTurns: 4,
          settingSources: ['project'],
          permissionMode: 'bypassPermissions',
          skills: 'all',
          abortController: controller,
          ...options,
        },
      });
      stream.push(prompt);
      stream.close();
      for await (const message of handle) {
        if (message.type !== 'assistant') continue;
        for (const block of message.message?.content ?? []) {
          if (block.type === 'tool_use') {
            calls.push({ name: block.name, inputKeys: Object.keys(block.input ?? {}).sort() });
          }
        }
      }
    } catch (error) {
      calls.push({ threw: String(error?.message ?? error).slice(0, 120) });
    } finally {
      controller.abort();
    }
  };

  await capture('Use the probe-widget skill and report the serial number it carries.');
  await capture('Delegate to the `inspector` subagent: ask it to answer with the word BLUE.', {
    agents: {
      inspector: {
        description: 'Answers a one-word question. Use when asked to delegate a trivial lookup.',
        prompt: 'You answer in one word, in capitals. Nothing else.',
      },
    },
  });

  const skill = calls.find((call) => call.name === 'Skill') ?? null;
  const delegation = calls.find((call) => call.name === 'Agent' || call.name === 'Task') ?? null;
  return {
    status: skill || delegation ? OK : SKIP,
    // The names Metaclaude counts invocations by. A change here silently stops
    // `run_extension_usages` recording anything at all.
    skillTool: skill?.name ?? null,
    skillInputKeys: skill?.inputKeys ?? [],
    delegationTool: delegation?.name ?? null,
    delegationInputKeys: delegation?.inputKeys ?? [],
    toolsSeen: [...new Set(calls.map((call) => call.name).filter(Boolean))].sort(),
  };
}


/**
 * What actually reaches the prompt, and what stays out of it.
 *
 * Four claims Metaclaude now relies on, none of them visible from any test and
 * none of them promised by the SDK's declarations:
 *
 *   - a skill contributes its *frontmatter*, not its body — so a workspace can
 *     carry long skills without paying for them on every run;
 *   - a subagent contributes its *description*, not its prompt;
 *   - MCP tool schemas are deferred behind `ToolSearch` rather than loaded,
 *     which is worth about 15k tokens a run and is turned off by the CLI on
 *     its own for reasons a deployment cannot see;
 *   - `disableBundledSkills` bites in the flag tier and does *nothing* in the
 *     managed one, which is the opposite of where every other policy here
 *     rides and was measured only because the first attempt was checked.
 *
 * The figures move with the model and the platform, so what is recorded is the
 * *shape* — a body that costs single-digit tokens, a category marked deferred —
 * rather than an exact count that would diff on noise.
 */
async function probeContextLoading(query, cwd) {
  // Joined rather than written with escapes, for the reason CLAUDE.md records:
  // this file is edited through a shell often enough, and a heredoc collapses
  // a backslash before node ever sees the source. It happened again writing
  // this very function.
  const NL = String.fromCharCode(10);
  const filler = (label, kb) =>
    Array.from({ length: Math.ceil((kb * 1024) / 60) }, (_, i) =>
      `${label} line ${i}: the quick brown fox jumps over the lazy dog again.`,
    ).join(NL);

  const skillDir = `${cwd}/.claude/skills/probe-long`;
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    `${skillDir}/SKILL.md`,
    ['---', 'name: probe-long', 'description: "Use for the long probe."', '---', '', filler('LONG', 24), ''].join(NL),
    'utf8',
  );

  const agents = {
    'probe-inspector': {
      description: 'Answers a one-word question. Use when asked to delegate a trivial lookup.',
      prompt: ['You answer in one word, in capitals.', '', filler('AGENT', 8)].join(NL),
    },
  };

  /** One turn, with the context breakdown taken at its result. */
  const measure = async (options) => {
    const stream = new PromptStream();
    const controller = new AbortController();
    const seen = { tools: [], context: null, threw: null };
    const handle = query({
      prompt: stream,
      options: {
        cwd,
        model: 'haiku',
        maxTurns: 1,
        settingSources: ['project'],
        skills: 'all',
        strictMcpConfig: true,
        permissionMode: 'dontAsk',
        agents,
        abortController: controller,
        ...options,
      },
    });
    stream.push('Reply with the single word OK and nothing else.');
    try {
      for await (const message of handle) {
        if (message.type === 'system' && message.subtype === 'init') {
          seen.tools = (message.tools ?? []).filter((name) => !name.startsWith('mcp__'));
        }
        if (message.type === 'result') {
          seen.context = await handle.getContextUsage({ detail: 'full' });
          stream.close();
        }
      }
    } catch (error) {
      seen.threw = String(error?.message ?? error).slice(0, 160);
    } finally {
      controller.abort();
    }
    return seen;
  };

  /*
   * Does the CLI emit `system/init` before the first user message?
   *
   * Measured on 2.1.267: no — twenty seconds of listening, `reinitialize()`
   * and `initializationResult()` all produced nothing, one prompt produced it
   * at ~800 ms. The CLI's tool list lives only on that frame, so Metaclaude
   * reads it from runs and never from a probe. A CLI that started emitting it
   * on open would let that simplify; one that stopped naming tools on it would
   * blind the CLI-tools screen. Ten seconds is generous against 800 ms.
   */
  const initWithoutPrompt = await (async () => {
    const stream = new PromptStream();
    const controller = new AbortController();
    let arrived = false;
    const handle = query({ prompt: stream, options: { cwd, settingSources: ['project'], abortController: controller } });
    const drained = (async () => { try { for await (const m of handle) { if (m.type === 'system' && m.subtype === 'init') arrived = true; } } catch { /* aborted */ } })();
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    stream.close(); controller.abort(); await drained;
    return arrived;
  })();

  const bundled = await measure({});
  const lean = await measure({ settings: { disableBundledSkills: true } });
  const managed = await measure({ managedSettings: { disableBundledSkills: true } });
  // The one built-in skill every CLI so far has shipped; the exception probes
  // below name it. A CLI that drops it makes those read as "floor wins" for
  // the wrong reason, so its presence is recorded beside the result.
  const EXCEPTION = 'code-review';
  const exception = await measure({
    settings: { disableBundledSkills: true, skillOverrides: { [EXCEPTION]: 'on' } },
  });
  const oneOff = await measure({ settings: { skillOverrides: { [EXCEPTION]: 'off' } } });

  if (!bundled.context || !lean.context || !managed.context || !exception.context || !oneOff.context) {
    return { status: SKIP, reason: bundled.threw ?? lean.threw ?? managed.threw ?? 'no context breakdown' };
  }
  const builtIn = (context) =>
    (context.skills?.skillFrontmatter ?? []).filter((row) => row.source === 'built-in').map((row) => row.name);

  const category = (context, name) => context.categories.find((row) => row.name.startsWith(name));
  const skillTokens = (context, name) =>
    context.skills?.skillFrontmatter?.find((row) => row.name === name)?.tokens ?? null;

  return {
    status: OK,
    // The frame that names the tools, and whether it comes unprompted. It does
    // not, which is why the CLI-tools screen is fed by runs and not by a probe.
    initFrameWithoutPrompt: initWithoutPrompt,
    // A 24 kB body against its own frontmatter. Single digits means the body
    // is fetched by `Skill` rather than carried in the prompt.
    skillBodyTokens: skillTokens(bundled.context, 'probe-long'),
    // An 8 kB prompt against its own description, same reasoning.
    agentPromptTokens: bundled.context.agents?.[0]?.tokens ?? null,
    /*
     * The lever that keeps tool schemas out of the window — the CLI's own and
     * every MCP server's alike, since both ride the same switch. It turns
     * itself off when `ANTHROPIC_BASE_URL` names a host it does not recognise
     * or the served model is on its unsupported list, and says nothing.
     *
     * No MCP server is mounted here on purpose: `tool()` wants a zod shape,
     * and this script is piped into the production image with no package
     * context to resolve one from. The built-in half answers the same
     * question — measured, the deferred built-ins are 15,378 tokens against
     * 1,952 for eight fat MCP tools, so it is also the larger half.
     */
    toolSearchOffered: bundled.tools.includes('ToolSearch'),
    builtinToolsDeferred: Boolean(category(bundled.context, 'System tools (deferred)')),
    // Which tier `disableBundledSkills` bites in. The managed one reads as the
    // natural home and is measured to do nothing at all.
    bundledSkills: {
      onByDefault: bundled.context.skills?.totalSkills ?? null,
      withFlagSettings: lean.context.skills?.totalSkills ?? null,
      withManagedSettings: managed.context.skills?.totalSkills ?? null,
      flagTierBites:
        (lean.context.skills?.totalSkills ?? 0) < (bundled.context.skills?.totalSkills ?? 0),
      managedTierBites:
        (managed.context.skills?.totalSkills ?? 0) < (bundled.context.skills?.totalSkills ?? 0),
    },
    /*
     * Whether one of the CLI's skills can be governed on its own, and whether
     * an exception survives the floor. Measured: it cannot — the floor wins —
     * which is why `CliSkillPolicy` has two shapes instead of one. A bump that
     * made the exception survive would let that class be simplified; one that
     * stopped `skillOverrides` biting at all would silently reintroduce every
     * bundled skill the moment an operator chose one.
     */
    skillOverrides: {
      exceptionSkillShipped: builtIn(bundled.context).includes(EXCEPTION),
      exceptionSurvivesFloor: builtIn(exception.context).includes(EXCEPTION),
      singleOffBites:
        builtIn(bundled.context).includes(EXCEPTION) && !builtIn(oneOff.context).includes(EXCEPTION),
    },
  };
}

/**
 * Does a resumed turn re-apply the system-prompt append, and what does changing
 * it cost?
 *
 * Three turns in one session: ALPHA, then BETA, then BETA again. If the second
 * sees BETA the append is re-applied; if the third cannot see ALPHA it replaces
 * rather than accumulates. Turns two and three differ only by whether the
 * append moved, so their cache-write figures price exactly that.
 */
async function probeResumeAppend(query, cwd, snapshot) {
  const withMark = (mark) => ({
    cwd,
    model: 'haiku',
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: `Context note: ${mark} is 4711.`,
      ...(snapshot === undefined ? {} : { snapshot }),
    },
  });

  const first = await turn(query, {
    prompt: 'Reply with exactly: OK',
    options: withMark('MARK_ALPHA'),
  });
  if (!first.sessionId) {
    return {
      resumeAppend: { status: SKIP, reason: 'the first turn reported no session id' },
      appendCacheCost: { status: SKIP, reason: 'needs a resumable session' },
    };
  }

  const second = await turn(query, {
    prompt: 'What is MARK_BETA? Answer with the number only, or the word ABSENT.',
    options: { ...withMark('MARK_BETA'), resume: first.sessionId },
  });
  const third = await turn(query, {
    prompt: 'What is MARK_ALPHA? Answer with the number only, or the word ABSENT.',
    options: { ...withMark('MARK_BETA'), resume: first.sessionId },
  });

  return {
    resumeAppend: {
      status: second.text ? OK : SKIP,
      reappliedOnResume: /4711/.test(second.text),
      accumulates: /4711/.test(third.text),
    },
    appendCacheCost: {
      status: second.usage && third.usage ? OK : SKIP,
      /*
       * The conclusion, not the magnitude.
       *
       * The raw figures move with the prompt, the working directory and the
       * mounted tools - measured 11,455 on one run and 15,556 on the next, for
       * behaviour that had not changed at all. Diffing them reported three
       * changes where there were none, which is how an instrument teaches you
       * to ignore it. What matters is whether changing the append rewrites the
       * prefix: an order of magnitude is the signal, and it was 66x and 114x on
       * two versions that behave identically.
       */
      prefixRewrittenOnChange:
        second.usage && third.usage && third.usage.cacheWrite > 0
          ? second.usage.cacheWrite / third.usage.cacheWrite >= 10
          : null,
      raw: {
        changedWrite: second.usage?.cacheWrite ?? null,
        unchangedWrite: third.usage?.cacheWrite ?? null,
        ratio:
          second.usage && third.usage && third.usage.cacheWrite > 0
            ? Math.round(second.usage.cacheWrite / third.usage.cacheWrite)
            : null,
      },
    },
  };
}

/**
 * Quota behaviour — only observable while a model is genuinely spent.
 *
 * There is no way to force a refusal, so this reports an explicit skip rather
 * than a comfortable pass. A check that cannot tell "the guard held" from "the
 * probe never ran" proves nothing.
 */
async function probeQuota(query, freshCwd) {
  let refused = null;
  for (const model of ['fable', 'opus', 'sonnet', 'haiku']) {
    const attempt = await turn(query, {
      prompt: 'Reply with exactly: OK',
      options: { cwd: freshCwd(), model },
    });
    const rejection = attempt.rateLimits.find((info) => info?.status === 'rejected');
    if (rejection || attempt.assistantErrors.includes('rate_limit')) {
      refused = { model, rejection: rejection ?? null, attempt };
      break;
    }
  }

  if (!refused) {
    return {
      quotaRefusal: {
        status: SKIP,
        reason: 'no model is currently refused — there is nothing to observe',
      },
      quotaFallback: { status: SKIP, reason: 'needs a refused model' },
    };
  }

  const { model, rejection, attempt } = refused;
  const withFallback = await turn(query, {
    prompt: 'Reply with exactly: OK',
    options: {
      cwd: freshCwd(),
      model,
      fallbackModel: model === 'haiku' ? 'sonnet' : 'haiku',
    },
  });

  return {
    quotaRefusal: {
      status: OK,
      model,
      assistantError: attempt.assistantErrors[0] ?? null,
      rateLimitType: rejection?.rateLimitType ?? null,
      carriesUnifiedWindows: Boolean(rejection?.unifiedWindows),
      globalWindows: rejection?.unifiedWindows
        ? Object.fromEntries(
            Object.entries(rejection.unifiedWindows).map(([key, value]) => [
              key,
              value?.utilization ?? null,
            ]),
          )
        : null,
    },
    quotaFallback: {
      status: OK,
      // Measured false on 0.3.247: the CLI's own fallback does not cover quota,
      // which is why Metaclaude switches models itself. If this turns true, that
      // code can be deleted.
      coversQuota: !withFallback.result?.isError,
    },
  };
}

/* -------------------------------------------------------------------------- */

/** Flat, path-wise diff: every leaf that moved, named. */
function diff(before, after, path = '') {
  const out = [];
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  for (const key of keys) {
    // Volatile by nature. A version string, a timestamp or a live utilisation
    // figure is not a behaviour, and reporting it as one buries the real changes.
    if (['cliVersion', 'at', 'reason', 'globalWindows', 'raw'].includes(key)) continue;
    const a = before?.[key];
    const b = after?.[key];
    const here = path ? `${path}.${key}` : key;
    if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a)) {
      out.push(...diff(a, b, here));
    } else if (JSON.stringify(a) !== JSON.stringify(b)) {
      out.push(`${here}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
    }
  }
  return out;
}

async function main() {
  const { query } = await loadSdk();
  const freshCwd = () => mkdtempSync(`${tmpdir()}/sdk-probe-`);
  const findings = {};

  const init = await turn(query, {
    prompt: 'Reply with exactly: OK',
    options: { cwd: freshCwd(), model: 'haiku' },
  });
  findings.initFrame = {
    status: init.initKeys.length > 0 ? OK : SKIP,
    cliVersion: init.cliVersion,
    keys: init.initKeys,
    // Declared on the type, absent in practice — the reason `served_effort` was
    // never built. If this turns true, that column becomes possible.
    carriesEffort: init.initHasEffort,
  };

  const bare = await turn(query, {
    prompt: 'Reply with exactly: OK',
    options: { cwd: freshCwd() },
  });
  findings.defaultModel = { status: bare.initModel ? OK : SKIP, served: bare.initModel };

  findings.rateLimitsShape = await probeUsageShape(query, freshCwd());
  findings.extensionTools = await probeExtensionTools(query, freshCwd());
  findings.contextLoading = await probeContextLoading(query, freshCwd());
  Object.assign(findings, await probeResumeAppend(query, freshCwd()));
  /*
   * The same three turns again, with `snapshot: false` stated.
   *
   * The default inverted at 0.3.267: omitting it now records the prompt on the
   * conversation's first request and replays that record on every resume, so a
   * changed append is ignored. The measurement above is what the SDK does when
   * a host says nothing; this one is what Metaclaude relies on, and the two
   * have to be tracked separately or the next bump silently answers for a
   * setting nobody passed. `supervisor.ts` states it explicitly for exactly
   * this reason — the append carries the language directive, the workspace
   * conventions and the standing shelf, and an operator who changes one of
   * those expects an open session to see it.
   */
  const explicit = await probeResumeAppend(query, freshCwd(), false);
  findings.resumeAppendUnsnapshotted = {
    status: explicit.resumeAppend.status,
    ...(explicit.resumeAppend.reason ? { reason: explicit.resumeAppend.reason } : {}),
    reappliedOnResume: explicit.resumeAppend.reappliedOnResume,
    accumulates: explicit.resumeAppend.accumulates,
  };
  Object.assign(findings, await probeQuota(query, freshCwd));

  const report = {
    at: new Date().toISOString(),
    sdkVersion: sdkVersion(),
    // The init frame carries platform-specific keys - `powershell_path` on
    // Windows, absent on Linux - so a baseline taken in the container and a
    // measurement taken on a laptop differ for reasons that have nothing to do
    // with the version. Recorded so the diff can say so instead of implying a
    // change nobody made.
    platform: process.platform,
    findings,
  };

  const out = flag('--out');
  if (out) writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);

  const baselinePath = flag('--baseline');
  if (!baselinePath) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  const changes = diff(baseline.findings, report.findings);
  console.log(JSON.stringify(report, null, 2));
  console.log(`\n${'='.repeat(64)}`);
  console.log(`baseline ${baseline.sdkVersion}  ->  now ${report.sdkVersion}`);
  if (baseline.platform && baseline.platform !== report.platform) {
    console.log(
      `
WARNING: baseline taken on ${baseline.platform}, measured on ${report.platform}. ` +
        'Some init-frame keys are platform-specific; compare on one platform before concluding.',
    );
  }

  const skipped = Object.entries(report.findings)
    .filter(([, value]) => value.status === SKIP)
    .map(([name]) => name);
  if (skipped.length > 0) {
    console.log(`\ncould not measure: ${skipped.join(', ')} — those answers are unknown, not "same".`);
  }

  if (changes.length === 0) {
    console.log('\nno behavioural change in anything this probe can see.');
    return;
  }
  console.log(`\n${changes.length} behavioural change(s) — each needs a decision:\n`);
  for (const line of changes) console.log(`  ${line}`);
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
