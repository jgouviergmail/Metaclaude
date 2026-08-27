/**
 * Browser-side web push: feature detection, the VAPID key dance, and the
 * app-icon badge. The server half lives in `services/push.ts` on the API.
 *
 * Everything here degrades to nothing: an unsupported browser (no service
 * worker, no PushManager, iOS Safari outside an installed PWA) simply never
 * sees the feature, and the badge helpers swallow absence — a badge is a
 * convenience, never worth an error path of its own.
 */

export interface BrowserPushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export function pushSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    typeof window !== 'undefined' &&
    'PushManager' in window &&
    'Notification' in window
  );
}

/**
 * A VAPID public key arrives base64url-encoded; `PushManager.subscribe`
 * wants raw bytes. Exported for its tests: the two alphabet substitutions
 * and the padding are exactly the kind of detail that breaks silently.
 */
export function urlBase64ToUint8Array(base64url: string): Uint8Array {
  const padding = '='.repeat((4 - (base64url.length % 4)) % 4);
  const base64 = (base64url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/** The subscription this browser currently holds, if any. */
export async function currentSubscription(): Promise<BrowserPushSubscription | null> {
  if (!pushSupported()) return null;
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  return subscription ? (subscription.toJSON() as BrowserPushSubscription) : null;
}

/**
 * Ask permission and subscribe this browser. Throws with a readable message
 * when the person declines — the caller shows it, once, and moves on.
 */
export async function enablePush(vapidPublicKey: string): Promise<BrowserPushSubscription> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error(
      'Notifications are blocked for this site. Allow them in the browser settings, then try again.',
    );
  }
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.subscribe({
    // Required by every push service: each push must be a visible notification.
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) as unknown as BufferSource,
  });
  return subscription.toJSON() as BrowserPushSubscription;
}

/** Unsubscribe locally; returns the endpoint so the server row can go too. */
export async function disablePush(): Promise<string | null> {
  if (!pushSupported()) return null;
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return null;
  const endpoint = subscription.endpoint;
  await subscription.unsubscribe();
  return endpoint;
}

/* -------------------------------------------------------------------------- */

interface BadgeHost {
  setAppBadge?: (count: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
}

/**
 * Reflect a count on the installed app's icon. Pure over its host so the
 * three behaviours — set, clear, absent — are directly testable.
 */
export function applyAppBadge(host: BadgeHost, count: number): void {
  try {
    if (count > 0) void host.setAppBadge?.(count)?.catch(() => {});
    else void host.clearAppBadge?.()?.catch(() => {});
  } catch {
    // The Badging API is a convenience; a host without it is not an error.
  }
}
