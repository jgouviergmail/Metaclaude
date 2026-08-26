/**
 * The update check — the informational half of guarded self-update.
 *
 * It asks GitHub for the latest published release and compares versions.
 * That is all: applying an update stays the tag-driven, health-gated,
 * self-rolling-back deploy pipeline, and nothing here can trigger it. The
 * check exists so "you are behind" is a fact the system can state about
 * itself instead of something the operator has to remember to look up.
 */

import { APP_VERSION, type UpdateCheck } from '@metaclaude/shared';

export type { UpdateCheck };

export interface UpdateCheckerDeps {
  /** `owner/repo` on GitHub. */
  repo: string;
  /** Fetch a URL's body as text. Injected; tests never touch the network. */
  fetchText: (url: string) => Promise<string>;
  now?: () => number;
  currentVersion?: string;
}

const TTL_MS = 60 * 60_000;

/** `1.2.3` (optionally `v`-prefixed) → [1,2,3]; null for anything else. */
function parseVersion(value: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isNewer(latest: [number, number, number], current: [number, number, number]): boolean {
  for (let i = 0; i < 3; i += 1) {
    if ((latest[i] as number) !== (current[i] as number)) {
      return (latest[i] as number) > (current[i] as number);
    }
  }
  return false;
}

export class UpdateChecker {
  private cached: UpdateCheck | null = null;

  constructor(private readonly deps: UpdateCheckerDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  async check(options: { force?: boolean } = {}): Promise<UpdateCheck> {
    // Unauthenticated GitHub API allows 60 requests an hour; a cached answer
    // is correct for far longer than that.
    if (!options.force && this.cached && this.now() - this.cached.checkedAt < TTL_MS) {
      return this.cached;
    }

    const current = this.deps.currentVersion ?? APP_VERSION;
    const base: UpdateCheck = {
      current,
      latest: null,
      updateAvailable: null,
      releaseUrl: null,
      error: null,
      checkedAt: this.now(),
    };

    let result: UpdateCheck;
    try {
      const body = await this.deps.fetchText(
        `https://api.github.com/repos/${this.deps.repo}/releases/latest`,
      );
      const release = JSON.parse(body) as { tag_name?: string; html_url?: string };
      const latest = release.tag_name ?? null;
      const latestParsed = latest ? parseVersion(latest) : null;
      const currentParsed = parseVersion(current);

      result = {
        ...base,
        latest,
        releaseUrl: release.html_url ?? null,
        updateAvailable:
          latestParsed && currentParsed ? isNewer(latestParsed, currentParsed) : null,
      };
    } catch (error) {
      // A 404 usually means no release has been published yet (or the repo is
      // private to this server). Said in the answer, never thrown: the screen
      // renders the fact.
      result = { ...base, error: error instanceof Error ? error.message : String(error) };
    }

    this.cached = result;
    return result;
  }
}
