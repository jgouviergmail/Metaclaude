# Plugins, skills, agents and MCP

Metaclaude extends the same three ways the Claude CLI does — and shows you
what your subscription already ships.

## Skills

A skill is a packaged instruction set the agent follows for a kind of task —
a review checklist, a deploy procedure, a house style. Manage them under
**Agents & skills**; Metaclaude writes them into the workspace before each
run, so the CLI discovers them exactly as it would in a terminal.

## Custom agents

A named sub-agent with its own prompt, tool list and optionally its own
model — a code reviewer, an explorer, a release scribe. Pick one per message
in the composer, or let runs delegate to them.

## The library

You do not have to start from a blank page. The **Library** tab under
Agents & skills is a starter shelf of skills and subagents, in two halves.

The first is the work of building software: a code reviewer, a test writer,
a debugger, a security auditor, a postmortem procedure, an SQL review
checklist and more.

The second is everything else a week contains — because nothing in this
system is specific to code. The memory, the learned policy and the board
serve a house move exactly as they serve a refactor. So the shelf also holds
a meal planner that writes the shopping list, a trip planner that leaves
slack in the day, an administrative navigator that drafts the letter and
names the deadline, a budget coach, a tutor, a home-project planner, a
fitness coach and a week planner — with procedures beside them for shopping
lists, cooking from the cupboard, formal letters, packing, decluttering,
hosting, auditing subscriptions, deciding a big purchase, revising for an
exam, practising a language, preparing a medical appointment and building
the household inventory an insurance claim needs.

Beyond the everyday, a set of entries goes deeper into the moments that
actually cost money and sleep: a tax preparer, a housing navigator for the
whole tenancy from inventory to deposit, a career coach, a caregiver
organiser for an ageing parent, a negotiator that fixes the walk-away number
before the conversation, a gardener that plans by season — and procedures for
a house move, an insurance claim, vehicle paperwork, a CV and cover letter,
interview preparation, health administration, energy savings, school
orientation, a sleep reset and a digital-hygiene sweep.

Each entry is written for the way this system delegates: the description
tells the main agent *when* to reach for it, and the prompt states working
rules rather than personality. Everything is in English — that is the
language these models reason best in — while the agent answers you in
whichever language you write.

Administration is the one domain where a good procedure stops being
portable, because a deadline or a ceiling is a fact about one country. Those
entries open with a **`Jurisdiction: France`** line naming the portal to
confirm against — service-public.fr, impots.gouv.fr, ameli.fr, ants.gouv.fr,
Parcoursup — and instruct the agent to say what still holds and what changes
if you are somewhere else. A catalogue test refuses any entry that cites a
national service without declaring which one it assumes, so the shelf cannot
quietly become France-only.

Where a domain belongs to a professional, the entry says so in its own text
and says what to bring to that appointment instead. The health and money
entries state plainly that they are not medical or financial advice — not as
a disclaimer bolted on, but as a working rule the agent follows: it will
prepare your questions for the doctor and refuse to play one.

The shelf is curated **in the repository**, not fetched from a store: what
you see has been read, versioned and reviewed like any other code in your
deployment, which is the whole trust story. Installing an entry copies it
into the global registry **disabled** — present in every workspace's list,
inert until you switch it on, and from then on yours: edit it, rename it,
delete it like anything you wrote yourself. The library keeps the original,
so a deleted copy can always be installed again.

## Which workspaces an extension reaches

A skill, a subagent or an MCP server reaches **any number of workspaces**, and
its editor asks the question the same way in all three: *every workspace,
including any created later*, or a list you tick one by one.

That matters because the two obvious answers are both wrong for most
extensions. Making something global to share it with three projects out of eight
exposes it to five that have no business seeing it — an MCP server especially,
since its credentials travel with it. Writing it out three times instead gives
you three copies that drift the moment one is edited.

**Seeing the library whole.** The scope control above each list — the same one
on every screen, in the row with the other filters — has three answers: *every
workspace*, meaning everything wherever it is attached; *global*, meaning what
reaches all of them; or one workspace, meaning its own plus the globals it also
mounts. The first is the one to reach for when the question is "where does this
live", because each row then carries a badge saying so: **Global**, the
workspace's own colour and name, a count when there are several, or **no
workspace** when it is attached to none.

**Attached to nothing** is a state an extension can hold: it stays in the
library and is mounted nowhere. Useful for parking something you are still
drafting — and because it is also a state you can arrive at by unticking the
last box, the control says so in words rather than leaving you to notice.

## Categories

Skills and subagents carry a **category**, in two groups. The domains of
work: engineering, writing, data, ops, research, product. The domains of a
life: home, health, money, learning, travel, career. And **general** for what
fits nowhere else — a taxonomy without an "everything else" drawer forces bad
filing.

The library filters by them, list entries wear them as badges, and both
editors let you file your own definitions the same way. They are labels for
finding things, nothing more: a category never changes what a skill or agent
may do.

## Plugins

Plugins bundle skills, agents and MCP servers in the vendor-neutral **Agent
Plugins 1.0.0** format. Install one under **Plugins** and its components load
per-component: a malformed piece produces a warning attached to the plugin,
never a broken install. Plugin state lives apart from plugin code, and a
plugin's declared paths cannot reach outside its own directory.

## Marketplaces

A marketplace is a published catalogue of plugins that the Claude CLI installs
from directly — Metaclaude stores only the source. Add one under **Plugins →
Add marketplace**, by GitHub repository (`owner/repo`) or by a direct
`marketplace.json` URL (https only). The card shows the catalogue as the
marketplace itself describes it; a source that fails to load shows the error
in its own words.

Which plugins actually run is chosen **per workspace**, under Workspace
settings → Marketplace plugins. At the start of a run the CLI installs
whatever is enabled but not yet present, and the transcript narrates the
install. Disabling or removing a marketplace severs its plugins everywhere at
once — a plugin left enabled from a removed source stays visible in the
workspace settings, marked, so it can be switched off.

Adding a marketplace is a trust decision — its plugins bring skills, hooks and
MCP servers into the agent, so treat a new source as you would a new
dependency. Only the owner account can add or remove one.

## MCP servers

MCP connects the agent to external systems — databases, browsers, trackers,
your own tools. Configure servers globally or per workspace under
**Agents & skills → MCP servers**; credentials go into an encrypted vault and
are merged into the server's environment only at run time. The interface never
displays a stored secret back, and editing a server keeps the credentials you
do not retype.

### Testing a server, and what the test leaves behind

Each enabled server carries its own **Test**. It connects exactly as a run
would — same configuration, same secrets, same OAuth token — and then asks the
server two things the connection status alone does not carry: what it says it
is for, and the description of every tool it exposes. Both appear on the card,
folded, because a server with thirty tools is a wall and its own account of
itself can run to paragraphs.

Asking costs a connection, so it happens when you press the button and never on
a page load. What the last test learned is therefore **kept**: come back
tomorrow and the tools are still listed, with the date of that test beside the
count. That date is the whole honesty of the arrangement — a stored list is
what the server answered *then*. Where **From Claude** has a live reading, the
live one wins, and a tool it no longer lists is not shown however recently it
was stored.

A test that fails changes nothing about what was stored: a server behind a
momentary blip should not read as one that exposes nothing.

### The connector directory

Under the same tab, below your own servers, sits a shelf of MCP servers this
repository has read the documentation for: the exact endpoint, and the exact
name of the credential each one wants. Paste the credential, press **Add**, and
Metaclaude writes the server globally and **disabled**, with your secret sealed
in the vault. Switch it on when you are ready, then open **From Claude** to see
whether it really connected.

The shelf is narrower than a list of famous MCP servers would be, and the
difference is the whole point: **every entry authenticates with something you
can paste.** An endpoint whose only path is an interactive OAuth consent is
deliberately absent, however well-known its publisher, because a run has no
browser — installing it would produce a server that can never connect.

Two entries explain why a curated directory beats a search engine. Sentry wants
its token as `Sentry-Bearer`, not `Bearer` — it reserves `Bearer` for MCP's own
OAuth — and Google Maps wants `X-Goog-Api-Key` with no scheme word at all.
Guess either and you get an authentication error that reads exactly like a bad
token. Each card links to the publisher's own page, which is where its facts
were read from.

Adding a connector is the same trust decision as adding a marketplace, held to
the same bar: a test runs every entry through the same publisher allowlist the
advisor uses for its own proposals, so a connector cannot exist for a publisher
this repository has not vouched for.

**From Claude** — the tab worth knowing about — shows what the CLI itself
reports for a workspace rather than what Metaclaude assumes: the models your
subscription grants and which take an effort level, the slash commands and
sub-agents available there, which account is signed in, and whether each MCP
server actually connected, with its error when it did not. The probe mounts
exactly what a run would — your configured servers, your custom agents,
under the same policy locks — so what it reports is the world a run really
sees. Refresh it after fixing a server's command; that read skips the cache.

## The other direction: Metaclaude *as* an MCP server

Everything above is Metaclaude consuming other people's servers. Since 0.38 it
also exposes one of its own, so your other software can ask this agent to work:
a script, an automation platform, Claude Code on your laptop, anything that
speaks MCP over HTTP.

**Settings → Connections → MCP access** mints the credential. A token names the
workspaces it may reach — there is deliberately no "all workspaces", so a token
made for one integration does not follow the deployment into every workspace
you create afterwards — what it may do (start runs, read notes and the board),
and a **ceiling**: the most a run it starts may do on its own. The value is
shown once, at creation; only its fingerprint is kept, so a lost token is
replaced rather than recovered.

**Naming a workspace on a token grants reading what was said in it.** Behind
the door the token opens, Metaclaude answers as it does from the interface — so
a run the application starts can list that workspace's sessions and read their
transcripts, within the ceiling like everything else it does. That is the
control: issue a token for the workspace whose conversations the application
may see, and no more. It reaches no other workspace's sessions, whatever it
asks.

The ceiling exists because nobody is watching these runs. A permission prompt
with no one to answer it expires after ten minutes and fails, which is a worse
answer than a refusal. *Plan only* executes nothing at all; *Run what is
already allowed* runs the tools the workspace pre-approves (see the
permissions chapter) and refuses everything else without waiting; *Run and
edit files* adds file edits — and it is the one ceiling that can still stop to
ask, so a run under it can stall on a command or a network call nobody
answers. A workspace set to less than the ceiling stays at less: the ceiling
is a maximum, never a grant.

In practice that makes *Run what is already allowed* plus a short
pre-approval list the setting to reach for: it never waits, and what it may do
is written down where you can read it.

Connecting is one line. In Claude Code:

```bash
claude mcp add --transport http metaclaude https://your-site/api/gateway/mcp --header "Authorization: Bearer mck_…"
```

The tools it offers: `list_workspaces`, `ask_workspace` (the main one — it runs
in that workspace with its memory, skills and conventions, and waits for the
answer), `start_run` and `run_status` for work too long to hold a request open,
`search_notes`, and `list_tasks`.

`ask_workspace` waits ten minutes. Past that it returns the run id and says the
work is still going — it has not been cancelled — and `run_status` is how you
collect the answer afterwards. For anything you expect to be slow, prefer
`start_run` and poll: holding an HTTP request open for half an hour is a bet on
every proxy between you and the deployment.

One more thing worth knowing about a token used all day: each one gets a
standing session per workspace, so its asks build on each other. That session is
bounded — past roughly a dozen runs' worth of transcript the next call starts a
fresh one, under the same name. Context that grows without end is a bill that
grows without end.

That bound is also where the cost sits. A run started through the gateway now
carries the same tools a run you started would, so it pays the same opening
prefix — which for the **Metaclaude** workspace is the largest in the
deployment, its whole system table. The first call of a session writes that
prefix to the cache and every call after it reads the cache instead, so the
expensive moment is a session's first question, not each one. Nothing here
calls a model that a run of your own would not.

**What `search_notes` returns.** Both kinds of thing this deployment has
written down: the reference documents in the knowledge base, and the notes its
agents keep. Each result says which it is, because they are not the same sort
of evidence — a `passage` is a quotation you can attribute to a document, page
and lines; a `memory` is something an agent concluded and may be out of date.
Name a workspace to search it alone, or omit it and the search covers every
workspace the token reaches plus anything filed globally, which is what a
calling program usually wants: it has no way of knowing where you filed a fact,
and should not need one.

Two consequences of that, both worth deciding on rather than discovering. A
token scoped to one project reaches the notes and documents you keep for all of
them, because the global shelf is part of what a run there reads. And granting
`read` now exposes the agent's own notes about a project, not only the
reference material filed with it.

**`search_notes` stops at the grant; `ask_workspace` does not.** The two are
different in kind and it is worth knowing which you are using. `search_notes`
is the token reading for itself, so it reaches the workspaces you named and the
global shelf, and nothing beyond. `ask_workspace` puts the agent to work inside
one of those workspaces, and that agent consults whoever *that workspace* is
allowed to consult — so it can come back with something `search_notes` would
not have found. The free path is the narrower one, deliberately: a credential
is bounded by what it was granted, a worker by where it works. If a program
needs to read a project directly, name that project on the token.

**Behind the door, it works as it does for you.** A token chooses which
workspace an application may knock at; it does not choose a narrower agent.
Runs it starts get the same tools a run you start there would get, under the
same workspace settings — so a workspace whose settings let its agent consult
its neighbours will do so for the application too, and one whose *Delegate*
tick is off will not. The one thing that stays specific to a token is its
ceiling, because nobody is watching: it caps the run it starts *and* every run
that run goes on to cause elsewhere.

Grant the **Metaclaude** workspace only to software you would let read the
whole deployment. Its steward reads every workspace's notes, runs, settings and
audit trail, and can start runs anywhere — all under the token's ceiling, and
none of it able to change a permission mode, a tool list or a directory.

**Treat a token as a password with a blast radius.** Anything holding one can
ask this agent to work in the workspaces you named, and the agent runs shell
commands. Give it the narrowest ceiling that does the job, and an expiry you
will notice. Every run it starts appears in the run history marked as coming
from the API, and in the audit trail under the token's name — the listing also
shows when each token was last used, which is how an integration you forgot
about becomes visible.

## Where are my claude.ai connectors?

Not here, and knowably so. The connectors you enable on claude.ai (Gmail,
Calendar, Drive…) follow a *full* interactive sign-in, whose token carries
the `user:mcp_servers` scope. A server pairs headlessly with a setup token,
which Anthropic scopes to inference only — the CLI in the container cannot
even ask for the connector list, and each connector's own OAuth consent
would still need a browser the agent does not have. Runs also mount servers
strictly and explicitly, on purpose: an agent that works unattended should
not inherit whatever a signed-in account happens to have switched on.

The equivalent here is the MCP registry above: any remote MCP endpoint a
service exposes can be added with its URL and an API key or header, scoped
globally or to one workspace, sealed in the vault — and it then shows up in
**From Claude** with its live connection status. The connector directory is
that path made one click: the endpoints already read and checked.

**And Gmail, Calendar and Drive specifically?** Built in, since 0.30.0 —
**Settings → Connections**. You register your own OAuth application in the
Google Cloud console (the screen shows the exact redirect URI to paste, and
walks the three steps), tick what the agent may do — reading mail, sending
mail, the calendar and Drive are each their own checkbox — and give consent
once, in your own browser. Metaclaude keeps the refresh token in the vault
and ships its own Gmail/Calendar/Drive MCP server *inside the image*, so
there is no third party between the agent and your account: the server
appears under this tab as `google`, switched on the moment consent comes back
— giving consent is the decision, and a connection that landed switched off on
a screen you were never sent to only looked broken. Switch it off there if you
want it held back; reconnecting to add a grant leaves the switch where you put
it. A capability you did not grant is not merely refused — its tool is never
registered, so the agent cannot try it.

One Google-side fact decides how well this works. Reading mail or Drive uses
scopes Google classes *restricted*: while a Cloud project's consent screen is
still in "Testing", its refresh tokens expire after **seven days** — the
connection stops working next week for no visible reason. A **Workspace**
account escapes this by publishing the app as *Internal*; a personal account
should either stick to the calendar and Drive-write grants (not restricted)
or use an automation hub instead. The hub route still exists and still works:
a service like Zapier issues a static server token that reaches Gmail among
thousands of apps, added here as an ordinary HTTP server — the trade is that
your Google data transits a third party. Both routes share one shape: a
browser step that happened once, outside the agent, reduced to a credential a
run can carry.
