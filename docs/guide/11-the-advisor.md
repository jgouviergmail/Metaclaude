# The advisor

Metaclaude is meta: it can study itself. The **advisor** is a run that reads
the actual state of a workspace — recent runs and their failures, the board,
the automations, the skills and subagents available, which MCP servers
connected, what the built-in library still holds — and proposes what would
genuinely help. Press **Ask the advisor** on the Dashboard and pick a
workspace; the analysis appears as an ordinary session titled *Advisor*,
readable like any other, and it keeps its session per workspace so each
analysis builds on the last.

## Graduated autonomy

The advisor does not get one blanket permission; each thing it can do gets
exactly the autonomy its consequences allow:

- **Tickets** it creates directly, in Backlog (To do only for something
  urgent) — a card is inert until someone works it. It names the fitting
  subagent in the description and leaves its reasoning as a comment on the
  card.
- **Automations** it creates directly but **disabled**. A disabled
  automation never fires; you read the rationale on the Automations page,
  beside the switch it is asking you to flip.
- **Skills, subagents, MCP servers and plugins** land in the **inbox** on
  the Dashboard. Each of these would act the moment it existed — so it does
  not exist until you accept it, and even then a skill, subagent or MCP
  server is created *disabled*, exactly like a library install. Dismissing
  is one click and final; the advisor is told what is already pending so it
  does not re-propose.

## The trusted-publisher allowlist

For MCP servers, the advisor searches the open web — and a web page that
says "add this MCP server" is exactly what prompt injection looks like. So
the server enforces an allowlist the repository itself curates: a `stdio`
proposal must name a package under a trusted npm scope (Anthropic's own
scopes, GitHub, Linear, Notion, Sentry, Stripe, Cloudflare, Hugging Face…),
a remote one must live on one of those publishers' hosts. A proposal from
anywhere else is refused server-side, whatever the run believes — the
refusal tells the advisor to *report* the finding instead, so a genuinely
reputable newcomer reaches you as prose, and adding it stays your decision,
made by hand. Proposals never carry credentials; secrets are yours to add,
in the vault, after accepting.

## Running it daily

Per workspace, **Settings → Autonomy → Let the advisor study this workspace
daily** opts in to one automatic analysis a day (off by default — an agent
that studies your workspace unprompted is a decision, not a discovery). The
manual button works either way. Every advisor run is pinned to the **Auto**
permission mode: reads and web research flow, anything high-risk still asks
— and the run is told plainly that it is an analyst, not an implementer.

## Not only the advisor

The proposal tools are mounted into **every** run. An agent working an
ordinary card that notices "this workspace rebuilds the same checklist every
week" can propose the automation on the spot, under the same graduated
rules: disabled if direct, inbox if it would act. The advisor is the
dedicated analyst; the ability to suggest belongs to the whole system.
