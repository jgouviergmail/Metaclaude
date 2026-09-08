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
  /**
   * The machine: version, uptime, resources, the Claude CLI, the doctor, the
   * updater. It was a tab inside Settings and is a screen of its own now —
   * nothing there is a preference, and Settings is where preferences live.
   */
  server: () => '/server',
  /** The whole shelf, or one workspace's — `kernel.ts` links the second. */
  memory: (workspaceId?: string) => `/memory${query({ workspace: workspaceId })}`,
  /**
   * One document of the library, opened at the line a run quoted.
   *
   * Built here rather than at each call site for the reason every route is:
   * the parameter names are a contract between the genesis strip that writes
   * them and the Memory page that reads them, and two spellings of `?line=`
   * is a link that resolves and does nothing.
   */
  memoryDocument: (documentId: string, line?: number | null) =>
    `/memory${query({ document: documentId, line: line ? String(line) : undefined })}`,
  automations: () => '/automations',
  agents: () => '/agents',
  plugins: () => '/plugins',
  analytics: () => '/analytics',
  /**
   * Settings' own landing, and the shape other systems already build.
   *
   * `integrations.ts` returns from Google's consent with a result here, and an
   * operator has bookmarks — so `/settings` keeps working and keeps taking a
   * query. What changed is that each group underneath it is a route of its
   * own, like the System section's screens; `/settings` sends you to the first
   * of them, or to the one that can read the parameter it carries.
   */
  settings: (params: Record<string, string | undefined> = {}) => `/settings${query(params)}`,
  /** One group of settings. The values are the section slugs below. */
  settingsSection: (section: SettingsSection) => `/settings/${section}`,
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

/**
 * The groups Settings is made of, in the order they are shown.
 *
 * Appearance first because it is the one an operator changes on a whim;
 * connections and security next; configuration and the audit log after, as the
 * things you go in for deliberately; help last, because it is not a setting at
 * all — it is the manual, and it lives here so the whole "how is this thing
 * set up and explained" question has one place.
 */
export const SETTINGS_SECTIONS = [
  'appearance',
  'connections',
  'security',
  'configuration',
  'audit',
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/**
 * The groups an operator has no business in.
 *
 * A rule about *authority*, so it belongs beside the routes rather than in the
 * strip that draws them: the API refuses these to an operator, the strip hides
 * them, and the screen sends one away who types the URL. Three readers, one
 * list — written twice, the third would eventually disagree with the other two
 * and the disagreement would be a hidden screen or an unguarded one.
 */
export const OWNER_ONLY_SETTINGS: readonly SettingsSection[] = [
  'connections',
  'configuration',
  'audit',
];

export function isOwnerOnlySection(section: string): boolean {
  return (OWNER_ONLY_SETTINGS as readonly string[]).includes(section);
}

/**
 * The System section's screens, in the order they are shown.
 *
 * Paths only. The strip pairs each with a label and an icon; `lib/sections.ts`
 * answers "which section owns this path" from the same list, and it must be
 * able to do so without importing a module full of icons — that pulled 1 kB
 * gzip into the entry chunk the day it was tried.
 */
export const SYSTEM_SECTION_PATHS = [
  '/server',
  '/automations',
  '/agents',
  '/plugins',
  '/analytics',
] as const;

export const routePattern = {
  workspace: '/w/:workspaceId',
  session: '/w/:workspaceId/s/:sessionId',
  settingsSection: '/settings/:section',
} as const;
