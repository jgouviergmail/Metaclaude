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
**Settings → MCP**; credentials go into an encrypted vault and are merged into
the server's environment only at run time. The interface never displays a
stored secret back, and editing a server keeps the credentials you do not
retype.

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
**From Claude** with its live connection status.
