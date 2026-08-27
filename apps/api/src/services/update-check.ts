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
      result = this.compare(base, await this.latestRelease());
    } catch (error) {
      // 404 here is about the *release*, not the repository: a repo that only
      // ever gets tagged (as this project's pipeline does) has no "latest
      // release" to answer with. The tags are the truth to fall back to.
      // Anything else — GitHub down, rate-limited — is not "no releases",
      // so no fallback: the error is the answer.
      if (!is404(error)) {
        result = { ...base, error: describe(error) };
      } else {
        try {
          const fromTag = await this.latestTag();
          result = fromTag
            ? this.compare(base, fromTag)
            : { ...base, error: NOTHING_PUBLISHED };
        } catch (tagError) {
          result = { ...base, error: is404(tagError) ? NOTHING_PUBLISHED : describe(tagError) };
        }
      }
    }

    this.cached = result;
    return result;
  }

  private compare(
    base: UpdateCheck,
    found: { latest: string | null; releaseUrl: string | null },
  ): UpdateCheck {
    const latestParsed = found.latest ? parseVersion(found.latest) : null;
    const currentParsed = parseVersion(base.current);
    return {
      ...base,
      ...found,
      updateAvailable:
        latestParsed && currentParsed ? isNewer(latestParsed, currentParsed) : null,
    };
  }

  private async latestRelease(): Promise<{ latest: string | null; releaseUrl: string | null }> {
    const body = await this.deps.fetchText(
      `https://api.github.com/repos/${this.deps.repo}/releases/latest`,
    );
    const release = JSON.parse(body) as { tag_name?: string; html_url?: string };
    return { latest: release.tag_name ?? null, releaseUrl: release.html_url ?? null };
  }

  /**
   * The newest version-shaped tag, by semver — never by list order, which
   * the GitHub tags API does not promise anything about.
   */
  private async latestTag(): Promise<{ latest: string; releaseUrl: string } | null> {
    const body = await this.deps.fetchText(
      `https://api.github.com/repos/${this.deps.repo}/tags?per_page=100`,
    );
    const tags = JSON.parse(body) as { name?: string }[];

    let best: { name: string; parsed: [number, number, number] } | null = null;
    for (const tag of tags) {
      const parsed = tag.name ? parseVersion(tag.name) : null;
      if (parsed && (!best || isNewer(parsed, best.parsed))) {
        best = { name: tag.name as string, parsed };
      }
    }
    if (!best) return null;
    return {
      latest: best.name,
      releaseUrl: `https://github.com/${this.deps.repo}/releases/tag/${best.name}`,
    };
  }
}

const NOTHING_PUBLISHED =
  'GitHub answered 404 for both releases and tags — nothing published there yet, ' +
  'or the repository is private and invisible to this server.';

/**
 * The injected fetch throws `"<status> <statusText>"` (see context.ts) — a
 * deliberate contract, matched here rather than by exception type so the
 * checker stays testable with a plain function.
 */
function is404(error: unknown): boolean {
  return error instanceof Error && /^404\b/.test(error.message);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
