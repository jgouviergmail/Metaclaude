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

## The three ideas worth knowing on day one

- **Nothing irreversible happens without you.** The default permission mode
  asks before writes, deletions, commands and network access. Plan mode
  executes nothing at all.
- **The system learns, and shows its work.** Which model suits which task,
  which memories helped — all of it is visible in Analytics and Memory, and
  all of it can be reset.
- **It is yours.** Self-hosted, running your subscription, talking to no API
  of ours. The Security chapter says exactly what that means.
