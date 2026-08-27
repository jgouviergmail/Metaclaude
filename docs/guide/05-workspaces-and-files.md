# Workspaces and files

A workspace is a directory plus a policy: where the agent works, and the rules
that apply while it does.

## Creating one

**Workspaces → New workspace.** A name is enough; a git URL clones a
repository into it at creation. A workspace that started empty can be
connected to a repository later from its **Git** panel — into an empty
directory it clones; into one with files it adds the remote and fetches,
leaving the merge to you so nothing you have is silently overwritten.

Each workspace carries its own defaults — model, effort, permission mode,
thinking budget, memory and reflexion toggles, tool allow/deny lists — under
its **Settings** tab. Session-level and message-level choices override them.

## Files

The **Files** panel is a real browser and editor over the workspace: create,
edit, upload, download, delete. It is jailed — paths cannot escape the
workspace, symlinks included, and a few names (`.git` internals, credentials
files) are not addressable through it at all. The agent works with git through
its own tools, which go through the permission prompt; the file panel is your
direct door.

## Notes

Markdown files in a workspace are notes, and the Files panel treats them the
way Obsidian would. A `.md` file opens **reading** — rendered, with
`[[wikilinks]]` live: click one and the linked note opens in the panel.
`[[Note|alias]]` shows the alias, a name no note answers to yet shows muted,
and links written inside code stay prose. The **Edit** toggle is the plain
editor, one keystroke away.

Under every note: its **local graph** — what links here on the left, what it
links to on the right, each node a click — and its **backlinks**, with the
line that made each link. Resolution works like Obsidian's: bare names match
case-insensitively, the note's own folder wins, then the shortest path.

There is nothing to install or sync for this. The notes are the workspace's
own files — a synced Obsidian vault works as-is, and everything the agent
writes with its file tools joins the graph the moment it lands on disk.

## Git

The **Source control** panel shows status and diffs, stages files, and
commits. The identity on those commits is the one configured at deployment.
Pushes and anything credentialed go through the agent — with a permission
prompt — rather than through the panel, so a credential never lives in the
browser.

## CLAUDE.md

Every workspace gets a starter `CLAUDE.md`. It is read at the start of every
session: build commands, conventions, things to avoid. It is yours — the
system never rewrites it. The learned memory lives alongside, not inside.

## Asking one workspace from another

The agent can **delegate**: from a session in one workspace, ask another
workspace to work on something and get its answer back — the target runs
with its own memory, skills, conventions and permission mode, so a project
consulted through its own agent answers better than its files read cold.

Every delegation goes through a permission prompt naming the target and the
exact ask, costs a full run there (visible in that workspace's history and
usage), and lands in a standing *Delegations* session so context accumulates
across asks. Depth is one by construction: a delegated run cannot delegate
further, so chains cannot loop and every delegation traces back to a run a
human started.

## Its settings

Every workspace carries the agent policy that applies inside it. Open the
workspace and press the settings button in its header; the drawer holds four
groups.

**Learning** — whether retrieved memory is injected into runs, whether the
learner may pick the model and effort, whether the reflexion pass runs after
each run, and whether file checkpointing records the point a run started (the
thing Rewind needs).

**Autonomy** — two opt-ins, both off by default, because an agent that acts
unprompted is a decision rather than a discovery:

- **Work the board by itself.** When a card run ends, the top To do card
  starts automatically — one at a time, success landing in Review, with the
  quota guard pausing automatic starts near the plan's ceiling.
- **Let the advisor study this workspace daily.** At most once a day an
  advisor run reads recent runs, the board and the registry, creates backlog
  tickets and *disabled* automations, and leaves anything that would act in
  the Dashboard inbox. The manual **Ask the advisor** button works whether or
  not this is on — see the advisor chapter.

**claude.ai** — mirroring this workspace's sessions to your account, which
only has an effect when the CLI's own account sign-in is the live credential.

**Marketplace plugins** — which plugins from your configured marketplaces the
CLI should install here at the start of a run.

The defaults for a new workspace come from the shape above; nothing here
changes another workspace.

## Archiving and deleting

Archiving hides a workspace without touching files. Deleting asks separately
about the files, and purging them is deliberately explicit — losing an agent's
work to a mis-click is not recoverable.
