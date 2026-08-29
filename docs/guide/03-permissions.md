# Permissions

Every tool call that writes, deletes, runs a command or reaches the network can
require your approval. This is the boundary that makes an autonomous agent
safe to leave alone — so Metaclaude spends real care on making it readable.

## The prompt

An approval card shows the **literal** command or file operation — not a
paraphrase — with a risk badge. High-risk calls (anything matching `rm -rf`,
piping downloads into a shell, force pushes, `sudo`, and friends) never offer
"always allow", and **Deny is always the focused button**: pressing Enter in a
hurry refuses.

While a prompt is open, the run shows as *waiting for you* — it holds its
place in the queue, deliberately, because a run blocked on approval still owns
a live agent.

## The six modes

| Mode | What it means |
| --- | --- |
| **Plan** | Research only. The agent reads and proposes; nothing executes. |
| **Ask** (default) | Every consequential call prompts. |
| **Accept edits** | File edits inside the workspace proceed; commands still prompt. |
| **Auto** | A classifier lets routine, low-risk calls through and prompts for the rest. |
| **Don't ask** | Nothing prompts, and nothing that would have prompted runs: only the tools this workspace pre-approves go through, plus the read-only ones that never ask. |
| **Bypass** | No prompts at all. Disabled at deployment level unless you explicitly enabled it at installation — and meant for disposable environments only. |

Modes are per-message in the composer, with defaults per workspace. Whatever
the mode, the deployment-level rules still hold: path jailing keeps file
access inside the workspace, and the directories an agent may reach beyond it
are bounded by the server's policy, not by the conversation.

## Pre-approved tools

A prompt needs somebody to answer it. An automation firing at 3am, a card the
board works on its own, a call arriving through the MCP gateway — none of them
has one, and an unanswered prompt expires after ten minutes and is declined.
So an unattended run is only ever as capable as what it may do *without*
asking, and that is what **Workspace settings → Pre-approved tools** decides.

Tick a tool there and it runs with no approval card, in every mode but Plan.
Leave it unticked and, under **Don't ask**, it is refused outright — which is
the whole of that mode: it never waits for you, so anything you have not
decided in advance is a no.

The list offers exactly the tools that can raise a prompt. Reading files,
searching them and listing a directory are absent because they never ask in
the first place.

- **Web search** and **Fetch a page** are the two an unattended run usually
  wants. They differ in where the request happens: a web search runs upstream
  and this server makes no outbound call of its own, while fetching a page is
  done by the container. Both cost tokens like any other tool.
- **Terminal** is the wide one. Ticking it is close to ticking all of them,
  because a shell command can do what every other tool does.

Ticking a tool is a standing decision, so the transcript says when one is
used: the run's timeline carries a line naming the tool and why no card
appeared. And whatever a run is refused — by this list, by the mode, or by a
classifier — the run ends with one line naming what it could not do, rather
than leaving it to the agent's closing paragraph.

## Advice

Stay on **Ask** until a workspace has earned trust, use **Plan** for anything
exploratory on a repository you care about, and treat **Bypass** as what it
is: the removal of the last check.

For anything unattended, the honest order is: pick the narrowest mode that can
do the job, then pre-approve the few tools it genuinely needs. A workspace on
**Don't ask** with *Web search* and *Fetch a page* ticked can research without
being able to touch a file — which is a much smaller grant than **Accept
edits**, and it never stalls.
