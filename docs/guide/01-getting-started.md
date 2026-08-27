# Getting started

Metaclaude is your private agentic OS: Claude Code with an interface, a memory,
a schedule and a policy that learns — running on your own server, on your own
Claude subscription.

## First sign-in

1. Open your Metaclaude address and sign in with the owner account created at
   installation.
2. Go to **Settings → Two-factor authentication** and enrol immediately: scan
   the QR code with any authenticator app, confirm one code, and store the
   recovery codes somewhere safe. They are shown exactly once and each works
   exactly once.

The dashboard greets a fresh deployment with a **Getting set up** checklist:
pair Claude, create a workspace, run the agent once, two-factor,
notifications, the host updater — each step a link to the screen where it
happens, ticked off as the deployment learns to do it. It disappears when
everything is done, and its ✕ dismisses it for good if you prefer to find
your own way.

## Your first run

1. **Workspaces → New workspace.** A workspace is a directory plus the agent
   policy that applies inside it. Give it a name; optionally paste a git URL to
   start from a repository.
2. Open the workspace and start a **session**. Type what you want done.
3. Watch the transcript stream: the agent's reasoning, its tool calls, and —
   whenever it wants to do something it cannot undo — a **permission prompt**
   showing the literal command, waiting for your decision.

Everything after that is refinement: the model and effort pickers under the
composer, the memory the system accumulates about your projects, the
automations that run without you. The rest of this guide takes them one at a
time.

## The brief

For the owner, the dashboard opens with **The brief** — one card answering
"what happened, what needs me" for the last 24 hours: a headline, the
failures linked straight into their sessions, approvals waiting, the
automations the failure guard switched off, the doctor's verdict, insight
growth, and the quota window closest to its ceiling. It is composed from the
server's own records, so it costs nothing and is always current.

## The three ideas worth knowing on day one

- **Nothing irreversible happens without you.** The default permission mode
  asks before writes, deletions, commands and network access. Plan mode
  executes nothing at all.
- **The system learns, and shows its work.** Which model suits which task,
  which memories helped — all of it is visible in Analytics and Memory, and
  all of it can be reset.
- **It is yours.** Self-hosted, running your subscription, talking to no API
  of ours. The Security chapter says exactly what that means.
