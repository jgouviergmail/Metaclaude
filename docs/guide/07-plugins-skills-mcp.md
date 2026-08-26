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
server actually connected, with its error when it did not. Refresh it after
fixing a server's command; that read skips the cache.
