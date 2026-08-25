/**
 * Realtime protocol.
 *
 * A single multiplexed WebSocket carries every live signal: transcript deltas,
 * run lifecycle, approval prompts, automation ticks and system notices. The
 * client subscribes to topics; the server fans out only what a topic's
 * subscribers actually need.
 *
 * Both directions are discriminated unions validated with Zod at the boundary,
 * so a malformed or hostile frame is rejected before it reaches any handler.
 */

import { z } from 'zod';
import {
  ApprovalDecision,
  ApprovalRequest,
  Automation,
  Millis,
  Run,
  Session,
  TranscriptEvent,
} from './domain.js';

/* -------------------------------------------------------------------------- */
/* Topics                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Topic grammar:
 *   `session:<sessionId>`   — transcript + run lifecycle for one session
 *   `workspace:<wsId>`      — session list changes, automations, file watch
 *   `system`                — health, notifications, approvals across the OS
 */
export const Topic = z
  .string()
  .min(1)
  .max(120)
  .regex(/^(system|session:[A-Za-z0-9_]+|workspace:[A-Za-z0-9_]+)$/);
export type Topic = z.infer<typeof Topic>;

/* -------------------------------------------------------------------------- */
/* Client → Server                                                             */
/* -------------------------------------------------------------------------- */

export const ClientFrame = z.discriminatedUnion('type', [
  /** Sent first. Authentication itself rides on the session cookie. */
  z.object({ type: z.literal('hello'), csrfToken: z.string().min(1) }),
  z.object({ type: z.literal('subscribe'), topics: z.array(Topic).max(64) }),
  z.object({ type: z.literal('unsubscribe'), topics: z.array(Topic).max(64) }),
  z.object({ type: z.literal('ping'), t: Millis }),
  /** Respond to a pending tool-permission prompt. */
  z.object({ type: z.literal('approval'), decision: ApprovalDecision }),
  /** Ask the kernel to stop the run currently attached to a session. */
  z.object({ type: z.literal('interrupt'), sessionId: z.string() }),
]);
export type ClientFrame = z.infer<typeof ClientFrame>;

/* -------------------------------------------------------------------------- */
/* Server → Client                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Streaming text deltas are sent out-of-band from the persisted transcript so
 * the UI can paint tokens as they arrive without a database write per token.
 * The authoritative `transcript` frame follows when the block completes.
 */
export const ServerFrame = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('ready'),
    serverTime: Millis,
    version: z.string(),
    /** Frames the client may have missed are replayed after this cursor. */
    resumeToken: z.string(),
  }),
  z.object({ type: z.literal('pong'), t: Millis }),
  z.object({ type: z.literal('subscribed'), topics: z.array(Topic) }),
  z.object({ type: z.literal('error'), code: z.string(), message: z.string() }),

  z.object({ type: z.literal('transcript'), topic: Topic, event: TranscriptEvent }),
  z.object({
    type: z.literal('delta'),
    topic: Topic,
    runId: z.string(),
    eventId: z.string(),
    /** Which transcript block this delta extends. */
    channel: z.enum(['assistant_text', 'thinking']),
    text: z.string(),
  }),

  z.object({ type: z.literal('run'), topic: Topic, run: Run }),
  z.object({ type: z.literal('session'), topic: Topic, session: Session }),
  z.object({ type: z.literal('approval_request'), topic: Topic, request: ApprovalRequest }),
  z.object({
    type: z.literal('approval_resolved'),
    topic: Topic,
    approvalId: z.string(),
    approved: z.boolean(),
  }),
  z.object({ type: z.literal('automation'), topic: Topic, automation: Automation }),
  z.object({
    type: z.literal('notification'),
    topic: Topic,
    level: z.enum(['info', 'success', 'warning', 'error']),
    title: z.string(),
    message: z.string(),
    /** Optional deep link, e.g. `/w/ws_123/s/ses_456`. */
    href: z.string().nullable().default(null),
  }),
  z.object({
    type: z.literal('files_changed'),
    topic: Topic,
    paths: z.array(z.string()).max(200),
  }),
  z.object({
    type: z.literal('metrics'),
    topic: Topic,
    activeRuns: z.number().int(),
    queuedRuns: z.number().int(),
    costTodayUsd: z.number(),
  }),
]);
export type ServerFrame = z.infer<typeof ServerFrame>;

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

export function sessionTopic(sessionId: string): Topic {
  return `session:${sessionId}`;
}

export function workspaceTopic(workspaceId: string): Topic {
  return `workspace:${workspaceId}`;
}

export const SYSTEM_TOPIC: Topic = 'system';

/** WebSocket close codes we use beyond the RFC set. */
export const CLOSE_CODES = {
  /** Cookie missing, expired, or CSRF token mismatch. */
  UNAUTHORIZED: 4401,
  /** Client sent a frame that failed schema validation. */
  BAD_FRAME: 4400,
  /** Too many frames in the sampling window. */
  RATE_LIMITED: 4429,
  /** Server is shutting down; client should reconnect with backoff. */
  GOING_AWAY: 4503,
} as const;
