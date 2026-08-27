/**
 * Passkeys — what is ours to test.
 *
 * The cryptography is @simplewebauthn's; verification is injected here so the
 * tests drive its outcomes. What these tests pin down is the judgement around
 * it: an IP origin refuses enrolment before any ceremony starts, a challenge
 * is single-use and expires, an unknown credential cannot sign in however
 * valid its signature, the counter and last-used stamp advance, and removing
 * a passkey demands the password because it is the same authority as removing
 * any second factor.
 */

import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase, type Db } from '../db/index.js';
import { AuthService } from './auth.js';
import { PasskeyError, rpIdFromOrigin, WebAuthnService, type WebAuthnLib } from './webauthn.js';

let db: Db;
let auth: AuthService;
let userId: string;

const ORIGIN = 'https://claude.home.arpa';
const NOW = 1_000_000;

function makeService(overrides: Partial<WebAuthnLib> = {}, now: () => number = () => NOW) {
  const lib: WebAuthnLib = {
    generateRegistrationOptions: async (options) => ({
      challenge: 'reg-challenge',
      rp: { name: 'Metaclaude', id: options.rpID },
      user: { id: 'x', name: options.userName, displayName: '' },
      pubKeyCredParams: [],
      excludeCredentials: options.excludeCredentials,
    }),
    verifyRegistrationResponse: async () => ({
      verified: true,
      registrationInfo: {
        credential: {
          id: 'cred-1',
          publicKey: new Uint8Array([1, 2, 3]),
          counter: 0,
          transports: ['internal'],
        },
      },
    }),
    generateAuthenticationOptions: async (options) => ({
      challenge: 'auth-challenge',
      rpId: options.rpID,
    }),
    verifyAuthenticationResponse: async () => ({
      verified: true,
      authenticationInfo: { newCounter: 7 },
    }),
    ...overrides,
  } as WebAuthnLib;
  return new WebAuthnService({ db, auth, lib, now });
}

async function enrol(service: WebAuthnService, label = 'My phone') {
  await service.beginRegistration({ id: userId, username: 'alice' }, ORIGIN, 'correct horse battery staple');
  return service.finishRegistration({ id: userId, username: 'alice' }, ORIGIN, label, {
    id: 'cred-1',
  });
}

beforeEach(async () => {
  db = openDatabase({ path: ':memory:' });
  migrate(db);
  auth = new AuthService(db);
  const user = await auth.createUser({
    username: 'alice',
    password: 'correct horse battery staple',
    role: 'owner',
  });
  userId = user.id;
});

afterEach(() => db.close());

describe('rpIdFromOrigin', () => {
  it('accepts a domain and strips the port', () => {
    expect(rpIdFromOrigin('https://claude.home.arpa')).toBe('claude.home.arpa');
    expect(rpIdFromOrigin('https://claude.home.arpa:8443')).toBe('claude.home.arpa');
  });

  it('refuses IP literals, plain http and garbage', () => {
    expect(rpIdFromOrigin('https://203.0.113.7')).toBeNull();
    expect(rpIdFromOrigin('https://[2001:db8::1]')).toBeNull();
    expect(rpIdFromOrigin('http://claude.home.arpa')).toBeNull();
    expect(rpIdFromOrigin('not a url')).toBeNull();
    expect(rpIdFromOrigin(undefined)).toBeNull();
  });
});

describe('enrolment', () => {
  it('refuses an IP origin with a message that says why', async () => {
    const service = makeService();
    await expect(
      service.beginRegistration({ id: userId, username: 'alice' }, 'https://203.0.113.7', 'correct horse battery staple'),
    ).rejects.toMatchObject({ statusCode: 422, message: expect.stringMatching(/domain/i) });
  });

  it('demands the password before offering options', async () => {
    const service = makeService();
    await expect(
      service.beginRegistration({ id: userId, username: 'alice' }, ORIGIN, 'wrong-password-entirely'),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('stores the verified credential with its label and rpID', async () => {
    const service = makeService();
    const record = await enrol(service);

    expect(record.label).toBe('My phone');
    expect(record.rpId).toBe('claude.home.arpa');
    const listed = service.list(userId);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.label).toBe('My phone');
    expect(listed[0]?.lastUsedAt).toBeNull();
  });

  it('refuses to finish without a begin, and consumes the challenge on use', async () => {
    const service = makeService();
    await expect(
      service.finishRegistration({ id: userId, username: 'alice' }, ORIGIN, 'x', { id: 'cred-1' }),
    ).rejects.toBeInstanceOf(PasskeyError);

    await enrol(service);
    // The challenge was consumed by the successful finish; replaying refuses.
    await expect(
      service.finishRegistration({ id: userId, username: 'alice' }, ORIGIN, 'x', { id: 'cred-1' }),
    ).rejects.toBeInstanceOf(PasskeyError);
  });

  it('refuses a verification the library rejects, storing nothing', async () => {
    const service = makeService({
      verifyRegistrationResponse: async () => ({ verified: false }),
    });
    await service.beginRegistration({ id: userId, username: 'alice' }, ORIGIN, 'correct horse battery staple');
    await expect(
      service.finishRegistration({ id: userId, username: 'alice' }, ORIGIN, 'x', { id: 'cred-1' }),
    ).rejects.toBeInstanceOf(PasskeyError);
    expect(service.list(userId)).toHaveLength(0);
  });
});

describe('login', () => {
  it('signs in with an enrolled credential, advancing counter and last-used', async () => {
    const service = makeService();
    await enrol(service);

    const { ceremonyId } = await service.beginLogin(ORIGIN);
    const outcome = await service.finishLogin(ORIGIN, ceremonyId, { id: 'cred-1' }, null, null);

    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') throw new Error('unreachable');
    expect(outcome.user.username).toBe('alice');
    expect(auth.authenticate(outcome.token)?.user.username).toBe('alice');

    const listed = service.list(userId);
    expect(listed[0]?.lastUsedAt).toBe(NOW);
    const counter = db
      .prepare<[], { counter: number }>('SELECT counter FROM webauthn_credentials')
      .get()?.counter;
    expect(counter).toBe(7);
  });

  it('refuses a credential nobody enrolled, whatever the signature says', async () => {
    const service = makeService();
    await enrol(service);
    const { ceremonyId } = await service.beginLogin(ORIGIN);
    const outcome = await service.finishLogin(ORIGIN, ceremonyId, { id: 'cred-unknown' }, null, null);
    expect(outcome.status).toBe('invalid');
  });

  it('a login ceremony is single-use and expires', async () => {
    const service = makeService();
    await enrol(service);

    const { ceremonyId } = await service.beginLogin(ORIGIN);
    await service.finishLogin(ORIGIN, ceremonyId, { id: 'cred-1' }, null, null);
    const replay = await service.finishLogin(ORIGIN, ceremonyId, { id: 'cred-1' }, null, null);
    expect(replay.status).toBe('invalid');

    // Same database, so the credential enrolled above already exists; only
    // the clock is different.
    let clock = NOW;
    const timed = makeService({}, () => clock);
    const second = await timed.beginLogin(ORIGIN);
    clock = NOW + 6 * 60_000; // past the 5-minute ceremony TTL
    const expired = await timed.finishLogin(ORIGIN, second.ceremonyId, { id: 'cred-1' }, null, null);
    expect(expired.status).toBe('invalid');
  });

  it('signs in even while the password lockout is counting, and resets it', async () => {
    // The lockout throttles password guessing; a passkey is not guessable, and
    // it is the recovery path for an owner whose password is being hammered.
    const service = makeService();
    await enrol(service);
    db.prepare('UPDATE users SET failed_logins = 9, locked_until = ? WHERE id = ?')
      .run(NOW + 60 * 60_000, userId);

    const { ceremonyId } = await service.beginLogin(ORIGIN);
    const outcome = await service.finishLogin(ORIGIN, ceremonyId, { id: 'cred-1' }, null, null);
    expect(outcome.status).toBe('ok');
    const row = db
      .prepare<[], { failed_logins: number; locked_until: number | null }>(
        'SELECT failed_logins, locked_until FROM users',
      )
      .get();
    expect(row?.failed_logins).toBe(0);
    expect(row?.locked_until).toBeNull();
  });

  it('refuses a login whose origin does not match the ceremony', async () => {
    const service = makeService();
    await enrol(service);
    const { ceremonyId } = await service.beginLogin(ORIGIN);
    const outcome = await service.finishLogin(
      'https://other.example', ceremonyId, { id: 'cred-1' }, null, null,
    );
    expect(outcome.status).toBe('invalid');
  });
});

describe('removal', () => {
  it('demands the password, then deletes exactly the named credential', async () => {
    const service = makeService();
    await enrol(service);

    const listed = service.list(userId);
    const id = listed[0]?.id as string;
    await expect(service.remove(userId, id, 'wrong-password-entirely')).resolves.toBe(false);
    expect(service.list(userId)).toHaveLength(1);

    await expect(service.remove(userId, id, 'correct horse battery staple')).resolves.toBe(true);
    expect(service.list(userId)).toHaveLength(0);
  });

  it('never deletes across users', async () => {
    const service = makeService();
    await enrol(service);
    const other = await auth.createUser({
      username: 'bob',
      password: 'correct horse battery staple',
      role: 'operator',
    });
    const id = service.list(userId)[0]?.id as string;
    await expect(service.remove(other.id, id, 'correct horse battery staple')).resolves.toBe(false);
    expect(service.list(userId)).toHaveLength(1);
  });
});
