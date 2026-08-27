/** Constants shared by the API and the web app. */

export const APP_NAME = 'Metaclaude';
export const APP_VERSION = '0.8.1';

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
