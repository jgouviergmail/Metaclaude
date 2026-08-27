# Automations

Automations are how Metaclaude works while you do not: a prompt, a workspace,
and a trigger.

## Triggers

- **Cron** — a standard five-field expression, for schedules.
- **Interval** — every N minutes, for polling-shaped work.
- **Manual** — a button, for runbooks you invoke on demand.
- **Event** — fire on another run's outcome: a failed run, a succeeded run,
  an idle session, a changed file.

Each automation carries its own policy — model, effort, permission mode, a
turn ceiling — independent of the workspace defaults. Leave the model unset
and the learner picks per firing, which makes automations exactly the
repeated workload the learner is best at.

## Continuous mode

The distinctive one. A **continuous** automation keeps a single session alive
across every firing, so context accumulates indefinitely: the Tuesday run
remembers what the Monday run learned. This is the loop primitive — a
standing agent with a heartbeat — and it pairs naturally with an event
trigger to build watchers that get better at what they watch.

## Guard rails

Autonomy without rails is an incident generator, so the rails are built in:

- **Consecutive-failure limit** — a runaway loop disables itself and says so.
- **No overlap** — a firing that arrives while the previous run is still
  going is skipped, not queued.
- **No catch-up burst** — downtime does not replay the missed schedule.

Every firing is an ordinary run: transcript, cost, permission prompts under
the automation's chosen mode, and a rating you can still give afterwards.

## Patterns that work

A nightly dependency-and-CI review per repository. A continuous watcher that
triages failures from your test suite. A weekly summary of what changed
across workspaces. Anything you would do every morning with the same three
prompts — that is an automation.

The board has its own standing loop besides these: the **autopilot** (see
the board chapter), which drains the To do column one card at a time and
respects the quota guard. Reach for an automation when the work is a
prompt on a schedule; reach for the autopilot when the work is already
written down as cards.
