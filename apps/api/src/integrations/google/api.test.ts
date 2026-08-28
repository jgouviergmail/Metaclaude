import { describe, expect, it } from 'vitest';

import type { FetchLike } from './oauth.js';
import {
  buildRawMessage,
  calendarCreate,
  calendarList,
  driveRead,
  encodeAddressList,
  encodeHeader,
  extractBody,
  gmailRead,
  gmailSend,
  GoogleApiError,
  headerValue,
  htmlToText,
  type GmailPart,
} from './api.js';

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64url');

/** A fetch answering a queue of bodies, recording every request. */
function fakeFetch(responses: Array<unknown | { status: number; body: unknown }>) {
  const calls: Array<{ url: string; method: string; body: unknown; headers?: Record<string, string> }> =
    [];
  let index = 0;
  const impl: FetchLike = async (url, init) => {
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(init.body) : undefined,
      headers: init?.headers,
    });
    const next = responses[Math.min(index++, responses.length - 1)];
    const shaped =
      next && typeof next === 'object' && 'status' in next
        ? (next as { status: number; body: unknown })
        : { status: 200, body: next };
    return {
      ok: shaped.status < 400,
      status: shaped.status,
      text: async () =>
        typeof shaped.body === 'string' ? shaped.body : JSON.stringify(shaped.body),
    };
  };
  return { impl, calls };
}

const call = (impl: FetchLike) => ({ fetchImpl: impl, accessToken: 'at-1' });

/* -------------------------------------------------------------------------- */

describe('reading a Gmail body', () => {
  it('reads the simple case: a phone writing text/plain', () => {
    const payload: GmailPart = {
      mimeType: 'text/plain',
      body: { data: b64('On arrive à 19 h.') },
    };
    expect(extractBody(payload)).toBe('On arrive à 19 h.');
  });

  it('finds the plain part inside multipart/alternative', () => {
    // The newsletter case. Code that reads payload.body.data and stops gets ""
    // here, and an agent summarising an inbox of empty messages invents.
    const payload: GmailPart = {
      mimeType: 'multipart/alternative',
      body: { size: 0 },
      parts: [
        { mimeType: 'text/plain', body: { data: b64('Le texte brut.') } },
        { mimeType: 'text/html', body: { data: b64('<p>Le HTML.</p>') } },
      ],
    };
    expect(extractBody(payload)).toBe('Le texte brut.');
  });

  it('descends through multipart/mixed to the alternative inside it', () => {
    // A message with an attachment: the readable part is two levels down.
    const payload: GmailPart = {
      mimeType: 'multipart/mixed',
      parts: [
        {
          mimeType: 'multipart/alternative',
          parts: [
            { mimeType: 'text/plain', body: { data: b64('Voici le devis.') } },
            { mimeType: 'text/html', body: { data: b64('<p>Voici le devis.</p>') } },
          ],
        },
        {
          mimeType: 'application/pdf',
          filename: 'devis.pdf',
          body: { attachmentId: 'att-1', size: 91_000 },
        },
      ],
    };
    expect(extractBody(payload)).toBe('Voici le devis.');
  });

  it('falls back to stripped HTML when there is no plain alternative', () => {
    const payload: GmailPart = {
      mimeType: 'text/html',
      body: { data: b64('<div>Bonjour<br>Ci-joint le <b>dossier</b>.</div>') },
    };
    expect(extractBody(payload)).toBe('Bonjour\nCi-joint le dossier.');
  });

  it('never mistakes a text attachment for the message', () => {
    const payload: GmailPart = {
      mimeType: 'multipart/mixed',
      parts: [
        { mimeType: 'text/plain', body: { data: b64('Le corps.') } },
        {
          mimeType: 'text/plain',
          filename: 'releve.txt',
          body: { data: b64('DO NOT READ ME AS THE BODY') },
        },
      ],
    };
    expect(extractBody(payload)).toBe('Le corps.');
  });

  it('returns empty rather than throwing on a message with nothing readable', () => {
    expect(extractBody(undefined)).toBe('');
    expect(extractBody({ mimeType: 'multipart/mixed', parts: [] })).toBe('');
    expect(extractBody({ mimeType: 'text/plain', body: {} })).toBe('');
  });

  it('decodes base64url, which is what Gmail actually sends', () => {
    // Standard base64 would mangle any body whose bytes produce - or _.
    const text = 'Réunion ~ ⌘ ?? >>';
    expect(extractBody({ mimeType: 'text/plain', body: { data: b64(text) } })).toBe(text);
  });

  it('reads headers whatever their casing', () => {
    const part: GmailPart = { headers: [{ name: 'subject', value: 'Réunion' }] };
    expect(headerValue(part, 'Subject')).toBe('Réunion');
    expect(headerValue(part, 'From')).toBe('');
    expect(headerValue(undefined, 'Subject')).toBe('');
  });

  it('strips script and style rather than reading them as prose', () => {
    expect(htmlToText('<style>p{color:red}</style><p>Texte</p><script>x()</script>')).toBe('Texte');
  });
});

describe('sending a Gmail message', () => {
  it('encodes a French subject as an RFC 2047 word', () => {
    // A raw accented subject in a header does not merely look wrong; it makes
    // the message ill-formed. This deployment is French, so this is the
    // ordinary case.
    const raw = Buffer.from(
      buildRawMessage({ to: 'a@b.fr', subject: 'Réunion budget', body: 'x' }),
      'base64url',
    ).toString('utf8');
    expect(raw).toContain(`Subject: =?UTF-8?B?${Buffer.from('Réunion budget').toString('base64')}?=`);
  });

  it('leaves an ASCII subject alone', () => {
    const raw = Buffer.from(
      buildRawMessage({ to: 'a@b.fr', subject: 'Budget meeting', body: 'x' }),
      'base64url',
    ).toString('utf8');
    expect(raw).toContain('Subject: Budget meeting');
    expect(raw).not.toContain('=?UTF-8?B?');
  });

  it('encodes a display name but never the address itself', () => {
    // Encoding the whole entry produces a header no mail server can route.
    const encoded = encodeAddressList('Aurélie Fontaine <aurelie@example.fr>');
    expect(encoded).toContain('<aurelie@example.fr>');
    expect(encoded).toMatch(/^=\?UTF-8\?B\?[^?]+\?= <aurelie@example\.fr>$/);
  });

  it('handles a list of addresses, mixed', () => {
    const encoded = encodeAddressList('plain@example.fr, Amélie <a@b.fr>');
    expect(encoded).toBe(`plain@example.fr, ${encodeHeader('Amélie')} <a@b.fr>`);
  });

  it('declares the body as base64 UTF-8, so accents survive', () => {
    const raw = Buffer.from(
      buildRawMessage({ to: 'a@b.fr', subject: 'x', body: 'Été à Nîmes' }),
      'base64url',
    ).toString('utf8');
    expect(raw).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(raw).toContain('Content-Transfer-Encoding: base64');
    expect(raw).toContain(Buffer.from('Été à Nîmes', 'utf8').toString('base64'));
  });

  it('separates headers with CRLF, as RFC 2822 requires', () => {
    const raw = Buffer.from(
      buildRawMessage({ to: 'a@b.fr', subject: 'x', body: 'y' }),
      'base64url',
    ).toString('utf8');
    expect(raw).toContain('\r\n');
    expect(raw).toContain('\r\n\r\n');
  });

  it('posts the raw message to Gmail with the bearer token', async () => {
    const { impl, calls } = fakeFetch([{ id: 'm-1', threadId: 't-1' }]);
    const sent = await gmailSend(call(impl), { to: 'a@b.fr', subject: 'Hi', body: 'There' });

    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toContain('/messages/send');
    expect(calls[0]!.headers?.authorization).toBe('Bearer at-1');
    expect((calls[0]!.body as { raw: string }).raw).toBe(
      buildRawMessage({ to: 'a@b.fr', subject: 'Hi', body: 'There' }),
    );
    expect(sent).toEqual({ id: 'm-1', threadId: 't-1' });
  });
});

describe('reading one message end to end', () => {
  it('asks for the full format and returns headers plus the walked body', async () => {
    const { impl, calls } = fakeFetch([
      {
        id: 'm-1',
        threadId: 't-1',
        snippet: 'Voici…',
        payload: {
          mimeType: 'multipart/alternative',
          headers: [
            { name: 'From', value: 'Amélie <a@b.fr>' },
            { name: 'Subject', value: 'Devis' },
            { name: 'Date', value: 'Tue, 5 Aug 2026 09:12:00 +0200' },
          ],
          parts: [{ mimeType: 'text/plain', body: { data: b64('Voici le devis signé.') } }],
        },
      },
    ]);

    const message = await gmailRead(call(impl), { id: 'm-1' });

    expect(new URL(calls[0]!.url).searchParams.get('format')).toBe('full');
    expect(message.from).toBe('Amélie <a@b.fr>');
    expect(message.subject).toBe('Devis');
    expect(message.body).toBe('Voici le devis signé.');
  });
});

describe('the calendar', () => {
  it('expands recurring events and orders them', async () => {
    // Without singleEvents a weekly meeting appears once, on the day it was
    // created, and every standing commitment vanishes from the agent's view.
    const { impl, calls } = fakeFetch([{ items: [] }]);
    await calendarList(call(impl), {
      calendarId: 'primary',
      timeMin: '2026-08-01T00:00:00Z',
      timeMax: '2026-08-08T00:00:00Z',
      limit: 50,
    });
    const query = new URL(calls[0]!.url).searchParams;
    expect(query.get('singleEvents')).toBe('true');
    expect(query.get('orderBy')).toBe('startTime');
  });

  it('marks an all-day event rather than pretending it has a time', async () => {
    // `date` and `dateTime` are different fields; reading the first as a
    // timestamp shifts a birthday onto the wrong day in half the world.
    const { impl } = fakeFetch([
      {
        items: [
          { id: 'e-1', summary: 'Anniversaire', start: { date: '2026-08-05' }, end: { date: '2026-08-06' } },
          {
            id: 'e-2',
            summary: 'Dentiste',
            start: { dateTime: '2026-08-05T09:00:00+02:00' },
            end: { dateTime: '2026-08-05T09:30:00+02:00' },
            location: 'Nîmes',
            attendees: [{ email: 'a@b.fr' }],
          },
        ],
      },
    ]);
    const events = await calendarList(call(impl), {
      calendarId: 'primary',
      timeMin: 'x',
      timeMax: 'y',
      limit: 10,
    });

    expect(events[0]).toMatchObject({ allDay: true, start: '2026-08-05' });
    expect(events[1]).toMatchObject({
      allDay: false,
      start: '2026-08-05T09:00:00+02:00',
      location: 'Nîmes',
      attendees: ['a@b.fr'],
    });
  });

  it('creates an all-day event from a bare date and a timed one otherwise', async () => {
    const { impl, calls } = fakeFetch([{ id: 'e-9' }, { id: 'e-10' }]);
    const base = { calendarId: 'primary', summary: 'Congés' };

    await calendarCreate(call(impl), { ...base, start: '2026-08-10', end: '2026-08-17' });
    expect(calls[0]!.body).toMatchObject({ start: { date: '2026-08-10' } });

    await calendarCreate(call(impl), {
      ...base,
      start: '2026-08-10T09:00:00+02:00',
      end: '2026-08-10T10:00:00+02:00',
      timeZone: 'Europe/Paris',
    });
    expect(calls[1]!.body).toMatchObject({
      start: { dateTime: '2026-08-10T09:00:00+02:00', timeZone: 'Europe/Paris' },
    });
  });

  it('escapes a calendar id that is an email address', async () => {
    const { impl, calls } = fakeFetch([{ items: [] }]);
    await calendarList(call(impl), {
      calendarId: 'someone@example.fr',
      timeMin: 'x',
      timeMax: 'y',
      limit: 5,
    });
    expect(calls[0]!.url).toContain('someone%40example.fr');
  });
});

describe('drive', () => {
  it('exports a Google Doc instead of downloading bytes it does not have', async () => {
    // A Google-native file has no media to download; ask for the bytes and
    // the call fails with an error about the export the caller should have
    // requested.
    const { impl, calls } = fakeFetch([
      { mimeType: 'application/vnd.google-apps.document' },
      'Le contenu du document.',
    ]);
    const text = await driveRead(call(impl), { id: 'f-1' });

    expect(calls[1]!.url).toContain('/export?mimeType=text%2Fplain');
    expect(text).toBe('Le contenu du document.');
  });

  it('downloads an ordinary file directly', async () => {
    const { impl, calls } = fakeFetch([{ mimeType: 'text/csv' }, 'a,b\n1,2']);
    await driveRead(call(impl), { id: 'f-2' });
    expect(calls[1]!.url).toContain('alt=media');
  });

  it('skips the metadata round trip when the type is already known', async () => {
    const { impl, calls } = fakeFetch(['x']);
    await driveRead(call(impl), { id: 'f-3', mimeType: 'text/plain' });
    expect(calls).toHaveLength(1);
  });
});

describe('errors', () => {
  it("reports Google's own sentence rather than the status code", async () => {
    const { impl } = fakeFetch([
      {
        status: 403,
        body: { error: { message: 'Request had insufficient authentication scopes.' } },
      },
    ]);
    await expect(gmailRead(call(impl), { id: 'm-1' })).rejects.toThrow(/insufficient authentication/);
  });

  it('keeps the status so a caller can tell 403 from 404', async () => {
    const { impl } = fakeFetch([{ status: 404, body: { error: { message: 'Not Found' } } }]);
    await expect(gmailRead(call(impl), { id: 'm-1' })).rejects.toMatchObject({
      status: 404,
      name: 'GoogleApiError',
    });
  });

  it('survives an error body that is not JSON', async () => {
    const { impl } = fakeFetch([{ status: 502, body: '<html>Bad Gateway</html>' }]);
    await expect(gmailRead(call(impl), { id: 'm-1' })).rejects.toThrow(GoogleApiError);
  });
});
