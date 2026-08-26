# Workspaces and files

A workspace is a directory plus a policy: where the agent works, and the rules
that apply while it does.

## Creating one

**Workspaces → New workspace.** A name is enough; a git URL clones a
repository into it at creation. A workspace that started empty can be
connected to a repository later from its **Git** panel — into an empty
directory it clones; into one with files it adds the remote and fetches,
leaving the merge to you so nothing you have is silently overwritten.

Each workspace carries its own defaults — model, effort, permission mode,
thinking budget, memory and reflexion toggles, tool allow/deny lists — under
its **Settings** tab. Session-level and message-level choices override them.

## Files

The **Files** panel is a real browser and editor over the workspace: create,
edit, upload, download, delete. It is jailed — paths cannot escape the
workspace, symlinks included, and a few names (`.git` internals, credentials
files) are not addressable through it at all. The agent works with git through
its own tools, which go through the permission prompt; the file panel is your
direct door.

## Git

The **Source control** panel shows status and diffs, stages files, and
commits. The identity on those commits is the one configured at deployment.
Pushes and anything credentialed go through the agent — with a permission
prompt — rather than through the panel, so a credential never lives in the
browser.

## CLAUDE.md

Every workspace gets a starter `CLAUDE.md`. It is read at the start of every
session: build commands, conventions, things to avoid. It is yours — the
system never rewrites it. The learned memory lives alongside, not inside.

## Archiving and deleting

Archiving hides a workspace without touching files. Deleting asks separately
about the files, and purging them is deliberately explicit — losing an agent's
work to a mis-click is not recoverable.
