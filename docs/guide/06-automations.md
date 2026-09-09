# Automations

Automations are how Metaclaude works while you do not: a prompt, a workspace,
and a trigger.

## Triggers

- **Cron** — a standard five-field expression, for schedules. It is read in
  the **server's timezone**, which the form names beside the field and
  **System → Server** shows. On a host left at UTC, `0 8 * * *` is ten
  o'clock in Paris all summer. Set `TZ` in the server's `.env` (an IANA name such as
  `Europe/Paris`) and every schedule follows that clock, daylight saving
  included.
- **Interval** — every N minutes, for polling-shaped work.
- **Manual** — a button, for runbooks you invoke on demand.
- **Event** — fire on another run's outcome in the same workspace: **a
  failed run** or **a succeeded run**. Two further events, an idle session and
  a changed file, have been named in the schema since the first release and
  nothing emits them; the server refuses them at creation rather than accept a
  trigger that never fires.

  An event trigger watches **one of two populations**, and the form makes you
  choose:

  - **Runs people start** — what you, a token or a delegation ran. The
    optional filter is one word that must appear in the run's **category** or
    its **prompt**, matched anywhere in it and ignoring case. The categories
    are identifiers the classifier assigns and are never translated:
    `code_write`, `code_edit`, `debug`, `review`, `test`, `refactor`,
    `research`, `explain`, `plan`, `ops`, `data`, `write`, `chat`. A word of
    the prompt works too, and a marker you put in your own prompts — `[nightly]`,
    `#prod` — is the most reliable of the three, because the category is
    guessed and the prompt is yours.
  - **Other automations finishing** — tick the ones to wait on, and you have a
    chain: tests, then deploy, then the report. It fires when one of them
    finishes that way *however it was started* — its schedule, **Run now**, or
    a message typed into its session — and it hears nothing else.

  The two are exclusive: a watcher of automations takes no filter, because a
  firing's prompt is the automation's own and a filter over it would either
  always match or silently never.

  **Loops are refused where you build them**, not at firing time. Pointing an
  automation at something that already leads back to it is rejected with the
  path it found, and the form does not offer the tick in the first place. That
  is what replaced the old blanket rule — "never react to a run an automation
  produced" — which made chains impossible in order to make loops impossible.

  **Sources live in one workspace.** Deleting or moving an automation removes
  it from the triggers that named it, and a watcher left with none says so on
  the list — *watches nothing since its source went away* — rather than
  quietly reverting to watching your own runs. For the same reason a watcher
  that names sources cannot be duplicated into another workspace: create it
  there and choose its sources from that workspace.

  **Run now** works on watchers like on everything else. There is no
  triggering run when you press it, so the firing is told exactly that instead
  of being left to invent a subject — and whatever waits on that automation
  will hear it finish, just as if the event had happened. To try one in
  isolation, pause what waits on it.

  **The downstream is told what the upstream answered.** A firing's prompt
  opens with the triggering run's outcome *and its final answer*, so "deploy
  what the tests approved" is expressible: the automation reads the figure, the
  verdict or the list its predecessor produced instead of only learning that it
  succeeded. The answer is bounded — a long one is cut — and the run and
  session ids sit beside it, so `run_result` returns the rest and
  `session_read` the whole conversation. Those tools are described in
  *Workspaces and files*; an automation has them like any other run of its
  workspace.

Each automation carries its own policy — model, effort, permission mode, a
turn ceiling — independent of the workspace defaults. Leave the model unset
and the learner picks per firing, which makes automations exactly the
repeated workload the learner is best at.

**Notify me when a firing ends.** Automations are silent by default: the
machinery works while you sleep, and a channel that wakes you for it gets
disabled within a week. Tick it for the ones whose whole point is to be read —
a morning brief computed at eight and read at six has ten hours — and the
phone hears about each firing under the automation's name.

## Continuous mode

The distinctive one. A **continuous** automation keeps a single session alive
across every firing, so context accumulates indefinitely: the Tuesday run
remembers what the Monday run learned. This is the loop primitive — a
standing agent with a heartbeat — and it pairs naturally with an event
trigger to build watchers that get better at what they watch.

## Finding one, and switching many at once

**Duplicate to** copies an automation into another workspace, from its own
menu. It is a copy and not a second attachment, and the difference is the
schema rather than a shortcut: a skill attaches to any number of workspaces
because what gets mounted is identical everywhere, while an automation carries
its own continuous session, failure count, next firing and paused state — all
of them per workspace. Reaching two workspaces from one row would mean
answering *"does failing three times here pause it there too"*, which is a
different subsystem.

So the copy starts its own life. Nothing travels but the definition: no
history, no schedule, no failure counter. It lands **paused**, because an
automation fires unattended and one that arrives already armed in a workspace
it was not written for is the surprise these guard rails exist to prevent —
read the prompt, then enable it.

**Keeping the copies together.** The two rows stay linked, and the next time you
edit one and save, Metaclaude asks whether to carry the change to the others,
listing them by workspace with each one tickable. That is the cost of a copy
made into a decision: it asks rather than syncing, because a copy whose prompt
deliberately names its own project has to be able to refuse. What travels is
what you just changed — prompt, name, description, trigger, model and
permissions, continuous mode, failure ceiling. What never travels is what
belongs to one copy's life in one workspace: its schedule, its history, its
failure counter, and **whether it is paused** — otherwise saving the original
would wake a copy you had deliberately stopped.

The question only appears when there is something to ask: other copies exist,
and something shared actually changed. If one copy has gone its own way for
good, **Detach from its copies** in its menu stops it being asked about.

An automation belongs to one workspace, chosen when you create it and
changeable afterwards from its editor — an automation written for one project
often turns out to suit another, and workspaces get created after the
automations that would serve them. Moving a **continuous** one ends its running
session: that thread lives in the old workspace, with that project's files and
permissions, so the next firing opens a fresh one on the other side. The editor
says so before you save, and only when it applies.

Each automation carries a badge naming the workspace it belongs to — the same
badge the skills, subagents and MCP servers use, so one glance answers "where
does this live" on any of those screens.

Past a dozen automations the list stops being readable, so it filters two ways:
by workspace, and by status — **All statuses**, **Active**, **Inactive**. The
counts on the status chips are of the workspace you have scoped to, so
*"Inactive 0"* answers the question actually being asked: none *here*. The filter
bar scrolls sideways rather than wrapping, so on a phone it stays one row and the
list below it keeps its height.

**Enable all** and **Disable all** act on *what the filter is currently
showing*, not on everything you own — which is the point: turn off every
automation in one workspace while a deployment settles, without touching the
others. Enabling genuinely reschedules each one rather than only flipping a
column, so a scheduled automation that was off for a week fires next at its
next real slot instead of immediately trying to catch up.

## Guard rails

Autonomy without rails is an incident generator, so the rails are built in:

- **Consecutive-failure limit** — a runaway loop disables itself and says so.
- **No overlap** — a firing that arrives while the previous run is still
  going is skipped, not queued.
- **No catch-up burst** — downtime does not replay the missed schedule.

Every firing is an ordinary run: transcript, cost, permission prompts under
the automation's chosen mode, and a rating you can still give afterwards.

## Which mode an automation should be on

The one thing that catches everybody: **Ask** is the default, and an
automation on Ask stops at its first consequential call and waits for you.
Nobody is there at 3am, so ten minutes later that call is declined and the
firing carries on crippled — or fails outright.

**Don't ask** is the mode built for this, and it goes with the workspace's
pre-approved tools: nothing waits, and what may run is the short list you
ticked. An automation that reads the web and writes a summary needs *Web
search* — or *Fetch a page* — pre-approved and nothing else. See the
permissions chapter.

Whatever a firing was refused, the run's timeline ends with a line naming it,
so an automation that quietly did half its job says so.

## How long a firing may take

As long as it needs. A firing is stopped only if it reports *nothing* for ten
minutes — the agent speaks every half minute while a tool runs, so that means it
stopped rather than that it is busy — with a second ceiling in hours behind it
for a tool that never returns. Both are on **Settings → Configuration**, and
either can be switched off.

A firing that was cut short is neither a success nor a failure, and the failure
guard treats it as exactly that: it leaves the streak where it was rather than
resetting it. It used to reset, which meant an automation cut short at every
firing showed a clean record for ever — never disabled, and invisible to the
doctor and the brief, which only look at automations the guard has already
switched off.

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
