# The board

One kanban per workspace, shared by you and the agents: what is captured,
what is moving, what is done — and who did what, always answerable.

## Columns

**Backlog** (captured, not committed) → **To do** → **In progress** →
**Review** (done, awaiting your eyes) → **Done**. New cards land on top of
their column. On a phone, swipe between columns; each column scrolls its own
cards.

## Cards

A card carries a title, a description, a priority (the coloured dot), an
assignee (you, or the workspace's agent), an optional due date — overdue
shows red — and, when something is stuck, a **blocked** marker whose reason
you can read on hover. Moving a card clears its block: the reason described
the place it was stuck.

Drag cards between columns with the mouse on a desktop. On a phone, **press
and hold** a card for a beat — it lifts under your finger, columns light up
as you pass, and letting go drops it (start moving right away and the board
scrolls instead, as it should). The ⋮ menu carries the same moves for
keyboards and anyone who prefers taps. Open a card to edit
it, comment, and read its **history**: every creation, move, edit and
comment is recorded with its author, which is what keeps a board worked by
several hands explicable.

## Sub-tasks

A card can be decomposed into sub-tasks (up to three levels). Sub-tasks live
on the same board and show their state on the parent's card view.

## Archive

Archiving takes a card off the board without losing it: it keeps the column
it died in, stays findable under the task list's *archived* filter, and a
restore puts it back exactly where it was. Deletion is deliberately
two-step — archive first, then delete — so the board never loses work to a
single click.

## Live, everywhere

Every open board converges in real time: a card moved on your phone slides
across the screen of the desktop showing the same workspace — and when an
agent works the board, its moves appear the same way, as they happen.

## Sending a card to the agent

Open a card and press **Send to the agent**. The card's title, description,
discussion and sub-tasks become the prompt of a run in a session named after
the card, the card slides to *In progress* with agent hands, and the pulsing
marker on it means exactly that: a live run is working this card. While it
runs, the drawer links straight to the session so you can watch — or steer —
like any other run.

When the run ends, the loop closes on the card itself. Success moves it to
**Review** with a comment — never to *Done*: done is your word, the agent
stops at review. Failure (or an interruption) blocks the card with the
reason where the board can read it, and the agent's comment says the same.
A card the agent already moved holds its place — its moves win over the
bookkeeping.

Press **Send back to the agent** after leaving review feedback in the
comments: the same session resumes, context intact, so the agent picks up
exactly where its last attempt ended. A card already being worked refuses a
second press until you interrupt the run.

## The autopilot

The board can drain itself. Switch **Work the board by itself** on in the
workspace's settings and, each time a card run ends, the top unblocked card
of *To do* starts on its own — one card at a time, in the order you
arranged, success landing in **Review** for your eyes, failures blocking
the card with their reason. You fill the queue from your phone; the agent
works through it; you dispense reviews.

Two guards keep it honest. Only one card runs at a time per workspace — a
backlog is a queue, not a fan-out. And near the plan's quota ceiling
(`METACLAUDE_QUOTA_GUARD_PCT`, 85% by default) automatic starts wait for
the window to breathe; a periodic sweep resumes them when it does.

The **Work the board** button in the header starts the top card once,
whether or not the autopilot is on — and being your own press, it outranks
the quota guard. The board history signs automatic starts as `autopilot`,
so who queued what stays answerable.

## What the agent can do on the board

Every run carries board tools scoped to its own workspace — `board_list`,
`board_get`, `board_create`, `board_update`, `board_move`, `board_comment`
and `board_decompose` — so any session, not only card runs, can capture
follow-ups as cards, break work into sub-tasks, comment progress, and move
what it works. Cards from another workspace's board are invisible to it,
and everything it does lands in the card history under its run's name.

The morning brief keeps the score: cards in review, blocked, being worked
and due soon — one line, linking here.
