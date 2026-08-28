/**
 * The Google calls behind the MCP tools, and the two encodings that make them
 * wrong in ways nobody notices until a real message arrives.
 *
 * **Reading a Gmail message is a tree walk, not a field read.** A message from
 * a phone is `text/plain`; one from a newsletter is `multipart/alternative`
 * holding plain and HTML; one with a photo is `multipart/mixed` wrapping that
 * alternative. `payload.body.data` is empty for every case but the first, so
 * code that reads it and stops returns "" for most real mail — and an agent
 * summarising an inbox of empty messages says confident, wrong things.
 *
 * **Sending needs RFC 2047.** SMTP headers are ASCII. A subject of "Réunion
 * budget" put raw into a header is not merely mangled, it makes the whole
 * message ill-formed. It has to be encoded-word wrapped, and this deployment
 * is French, so this is the common case rather than the exotic one.
 *
 * Every function takes its access token and a `fetch`. No token minting, no
 * network at construction, nothing to stub globally: the tests drive real
 * payloads through real parsing.
 */

import type { FetchLike } from './oauth.js';

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const CALENDAR = 'https://www.googleapis.com/calendar/v3';
const DRIVE = 'https://www.googleapis.com/drive/v3';

export class GoogleApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'GoogleApiError';
  }
}

export interface GoogleCall {
  fetchImpl: FetchLike;
  accessToken: string;
}

async function request(
  call: GoogleCall,
  url: string,
  init?: { method?: string; body?: unknown },
): Promise<Record<string, unknown>> {
  const response = await call.fetchImpl(url, {
    method: init?.method ?? 'GET',
    headers: {
      authorization: `Bearer ${call.accessToken}`,
      ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });

  const text = await response.text();
  if (!response.ok) {
    // Google nests the useful sentence; surface it rather than the status.
    let detail = text.slice(0, 300);
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string } };
      if (parsed.error?.message) detail = parsed.error.message;
    } catch {
      /* keep the raw body */
    }
    throw new GoogleApiError(detail, response.status);
  }
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

/* -------------------------------------------------------------------------- */
/* Gmail                                                                       */
/* -------------------------------------------------------------------------- */

export interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name: string; value: string }>;
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GmailPart[];
}

/** Case-insensitive header lookup — Gmail's casing is not guaranteed. */
export function headerValue(part: GmailPart | undefined, name: string): string {
  const wanted = name.toLowerCase();
  return part?.headers?.find((header) => header.name.toLowerCase() === wanted)?.value ?? '';
}

function decodeBody(data: string | undefined): string {
  if (!data) return '';
  // Gmail uses base64url. Buffer tolerates the padding being absent.
  return Buffer.from(data, 'base64url').toString('utf8');
}

/** A crude tag strip, for the messages that carry no plain-text alternative. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * The readable body of a message, walking the MIME tree.
 *
 * Plain text wins wherever it is found; HTML is the fallback, stripped. An
 * attachment part is skipped even when its mime type says text — a `.txt`
 * attachment is not the message.
 */
export function extractBody(payload: GmailPart | undefined): string {
  if (!payload) return '';

  const plain: string[] = [];
  const html: string[] = [];

  const walk = (part: GmailPart): void => {
    // `filename` non-empty means this part is an attachment, whatever its type.
    if (part.filename) return;
    const type = (part.mimeType ?? '').toLowerCase();
    if (type === 'text/plain') plain.push(decodeBody(part.body?.data));
    else if (type === 'text/html') html.push(decodeBody(part.body?.data));
    for (const child of part.parts ?? []) walk(child);
  };
  walk(payload);

  const text = plain.join('\n').trim();
  if (text) return text;
  const markup = html.join('\n').trim();
  return markup ? htmlToText(markup) : '';
}

export interface GmailSummary {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  snippet: string;
}

export async function gmailSearch(
  call: GoogleCall,
  input: { query: string; limit: number },
): Promise<GmailSummary[]> {
  const url = new URL(`${GMAIL}/messages`);
  url.searchParams.set('q', input.query);
  url.searchParams.set('maxResults', String(input.limit));
  const listing = (await request(call, url.toString())) as {
    messages?: Array<{ id: string; threadId: string }>;
  };

  const found = listing.messages ?? [];
  // Metadata format: enough for a summary line, and it does not drag whole
  // message bodies (attachments included) across for a list of ten.
  return Promise.all(
    found.map(async (message) => {
      const detail = new URL(`${GMAIL}/messages/${message.id}`);
      detail.searchParams.set('format', 'metadata');
      for (const header of ['From', 'To', 'Subject', 'Date']) {
        detail.searchParams.append('metadataHeaders', header);
      }
      const full = (await request(call, detail.toString())) as {
        threadId?: string;
        snippet?: string;
        payload?: GmailPart;
      };
      return {
        id: message.id,
        threadId: full.threadId ?? message.threadId,
        from: headerValue(full.payload, 'From'),
        to: headerValue(full.payload, 'To'),
        subject: headerValue(full.payload, 'Subject'),
        date: headerValue(full.payload, 'Date'),
        snippet: full.snippet ?? '',
      };
    }),
  );
}

export async function gmailRead(
  call: GoogleCall,
  input: { id: string },
): Promise<GmailSummary & { body: string }> {
  const url = new URL(`${GMAIL}/messages/${input.id}`);
  url.searchParams.set('format', 'full');
  const message = (await request(call, url.toString())) as {
    id?: string;
    threadId?: string;
    snippet?: string;
    payload?: GmailPart;
  };
  return {
    id: message.id ?? input.id,
    threadId: message.threadId ?? '',
    from: headerValue(message.payload, 'From'),
    to: headerValue(message.payload, 'To'),
    subject: headerValue(message.payload, 'Subject'),
    date: headerValue(message.payload, 'Date'),
    snippet: message.snippet ?? '',
    body: extractBody(message.payload),
  };
}

/**
 * RFC 2047 encoded-word, applied only when the value is not already ASCII.
 *
 * Leaving ASCII alone matters: an encoded-word where none is needed is legal
 * but unreadable in the raw message, and makes every debugging session worse.
 */
export function encodeHeader(value: string): string {
  // eslint-disable-next-line no-control-regex -- the point is the ASCII range
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

/**
 * An address list, encoded per RFC 2047 without breaking the addresses.
 *
 * Only the display name may be non-ASCII; the address itself must not be
 * touched, so `Aurélie <a@b.fr>` encodes the name and leaves `<a@b.fr>` alone.
 * Encoding the whole string would produce an unroutable header.
 */
export function encodeAddressList(value: string): string {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const match = /^(.*?)\s*<([^>]+)>$/.exec(entry);
      if (!match) return entry;
      const name = match[1]!.replace(/^"|"$/g, '').trim();
      return name ? `${encodeHeader(name)} <${match[2]}>` : `<${match[2]}>`;
    })
    .join(', ');
}

/** The RFC 2822 message Gmail wants, base64url encoded. */
export function buildRawMessage(input: {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  replyTo?: string;
}): string {
  const lines = [
    `To: ${encodeAddressList(input.to)}`,
    ...(input.cc ? [`Cc: ${encodeAddressList(input.cc)}`] : []),
    ...(input.replyTo ? [`In-Reply-To: ${input.replyTo}`, `References: ${input.replyTo}`] : []),
    `Subject: ${encodeHeader(input.subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    // Without this, a body with accents is 8-bit content declared as 7-bit.
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(input.body, 'utf8').toString('base64'),
  ];
  return Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url');
}

export async function gmailSend(
  call: GoogleCall,
  input: { to: string; subject: string; body: string; cc?: string },
): Promise<{ id: string; threadId: string }> {
  const sent = (await request(call, `${GMAIL}/messages/send`, {
    method: 'POST',
    body: { raw: buildRawMessage(input) },
  })) as { id?: string; threadId?: string };
  return { id: sent.id ?? '', threadId: sent.threadId ?? '' };
}

/* -------------------------------------------------------------------------- */
/* Calendar                                                                    */
/* -------------------------------------------------------------------------- */

export interface CalendarEvent {
  id: string;
  summary: string;
  start: string;
  end: string;
  location: string;
  attendees: string[];
  /** True for an all-day event, where the times are dates. */
  allDay: boolean;
}

function readEvent(raw: Record<string, unknown>): CalendarEvent {
  const start = (raw.start ?? {}) as { dateTime?: string; date?: string };
  const end = (raw.end ?? {}) as { dateTime?: string; date?: string };
  return {
    id: typeof raw.id === 'string' ? raw.id : '',
    summary: typeof raw.summary === 'string' ? raw.summary : '(no title)',
    start: start.dateTime ?? start.date ?? '',
    end: end.dateTime ?? end.date ?? '',
    location: typeof raw.location === 'string' ? raw.location : '',
    attendees: Array.isArray(raw.attendees)
      ? raw.attendees
          .map((a) => (a as { email?: string }).email)
          .filter((email): email is string => typeof email === 'string')
      : [],
    // An all-day event carries `date`, not `dateTime`. Rendering it as a
    // timestamp shifts it by a timezone and puts a birthday on the wrong day.
    allDay: !start.dateTime && Boolean(start.date),
  };
}

export async function calendarList(
  call: GoogleCall,
  input: { calendarId: string; timeMin: string; timeMax: string; limit: number },
): Promise<CalendarEvent[]> {
  const url = new URL(`${CALENDAR}/calendars/${encodeURIComponent(input.calendarId)}/events`);
  url.searchParams.set('timeMin', input.timeMin);
  url.searchParams.set('timeMax', input.timeMax);
  url.searchParams.set('maxResults', String(input.limit));
  // Without these two, a weekly meeting appears once, on the day it was
  // created, and every recurring commitment vanishes from the agent's view.
  url.searchParams.set('singleEvents', 'true');
  url.searchParams.set('orderBy', 'startTime');
  const listing = (await request(call, url.toString())) as {
    items?: Array<Record<string, unknown>>;
  };
  return (listing.items ?? []).map(readEvent);
}

export async function calendarCreate(
  call: GoogleCall,
  input: {
    calendarId: string;
    summary: string;
    start: string;
    end: string;
    description?: string;
    location?: string;
    attendees?: string[];
    timeZone?: string;
  },
): Promise<CalendarEvent> {
  // A bare date means all-day; anything else is a timestamp.
  const isDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);
  const bound = (value: string) =>
    isDate(value)
      ? { date: value }
      : { dateTime: value, ...(input.timeZone ? { timeZone: input.timeZone } : {}) };

  const created = await request(
    call,
    `${CALENDAR}/calendars/${encodeURIComponent(input.calendarId)}/events`,
    {
      method: 'POST',
      body: {
        summary: input.summary,
        start: bound(input.start),
        end: bound(input.end),
        ...(input.description ? { description: input.description } : {}),
        ...(input.location ? { location: input.location } : {}),
        ...(input.attendees?.length
          ? { attendees: input.attendees.map((email) => ({ email })) }
          : {}),
      },
    },
  );
  return readEvent(created);
}

/* -------------------------------------------------------------------------- */
/* Drive                                                                       */
/* -------------------------------------------------------------------------- */

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  webViewLink: string;
}

export async function driveSearch(
  call: GoogleCall,
  input: { query: string; limit: number },
): Promise<DriveFile[]> {
  const url = new URL(`${DRIVE}/files`);
  url.searchParams.set('q', input.query);
  url.searchParams.set('pageSize', String(input.limit));
  url.searchParams.set('fields', 'files(id,name,mimeType,modifiedTime,webViewLink)');
  const listing = (await request(call, url.toString())) as { files?: Array<Record<string, string>> };
  return (listing.files ?? []).map((file) => ({
    id: file.id ?? '',
    name: file.name ?? '',
    mimeType: file.mimeType ?? '',
    modifiedTime: file.modifiedTime ?? '',
    webViewLink: file.webViewLink ?? '',
  }));
}

/** Google's own formats have no bytes to download; they must be exported. */
export const DRIVE_EXPORTS: Record<string, string> = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain',
};

export async function driveRead(
  call: GoogleCall,
  input: { id: string; mimeType?: string },
): Promise<string> {
  let mimeType = input.mimeType;
  if (!mimeType) {
    const meta = (await request(
      call,
      `${DRIVE}/files/${encodeURIComponent(input.id)}?fields=mimeType`,
    )) as { mimeType?: string };
    mimeType = meta.mimeType ?? '';
  }

  const exportAs = DRIVE_EXPORTS[mimeType];
  const url = exportAs
    ? `${DRIVE}/files/${encodeURIComponent(input.id)}/export?mimeType=${encodeURIComponent(exportAs)}`
    : `${DRIVE}/files/${encodeURIComponent(input.id)}?alt=media`;

  const response = await call.fetchImpl(url, {
    headers: { authorization: `Bearer ${call.accessToken}` },
  });
  const text = await response.text();
  if (!response.ok) throw new GoogleApiError(text.slice(0, 300), response.status);
  return text;
}
