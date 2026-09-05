/** Constants shared by the API and the web app. */

export const APP_NAME = 'Metaclaude';
export const APP_VERSION = '0.46.1';

/**
 * How long a machine token may live. A year is the outer bound, not a default.
 *
 * Here rather than beside its schema in `api-contracts.ts`: the form that mints
 * a token needs the *value* at runtime, and a value import would pull that
 * whole module — every API-only Zod schema in it — into the web app's runtime
 * graph. Types are free to cross; values are not.
 */
export const MAX_API_TOKEN_DAYS = 365;

/** Name of the httpOnly session cookie. Never readable from JavaScript. */
export const SESSION_COOKIE = 'mc_session';

/**
 * Name of the CSRF cookie. Deliberately *not* httpOnly: the double-submit
 * pattern requires the client to read this value and echo it in a header, which
 * a cross-origin attacker cannot do. It carries no authority on its own — only
 * the pairing of this token with the httpOnly session cookie authorises a
 * mutating request.
 */
export const CSRF_COOKIE = 'mc_csrf';

/** Header carrying the double-submit CSRF token on mutating requests. */
export const CSRF_HEADER = 'x-metaclaude-csrf';

/** Maximum bytes we will read into the browser file editor. */
export const MAX_EDITABLE_FILE_BYTES = 2 * 1024 * 1024;

/** Tool results larger than this are truncated for the transcript. */
export const MAX_TOOL_RESULT_CHARS = 24_000;

/** How long an unanswered permission prompt stays valid. */
export const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;

/** Dimensionality of the built-in hashing embedder. */
export const HASH_EMBEDDING_DIM = 512;

/**
 * Tools that mutate state or reach the network. Used to compute the risk badge
 * shown on a permission prompt and to pick a safe default in the UI.
 */
export const HIGH_RISK_TOOLS = ['Bash', 'Write', 'Edit', 'NotebookEdit', 'KillShell'] as const;
export const NETWORK_TOOLS = ['WebFetch', 'WebSearch'] as const;
export const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep', 'TodoWrite', 'Task'] as const;

/**
 * The built-in tools a workspace may pre-approve, in the order the settings
 * form offers them.
 *
 * Derived rather than restated: a tool that can open a prompt is exactly a
 * network tool or a high-risk one, and read-only tools are absent because they
 * never prompt — a switch for them would do nothing at all. Network first,
 * because reaching the web is both the mildest of these and the one an
 * unattended run actually needs.
 */
export const PREAPPROVABLE_TOOLS = [...NETWORK_TOOLS, ...HIGH_RISK_TOOLS] as const;

/** The longest a tool name may be. Bounds the stored list; nothing is near it. */
export const MAX_TOOL_NAME_LENGTH = 128;

/**
 * An MCP tool call arrives as `mcp__<server>__<tool>`; a built-in arrives bare.
 *
 * The regex is non-greedy on purpose. Its predecessor was `/^mcp__[^_]+__/`,
 * copied into six places, and it stops at the first underscore — so a server
 * an operator named `my_server` was never stripped, and the risk badge, the
 * transcript card and the grant key all fell through to their default branch
 * on every one of its tools. `McpServerRecord.name` allows underscores, so the
 * name that breaks it is one the form accepts.
 *
 * `mcp__a__b__c` stays ambiguous — the convention cannot say whether the
 * server is `a` or `a__b` — and the shortest wins, which is the reading that
 * gets the common case right.
 */
const MCP_TOOL = /^mcp__(.+?)__(.+)$/;

/** A tool call split into the server that offers it and its own name. */
export function splitToolName(name: string): { server: string | null; bare: string } {
  const match = MCP_TOOL.exec(name);
  if (!match) return { server: null, bare: name };
  return { server: match[1]!, bare: match[2]! };
}

/** The tool's own name, with any MCP server prefix removed. */
export function bareToolName(name: string): string {
  return splitToolName(name).bare;
}

/** The outcome of vetting a list of tool names. */
export interface ToolNameReview {
  /** Well-formed, trimmed, de-duplicated names, in the order given. */
  allowed: string[];
  /** Refused inputs, with the reason, for the operator to read. */
  rejected: { name: string; reason: string }[];
}

/**
 * Partition a list of tool names into the ones a workspace may store and the
 * ones it may not.
 *
 * Never throws: the supervisor calls it on every run and must not fail a run
 * over a stale setting — it drops the entry and logs it, exactly as
 * `reviewAdditionalDirectories` does for a directory that has become invalid.
 *
 * The parenthesis rule is the one that is not obvious, and it was measured
 * rather than assumed. A scoped rule — `WebFetch(domain:example.com)` — handed
 * to the CLI on this channel, under the managed policy locks Metaclaude sets,
 * does not scope anything: a fetch of *nodejs.org* went through. So an
 * operator writing one in order to narrow an approval would silently get the
 * whole tool instead. Refusing it is the only honest answer; a rule that
 * quietly means more than it says is worse than no rule.
 */
export function reviewToolNames(names: readonly string[]): ToolNameReview {
  const allowed: string[] = [];
  const rejected: { name: string; reason: string }[] = [];
  const seen = new Set<string>();

  for (const raw of names) {
    const name = raw.trim();
    if (!name) {
      rejected.push({ name: raw, reason: 'is empty' });
      continue;
    }
    if (name.length > MAX_TOOL_NAME_LENGTH) {
      rejected.push({ name, reason: `is longer than ${MAX_TOOL_NAME_LENGTH} characters` });
      continue;
    }
    if (name.includes('(') || name.includes(')')) {
      rejected.push({ name, reason: 'is a scoped rule, and the CLI widens it to the whole tool' });
      continue;
    }
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
      rejected.push({ name, reason: 'is not a tool name' });
      continue;
    }
    if (seen.has(name)) continue;
    seen.add(name);
    allowed.push(name);
  }

  return { allowed, rejected };
}

/**
 * Whether a tool call is covered by a workspace's pre-approval list.
 *
 * Exact names only, and that is deliberate: a bare `search` in the list must
 * not reach `mcp__some-server__search`. The operator approved a tool they
 * could name, not every tool that happens to end the same way.
 */
export function isPreapprovedTool(preapproved: readonly string[], toolName: string): boolean {
  return preapproved.some((entry) => entry.trim() === toolName);
}

/**
 * Bash command fragments that always escalate a prompt to `high` risk even when
 * the tool itself would be medium. These are matched case-insensitively against
 * the command string.
 */
export const DANGEROUS_COMMAND_PATTERNS: readonly RegExp[] = [
  /\brm\s+(-[a-z]*\s+)*-[a-z]*[rf]/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /:\(\)\s*\{.*\}\s*;\s*:/, // fork bomb
  /\bchmod\s+(-[a-zA-Z]+\s+)*777\b/i,
  /\bcurl\b[^|]*\|\s*(ba)?sh/i,
  /\bwget\b[^|]*\|\s*(ba)?sh/i,
  /\bgit\s+push\b.*--force\b/i,
  /\bshutdown\b|\breboot\b/i,
  /\bsudo\b/i,
  />\s*\/dev\/sd[a-z]/i,
];

/** Language inference for the editor and for syntax highlighting. */
export const EXTENSION_LANGUAGE: Readonly<Record<string, string>> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'json',
  md: 'markdown',
  mdx: 'markdown',
  py: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  rb: 'ruby',
  php: 'php',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  swift: 'swift',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  fish: 'shell',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  ini: 'ini',
  sql: 'sql',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'scss',
  less: 'less',
  vue: 'vue',
  svelte: 'svelte',
  dockerfile: 'dockerfile',
  graphql: 'graphql',
  proto: 'protobuf',
  xml: 'xml',
  svg: 'xml',
  txt: 'text',
  env: 'shell',
};

export function languageForPath(path: string): string | null {
  const base = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  if (base === 'dockerfile' || base.startsWith('dockerfile.')) return 'dockerfile';
  if (base === 'makefile') return 'makefile';
  if (base.startsWith('.env')) return 'shell';
  const dot = base.lastIndexOf('.');
  if (dot < 0) return null;
  return EXTENSION_LANGUAGE[base.slice(dot + 1)] ?? null;
}
