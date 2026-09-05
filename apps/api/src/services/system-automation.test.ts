/**
 * The shipped automation: once, disabled, and never re-imposed.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { Automation } from '@metaclaude/shared';
import { kvGet, migrate, openDatabase, type Db } from '../db/index.js';
import {
  MORNING_REVIEW_PROMPT,
  SYSTEM_AUTOMATION_KEY,
  SYSTEM_AUTOMATION_NAME,
  seedSystemAutomation,
} from './system-automation.js';

let db: Db;
let created: unknown[];
let rows: Map<string, Automation>;
let updates: { id: string; patch: unknown }[];

const automations = {
  create: (input: { workspaceId: string; name: string; enabled?: boolean; policy?: Partial<Automation['policy']> }) => {
    created.push(input);
    const automation = {
      id: `auto_${created.length}`,
      runCount: 0,
      ...input,
      policy: { permissionMode: 'default', ...(input.policy ?? {}) },
    } as unknown as Automation;
    rows.set(automation.id, automation);
    return automation;
  },
  get: (id: string) => rows.get(id) ?? null,
  update: (id: string, patch: { policy?: Partial<Automation['policy']> }) => {
    updates.push({ id, patch });
    const current = rows.get(id);
    if (!current) return null;
    const next = { ...current, policy: { ...current.policy, ...(patch.policy ?? {}) } } as Automation;
    rows.set(id, next);
    return next;
  },
};

beforeEach(() => {
  db = openDatabase({ path: ':memory:' });
  migrate(db);
  created = [];
  rows = new Map();
  updates = [];
});

describe('seedSystemAutomation', () => {
  it('creates the morning review, disabled, and remembers it', () => {
    const automation = seedSystemAutomation({ db, workspaceId: 'ws_sys', automations });

    expect(automation?.id).toBe('auto_1');
    expect(created[0]).toMatchObject({
      workspaceId: 'ws_sys',
      name: SYSTEM_AUTOMATION_NAME,
      enabled: false,
      trigger: { type: 'cron', expression: '0 8 * * *' },
      prompt: MORNING_REVIEW_PROMPT,
    });
    expect(kvGet(db, SYSTEM_AUTOMATION_KEY, null)).toBe('auto_1');
  });

  /**
   * Remembered by key rather than looked up by name: an operator who deleted
   * it, or renamed it into something of their own, is not contradicted.
   */
  it('seeds once, whatever became of the row afterwards', () => {
    seedSystemAutomation({ db, workspaceId: 'ws_sys', automations });

    expect(seedSystemAutomation({ db, workspaceId: 'ws_sys', automations })).toBeNull();
    expect(created).toHaveLength(1);
  });

  /**
   * Nobody is there at eight: under `dontAsk` the review acts on the
   * steward's pre-approved tools and is refused the rest, instead of
   * leaving a card that expires unanswered. A review seeded by an earlier
   * release under `default` and never fired is brought to the same policy;
   * one that has run, or that the operator moved, is theirs.
   */
  it('seeds the review under dontAsk, and aligns an earlier never-fired seed once', () => {
    seedSystemAutomation({ db, workspaceId: 'ws_sys', automations });
    expect(created[0]).toMatchObject({ policy: { permissionMode: 'dontAsk' } });

    // An older deployment: seeded under the shipped default and never fired.
    rows.set('auto_1', { ...rows.get('auto_1')!, policy: { permissionMode: 'default' } } as Automation);
    seedSystemAutomation({ db, workspaceId: 'ws_sys', automations });
    expect(updates).toEqual([{ id: 'auto_1', patch: { policy: { permissionMode: 'dontAsk' } } }]);

    // Moved by the operator, or already fired: left alone.
    rows.set('auto_1', { ...rows.get('auto_1')!, policy: { permissionMode: 'default' }, runCount: 3 } as Automation);
    seedSystemAutomation({ db, workspaceId: 'ws_sys', automations });
    rows.set('auto_1', { ...rows.get('auto_1')!, policy: { permissionMode: 'acceptEdits' }, runCount: 0 } as Automation);
    seedSystemAutomation({ db, workspaceId: 'ws_sys', automations });
    expect(updates).toHaveLength(1);
  });

  it('asks the run to stop early when nothing happened, and never to act irreversibly', () => {
    expect(MORNING_REVIEW_PROMPT).toMatch(/If nothing happened/);
    expect(MORNING_REVIEW_PROMPT).toMatch(/irreversible, say precisely what you would do and stop/);
    expect(MORNING_REVIEW_PROMPT).toMatch(/system_overview/);
  });
});
