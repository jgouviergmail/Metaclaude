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

**And Gmail, Calendar and Drive specifically?** Google's own MCP endpoints
cover the developer platform, not your mailbox — the directory carries Maps,
which is the one that helps a trip or a move. For your personal Google data
there are two honest routes, and neither is an import. Run an automation hub
that issues a **static** server token — Zapier's MCP is the common one, and it
reaches Gmail, Calendar and Drive among thousands of others; you get a personal
server URL and a token from its settings, and you add it here as an ordinary
HTTP server with an `Authorization` header. Or register your own Google Cloud
OAuth application, complete the consent once in your own browser, and run a
local MCP server holding the refresh token. Both work unattended, because in
both cases the browser step happened once, outside the agent. That is the
general shape of every connector question here: something a human authorised
once, reduced to a credential a run can carry.
