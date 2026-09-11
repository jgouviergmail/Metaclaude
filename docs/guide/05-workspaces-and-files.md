# Workspaces and files

A workspace is a directory plus a policy: where the agent works, and the rules
that apply while it does.

## Creating one

**Workspaces → New workspace.** A name is enough; a git URL clones a
repository into it at creation. A workspace that started empty can be
connected to a repository later from its **Git** panel — into an empty
directory it clones; into one with files it adds the remote and fetches,
leaving the merge to you so nothing you have is silently overwritten.

A workspace also carries a **colour and an icon**, chosen at creation and
changeable afterwards from its Settings tab. They are not decoration: the colour
is what the workspace switcher, the analytics ranking and the board cards use to
tell one project from another at a glance, so two workspaces you move between
often are worth making visibly different.

Each workspace carries its own defaults — model, effort, permission mode,
thinking budget, memory and reflexion toggles, tool allow/deny lists — under
its **Settings** tab. Model, effort and mode are the base values of every
session, existing ones included: a session follows them until you touch a
pill in its composer, then keeps what you chose.

## Files

The **Files** panel is a real browser and editor over the workspace: create,
edit, upload, download, delete. It is jailed — paths cannot escape the
workspace, symlinks included, and a few names (`.git` internals, credentials
files) are not addressable through it at all. The agent works with git through
its own tools, which go through the permission prompt; the file panel is your
direct door.

A listing shows at most a thousand entries — directories first, then
alphabetically — and says so plainly when a folder holds more. Reading a
`node_modules` out loud costs a second of the server's single thread and
megabytes on the wire for a list nobody scrolls; the **Find a file by name**
box above the listing searches the whole tree and is what reaches the rest.

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

**It knows who to ask because you told it.** Every run that may delegate
carries a short directory of the other workspaces: each one's slug, its name
and its description. So a workspace's **description is not decoration** — it
is what another project's agent reads to decide whether the question belongs
to you. Write it as an answer to "when should someone ask this workspace?",
and keep it to a sentence or two. A workspace with no description stays
reachable if you name its slug yourself, but no agent will find it.

The block is bounded, and it degrades in one direction only: every workspace
stays listed, and the descriptions are what shrink when there are many. Around
twenty-seven workspaces all keep theirs; past that you see the names and the
descriptions go together. **Settings → Configuration → Peer directory budget**
sets the size, and `0` there switches everything between workspaces off across
the whole server — the directory, the search and the delegation together.

**Any workspace can decline.** In its settings, under *Other workspaces*, turn
off *Let other workspaces consult this one* and it leaves every directory,
refuses every delegation, and stops answering the cheap search too: its notes
and documents are no longer readable from another project. Metaclaude's own
steward still reaches it — that switch is about other projects, not about you.
Each workspace's own *Learning* switches still apply on top: one that recalls
nothing offers no notes, and one with its library off offers no documents.

Every delegation goes through a permission prompt naming the target and the
exact ask, costs a full run there (visible in that workspace's history and
usage), and lands in a standing *Delegations* session so context accumulates
across asks. Depth is one by construction: a delegated run cannot delegate
further, so chains cannot loop and every delegation traces back to a run a
human started.

**Searching costs nothing, so try it first.** Beside *Delegate* sits
*Search workspaces*, which reads what the other workspaces have already written
down — their notes and the documents filed with them — without starting a run
anywhere. It needs no tick: it reads and never writes, so it is available
wherever there is somebody to consult, and it is what an agent should reach for
before spending a full run on a question that was already answered somewhere.
Results say which workspace each one came from.

One run never sees any of this: one that is itself a delegation, which cannot
delegate onwards and must not carry another workspace's notes home. A run
started through the MCP gateway *does* see it, and that is the rule for the
gateway rather than an exception — a token says which workspace an application
may knock at, and behind that door the agent works as it does for you. And in
`dontAsk`, where nothing unapproved executes, the directory offers the search
and stays silent about *Delegate* unless you have ticked it: being told about a
tool that would only be refused wastes the turn.

## Reading its other sessions

Sessions are separate conversations, not separate agents. A run of a workspace
can read the **other sessions of that same workspace** — so "use the data from
the session about the API", or "what did we conclude last week", is something
you can simply ask for, and an automation can be written to work from a session
you point it at.

Three tools do it, and they only read:

- **`session_list`** turns a name into a session — it matches titles ignoring
  case and accents, so *Évaluation* is found typed `evaluation`. The session the
  run is in is marked, so the agent does not read back the conversation it is
  having.
- **`session_read`** returns what was said, oldest first. Narrow it with a
  window — "the last seven days" — rather than reading everything; if the reply
  was cut to fit, it says so, and the agent is told to pass that on rather than
  treat the part it got as the whole conversation.
- **`run_result`** returns one run in full, including its final answer.

**A chained automation gets the answer without asking.** When an automation
fires because another one finished, the prompt opens with what that automation
answered — bounded, with the run and session ids beside it, so a long answer
stays one `run_result` away. That is what makes "deploy what the tests
approved" expressible: the downstream is told what the upstream *said*, not
only that it succeeded.

**The fence is the workspace, and it is not a setting.** These tools reach the
workspace's own sessions and nothing else; a session belonging to another
workspace answers exactly as one that does not exist.

An application connected through the **MCP gateway** gets them too, for the
workspace its token names — the token says which door it may knock at, and
behind that door Metaclaude answers as it does on screen. So **granting a
workspace to a token grants reading the conversations held there**: issue one
for the workspace an application may see. A **delegated** run is the exclusion:
it is another workspace's agent and its answer goes home with it, so it
consults yours through its own reasoning rather than reading your sessions.
Metaclaude's own steward does not get them either — it already reads runs and
sessions across the whole deployment.

**This is not the same thing as memory.** Memory is what gets distilled after a
run and reaches later runs whether or not anyone asks — a convention, a
preference, a fact about the project. This is the verbatim record, for what you
name. Keeping the second out of every prompt is deliberate: injecting other
sessions into every run would cost tens of thousands of tokens a turn for
content that mostly does not concern the question, and would rewrite the cached
prefix on every message.

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
