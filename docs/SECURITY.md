# Security

## The problem

Metaclaude runs an AI agent that executes model-authored shell commands and edits
files in your projects, reachable over the network from your phone. That is a
larger attack surface than most self-hosted tools, and it deserves to be treated
as one.

Three distinct threats:

1. **An attacker on the network**, with no credentials, trying to get in.
2. **Content the agent reads** — a cloned repository, a fetched page — trying to
   steer the agent into doing something you did not ask for.
3. **A stolen data volume**, offline.

---

## Authentication

**Passwords** are hashed with scrypt at N=2¹⁶, r=8, p=1 — about 64 MiB and
~100 ms per verification, comfortably above the OWASP floor. The encoded form is
self-describing (`scrypt$N$r$p$salt$hash`) so parameters can be raised later
without invalidating existing hashes, and a login with an outdated hash
transparently upgrades it.

The policy is length-first, following current NIST guidance: 12 characters
minimum, a block-list of credential-stuffing favourites (including French ones),
and rejection of trivially repetitive strings. No composition rules, because
they push people toward `P@ssw0rd1!`.

**A login for an unknown user still performs a full scrypt verification** against
a pre-computed decoy hash, so response timing cannot enumerate accounts.

**Two-factor authentication** is TOTP (RFC 6238), implemented directly on
`node:crypto`. Verification checks every step in the ±1 window with no early
exit, so timing cannot leak which digit was wrong. Enrolment is two-phase: the
secret is stored immediately but `totp_enabled` stays false until the user proves
they can generate a valid code — which prevents locking yourself out with a
mis-scanned QR code. Ten single-use recovery codes are issued on confirmation
and removed from the stored list the moment one is consumed.

**Brute force** is blunted twice over:

- Per client address: a token bucket (10 attempts, refilling at one per six
  seconds), reset on a successful login so a shared NAT does not punish you.
- Per account: exponential lockout persisted on the user row, so a restart does
  not hand the attacker a fresh budget. Three free attempts, then 2s, 4s, 8s …
  capped at fifteen minutes.

**Sessions** are 256-bit random tokens. Only their SHA-256 is stored, so a
database leak yields no usable session. Two independent expiries: a 14-day idle
window that slides forward (written at most once a minute, so this does not
dominate the WAL) and a 90-day absolute cap. Changing your password revokes every
session including the current one — that is the whole point of changing it after
a suspected compromise.

---

## CSRF

Three independent mechanisms, all of which must fail for a forgery to succeed:

1. **`SameSite=Strict`** on the session cookie. Browser-enforced.
2. **Origin verification.** A cross-origin `Origin` that is not in the allow-list
   is rejected outright.
3. **A double-submit token.** The server issues a second, deliberately readable
   cookie; the client echoes it in `X-Metaclaude-CSRF`. A cross-origin form post
   cannot set a custom header without a successful preflight, and the readable
   cookie carries no authority on its own — only the *pairing* with the httpOnly
   session cookie authorises anything.

The token is re-issuable: if the client loses its copy (cleared cookies, a
restored tab), `/api/auth/me` rotates it rather than leaving a valid session
unable to write.

> An earlier draft of `/api/auth/me` returned the session's stored CSRF *hash*
> under a field named `csrfToken`. That would have leaked the stored hash and
> broken every write. The field is now named `csrfHash` at the type level so the
> mistake cannot be made silently.

### WebSockets

`WebSocket` ignores CORS entirely, so a cross-origin page *can* open a socket and
the browser *will* attach cookies. The defence is the handshake: the first frame
must present the CSRF token, and until it does, every other frame is rejected and
the socket is closed after ten seconds. An attacker page cannot read the CSRF
cookie cross-origin, so it cannot complete the handshake.

---

## Filesystem

Every client-supplied path goes through `resolveInside(root, path)` before a file
descriptor is opened:

- NUL bytes rejected.
- A leading `/` is treated as workspace-relative, never filesystem-root.
- Containment is checked with `path.relative`, not string prefixing — the latter
  would accept `/data/workspaces-evil` as inside `/data/workspaces`.
- **Symlinks are resolved.** A link the *agent itself* planted inside a workspace,
  pointing at `/etc` or at another workspace, is caught. For paths that do not
  exist yet, the nearest existing ancestor is resolved instead.
- A small deny-list (`.git-credentials`, `.netrc`, `master.key`) is never
  addressable.

The test suite includes a real symlink escape against a real temporary directory,
not a mocked one.

Directory listings additionally hide `.git` internals and dependency directories,
and refuse to stat sockets, FIFOs and device nodes — reading one can block
indefinitely.

---

## Command execution

Every git invocation uses `execFile` with an **argv array**. No shell is ever
spawned, so there is no command-injection surface. Where a path could be
mistaken for a flag, `--` terminates option parsing.

Only read and low-risk write operations are exposed: status, diff, log, branches,
stage, unstage, commit. Anything destructive — `reset --hard`, force push,
history rewriting — is deliberately absent from the API. The agent can still do
those through its Bash tool, where they go through the permission prompt and land
in the audit log.

Git clone URLs are validated to `https`, `http` and `ssh`. A `file://` or `ext::`
URL would let a caller read arbitrary host paths or execute a transport helper.
`GIT_TERMINAL_PROMPT=0` and `BatchMode=yes` prevent a clone from hanging on a
credential prompt in a container with no TTY.

---

## The permission system

This is the control that matters most, because it is the one standing between a
model's decision and your filesystem.

Every tool call that writes, deletes, runs a command or reaches the network can
require approval. The prompt shows the **literal** command — the actual string
that will be executed, not a paraphrase — because a summary you cannot verify is
worse than no summary at all.

A heuristic risk badge escalates on patterns like `rm -rf`, `mkfs`, `dd if=`,
fork bombs, `chmod 777`, `curl … | sh`, `git push --force`, `sudo`, and writes to
raw block devices. **High-risk calls never offer "always allow"** — the dangerous
path must not also be the fast path. Deny holds initial focus and is bound to
Escape; approving requires a deliberate click or ⌘Enter.

An unanswered prompt is **denied** after ten minutes, with a message telling the
model to take a different approach rather than retry — a bare "denied" makes
models loop on the identical call.

`bypassPermissions` is refused at three layers unless
`METACLAUDE_ALLOW_BYPASS_PERMISSIONS` is set on the container: the route
validators, the workspace settings endpoint, and the supervisor when it builds
SDK options. A workspace, a session, a run and an automation each check it
independently.

---

## Prompt injection

The agent reads content it does not control: repository files, fetched pages,
tool output. Assume some of it is hostile.

Metaclaude does not claim to solve prompt injection. What it does is make the
consequences bounded and visible:

- **The permission prompt is the backstop.** An injected instruction that leads
  to a destructive command still has to get past a human reading the literal
  command.
- **Retrieved memory is framed as recall, not instruction**, and the model is
  told to prefer what it can verify in the repository right now.
- **Reflexion cannot act.** The pass that writes to memory has no tools, no
  filesystem access, and runs in a scratch directory. It reads text and returns
  JSON.
- **Generated skills are never auto-installed.** A proposal enters a review queue.
- **Model output is treated as untrusted** by the frontend renderer.

---

## XSS

Assistant output is rendered as markdown, and it can contain anything the model
read. It goes through an allow-list sanitiser:

`marked` produces HTML with a custom renderer that escapes all code, drops raw
HTML entirely, and refuses to emit `<img>` (an image tag is a request to an
arbitrary host, which would leak that this instance rendered a given transcript).
That HTML is then parsed into a detached `<template>` and the tree is walked with
an explicit tag and attribute allow-list — parsing first is what closes the
mutation-XSS class, because the browser's own parser resolves every ambiguity
before we inspect it.

URLs are scheme-checked **after** stripping control characters, so `java\nscript:`
and `javascript:` are both blocked. Links get
`rel="noopener noreferrer nofollow"`.

A strict CSP backs this up: `script-src 'self'`, `object-src 'none'`,
`frame-ancestors 'none'`, no external origins of any kind.

---

## Secrets at rest

MCP servers need API keys. Each value is sealed with AES-256-GCM under a 32-byte
master key, with a random 96-bit IV per write and AAD binding the ciphertext to
its `(scope, key)` slot — so a row cannot be silently moved to a different slot.

**No endpoint returns a decrypted secret.** Only key *names* are stored on the
server row and returned by the API. Because of that, an edit form cannot
round-trip a value, so submitted secrets are *merged* over what is stored rather
than replacing it — otherwise renaming a server would silently destroy every
credential. Deleting one is an explicit act.

The master key comes from `METACLAUDE_MASTER_KEY`, or is generated on first boot
and stored at `/var/lib/metaclaude/master.key` with mode 0600. At startup the
vault self-tests every stored secret and logs loudly if decryption fails, turning
a wrong key into an immediate, actionable error instead of a confusing MCP
failure hours later.

**Back up that key with your data volume.** Without it, stored secrets are
unrecoverable — by design.

---

## Audit

Every meaningful action is recorded, and each entry commits to the hash of the
one before it:

```
hash(n) = SHA-256( hash(n-1) ‖ id ‖ timestamp ‖ actor ‖ action ‖ target ‖ ip ‖ outcome ‖ detail )
```

An attacker with write access to the database can delete rows, but cannot
silently rewrite history: `verifyChain()` — exposed as a button in Settings —
detects any edit, reorder or gap.

Two subtleties that took a bug each to get right:

- The chain is ordered by **`rowid`** (insertion order), not by timestamp. Ids
  carry a random suffix, and a single login writes several entries in the same
  millisecond; ordering by `(at, id)` chained onto the wrong predecessor and
  permanently reported tampering on an untouched log.
- Retention pruning **re-anchors** the surviving chain. Deleting old rows
  necessarily breaks the links, so the survivors are rehashed from genesis.
  Retention is an operator decision; it must not leave verification broken
  forever.

Logs are redacted aggressively — cookies, authorization headers, the CSRF header,
`Set-Cookie`, and any field named like a password, token, key or secret.

---

## Container

| Control | Setting |
|---|---|
| User | uid 10001, non-root |
| Capabilities | `cap_drop: ALL` |
| Privilege escalation | `no-new-privileges:true` |
| Root filesystem | read-only |
| `/tmp` | tmpfs, `nosuid`, 1 GB |
| Resources | CPU and memory limits, `nofile` and `nproc` ulimits |
| Network | internal-only; the app publishes **no** host port |
| Signals | `tini` as PID 1, so CLI subprocesses are reaped |

`/tmp` is `nosuid` but deliberately **not** `noexec`: build tooling the agent
legitimately runs (node-gyp, cargo, pip) executes helpers it writes there.
Forbidding that breaks ordinary development work rather than an attack.

The only route in is Caddy, which terminates TLS, sets HSTS, `nosniff`,
`X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, a restrictive
`Permissions-Policy`, and `X-Robots-Tag: noindex`.

---

## Deployment advice

**Do not expose this to the open internet unless you need to.** The strongest
control available is not in this codebase: put it on a private network. A
Tailscale or WireGuard address, with `METACLAUDE_DOMAIN` pointing at it, gives
you access from every device with no public attack surface at all.

If you do expose it publicly:

- Turn on TOTP. It is one screen.
- Leave `METACLAUDE_ALLOW_BYPASS_PERMISSIONS` unset.
- Set a cost ceiling per workspace, so a runaway loop is bounded in money as well
  as in failures.
- Check the audit log occasionally, and verify the chain.
- Keep the image updated — the pinned Claude CLI version is a deliberate,
  reviewable bump.

## Reporting

This is a personal tool, not a product with a security team. If you find
something, the fix is yours to make — the code is small and the tests are
thorough enough to change it with confidence.
