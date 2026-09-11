import { describe, expect, it } from 'vitest';
import {
  DELEGATION_TOOL_FIELD,
  HIGH_RISK_TOOLS,
  NETWORK_TOOLS,
  PREAPPROVABLE_TOOLS,
  SKILL_TOOL,
  SKILL_TOOL_FIELD,
  bareToolName,
  isDelegationTool,
  isPreapprovedTool,
  languageForPath,
  mcpToolName,
  reviewToolNames,
  reviewDeniedToolNames,
  DEFAULT_DISABLED_CLI_TOOLS,
  splitToolName,
} from './constants.js';

describe('languageForPath', () => {
  it('names the language of a path by its extension, and by its filename where there is none', () => {
    expect(languageForPath('src/kernel/supervisor.ts')).toBe('typescript');
    expect(languageForPath('Dockerfile')).toBe('dockerfile');
    expect(languageForPath('docker/Dockerfile.web')).toBe('dockerfile');
    expect(languageForPath('.env.production')).toBe('shell');
    expect(languageForPath('LICENSE')).toBeNull();
  });
});

describe('splitToolName', () => {
  it('leaves a built-in tool alone', () => {
    expect(splitToolName('WebSearch')).toEqual({ server: null, bare: 'WebSearch' });
    expect(bareToolName('Bash')).toBe('Bash');
  });

  it('splits an MCP tool into its server and its own name', () => {
    expect(splitToolName('mcp__github__search_issues')).toEqual({
      server: 'github',
      bare: 'search_issues',
    });
  });

  /**
   * The regex this replaces was `/^mcp__[^_]+__/`, which stops at the first
   * underscore — so a server named `my_server` was never stripped and every
   * caller (the risk badge, the transcript card, the grant key) fell through
   * to its default branch. `McpServerRecord.name` allows underscores, so this
   * is a name an operator can actually type.
   */
  it('strips a server whose own name contains an underscore', () => {
    expect(splitToolName('mcp__my_server__do_thing')).toEqual({
      server: 'my_server',
      bare: 'do_thing',
    });
  });

  it('takes the shortest server when the name is ambiguous, rather than guessing', () => {
    expect(splitToolName('mcp__a__b__c')).toEqual({ server: 'a', bare: 'b__c' });
  });

  it('treats a malformed prefix as a plain name rather than inventing a server', () => {
    expect(splitToolName('mcp__github')).toEqual({ server: null, bare: 'mcp__github' });
    expect(splitToolName('mcp____tool')).toEqual({ server: null, bare: 'mcp____tool' });
  });
});

describe('PREAPPROVABLE_TOOLS', () => {
  /**
   * Read-only tools are deliberately absent: they never open a prompt, so
   * offering to pre-approve them would be a switch that does nothing.
   */
  it('is exactly the tools that can open a permission prompt, network first', () => {
    expect(PREAPPROVABLE_TOOLS).toEqual([...NETWORK_TOOLS, ...HIGH_RISK_TOOLS]);
    expect(PREAPPROVABLE_TOOLS).not.toContain('Read');
    expect(PREAPPROVABLE_TOOLS).not.toContain('Grep');
  });
});

describe('reviewToolNames', () => {
  it('keeps well-formed names, trimmed and de-duplicated, in the order given', () => {
    const review = reviewToolNames(['  WebSearch ', 'Bash', 'WebSearch', 'mcp__github__search']);
    expect(review.allowed).toEqual(['WebSearch', 'Bash', 'mcp__github__search']);
    expect(review.rejected).toEqual([]);
  });

  it('rejects an empty entry', () => {
    const review = reviewToolNames(['', '   ']);
    expect(review.allowed).toEqual([]);
    expect(review.rejected.map((entry) => entry.reason)).toEqual(['is empty', 'is empty']);
  });

  /**
   * Measured against the CLI, not assumed. `--allowedTools
   * 'WebFetch(domain:example.com)'` with the managed policy locks Metaclaude
   * sets did **not** scope anything: a fetch of nodejs.org went through. A
   * scoped rule on this channel is read as an allow of the whole tool, so an
   * operator writing one to *narrow* an approval would silently get the
   * opposite of what they typed.
   */
  it('rejects a scoped rule, because the CLI widens it to the whole tool', () => {
    const review = reviewToolNames(['WebFetch(domain:example.com)']);
    expect(review.allowed).toEqual([]);
    expect(review.rejected[0]?.name).toBe('WebFetch(domain:example.com)');
    expect(review.rejected[0]?.reason).toMatch(/widen/i);
  });

  it('rejects anything that is not shaped like a tool name', () => {
    const review = reviewToolNames(['Web Search', 'Bash;rm', 'WebFetch/*', '*']);
    expect(review.allowed).toEqual([]);
    expect(review.rejected).toHaveLength(4);
    for (const entry of review.rejected) expect(entry.reason).toBe('is not a tool name');
  });

  it('rejects an over-long entry rather than storing it', () => {
    const review = reviewToolNames(['A'.repeat(129)]);
    expect(review.allowed).toEqual([]);
    expect(review.rejected[0]?.reason).toMatch(/128/);
  });

  it('never throws, whatever it is handed', () => {
    expect(() => reviewToolNames([])).not.toThrow();
    expect(reviewToolNames([]).allowed).toEqual([]);
  });
});

describe('reviewDeniedToolNames', () => {
  it('keeps every rule reviewToolNames applies', () => {
    // Derived rather than restated: the deny direction adds a rule, it does
    // not fork the vetting. A rule added to `reviewToolNames` later has to
    // reach this list too, and this is what says so.
    const nasty = ['WebFetch(domain:example.com)', 'Web Search', '', 'A'.repeat(129)];
    expect(reviewDeniedToolNames(nasty).allowed).toEqual(reviewToolNames(nasty).allowed);
    expect(reviewDeniedToolNames(nasty).rejected.map((entry) => entry.name)).toEqual(
      reviewToolNames(nasty).rejected.map((entry) => entry.name),
    );
  });

  /**
   * The one rule that only makes sense in this direction.
   *
   * `ToolSearch` is how the CLI keeps every other tool's schema out of the
   * prompt until something needs it. Denying it is a 15,500-token regression
   * on every run — measured — announced by nothing at all. Pre-approving it,
   * by contrast, is harmless, which is why the rule is here and not in
   * `reviewToolNames`.
   */
  it('refuses ToolSearch, and says why', () => {
    const review = reviewDeniedToolNames(['Bash', 'ToolSearch', 'WebFetch']);

    expect(review.allowed).toEqual(['Bash', 'WebFetch']);
    expect(review.rejected).toHaveLength(1);
    expect(review.rejected[0]?.name).toBe('ToolSearch');
    expect(review.rejected[0]?.reason).toContain('loads every other tool');
  });

  it('lets ToolSearch through the pre-approval direction, which is the other list', () => {
    expect(reviewToolNames(['ToolSearch']).allowed).toEqual(['ToolSearch']);
  });
});

describe('DEFAULT_DISABLED_CLI_TOOLS', () => {
  it('is a list this deployment could actually store', () => {
    // The shipped default has to survive the vetting the form applies, or a
    // fresh deployment would be refusing to save the state it booted with.
    expect(reviewDeniedToolNames([...DEFAULT_DISABLED_CLI_TOOLS])).toEqual({
      allowed: [...DEFAULT_DISABLED_CLI_TOOLS],
      rejected: [],
    });
  });

  it('never disables the tools Metaclaude’s own features are built on', () => {
    // `Skill` and `Task` are measured to be deniable, and denying either takes
    // a whole Metaclaude feature down with it: without `Skill` a skill cannot
    // be opened at all, without `Task` a custom subagent cannot be reached.
    // They stay listed on the screen — an operator may have their reasons —
    // but shipping them off by default would be this system disabling itself.
    for (const load of ['Skill', 'Task', 'Agent', 'Bash', 'Read', 'Edit', 'Write']) {
      expect(DEFAULT_DISABLED_CLI_TOOLS).not.toContain(load);
    }
  });
});

describe('isPreapprovedTool', () => {
  it('matches a name the operator listed', () => {
    expect(isPreapprovedTool(['WebSearch', 'WebFetch'], 'WebSearch')).toBe(true);
    expect(isPreapprovedTool(['WebSearch'], 'Bash')).toBe(false);
    expect(isPreapprovedTool([], 'WebSearch')).toBe(false);
  });

  it('ignores surrounding whitespace in a stored entry', () => {
    expect(isPreapprovedTool([' WebSearch '], 'WebSearch')).toBe(true);
  });

  /**
   * Exact names only, and that is the point. A bare `search` in the list must
   * not reach `mcp__some-server__search`: the operator approved a tool they
   * could name, not every tool that happens to end the same way.
   */
  it('does not let a bare entry reach an MCP tool that shares its name', () => {
    expect(isPreapprovedTool(['search'], 'mcp__github__search')).toBe(false);
    expect(isPreapprovedTool(['mcp__github__search'], 'mcp__github__search')).toBe(true);
    expect(isPreapprovedTool(['mcp__github__search'], 'mcp__gitlab__search')).toBe(false);
  });
});


describe('mcpToolName', () => {
  /**
   * The builder beside the parser, and pinned to it.
   *
   * Six places used to spell the `mcp__<server>__<tool>` prefix by hand, and
   * the note above `MCP_TOOL` records what that cost: a server named
   * `my_server` fell through every one of them. A name that is *built* by the
   * same module that takes it apart cannot drift from it, and the round trip
   * is the assertion rather than the shape of the string.
   */
  it('round-trips through the parser, underscores in the server name included', () => {
    for (const [server, tool] of [
      ['google', 'gmail_search'],
      ['my_server', 'list_things'],
      ['metaclaude_system', 'system_run_ask'],
      ['a-b.c', 'x'],
    ] as const) {
      const built = mcpToolName(server, tool);

      expect(splitToolName(built)).toEqual({ server, bare: tool });
    }
  });

  it('produces a name the pre-approval list accepts', () => {
    // A name the operator can store is the whole point: `reviewToolNames`
    // refuses anything outside `[A-Za-z0-9_.-]`, so a builder that emitted a
    // separator it rejects would make every MCP tool unpre-approvable.
    const built = mcpToolName('google', 'gmail_search');

    expect(reviewToolNames([built])).toEqual({ allowed: [built], rejected: [] });
  });
});


describe('the two built-in tools that reach an extension', () => {
  /**
   * Measured against Claude Code through the SDK on 2026-09-10, and pinned
   * here because nothing else can hold them: the SDK declares no input type
   * for `Skill` at all — `ToolInputSchemas` has an entry for every other
   * built-in — and the name of the other one was wrong in this repository for
   * four releases. A constant that drifts from the wire is an invocation
   * nobody counts and a permission card nobody can read.
   */
  it('names the skill tool and the field it carries', () => {
    expect(SKILL_TOOL).toBe('Skill');
    expect(SKILL_TOOL_FIELD).toBe('skill');
  });

  it('accepts the name the CLI actually sends for a delegation', () => {
    expect(isDelegationTool('Agent')).toBe(true);
    expect(DELEGATION_TOOL_FIELD).toBe('subagent_type');
  });

  /**
   * `Task` is kept as an alias rather than deleted. Nothing here can see what
   * a future CLI calls it, the cost of accepting both is one array entry, and
   * the cost of being wrong is an invocation that goes unrecorded.
   */
  it('keeps accepting the name this repository used to believe in', () => {
    expect(isDelegationTool('Task')).toBe(true);
  });

  it('refuses anything else, prefixed names included', () => {
    for (const name of ['Bash', 'Skill', 'agent', 'AgentX', 'mcp__x__Agent', '']) {
      expect(isDelegationTool(name)).toBe(false);
    }
  });
});
