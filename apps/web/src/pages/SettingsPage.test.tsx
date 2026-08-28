/**
 * The one routing decision the settings page makes on its own: which tab it
 * opens on. Pure-function tests, deliberately — rendering the whole page
 * would drag a dozen API mocks for a decision that takes a query string.
 */

import { describe, expect, it } from 'vitest';

import { initialSettingsTab } from './SettingsPage';

describe('which tab the settings page opens on', () => {
  it('opens Security by default', () => {
    expect(initialSettingsTab('')).toBe('security');
    expect(initialSettingsTab('?theme=dark')).toBe('security');
  });

  it('opens Connections when Google’s callback carried an outcome', () => {
    // The toast lives in the connection card, and Radix unmounts inactive
    // tabs: landing anywhere else swallows the outcome silently.
    expect(initialSettingsTab('?google=connected')).toBe('connections');
    expect(initialSettingsTab('?google=failed&reason=redirect_uri_mismatch')).toBe('connections');
  });
});
