/**
 * The Google tools, and which grants each one requires.
 *
 * Registration is gated by the grants the operator actually consented to, and
 * that is a real boundary rather than a tidy one: a tool that is not
 * registered does not appear in the model's tool list at all, so the agent
 * cannot decide to try it and cannot report back that "sending mail failed".
 * The alternative — register everything, fail at the API — teaches the model
 * that the capability exists and encourages it to retry.
 *
 * Kept apart from `server.ts` so the wiring can be tested without a stdio
 * transport: `googleTools()` returns plain descriptors, and the server does
 * nothing but hand them to the SDK.
 */

import { z } from 'zod';

import type { GoogleGrant } from '@metaclaude/shared';

import {
  calendarCreate,
  calendarList,
  driveRead,
  driveSearch,
  gmailRead,
  gmailSearch,
  gmailSend,
  type GoogleCall,
} from './api.js';

export interface GoogleTool {
  name: string;
  title: string;
  description: string;
  /** Every grant the tool needs; absent any of them, it is not registered. */
  requires: readonly GoogleGrant[];
  inputSchema: z.ZodRawShape;
  /** Returns whatever should be serialised back to the model. */
  run: (call: GoogleCall, input: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Gmail's own query syntax, quoted in the description on purpose: the model
 * writes these, and `from:` / `newer_than:` / `has:attachment` are the
 * difference between a useful search and reading the whole inbox.
 */
const GMAIL_QUERY = z
  .string()
  .min(1)
  .describe(
    'A Gmail search query, using Gmail syntax: from:, to:, subject:, has:attachment, ' +
      'is:unread, label:, newer_than:7d, older_than:1m, or plain words. ' +
      'Example: from:banque newer_than:30d has:attachment',
  );

const ALL: readonly GoogleTool[] = [
  {
    name: 'gmail_search',
    title: 'Search mail',
    description:
      'Search the connected Gmail account and return matching messages as sender, subject, date and snippet. Use gmail_read for the body of one.',
    requires: ['gmail.read'],
    inputSchema: {
      query: GMAIL_QUERY,
      limit: z.number().int().min(1).max(50).default(10).describe('How many messages, at most.'),
    },
    run: (call, input) =>
      gmailSearch(call, {
        query: String(input.query),
        limit: typeof input.limit === 'number' ? input.limit : 10,
      }),
  },
  {
    name: 'gmail_read',
    title: 'Read a message',
    description:
      'Read one Gmail message in full, including its body as plain text. Takes an id from gmail_search.',
    requires: ['gmail.read'],
    inputSchema: { id: z.string().min(1).describe('The message id, from gmail_search.') },
    run: (call, input) => gmailRead(call, { id: String(input.id) }),
  },
  {
    name: 'gmail_send',
    title: 'Send a message',
    description:
      'Send an email from the connected account. Write the body as plain text; it is sent as UTF-8, so accents and any language are fine.',
    requires: ['gmail.send'],
    inputSchema: {
      to: z.string().min(1).describe('Recipient(s), comma separated.'),
      subject: z.string().describe('The subject line.'),
      body: z.string().describe('The message body, plain text.'),
      cc: z.string().optional().describe('Carbon copy recipient(s), comma separated.'),
    },
    run: (call, input) =>
      gmailSend(call, {
        to: String(input.to),
        subject: String(input.subject ?? ''),
        body: String(input.body ?? ''),
        ...(input.cc ? { cc: String(input.cc) } : {}),
      }),
  },
  {
    name: 'calendar_list_events',
    title: 'List calendar events',
    description:
      'List events between two instants, recurring events expanded to their occurrences. Times are RFC 3339; an all-day event is flagged rather than given a time.',
    requires: ['calendar.read'],
    inputSchema: {
      timeMin: z.string().min(1).describe('Start of the window, RFC 3339 (2026-08-01T00:00:00Z).'),
      timeMax: z.string().min(1).describe('End of the window, RFC 3339.'),
      calendarId: z.string().default('primary').describe('Calendar id, or "primary".'),
      limit: z.number().int().min(1).max(250).default(50),
    },
    run: (call, input) =>
      calendarList(call, {
        calendarId: String(input.calendarId ?? 'primary'),
        timeMin: String(input.timeMin),
        timeMax: String(input.timeMax),
        limit: typeof input.limit === 'number' ? input.limit : 50,
      }),
  },
  {
    name: 'calendar_create_event',
    title: 'Create a calendar event',
    description:
      'Create an event. Give start and end as RFC 3339 timestamps for a timed event, or as bare dates (2026-08-10) for an all-day one; the end date is exclusive.',
    requires: ['calendar.write'],
    inputSchema: {
      summary: z.string().min(1).describe('The event title.'),
      start: z.string().min(1).describe('RFC 3339 timestamp, or YYYY-MM-DD for all day.'),
      end: z.string().min(1).describe('RFC 3339 timestamp, or YYYY-MM-DD (exclusive) for all day.'),
      description: z.string().optional(),
      location: z.string().optional(),
      attendees: z.array(z.string()).optional().describe('Email addresses to invite.'),
      timeZone: z.string().optional().describe('IANA zone, e.g. Europe/Paris.'),
      calendarId: z.string().default('primary'),
    },
    run: (call, input) =>
      calendarCreate(call, {
        calendarId: String(input.calendarId ?? 'primary'),
        summary: String(input.summary),
        start: String(input.start),
        end: String(input.end),
        ...(input.description ? { description: String(input.description) } : {}),
        ...(input.location ? { location: String(input.location) } : {}),
        ...(Array.isArray(input.attendees) ? { attendees: input.attendees.map(String) } : {}),
        ...(input.timeZone ? { timeZone: String(input.timeZone) } : {}),
      }),
  },
  {
    name: 'drive_search',
    title: 'Search Drive',
    description:
      "Search Drive with Google's query syntax, e.g. name contains 'devis' or mimeType = 'application/pdf'. Returns id, name, type and a link.",
    requires: ['drive.read'],
    inputSchema: {
      query: z
        .string()
        .min(1)
        .describe("Drive query syntax: name contains 'x', mimeType = 'application/pdf', trashed = false"),
      limit: z.number().int().min(1).max(100).default(20),
    },
    run: (call, input) =>
      driveSearch(call, {
        query: String(input.query),
        limit: typeof input.limit === 'number' ? input.limit : 20,
      }),
  },
  {
    name: 'drive_read',
    title: 'Read a Drive file',
    description:
      'Read a Drive file as text. Google Docs and Sheets are exported (to text and CSV); other files are downloaded as-is, so binary formats will not be readable.',
    requires: ['drive.read'],
    inputSchema: { id: z.string().min(1).describe('The file id, from drive_search.') },
    run: (call, input) => driveRead(call, { id: String(input.id) }),
  },
];

/** The tools a connection with these grants may expose. */
export function googleTools(grants: readonly GoogleGrant[]): GoogleTool[] {
  return ALL.filter((tool) => tool.requires.every((grant) => grants.includes(grant)));
}

export const ALL_GOOGLE_TOOLS = ALL;
