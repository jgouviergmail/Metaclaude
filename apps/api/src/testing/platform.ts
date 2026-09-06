/**
 * Tests that can only be true where the product runs.
 *
 * A handful of cases assert POSIX absolute paths verbatim — `/srv/metaclaude/
 * workspaces/a`, `/etc/passwd` — and they do it on purpose: `CLAUDE.md` says a
 * containment rule needs a case "under the layout that actually ships", and
 * what ships is a Linux container. `resolve()` on Windows turns those into
 * `D:\srv\metaclaude\workspaces\a`, so the assertion compares two different
 * worlds and fails. Symlink creation needs a privilege there too.
 *
 * Fourteen of them failed on the maintainer's Windows machine, permanently.
 * That is worse than it sounds: a suite with a standing red block teaches you
 * to read past red, which is exactly how a real failure hides — and it made
 * `pnpm verify` unable to pass locally, so the one command that would have
 * caught a typecheck error nobody ran was a command nobody could run.
 *
 * Skipping is the honest answer, not weakening the assertion: the case still
 * runs in CI, on the platform it describes, and it says out loud why it did
 * not run here. Never reach for this to quieten a case that is merely
 * inconvenient — if it can be true on Windows, make it true.
 */

/** True where POSIX absolute paths and symlinks behave as the image expects. */
export const POSIX = process.platform !== 'win32';
