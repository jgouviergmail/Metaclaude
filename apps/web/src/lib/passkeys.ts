/**
 * Passkey helpers around @simplewebauthn/browser.
 *
 * The one piece of judgement here is `isIpHost`: WebAuthn scopes a credential
 * to a *domain*, so a deployment visited by IP address cannot use passkeys at
 * all. The API refuses that server-side too; knowing it client-side lets the
 * Security screen explain instead of offering a button that fails.
 */

import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/browser';

/**
 * Whether a hostname is an IP literal rather than a domain.
 *
 * IPv6 arrives from `location.hostname` with its brackets; a bare form with
 * colons is one too. Dotted digits are IPv4 only when *every* label is a
 * number — `10.0.0.7.example` is a domain.
 */
export function isIpHost(hostname: string): boolean {
  if (hostname.startsWith('[') || hostname.includes(':')) return true;
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
}

/** The browser has the WebAuthn API at all. */
export function passkeySupported(): boolean {
  return typeof window !== 'undefined' && typeof window.PublicKeyCredential === 'function';
}

/** The current address can carry a passkey — a domain, not an IP. */
export function passkeyDomainOk(): boolean {
  return typeof window !== 'undefined' && !isIpHost(window.location.hostname);
}

// The ceremony library loads when a ceremony starts, not with the app: these
// run behind a tap, a network round-trip and a biometric prompt, so the
// import cost vanishes — and the entry chunk stays free of WebAuthn code for
// everyone who signs in with a password.
export async function createPasskey(
  optionsJSON: PublicKeyCredentialCreationOptionsJSON,
): Promise<RegistrationResponseJSON> {
  const { startRegistration } = await import('@simplewebauthn/browser');
  return startRegistration({ optionsJSON });
}

export async function assertPasskey(
  optionsJSON: PublicKeyCredentialRequestOptionsJSON,
): Promise<AuthenticationResponseJSON> {
  const { startAuthentication } = await import('@simplewebauthn/browser');
  return startAuthentication({ optionsJSON });
}

/** The user closed the browser's passkey prompt — a choice, not a failure. */
export function isCeremonyCancelled(error: unknown): boolean {
  return error instanceof Error && (error.name === 'NotAllowedError' || error.name === 'AbortError');
}
