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
| **Don't ask** | Everything proceeds except what the deployment forbids. |
| **Bypass** | No prompts at all. Disabled at deployment level unless you explicitly enabled it at installation — and meant for disposable environments only. |

Modes are per-message in the composer, with defaults per workspace. Whatever
the mode, the deployment-level rules still hold: path jailing keeps file
access inside the workspace, and the directories an agent may reach beyond it
are bounded by the server's policy, not by the conversation.

## Advice

Stay on **Ask** until a workspace has earned trust, use **Plan** for anything
exploratory on a repository you care about, and treat **Bypass** as what it
is: the removal of the last check.
