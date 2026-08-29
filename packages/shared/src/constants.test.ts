import { describe, expect, it } from 'vitest';
import {
  HIGH_RISK_TOOLS,
  NETWORK_TOOLS,
  PREAPPROVABLE_TOOLS,
  bareToolName,
  isPreapprovedTool,
  languageForPath,
  reviewToolNames,
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
