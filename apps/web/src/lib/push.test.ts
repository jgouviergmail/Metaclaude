/**
 * The two push helpers whose failure is silent: the base64url decoding a
 * subscription depends on byte for byte, and the badge that must never
 * throw whatever the host offers.
 */

import { describe, expect, it, vi } from 'vitest';
import { applyAppBadge, urlBase64ToUint8Array } from './push';

describe('urlBase64ToUint8Array', () => {
  it('decodes the url-safe alphabet and restores the padding', () => {
    // 'Metaclaude!!' → base64 'TWV0YWNsYXVkZSEh' — no url-specific chars.
    expect(Array.from(urlBase64ToUint8Array('TWV0YWNsYXVkZSEh'))).toEqual(
      Array.from('Metaclaude!!').map((c) => c.charCodeAt(0)),
    );
    // Bytes 0xfb 0xff → base64 '+/8=' → base64url '-_8' (padding stripped).
    expect(Array.from(urlBase64ToUint8Array('-_8'))).toEqual([0xfb, 0xff]);
  });

  it('round-trips a realistic VAPID key length (65 raw bytes)', () => {
    const bytes = Array.from({ length: 65 }, (_, i) => (i * 7) % 256);
    const base64url = Buffer.from(bytes).toString('base64url');
    expect(Array.from(urlBase64ToUint8Array(base64url))).toEqual(bytes);
  });
});

describe('applyAppBadge', () => {
  it('sets on a positive count and clears on zero', () => {
    const setAppBadge = vi.fn(async () => {});
    const clearAppBadge = vi.fn(async () => {});
    applyAppBadge({ setAppBadge, clearAppBadge }, 3);
    expect(setAppBadge).toHaveBeenCalledWith(3);
    applyAppBadge({ setAppBadge, clearAppBadge }, 0);
    expect(clearAppBadge).toHaveBeenCalledTimes(1);
  });

  it('is inert on a host without the API, and survives one that throws', () => {
    expect(() => applyAppBadge({}, 5)).not.toThrow();
    expect(() =>
      applyAppBadge(
        {
          setAppBadge: () => {
            throw new Error('blocked');
          },
        },
        5,
      ),
    ).not.toThrow();
  });
});
