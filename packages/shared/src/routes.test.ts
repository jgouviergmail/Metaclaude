/**
 * The routes, as a contract both sides obey.
 *
 * The web app and the API build the same URLs by hand, in two files that never
 * meet: the API sends a push notification pointing at `/w/${id}/s/${id}` and
 * returns from Google's consent to `/settings?google=…`, and the web app owns
 * the router those paths have to match. A rename on one side breaks the other
 * silently — the link simply lands on the 404 screen, in a notification the
 * operator tapped from their phone.
 *
 * These tests pin the strings that ship today, on purpose. The point of the
 * contract is not to change any URL: an operator has bookmarks, and a
 * notification sent last week still has to open the right session. It is to
 * make the next change impossible to make on one side only.
 */

import { describe, expect, it } from 'vitest';
import { routePattern, routes } from './routes.js';

describe('the paths that ship today', () => {
  it('builds every top-level screen exactly as it is deployed', () => {
    // Written out rather than derived: a table that generated these from the
    // same source as the implementation would agree with any typo.
    expect(routes.dashboard()).toBe('/');
    expect(routes.login()).toBe('/login');
    expect(routes.workspaces()).toBe('/workspaces');
    expect(routes.board()).toBe('/board');
    expect(routes.memory()).toBe('/memory');
    expect(routes.automations()).toBe('/automations');
    expect(routes.agents()).toBe('/agents');
    expect(routes.plugins()).toBe('/plugins');
    expect(routes.analytics()).toBe('/analytics');
    expect(routes.settings()).toBe('/settings');
    expect(routes.help()).toBe('/help');
  });

  it('builds a workspace and a session as the API already sends them', () => {
    expect(routes.workspace('ws_1')).toBe('/w/ws_1');
    expect(routes.session('ws_1', 'ses_1')).toBe('/w/ws_1/s/ses_1');
  });

  it('carries the query the two screens that take one already use', () => {
    // `kernel.ts` links a workspace's memories, `integrations.ts` returns from
    // Google's consent screen onto a named tab.
    expect(routes.memory('ws_1')).toBe('/memory?workspace=ws_1');
    expect(routes.settings({ google: 'connected' })).toBe('/settings?google=connected');
  });
});

describe('an id that is not a plain identifier', () => {
  /*
   * Ids are generated from a safe alphabet, so this changes nothing today —
   * which is exactly when to fix it. A path segment pasted into a template is
   * a way to leave the workspace you meant: `/w/../../etc` resolves, and a
   * space or a `?` ends the segment early and turns the rest into a query.
   */
  it('encodes a segment rather than pasting it into the path', () => {
    expect(routes.workspace('a b')).toBe('/w/a%20b');
    expect(routes.workspace('../evil')).toBe('/w/..%2Fevil');
    expect(routes.session('ws?x', 'ses#y')).toBe('/w/ws%3Fx/s/ses%23y');
  });

  it('encodes a query value too', () => {
    expect(routes.memory('a b')).toBe('/memory?workspace=a+b');
    expect(routes.settings({ google: 'a&b' })).toBe('/settings?google=a%26b');
  });

  it('leaves an ordinary id untouched, or every existing link would move', () => {
    expect(routes.workspace('ws_01HZY')).toBe('/w/ws_01HZY');
    expect(routes.session('ws_01HZY', 'ses_01HZZ')).toBe('/w/ws_01HZY/s/ses_01HZZ');
  });
});

describe('the router patterns', () => {
  it('names the same two shapes the builders produce', () => {
    expect(routePattern.workspace).toBe('/w/:workspaceId');
    expect(routePattern.session).toBe('/w/:workspaceId/s/:sessionId');
  });

  /*
   * The pattern and the builder are the halves that must not drift: the router
   * matches one, the API sends the other. Checked by turning a built URL back
   * into its pattern, which is what a router does.
   */
  it('matches what the builder builds', () => {
    const asPattern = (path: string) =>
      path.replace(/\/w\/[^/]+\/s\/[^/]+$/, '/w/:workspaceId/s/:sessionId').replace(
        /\/w\/[^/]+$/,
        '/w/:workspaceId',
      );
    expect(asPattern(routes.workspace('ws_1'))).toBe(routePattern.workspace);
    expect(asPattern(routes.session('ws_1', 'ses_1'))).toBe(routePattern.session);
  });
});
