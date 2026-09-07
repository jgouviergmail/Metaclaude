/**
 * Whether the Claude CLI this image ships is behind the published one.
 *
 * A reading, never an action, and the distinction is the whole design. The CLI
 * is installed into the image at build time — `npm install -g
 * @anthropic-ai/claude-code@${CLAUDE_CLI_VERSION}` in the Dockerfile — and the
 * container refuses to change it three times over: the process runs as uid
 * 10001, the directory is root-owned, and the filesystem is mounted read-only.
 * All three are deliberate. So there is no honest "update" button to offer;
 * moving the CLI means raising the pin and shipping a Metaclaude release.
 *
 * What was missing was not the ability to update but the *knowledge* that an
 * update exists: the installed version was visible only in a diagnostics
 * check, and the published one nowhere at all, so an operator had no way to
 * know a release was worth asking for.
 *
 * Modelled on `UpdateChecker`, down to the injected `fetchText`: the same TTL
 * reasoning, the same rule that a failure is reported rather than thrown, and
 * the same refusal to let a wedged network hold a page open.
 */

/** How long a published-version reading stays good. npm does not rate-limit this hard; the answer simply does not change often. */
const TTL_MS = 6 * 60 * 60 * 1000;

export interface ClaudeCliStatus {
  /** What `claude --version` answered, or null when the CLI cannot be spawned. */
  installed: string | null;
  /** The newest published version, or null when it could not be read. */
  latest: string | null;
  /**
   * Whether the installed one is behind.
   *
   * Null rather than false whenever either side is unknown: "not behind" and
   * "we could not tell" are different answers, and a badge that renders the
   * second as the first is a badge that goes quiet exactly when the network
   * is broken.
   */
  behind: boolean | null;
  error: string | null;
  checkedAt: number;
}

export interface ClaudeCliUpdateDeps {
  /** What the CLI says about itself. The Doctor's own reading, shared. */
  installedVersion: () => Promise<string | null>;
  fetchText: (url: string) => Promise<string>;
  now?: () => number;
}

/** `2.1.247 (Claude Code)` — the CLI prints its name beside the number. */
function versionOnly(reported: string | null): string | null {
  if (!reported) return null;
  const match = /\d+\.\d+\.\d+/.exec(reported);
  return match ? match[0] : null;
}

/**
 * Compare two dotted versions numerically.
 *
 * Not `localeCompare`, and not a string comparison: `2.1.9` is newer than
 * `2.1.10` under both, which is exactly the case a CLI on a fast release
 * cadence hits every few weeks.
 */
function isBehind(installed: string, latest: string): boolean {
  const a = installed.split('.').map(Number);
  const b = latest.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left < right;
  }
  return false;
}

export class ClaudeCliUpdate {
  private cached: ClaudeCliStatus | null = null;

  constructor(private readonly deps: ClaudeCliUpdateDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  async check(options: { force?: boolean } = {}): Promise<ClaudeCliStatus> {
    if (!options.force && this.cached && this.now() - this.cached.checkedAt < TTL_MS) {
      return this.cached;
    }

    const installed = versionOnly(await this.deps.installedVersion());
    const base: ClaudeCliStatus = {
      installed,
      latest: null,
      behind: null,
      error: null,
      checkedAt: this.now(),
    };

    let result: ClaudeCliStatus;
    try {
      const body = await this.deps.fetchText(
        'https://registry.npmjs.org/@anthropic-ai/claude-code/latest',
      );
      const latest = versionOnly((JSON.parse(body) as { version?: string }).version ?? null);
      result = {
        ...base,
        latest,
        behind: installed && latest ? isBehind(installed, latest) : null,
      };
    } catch (error) {
      // Reported, never thrown: this is decoration on a card that has more
      // important things to say, and a registry that is down must not take
      // the sign-in status with it.
      result = { ...base, error: error instanceof Error ? error.message : String(error) };
    }

    this.cached = result;
    return result;
  }
}
