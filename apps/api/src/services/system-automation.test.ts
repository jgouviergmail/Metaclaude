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

const automations = {
  create: (input: { workspaceId: string; name: string; enabled?: boolean }) => {
    created.push(input);
    return { id: `auto_${created.length}`, ...input } as unknown as Automation;
  },
};

beforeEach(() => {
  db = openDatabase({ path: ':memory:' });
  migrate(db);
  created = [];
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

  it('asks the run to stop early when nothing happened, and never to act irreversibly', () => {
    expect(MORNING_REVIEW_PROMPT).toMatch(/If nothing happened/);
    expect(MORNING_REVIEW_PROMPT).toMatch(/irreversible, say precisely what you would do and stop/);
    expect(MORNING_REVIEW_PROMPT).toMatch(/system_overview/);
  });
});
