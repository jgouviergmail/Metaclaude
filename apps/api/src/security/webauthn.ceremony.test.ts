/**
 * The whole ceremony, with real cryptography.
 *
 * webauthn.test.ts drives the service's judgement with an injected verifier;
 * nothing there can catch a broken *byte path* — a public key stored as the
 * wrong bytes, a base64url id that does not round-trip through SQLite, a
 * challenge compared against the wrong encoding. All of those fail only when
 * a real signature meets the real @simplewebauthn verifier, so this file is a
 * software authenticator: a P-256 keypair, a CBOR "none" attestation, a DER
 * signature over authenticatorData ‖ SHA-256(clientDataJSON) — the exact
 * bytes a browser would send — pushed through the unmodified service.
 */

import { createHash, createSign, generateKeyPairSync, randomBytes } from 'node:crypto';
import { isoBase64URL, isoCBOR } from '@simplewebauthn/server/helpers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase, type Db } from '../db/index.js';
import { AuthService } from './auth.js';
import { WebAuthnService } from './webauthn.js';

const ORIGIN = 'https://claude.home.arpa';
const RP_ID = 'claude.home.arpa';

// TS Maps are invariant in their type parameters, so a perfectly encodable
// Map<number, number | Uint8Array> is not assignable to the encoder's
// recursive CBORType. The cast says "trust the shape", once, here.
type CBOR = Parameters<typeof isoCBOR.encode>[0];

let db: Db;
let auth: AuthService;
let service: WebAuthnService;
let userId: string;

/** A software authenticator: one resident P-256 credential. */
function makeAuthenticator() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const credentialId = randomBytes(32);

  const rpIdHash = createHash('sha256').update(RP_ID).digest();

  // COSE_Key: EC2 (1:2), ES256 (3:-7), P-256 (-1:1), x (-2), y (-3).
  const coseKey = isoCBOR.encode(
    new Map<number, number | Uint8Array>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, isoBase64URL.toBuffer(jwk.x)],
      [-3, isoBase64URL.toBuffer(jwk.y)],
    ]) as CBOR,
  );

  const attest = (challenge: string) => {
    const clientDataJSON = Buffer.from(
      JSON.stringify({ type: 'webauthn.create', challenge, origin: ORIGIN }),
    );
    // authData: rpIdHash(32) | flags(1) | signCount(4) | aaguid(16) |
    // credIdLen(2) | credId | COSE key. Flags 0x45 = UP | UV | AT.
    const authData = Buffer.concat([
      rpIdHash,
      Buffer.from([0x45]),
      Buffer.alloc(4),
      Buffer.alloc(16),
      Buffer.from([credentialId.length >> 8, credentialId.length & 0xff]),
      credentialId,
      Buffer.from(coseKey),
    ]);
    const attestationObject = isoCBOR.encode(
      new Map<string, string | Map<never, never> | Uint8Array>([
        ['fmt', 'none'],
        ['attStmt', new Map<never, never>()],
        ['authData', new Uint8Array(authData)],
      ]) as CBOR,
    );
    return {
      id: isoBase64URL.fromBuffer(credentialId),
      rawId: isoBase64URL.fromBuffer(credentialId),
      type: 'public-key' as const,
      clientExtensionResults: {},
      response: {
        clientDataJSON: isoBase64URL.fromBuffer(clientDataJSON),
        attestationObject: isoBase64URL.fromBuffer(attestationObject),
      },
    };
  };

  const assert = (challenge: string, counter: number) => {
    const clientDataJSON = Buffer.from(
      JSON.stringify({ type: 'webauthn.get', challenge, origin: ORIGIN }),
    );
    const counterBytes = Buffer.alloc(4);
    counterBytes.writeUInt32BE(counter);
    // Flags 0x05 = UP | UV; no attested credential data on an assertion.
    const authenticatorData = Buffer.concat([rpIdHash, Buffer.from([0x05]), counterBytes]);
    const signature = createSign('SHA256')
      .update(
        Buffer.concat([authenticatorData, createHash('sha256').update(clientDataJSON).digest()]),
      )
      .sign(privateKey);
    return {
      id: isoBase64URL.fromBuffer(credentialId),
      rawId: isoBase64URL.fromBuffer(credentialId),
      type: 'public-key' as const,
      clientExtensionResults: {},
      response: {
        clientDataJSON: isoBase64URL.fromBuffer(clientDataJSON),
        authenticatorData: isoBase64URL.fromBuffer(authenticatorData),
        signature: isoBase64URL.fromBuffer(signature),
      },
    };
  };

  return { attest, assert };
}

beforeEach(async () => {
  db = openDatabase({ path: ':memory:' });
  migrate(db);
  auth = new AuthService(db);
  service = new WebAuthnService({ db, auth });
  const user = await auth.createUser({
    username: 'alice',
    password: 'correct horse battery staple',
    role: 'owner',
  });
  userId = user.id;
});

afterEach(() => db.close());

describe('a real ceremony, end to end', () => {
  it('enrols and signs in with genuine signatures, stored bytes intact', async () => {
    const authenticator = makeAuthenticator();
    const user = { id: userId, username: 'alice' };

    const options = await service.beginRegistration(user, ORIGIN, 'correct horse battery staple');
    const record = await service.finishRegistration(
      user,
      ORIGIN,
      'Software key',
      authenticator.attest(options.challenge),
    );
    expect(record.rpId).toBe(RP_ID);

    const { ceremonyId, options: loginOptions } = await service.beginLogin(ORIGIN);
    const outcome = await service.finishLogin(
      ORIGIN,
      ceremonyId,
      authenticator.assert(loginOptions.challenge, 9),
      null,
      null,
    );

    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') throw new Error('unreachable');
    expect(auth.authenticate(outcome.token)?.user.username).toBe('alice');
    // The verifier accepted counter 9, and the row kept it.
    expect(
      db.prepare<[], { counter: number }>('SELECT counter FROM webauthn_credentials').get()
        ?.counter,
    ).toBe(9);
  });

  it('rejects a signature one byte off — the verification is real', async () => {
    const authenticator = makeAuthenticator();
    const user = { id: userId, username: 'alice' };

    const options = await service.beginRegistration(user, ORIGIN, 'correct horse battery staple');
    await service.finishRegistration(user, ORIGIN, 'k', authenticator.attest(options.challenge));

    const { ceremonyId, options: loginOptions } = await service.beginLogin(ORIGIN);
    const assertion = authenticator.assert(loginOptions.challenge, 1);
    const sig = isoBase64URL.toBuffer(assertion.response.signature);
    sig[10] = sig[10]! ^ 0xff;
    assertion.response.signature = isoBase64URL.fromBuffer(sig);

    const outcome = await service.finishLogin(ORIGIN, ceremonyId, assertion, null, null);
    expect(outcome.status).toBe('invalid');
  });

  it('rejects an assertion signed for a different origin', async () => {
    const authenticator = makeAuthenticator();
    const user = { id: userId, username: 'alice' };
    const options = await service.beginRegistration(user, ORIGIN, 'correct horse battery staple');
    await service.finishRegistration(user, ORIGIN, 'k', authenticator.attest(options.challenge));

    const { ceremonyId, options: loginOptions } = await service.beginLogin(ORIGIN);
    const assertion = authenticator.assert(loginOptions.challenge, 1);
    // Re-sign the clientDataJSON for another origin, signature and all: only
    // the library's origin check can catch this one.
    const forged = Buffer.from(
      JSON.stringify({
        type: 'webauthn.get',
        challenge: loginOptions.challenge,
        origin: 'https://evil.example',
      }),
    );
    assertion.response.clientDataJSON = isoBase64URL.fromBuffer(forged);

    const outcome = await service.finishLogin(ORIGIN, ceremonyId, assertion, null, null);
    expect(outcome.status).toBe('invalid');
  });
});
