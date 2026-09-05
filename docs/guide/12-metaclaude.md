# Talking to Metaclaude

Metaclaude has a workspace of its own. It is called **Metaclaude**, it is
created the first time the server starts, and it is the one place where the
agent works *on the application* rather than on a project: your workspaces,
your sessions and runs, the memories, the automations, the settings, its own
health. Think of it as your second — the one you brief when you do not have
time to look yourself.

You reach it from the **Dashboard**. The card near the top is a composer:
write what you want to know or what you want done, press **Ask** (or
Ctrl+Enter), and you are taken to the session where the answer streams. It is
an ordinary session titled *Conversation* — the transcript, the approval
cards, steering and rewind all work as they do everywhere else — and it is
kept from one question to the next so the conversation has a memory. A
conversation that is still answering is opened, never doubled.

## What it knows

Everything you can see in the interface, through tools of its own. It reads
the deployment's state (runs in flight, approvals waiting, the last day's
failures and cost), every workspace and its settings, sessions and runs with
their transcripts, memories in both tiers, insights and proposals, automations,
the operational settings and where each value comes from, the doctor's report,
the analytics, the audit log, whether an update exists. It also has the
documentation you are reading and the source code of the version that is
running, both copied into its workspace at every start — so a question that
goes deeper than the guide still has an answer grounded in what is actually
deployed, cited by file and line.

Its standing instructions are regenerated at every start from the running
version, so it is never a release behind. A file called `NOTES.md` in its
workspace is yours: whatever you write there — house rules, things to keep an
eye on, how you like to be briefed — is read at the start of every session and
never overwritten.

## What it can do, in three rings

The boundary is drawn by **reversibility**, not by subject.

- **Reading** is free. It reads before it acts, always, and tells you which
  tool it read something from.
- **Reversible changes** it makes at once, then tells you. Writing or editing
  a memory and moving it between the global and workspace tiers; accepting or
  rejecting an insight or a proposal; enabling, pausing, creating or firing an
  automation (a new one is created disabled unless you say otherwise);
  renaming, pinning or archiving a session; moving an operational setting;
  renaming a workspace or changing its ordinary settings; deciding an approval
  card of low or medium risk on your behalf; asking another workspace's agent
  a question and waiting, or starting a run there and coming back;
  interrupting a run; filing, moving and annotating cards on its own board;
  proposing an automation, a skill, an agent, an MCP server or a plugin, which
  land disabled or in your inbox until you accept them. None of these opens
  an approval card — not in the conversation, and not when it runs on a
  schedule with nobody there to answer one. Every one of them is written to
  the audit log under its own name — `metaclaude:<run>`, never yours — or
  signed by the run, so you can always see what it did while you were away.
- **Irreversible changes are not its to make.** Deleting or purging anything,
  archiving or deleting a workspace, applying an update or rolling one back,
  backups, tokens and credentials, allowing a high-risk approval, and changing
  any workspace's permission mode, tool lists or extra directories. It has no
  tool for these, and when one of them is the right course it says so
  precisely — what would happen, to what, and why — and stops. A card that
  lets you approve exactly such an action from the conversation is planned for
  a later release.

Two lines it never crosses, whichever ring: it has **no shell and no file
editor** in its own workspace, and it cannot widen its own reach. Its tool
lists are fixed by the server; the workspace cannot be archived or deleted,
and its settings dialog shows those controls locked rather than let you
discover the rule from a failed save.

**The permission mode is yours.** It decides how much you want to be asked,
not what Metaclaude can reach — every mode keeps the shell and the editors
forbidden and its tools bounded to the pre-approved list. Leave it on *Ask*
and anything outside that list (a web fetch, say) waits for you; set it to
*Don't ask* and it acts on its own tools without waiting and is refused the
rest, which is what makes it autonomous while you are away. *Bypass* is the
one mode never offered here.

## Scheduling it

An automation called **Morning review** ships in its workspace, **disabled**
and set to *Don't ask*, since nobody is there at eight to answer a card.
Enable it on the Automations page and every morning at eight Metaclaude reads
the last twenty-four hours — failures, waiting approvals, new insights,
health — acts on what is reversible and clearly right, and leaves you a short
brief in a session of its workspace. If nothing happened, it says so in two
lines. Any automation you create in that workspace runs with the same tools
and the same rules.

## Language

It writes in the language the application is set to, like everything else
Metaclaude produces — see *Memory and learning*. Switch the app to English and
the next answer is in English; code, paths and command output stay as they
are.
