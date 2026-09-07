/**
 * Every path in the interface, built from one place.
 *
 * The web app owns the router; the API sends people into it. A push
 * notification points at a session, a scheduler notification at the
 * automations screen, Google's consent returns to a named settings tab, and an
 * insight links a workspace's memories. Those strings were written by hand on
 * both sides, in files that never meet — so a rename in the router would have
 * left the notifications landing on the 404 screen, silently, on a phone.
 *
 * **No URL here may change.** An operator has bookmarks and a notification sent
 * last week still has to open the right session; `routes.test.ts` pins each
 * string that ships. What the contract buys is not freedom to rename, it is
 * that renaming becomes one edit instead of two that can disagree.
 *
 * Kept out of `domain.ts` deliberately, and for the opposite reason to
 * `api-contracts.ts`: this *is* reachable from the web app's runtime, so it
 * belongs where both sides can import it — and it is a handful of strings, not
 * a Zod schema, so it costs the bundle nothing worth measuring.
 */

/** A path segment, safe to paste into a URL. */
function segment(value: string): string {
  // Ids come from a safe alphabet, so this changes nothing today — which is
  // when to do it. An unencoded segment is a way out of the path it belongs to:
  // `/w/../../etc` resolves, and a `?` ends the segment and turns the rest into
  // a query.
  return encodeURIComponent(value);
}

/** A query string, or nothing at all when there is nothing to say. */
function query(params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, value);
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

export const routes = {
  dashboard: () => '/',
  login: () => '/login',
  workspaces: () => '/workspaces',
  workspace: (workspaceId: string) => `/w/${segment(workspaceId)}`,
  session: (workspaceId: string, sessionId: string) =>
    `/w/${segment(workspaceId)}/s/${segment(sessionId)}`,
  board: () => '/board',
  /** The whole shelf, or one workspace's — `kernel.ts` links the second. */
  memory: (workspaceId?: string) => `/memory${query({ workspace: workspaceId })}`,
  automations: () => '/automations',
  agents: () => '/agents',
  plugins: () => '/plugins',
  analytics: () => '/analytics',
  /** `integrations.ts` returns from Google's consent with a result here. */
  settings: (params: Record<string, string | undefined> = {}) => `/settings${query(params)}`,
  help: () => '/help',
} as const;

/**
 * The two paths the router matches rather than builds.
 *
 * They are the other half of the pair above: the router matches these, the API
 * sends what the builders produce, and nothing else connects them. A test turns
 * one into the other so they cannot drift apart.
 */
/**
 * What every workspace path begins with.
 *
 * The rail highlights `Workspaces` for a session too, and asked that question
 * with a literal `'/w/'`. The prefix is a fact about the contract above, so it
 * comes from there rather than being written a second time three files away.
 */
export const WORKSPACE_PREFIX = '/w/';

export const routePattern = {
  workspace: '/w/:workspaceId',
  session: '/w/:workspaceId/s/:sessionId',
} as const;
