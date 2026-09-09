/**
 * Automations — the loop engine.
 *
 * An automation is a prompt plus a trigger. On each firing the scheduler submits
 * a run to the kernel exactly as a human would, which means automations get the
 * same permissions, the same memory retrieval and the same learning loop.
 *
 * Two modes:
 *  - one-shot: each firing starts a fresh session.
 *  - continuous: every firing continues the *same* session, so the agent keeps
 *    its accumulated context across firings. This is what turns a schedule into
 *    a genuinely long-running agent rather than a repeated cold start.
 *
 * Safety rails that matter for something that runs unattended:
 *  - Consecutive failures disable the automation instead of retrying forever.
 *  - A firing is skipped, not queued, when the previous one is still running.
 *  - A missed window (server was down) fires once, never once per missed slot.
 */

import type { Automation, AutomationTrigger, Run, RunStatus } from '@metaclaude/shared';
import {
  AutomationPolicy,
  declaredSources,
  EMITTED_AUTOMATION_EVENTS,
  newId,
  watchesAutomations,
  watchPath,
  workspaceTopic,
} from '@metaclaude/shared';
import type { Db } from '../db/index.js';
import { parseJson, toBool, toInt, tx } from '../db/index.js';
import type { EventBus } from '../kernel/bus.js';
import type { Kernel } from '../kernel/kernel.js';
import type { SessionRepo, WorkspaceRepo } from '../kernel/repositories.js';
import { isValidCron, nextFireTime, parseCron } from './cron.js';
import { routes } from '@metaclaude/shared';

export class SchedulerError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
    this.name = 'SchedulerError';
  }
}

interface AutomationRow {
  id: string;
  workspace_id: string;
  name: string;
  description: string;
  prompt: string;
  trigger: string;
  policy: string;
  continuous: number;
  session_id: string | null;
  family_id: string | null;
  max_consecutive_failures: number;
  consecutive_failures: number;
  enabled: number;
  last_run_at: number | null;
  last_status: string | null;
  next_run_at: number | null;
  run_count: number;
  created_at: number;
  updated_at: number;
}

/**
 * Every field at its declared default, read from the schema rather than typed
 * out again. The literal that stood here was the third copy of this shape;
 * the second — in `routes/registry.ts` — is what silently dropped `notify`
 * for a release, and a copy that only *looks* right is how that happens.
 */
const DEFAULT_POLICY: Automation['policy'] = AutomationPolicy.parse({});

/**
 * The stored policy, with every declared field present.
 *
 * A cast is not a parse: the column holds whatever was written the day it was
 * written, and the rows created before `notify` existed simply do not carry
 * the key — so `policy.notify` was `undefined` on them, which is falsy and
 * therefore *worked*, while the object the API returned did not match the
 * type it claims. Parsing fills each missing field with its declared default.
 * A policy the schema refuses keeps its values over the defaults rather than
 * being reset: it is already unusable, and losing what an operator chose
 * would be a second failure on top of the first.
 */
function readPolicy(raw: string): Automation['policy'] {
  const stored = parseJson<Record<string, unknown>>(raw, {});
  const parsed = AutomationPolicy.safeParse(stored);
  return parsed.success ? parsed.data : { ...DEFAULT_POLICY, ...stored };
}

function toAutomation(row: AutomationRow): Automation {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    description: row.description,
    prompt: row.prompt,
    trigger: parseJson<AutomationTrigger>(row.trigger, { type: 'manual' }),
    policy: readPolicy(row.policy),
    continuous: toBool(row.continuous),
    sessionId: row.session_id,
    familyId: row.family_id,
    maxConsecutiveFailures: row.max_consecutive_failures,
    consecutiveFailures: row.consecutive_failures,
    enabled: toBool(row.enabled),
    lastRunAt: row.last_run_at,
    lastStatus: row.last_status as RunStatus | null,
    nextRunAt: row.next_run_at,
    runCount: row.run_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface SchedulerDeps {
  db: Db;
  bus: EventBus;
  kernel: Kernel;
  sessions: SessionRepo;
  workspaces: WorkspaceRepo;
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
}

/** How often the scheduler wakes to look for due automations. */
const TICK_INTERVAL_MS = 30_000;

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(private readonly deps: SchedulerDeps) {}

  /* ---------------------------------------------------------------------- */
  /* CRUD                                                                    */
  /* ---------------------------------------------------------------------- */

  list(workspaceId?: string): Automation[] {
    const rows = workspaceId
      ? this.deps.db
          .prepare<[string], AutomationRow>(
            'SELECT * FROM automations WHERE workspace_id = ? ORDER BY created_at DESC',
          )
          .all(workspaceId)
      : this.deps.db
          .prepare<[], AutomationRow>('SELECT * FROM automations ORDER BY created_at DESC')
          .all();
    return rows.map(toAutomation);
  }

  get(id: string): Automation | null {
    const row = this.deps.db
      .prepare<[string], AutomationRow>('SELECT * FROM automations WHERE id = ?')
      .get(id);
    return row ? toAutomation(row) : null;
  }

  create(input: {
    workspaceId: string;
    name: string;
    description?: string;
    prompt: string;
    trigger: AutomationTrigger;
    policy?: Partial<Automation['policy']>;
    continuous?: boolean;
    maxConsecutiveFailures?: number;
    enabled?: boolean;
  }): Automation {
    if (!this.deps.workspaces.get(input.workspaceId)) {
      throw new SchedulerError('Unknown workspace.', 404);
    }
    // After the workspace check, not before: a trigger naming automations is
    // validated *against* that workspace, so an unknown one has to be the
    // error the caller hears rather than "no automation named …".
    this.validateTrigger(input.trigger, { workspaceId: input.workspaceId });

    const id = newId('automation');
    const now = Date.now();
    const enabled = input.enabled ?? true;

    this.deps.db
      .prepare(
        `INSERT INTO automations
           (id, workspace_id, name, description, prompt, trigger, policy, continuous,
            max_consecutive_failures, enabled, next_run_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.workspaceId,
        input.name,
        input.description ?? '',
        input.prompt,
        JSON.stringify(input.trigger),
        JSON.stringify({ ...DEFAULT_POLICY, ...(input.policy ?? {}) }),
        toInt(input.continuous ?? false),
        input.maxConsecutiveFailures ?? 3,
        toInt(enabled),
        enabled ? this.computeNextRun(input.trigger, now) : null,
        now,
        now,
      );

    const automation = this.get(id) as Automation;
    this.publish(automation);
    return automation;
  }

  /**
   * Switch many automations on or off in one transaction.
   *
   * Deliberately *not* one `UPDATE … WHERE id IN (…)`, which is how the skills
   * and subagents do it and would be the obvious thing here. Enabling an
   * automation is three coupled writes: `enabled` is the visible half,
   * `next_run_at` is what the sweep actually selects on — `enabled = 1 AND
   * next_run_at IS NOT NULL` — and re-enabling clears `consecutive_failures`,
   * or an automation the failure ceiling switched off switches itself off
   * again on its very next failure.
   *
   * A second statement doing two of the three would leave automations
   * *enabled and never firing*, which is the worst answer a button called
   * "enable all" can give: the screen agrees with the operator and nothing
   * happens. So the bulk verb is the single verb, once per row. The cost is N
   * statements where the registry pays one, and it is the right trade here for
   * the reason the registry's own note gives in reverse: a skill's row carries
   * up to 200 000 characters and an automation's carries a cron expression.
   *
   * The scope is checked per row rather than in the SQL: the ids are what the
   * operator was shown, and a screen filtered to one workspace must not be
   * able to switch off another's by naming its ids.
   */
  setEnabled(ids: readonly string[], enabled: boolean, workspaceId?: string): number {
    if (ids.length === 0) return 0;

    return tx(this.deps.db, () => {
      let changed = 0;
      for (const id of ids) {
        const current = this.get(id);
        if (!current) continue;
        if (workspaceId !== undefined && current.workspaceId !== workspaceId) continue;
        // Counted on the value, not on the statement: "3 changed" has to mean
        // three were switched, or the toast overstates what the press did.
        if (current.enabled === enabled) continue;
        if (this.update(id, { enabled })) changed += 1;
      }
      return changed;
    });
  }

  /**
   * Apply a partial update.
   *
   * `policy` is called out separately because it is patched *into* the stored
   * one rather than replacing it — `{ ...current.policy, ...patch.policy }`
   * below — so the caller may legitimately send some of its five fields. The
   * plain `Partial<Omit<Automation, …>>` this used to declare required all
   * five, which is why the route reached it through `as never`: a cast that
   * silenced the mismatch and, with it, any future one. Saying what the method
   * actually accepts lets the cast go.
   */
  update(
    id: string,
    patch: Partial<Omit<Automation, 'id' | 'policy'>> & {
      policy?: Partial<Automation['policy']>;
    },
  ): Automation | null {
    const current = this.get(id);
    if (!current) return null;

    /*
     * Moving an automation to another workspace.
     *
     * It used to be refused outright — the type omitted `workspaceId` and the
     * route omitted it from the patch schema — and the reason was sound rather
     * than lazy: an automation is bound to its workspace in three ways, and a
     * move that ignores any of them leaves it running somewhere it does not
     * belong. What was missing is that the reason is fixable, and the need is
     * ordinary: an automation written for one project turns out to suit
     * another, or a workspace is created after it.
     *
     * The binding that actually breaks is the *continuous session*. A
     * continuous automation keeps writing into one session so context
     * accumulates, and that session lives in the old workspace — carrying it
     * across would have the automation writing into a project it no longer
     * belongs to, with that project's files and permissions. So a move ends the
     * thread: the next firing opens a fresh session in the new workspace. That
     * is a real consequence and the editor says so before the save.
     */
    const movedTo =
      patch.workspaceId !== undefined && patch.workspaceId !== current.workspaceId
        ? patch.workspaceId
        : null;
    if (movedTo !== null && !this.deps.workspaces.get(movedTo)) {
      throw new SchedulerError('Unknown workspace.', 404);
    }

    const trigger = patch.trigger ?? current.trigger;
    const enabled = patch.enabled ?? current.enabled;

    /*
     * The trigger is validated against the workspace it will *land* in, and it
     * is validated whenever either half moves.
     *
     * `if (patch.trigger)` was enough while a trigger meant only a cron
     * expression, which means the same thing everywhere. A trigger that names
     * automations does not: they are looked up in one workspace, and a move
     * that leaves the trigger untouched would carry names `onRunFinished` —
     * which lists watchers by workspace — can never resolve again. The watcher
     * would sit there enabled and permanently mute, which is the failure this
     * whole feature exists to stop being invisible.
     */
    if (patch.trigger !== undefined || movedTo !== null) {
      this.validateTrigger(trigger, {
        workspaceId: movedTo ?? current.workspaceId,
        selfId: id,
      });
    }

    const write = (): void => {
      this.deps.db
        .prepare(
          `UPDATE automations SET
           workspace_id = ?, session_id = ?,
           name = ?, description = ?, prompt = ?, trigger = ?, policy = ?, continuous = ?,
           max_consecutive_failures = ?, enabled = ?, next_run_at = ?,
           consecutive_failures = ?, updated_at = ?
         WHERE id = ?`,
        )
        .run(
          movedTo ?? current.workspaceId,
          // The continuous thread does not travel. Kept when it stays put.
          movedTo !== null ? null : current.sessionId,
          patch.name ?? current.name,
          patch.description ?? current.description,
          patch.prompt ?? current.prompt,
          JSON.stringify(trigger),
          JSON.stringify({ ...current.policy, ...(patch.policy ?? {}) }),
          toInt(patch.continuous ?? current.continuous),
          patch.maxConsecutiveFailures ?? current.maxConsecutiveFailures,
          toInt(enabled),
          enabled ? this.computeNextRun(trigger, Date.now()) : null,
          // Re-enabling clears the failure counter: the operator has presumably
          // fixed whatever was wrong.
          enabled && !current.enabled
            ? 0
            : (patch.consecutiveFailures ?? current.consecutiveFailures),
          Date.now(),
          id,
        );

      /*
       * A move takes this automation out of reach of everything that watched
       * it, so the same write that moves it drops it from their triggers.
       *
       * In the transaction rather than after it: a list of ids in JSON is a
       * foreign key nothing enforces, and the way those go wrong is that the
       * prune is a *second* operation which does not always happen. The
       * watchers left behind become sourceless — visibly, on the list — which
       * is the honest answer; silently reverting them to watching people's
       * runs would repurpose an automation written for a chain.
       */
      if (movedTo !== null) this.forgetSource(id);
    };
    if (movedTo !== null) tx(this.deps.db, write);
    else write();

    const updated = this.get(id) as Automation;
    this.publish(updated);
    return updated;
  }

  /**
   * Copy an automation into another workspace, and remember that they are the
   * same automation.
   *
   * Server-side rather than a client composing a `create`, for one reason: the
   * family has to land on *both* rows or on neither. A source that was never
   * duplicated has no family yet, so one is minted and written back to it —
   * which is a write to a row the operator did not edit, and exactly why this
   * is one transaction rather than two requests.
   *
   * Nothing but the definition travels. The session, the history, the failure
   * counter and the schedule belong to the original's life in its own
   * workspace, and the copy starts its own. It lands paused because an
   * automation fires unattended, and one arriving already armed in a workspace
   * it was not written for is the surprise the guard rails exist to prevent.
   */
  duplicate(id: string, workspaceId: string): Automation {
    const source = this.get(id);
    if (!source) throw new SchedulerError('Automation not found.', 404);
    if (!this.deps.workspaces.get(workspaceId)) {
      throw new SchedulerError('Unknown workspace.', 404);
    }
    if (source.workspaceId === workspaceId) {
      throw new SchedulerError('That automation already lives in this workspace.', 409);
    }
    /*
     * A copy is always in another workspace, and an event trigger's sources
     * are always in its own — so the copy could only ever name automations it
     * cannot reach. `create` would refuse it anyway, with a message about an
     * unknown automation that describes the symptom rather than the reason.
     * Said here, where the operator is choosing the destination.
     */
    if (watchesAutomations(source.trigger)) {
      throw new SchedulerError(
        `"${source.name}" watches automations of its own workspace, and a copy would land in another where those do not exist. Create it there and choose its sources from that workspace.`,
        409,
      );
    }

    return tx(this.deps.db, () => {
      const familyId = source.familyId ?? newId('automationFamily');
      if (!source.familyId) {
        this.deps.db.prepare('UPDATE automations SET family_id = ? WHERE id = ?').run(familyId, id);
      }
      const copy = this.create({
        workspaceId,
        name: source.name,
        description: source.description,
        prompt: source.prompt,
        trigger: source.trigger,
        policy: source.policy,
        continuous: source.continuous,
        maxConsecutiveFailures: source.maxConsecutiveFailures,
        enabled: false,
      });
      this.deps.db.prepare('UPDATE automations SET family_id = ? WHERE id = ?').run(familyId, copy.id);
      const stored = this.get(copy.id) as Automation;
      this.publish(stored);
      return stored;
    });
  }

  /** The other copies of this automation — itself excluded, empty when it has no family. */
  family(id: string): Automation[] {
    const automation = this.get(id);
    if (!automation?.familyId) return [];
    return this.deps.db
      .prepare<[string, string], AutomationRow>(
        'SELECT * FROM automations WHERE family_id = ? AND id != ? ORDER BY name',
      )
      .all(automation.familyId, id)
      .map(toAutomation);
  }

  /**
   * Take one copy out of its family.
   *
   * Needed, and not a nicety: a copy whose prompt deliberately names its own
   * project would otherwise be asked to accept every edit made to its siblings,
   * for ever. Refusing once per save is a chore; saying so once is an answer.
   *
   * The last remaining member keeps its family id, harmlessly — `family()`
   * returns nothing for a group of one, and a later duplication reuses it.
   */
  detach(id: string): boolean {
    return (
      this.deps.db.prepare('UPDATE automations SET family_id = NULL WHERE id = ?').run(id).changes >
      0
    );
  }

  delete(id: string): boolean {
    // One transaction, because the row and every reference to it go together.
    // See `forgetSource`: what makes a JSON list of ids survivable is that
    // removing the referent removes the references, on every path that can
    // remove it. This route and a move are the only two.
    return tx(this.deps.db, () => {
      this.forgetSource(id);
      return this.deps.db.prepare('DELETE FROM automations WHERE id = ?').run(id).changes > 0;
    });
  }

  /**
   * Drop `id` from the sources of every automation that watches it.
   *
   * Called where the automation stops being reachable — deleted, or moved to
   * another workspace. A watcher left with no source at all keeps an empty
   * list rather than losing the field: `automations: []` is a state the list
   * and the editor both name ("no source"), where an absent field would mean
   * "watches the runs people start" and quietly turn a chain link into
   * something else entirely.
   */
  private forgetSource(id: string): void {
    for (const automation of this.list()) {
      const trigger = automation.trigger;
      // The narrowing is what the spread below needs; the membership question
      // goes through the shared reader, like every other site.
      if (trigger.type !== 'event' || !declaredSources(trigger).includes(id)) continue;
      const next: AutomationTrigger = {
        ...trigger,
        automations: declaredSources(trigger).filter((source) => source !== id),
      };
      this.deps.db
        .prepare('UPDATE automations SET trigger = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(next), Date.now(), automation.id);
      this.publish(this.get(automation.id) as Automation);
    }
  }

  /**
   * The automation whose *current* session this is, if any.
   *
   * The one definition of "this run belongs to that automation", shared by
   * `recordOutcome` and `onRunFinished` — they used to answer differently, one
   * by session and one by `triggeredBy`, so pressing "Run now" updated an
   * automation's status while counting, for the watchers, as a run a person
   * started. A session belongs to at most one automation: `create` and
   * `duplicate` start at null, `fire` claims one, and a move releases it —
   * which is also what keeps an automation's current session inside its own
   * workspace, so a run found this way is always a run of `run.workspaceId`.
   *
   * *Current* is the limit worth stating. A one-shot automation mints a fresh
   * session per firing, so if two firings overlap — possible, since the
   * in-flight guard checks the previous session and that one is new — the
   * older run finishes in a session the row no longer names, and is claimed by
   * nobody. It is then ignored rather than misattributed: a link of a chain is
   * missed, never a wrong one fired. `recordOutcome` has always lost that run
   * the same way, and the fix for both would be a column on `runs`, which is
   * not worth a migration for a race nothing has been seen to hit.
   */
  automationBySession(sessionId: string): Automation | null {
    const row = this.deps.db
      .prepare<[string], AutomationRow>('SELECT * FROM automations WHERE session_id = ?')
      .get(sessionId);
    return row ? toAutomation(row) : null;
  }

  private validateTrigger(
    trigger: AutomationTrigger,
    scope: { workspaceId: string; selfId?: string },
  ): void {
    if (trigger.type === 'cron' && !isValidCron(trigger.expression)) {
      throw new SchedulerError(`"${trigger.expression}" is not a valid cron expression.`);
    }
    if (trigger.type === 'interval' && trigger.everyMs < 60_000) {
      throw new SchedulerError('The shortest interval is one minute.');
    }
    if (trigger.type !== 'event') return;

    // The schema has named four events since the first release and only two
    // have an emitter. An automation on the other two showed as enabled and
    // stayed silent forever — indistinguishable from a deployment where
    // nothing happened, which the steward pointed out. Refused here, where
    // the person creating it is still listening.
    if (!(EMITTED_AUTOMATION_EVENTS as readonly string[]).includes(trigger.event)) {
      throw new SchedulerError(
        `Nothing emits "${trigger.event}" yet; an event trigger can watch ${EMITTED_AUTOMATION_EVENTS.join(' or ')}.`,
      );
    }

    if (!watchesAutomations(trigger)) return;
    const sources = declaredSources(trigger);

    if (sources.length === 0) {
      throw new SchedulerError(
        'Name at least one automation to watch, or remove the list to watch the runs people start.',
      );
    }
    /*
     * The two modes are exclusive, and this is where that is enforced rather
     * than in the schema, because the reason is behavioural. A firing's prompt
     * is the automation's own prompt, so a filter over it is very nearly a
     * constant: kept alongside sources it would either match always or never,
     * and the "never" is a watcher that looks configured and is dead. A field
     * that cannot help but can silently kill is refused, not ignored.
     */
    if (trigger.filter !== undefined) {
      throw new SchedulerError(
        'An event trigger either watches automations or filters the runs people start — not both.',
      );
    }
    if (new Set(sources).size !== sources.length) {
      throw new SchedulerError('The same automation is named twice.');
    }
    if (scope.selfId && sources.includes(scope.selfId)) {
      throw new SchedulerError('An automation cannot watch itself.');
    }

    const here = new Map(this.list(scope.workspaceId).map((entry) => [entry.id, entry]));
    for (const sourceId of sources) {
      if (!here.has(sourceId)) {
        // Deliberately one message for "does not exist" and for "lives
        // somewhere else": both mean the same thing to the caller — this
        // workspace has no such automation — and the second must not become a
        // way to probe another workspace's ids.
        //
        // 400 rather than 404: the automation named in the URL is there, and
        // it is the body that names something that is not. A 404 here would
        // have the client report the row it is editing as gone.
        throw new SchedulerError(`This workspace has no automation "${sourceId}".`, 400);
      }
    }

    /*
     * The loop guard, and the reason the old blanket refusal could be lifted.
     *
     * Every edge is declared, so a cycle is a property of the graph rather
     * than something to detect at firing time: follow each proposed source's
     * own sources and refuse if the automation being edited is reachable.
     * `enabled` is deliberately not consulted — a paused link is still an
     * edge, and re-enabling it goes through `setEnabled`, which revalidates
     * nothing. Structurally acyclic beats conditionally acyclic.
     *
     * Nothing to check at creation: an automation that does not exist yet
     * cannot be reached from anywhere, which is why `selfId` is optional.
     */
    if (!scope.selfId) return;
    const graph = new Map(
      [...here.values()].map((entry) => [entry.id, declaredSources(entry.trigger)]),
    );
    // `watchPath` is shared with the editor, which uses the same walk to
    // decide what to *offer*: two implementations would drift, and the one
    // that drifts offers a tick whose only outcome is this refusal.
    const path = watchPath((id) => graph.get(id) ?? [], sources, scope.selfId);
    if (path) {
      // Named rather than merely refused: "Deploy → Report → Deploy" is
      // actionable where "that would loop" is not.
      const named = path.map((id) => here.get(id)?.name ?? id).join(' → ');
      throw new SchedulerError(
        `That would loop: ${named} already leads back to this automation.`,
        409,
      );
    }
  }

  private computeNextRun(trigger: AutomationTrigger, from: number): number | null {
    switch (trigger.type) {
      case 'cron':
        try {
          return nextFireTime(parseCron(trigger.expression), from);
        } catch {
          return null;
        }
      case 'interval':
        return from + trigger.everyMs;
      default:
        // `manual` and `event` triggers are never time-scheduled.
        return null;
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Execution                                                               */
  /* ---------------------------------------------------------------------- */

  /**
   * Fire an automation now, regardless of its schedule.
   *
   * "Run now" works on every kind, event triggers included, and that is a
   * decision rather than an oversight. The button does one thing everywhere —
   * run this prompt at once — and disabling it on watchers would make the
   * control mean different things on neighbouring rows while leaving the case
   * it was meant to protect (a watcher of people's runs) untouched. It earns
   * its place: testing a prompt without waiting for the event, and re-running
   * the downstream half of a chain without redoing the upstream half.
   *
   * What was missing is not a guard, it is the truth. A watcher's prompt
   * generally opens by referring to "the run that just failed", and by hand
   * there is none — so a hand-fired watcher is told so, in the same slot the
   * event context would have used. Silence there had the model invent a
   * subject.
   */
  async fire(
    id: string,
    triggeredBy: 'automation' | 'loop' | 'user' = 'automation',
    options: {
      /** Prepended to the prompt: what an event-triggered firing is reacting to. */
      context?: string;
    } = {},
  ): Promise<string> {
    const automation = this.get(id);
    if (!automation) throw new SchedulerError('Unknown automation.', 404);

    const workspace = this.deps.workspaces.get(automation.workspaceId);
    if (!workspace) throw new SchedulerError('The automation’s workspace no longer exists.', 404);

    // Skipping rather than queueing: a slow automation firing every minute
    // would otherwise build an unbounded backlog.
    //
    // The check is against the session the *last* firing used, and it happens
    // before a new one is created. Checking the resolved session was a no-op
    // for a one-shot automation: that path mints a fresh session per firing, so
    // the thing being asked "are you busy?" had by construction never run
    // anything — and the backlog this guard exists to prevent built up anyway,
    // one abandoned session at a time.
    if (automation.sessionId && this.deps.kernel.hasActiveRunForSession(automation.sessionId)) {
      throw new SchedulerError('The previous run of this automation is still in flight.', 409);
    }

    const sessionId = this.resolveSession(automation, workspace.id);

    const context =
      options.context ??
      (automation.trigger.type === 'event'
        ? 'Run by hand, not by the event this automation watches — there is no triggering run to look at.'
        : null);

    const run = await this.deps.kernel.submit({
      sessionId,
      prompt: context ? `${context}\n\n${automation.prompt}` : automation.prompt,
      triggeredBy: automation.continuous ? 'loop' : triggeredBy,
      // Only what the operator actually pinned.
      //
      // Sending the whole policy sent `model: 'default'` too, and `'default'`
      // is a *value*: the kernel reads any defined `overrides.model` as an
      // explicit choice and stops consulting the learner. Automations are the
      // runs that repeat most, so that quietly excluded exactly the workload
      // where learning pays off, forever. `permissionMode` is passed as-is
      // because `'default'` there names a real mode rather than "unset".
      overrides: {
        ...(automation.policy.model !== 'default' ? { model: automation.policy.model } : {}),
        ...(automation.policy.effort !== null ? { effort: automation.policy.effort } : {}),
        permissionMode: automation.policy.permissionMode,
        ...(automation.policy.agentName !== null
          ? { agentName: automation.policy.agentName }
          : {}),
      },
    });

    this.deps.db
      .prepare(
        `UPDATE automations SET
           last_run_at = ?, run_count = run_count + 1, session_id = ?, next_run_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        Date.now(),
        sessionId,
        automation.enabled ? this.computeNextRun(automation.trigger, Date.now()) : null,
        Date.now(),
        id,
      );

    this.publish(this.get(id) as Automation);
    return run.id;
  }

  /**
   * Pick the session an automation should run in.
   * Continuous automations reuse one session so context accumulates; one-shot
   * automations get a fresh session per firing.
   */
  private resolveSession(automation: Automation, workspaceId: string): string {
    if (automation.continuous && automation.sessionId) {
      const existing = this.deps.sessions.get(automation.sessionId);
      if (existing && !existing.archived) return existing.id;
    }

    const session = this.deps.sessions.create({
      workspaceId,
      title: automation.continuous ? `↻ ${automation.name}` : `⏱ ${automation.name}`,
      model: String(automation.policy.model),
      effort: automation.policy.effort,
      permissionMode: automation.policy.permissionMode,
      agentName: automation.policy.agentName,
    });
    return session.id;
  }

  /**
   * Record how a run belonging to an automation ended.
   * Wired to the event bus in `context.ts`; a session with no automation is a
   * no-op, so this is safe to call for every finished run.
   *
   * `attended` distinguishes a human pressing "Run now" from an unattended
   * firing. Both update `lastStatus` — the UI shows it either way — but only an
   * unattended failure counts toward the auto-disable guard. Someone actively
   * debugging an automation should not have it switched off underneath them.
   */
  /**
   * The emitter behind `event` triggers. Called by the kernel for every
   * finished run; fires the enabled event automations of that run's workspace
   * whose event matches its outcome.
   *
   * Two populations of runs, and a watcher belongs to exactly one of them.
   *
   * A run made *inside an automation's current session* is that automation
   * finishing, whoever started it — the schedule, "Run now", or a message
   * typed into its session. That is already how `recordOutcome` reads the same
   * run, and one definition of "whose run is this" is the point:
   * `automationBySession`. Such a run is heard only by the watchers that named
   * that automation. Every other finished run — a person's, a token's, a
   * delegation's — is heard only by the watchers that named *nothing*, filter
   * applied, which is the behaviour every event automation had before sources
   * existed.
   *
   * What used to be here was a blanket refusal of anything an automation
   * produced, because two watchers of failures whose firings can fail feed
   * each other forever. The refusal is now the acyclicity of the declared
   * graph, checked in `validateTrigger` where the operator is still listening:
   * a loop cannot be built, so it need not be forbidden here. What survives
   * from that guard is the pair of cases it also covered by accident and which
   * nothing else covers: a run belonging to no automation but produced by one
   * anyway (its automation was deleted or moved mid-flight) and the advisor's
   * own `system` analyses, neither of which anybody can have named.
   *
   * A watcher whose previous firing is still in flight is skipped with a log
   * line, as a due schedule would be.
   */
  async onRunFinished(run: Pick<Run, 'id' | 'workspaceId' | 'sessionId' | 'status' | 'triggeredBy' | 'category' | 'prompt' | 'error'>): Promise<number> {
    const event = run.status === 'failed' ? 'run_failed' : run.status === 'succeeded' ? 'run_succeeded' : null;
    if (!event) return 0;

    const source = this.automationBySession(run.sessionId);
    if (
      !source &&
      (run.triggeredBy === 'automation' || run.triggeredBy === 'loop' || run.triggeredBy === 'system')
    ) {
      return 0;
    }

    const watchers = this.list(run.workspaceId).filter((automation) => {
      if (!automation.enabled || automation.trigger.type !== 'event') return false;
      if (automation.trigger.event !== event) return false;
      /*
       * Its own session, in either mode — and redundant in both, which is why
       * it is worth a line rather than a shrug. A watcher whose session this
       * is *is* `source`, so the sourced arm asks whether it names itself
       * (refused at write) and the sourceless arm requires no source at all.
       * It stands as the last guard against a self-reference that reached the
       * row some other way, where the cost of being wrong is an endless loop
       * and the cost of the check is one comparison.
       */
      if (automation.sessionId === run.sessionId) return false;
      if (watchesAutomations(automation.trigger)) {
        return source !== null && declaredSources(automation.trigger).includes(source.id);
      }
      return source === null && matchesFilter(automation.trigger.filter, run);
    });

    let fired = 0;
    for (const watcher of watchers) {
      const context = source
        ? `Triggered by the automation "${source.name}" (run ${run.id}), which ${run.status}` +
          (run.error ? ` — ${run.error.slice(0, 300)}` : '') +
          '.'
        : `Triggered by run ${run.id} in this workspace, which ${run.status}` +
          (run.error ? ` — ${run.error.slice(0, 300)}` : '') +
          `. Its prompt began: "${run.prompt.slice(0, 200).replace(/\s+/g, ' ')}".`;
      try {
        await this.fire(watcher.id, 'automation', { context });
        fired += 1;
      } catch (error) {
        this.deps.log('warn', 'event automation skipped', {
          id: watcher.id,
          name: watcher.name,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return fired;
  }

  /**
   * The name of the automation whose session this is, when it asked to be
   * notified of its firings; null otherwise. What lets the push handler
   * make one exception to "only runs a human started".
   */
  notifying(sessionId: string): string | null {
    const automation = this.automationBySession(sessionId);
    if (!automation) return null;
    return automation.policy.notify ? automation.name : null;
  }

  recordOutcome(sessionId: string, status: RunStatus, attended = false): void {
    const automation = this.automationBySession(sessionId);
    if (!automation) return;

    /*
     * Three outcomes, three answers — and the middle one is the correction.
     *
     * `succeeded` ends a streak. `failed` extends it. Anything else — a firing
     * stopped at a ceiling, cancelled, or cut off by a restart — leaves it
     * exactly where it was, because a firing that never got to finish is not
     * evidence either way.
     *
     * It used to reset the streak, which made a stopped firing read as a
     * healthy one: an automation cut short at every firing showed
     * `consecutiveFailures: 0` for ever, was never disabled, and appeared in
     * neither the doctor nor the brief — both of which only look at
     * automations the guard has already switched off. It could also launder a
     * real streak back to nothing by being interrupted once.
     */
    const failed = status === 'failed';
    const succeeded = status === 'succeeded';
    const consecutive = attended
      ? automation.consecutiveFailures
      : failed
        ? automation.consecutiveFailures + 1
        : succeeded
          ? 0
          : automation.consecutiveFailures;
    const shouldDisable =
      !attended &&
      failed &&
      automation.maxConsecutiveFailures > 0 &&
      consecutive >= automation.maxConsecutiveFailures;

    this.deps.db
      .prepare(
        `UPDATE automations SET last_status = ?, consecutive_failures = ?, enabled = ?, next_run_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        status,
        consecutive,
        shouldDisable ? 0 : toInt(automation.enabled),
        shouldDisable ? null : automation.nextRunAt,
        Date.now(),
        automation.id,
      );

    if (shouldDisable) {
      this.deps.log('warn', `automation "${automation.name}" disabled after ${consecutive} failures`);
      this.deps.bus.publish('system', {
        type: 'notification',
        topic: 'system',
        level: 'error',
        title: 'Automation disabled',
        message: `"${automation.name}" failed ${consecutive} times in a row and was switched off.`,
        href: routes.automations(),
      });
    }
    this.publish(this.get(automation.id) as Automation);
  }

  /* ---------------------------------------------------------------------- */
  /* Ticking                                                                 */
  /* ---------------------------------------------------------------------- */

  start(): void {
    if (this.timer) return;
    // On boot, re-derive every next_run_at: expressions may have changed and
    // stale values from before a long downtime would fire a burst.
    this.rescheduleAll();

    this.timer = setInterval(() => void this.tick(), TICK_INTERVAL_MS);
    this.timer.unref?.();
    this.deps.log('info', 'scheduler started');
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Fire everything that is due. Exposed for tests. */
  async tick(now: number = Date.now()): Promise<number> {
    // Overlapping ticks would double-fire; a slow kernel submit is enough to
    // make that reachable at a 30s interval.
    if (this.ticking) return 0;
    this.ticking = true;

    try {
      const due = this.deps.db
        .prepare<[number], AutomationRow>(
          'SELECT * FROM automations WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?',
        )
        .all(now);

      let fired = 0;
      for (const row of due) {
        try {
          await this.fire(row.id);
          fired += 1;
        } catch (error) {
          // A conflict (previous run still going) is expected and benign; log
          // anything else, but never let one automation stop the others.
          const status = (error as SchedulerError).statusCode;
          if (status !== 409) {
            this.deps.log('warn', `automation "${row.name}" failed to fire`, {
              message: (error as Error).message,
            });
          }
          // Always move the schedule forward, otherwise a permanently failing
          // automation is retried on every single tick.
          this.deps.db
            .prepare('UPDATE automations SET next_run_at = ? WHERE id = ?')
            .run(this.computeNextRun(toAutomation(row).trigger, now), row.id);
        }
      }
      return fired;
    } finally {
      this.ticking = false;
    }
  }

  /** Recompute `next_run_at` for every enabled automation from now. */
  rescheduleAll(now: number = Date.now()): void {
    const rows = this.deps.db
      .prepare<[], AutomationRow>('SELECT * FROM automations WHERE enabled = 1')
      .all();
    const update = this.deps.db.prepare('UPDATE automations SET next_run_at = ? WHERE id = ?');

    for (const row of rows) {
      update.run(this.computeNextRun(toAutomation(row).trigger, now), row.id);
    }
  }

  private publish(automation: Automation): void {
    const topic = workspaceTopic(automation.workspaceId);
    this.deps.bus.publish(topic, { type: 'automation', topic, automation });
  }
}

/** An event trigger's `filter`: a word that must appear in the run's category or prompt. */
function matchesFilter(filter: string | undefined, run: Pick<Run, 'category' | 'prompt'>): boolean {
  const needle = filter?.trim().toLowerCase();
  if (!needle) return true;
  return (
    (run.category ?? '').toLowerCase().includes(needle) || run.prompt.toLowerCase().includes(needle)
  );
}
