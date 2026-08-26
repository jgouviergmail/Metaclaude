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
a pre-computed decoy hash, so response timing cannot enumerate accounts. The
locked-account path does the same work before answering, for the same reason:
returning early made a locked account measurably faster than a name that does
not exist.

What timing closes, the status code does not. A locked account answers `429`
where an unknown name answers `401`, so someone willing to spend five requests
per candidate can learn that a username exists. That is deliberate: an owner
locked out of their own server needs to be told so, and told when it lifts.
The disclosure is one username, on a deployment that already answers
`/api/auth/bootstrap-status`, against a ten-token bucket refilling at one per
six seconds, writing an audit line per probe and leaving the real account
locked where the owner will notice.

**Two-factor authentication** is TOTP (RFC 6238), implemented directly on
`node:crypto`. Verification checks every step in the ±1 window with no early
exit, so timing cannot leak which digit was wrong.

Enrolment is two-phase, and both phases needed a fix:

- The candidate secret is **staged** in `totp_pending_secret`, and only a correct
  code promotes it. Writing it straight to `totp_secret` and clearing
  `totp_enabled` — the obvious implementation — meant that *starting* an
  enrolment silently switched 2FA off, reachable with nothing but a stolen
  session cookie and neatly around the password that disabling demands.
- Starting an enrolment therefore **costs a password**, and is audited, exactly
  like disabling: re-enrolling replaces the second factor, so it carries the same
  authority as removing it.

`totp_enabled` stays false throughout, so a mis-scanned QR code cannot lock you
out. Ten recovery codes are issued on confirmation.

**Both kinds of second factor are single-use, and that is enforced by the write
rather than by a check before it.** A TOTP code is valid across a ±1 period
window — about ninety seconds — and a recovery code until it is spent, so each
is recorded as consumed: the counter for TOTP, removal from the list for a
recovery code. Each is committed by an `UPDATE` carrying its own precondition in
the `WHERE`, and a statement that changes no rows means another request got
there first. That matters because verifying the password costs ~100 ms of
scrypt, and everything after it would otherwise be deciding against a snapshot
of the account taken before that: two logins submitted together with one code
both succeeded, and two with one recovery code issued two sessions while
consuming a single code.

A code that was merely already spent is refused but not counted toward the
lockout: a resubmitted sign-in form is not a guess, and two enrolled devices
whose clocks differ inside the drift window would otherwise lock the account out
with codes that were correct when they were shown.

Turning 2FA off clears the consumed counter with the secret it counted, and a
stored counter that this clock could not have produced is ignored — otherwise a
host whose clock ran fast and was then corrected refused every code until real
time caught up, with no way back through the product.

**Brute force** is blunted twice over:

- Per client address: a token bucket (10 attempts, refilling at one per six
  seconds), reset on a successful login so a shared NAT does not punish you. The
  address is taken from the **rightmost** `x-forwarded-for` entry, and only when
  `METACLAUDE_TRUST_PROXY` is set. The header grows left to right and each proxy
  *appends*, so the last element is the one our own proxy vouches for and
  everything left of it came from the caller: keying on the leftmost entry — the
  default for `trustProxy: true` — would let a client pick a fresh bucket per
  request and walk straight through this lockout. Fastify is configured with a
  one-hop trust function for the same reason, so `request.ip` agrees.
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
- A small deny-list (`.git`, `.git-credentials`, `.netrc`, `master.key`) is
  never addressable. `.git` is on it in both directions: a credentialed clone
  leaves a token in `.git/config`, and several git settings name a command git
  will later execute — so an unprompted HTTP write there would be an
  approval-free path to command execution.

The test suite includes a real symlink escape against a real temporary directory,
not a mocked one.

Directory listings additionally hide `.git` internals and dependency directories,
and refuse to stat sockets, FIFOs and device nodes — reading one can block
indefinitely.

Deleting or moving compares the target against the **resolved** root. Comparing
against the raw argument let a root passed with a trailing slash slip past the
guard, and `rm -r` then took the whole workspace.

**`additionalDirectories`** — the per-workspace setting that widens a run's
filesystem scope — is validated on save *and* again on every run. An entry must
live under the workspaces root, must not be the root itself, and must neither be
nor contain the data directory. Every one of those tests runs against the
**resolved** path: they compare places on disk, not spellings, so a symlink
named like a workspace cannot stand in for the directory it points at.
Unvalidated it was a straight escalation: `/` hands the agent the container, and
the data directory hands it the database (session and password hashes, the
sealed vault) plus `master.key`. None of it would raise an approval prompt,
because from the CLI's point of view the directory is simply in scope.

What this **cannot** bound is a symlink the agent creates *inside* a directory
it was already granted. Any such link postdates every check, so no path-based
validation could see it; the same is true of the agent's own workspace, which is
why this is a property of directory grants rather than a gap in the check.
`security/directories.test.ts` asserts that limit explicitly rather than
implying a defence that does not exist. Grant a directory only if you would be
content for the agent to reach anything reachable *from* it, and note that the
shipped image places the workspaces root inside the data directory — so on that
layout the containing directory holds `master.key` and the database.

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

That covers HTTP **headers** too, not just the env map. An HTTP MCP server
authenticates through `Authorization`, so a header value is a credential far more
often than it is metadata; keeping the map on the row put a bearer token in
plaintext and handed it to anyone who could read the server list. Header names
live on the row, values in the vault under a `header:` slot prefix that keeps
them distinct from an env var of the same name. A database upgraded from an
earlier build drains its plaintext headers into the vault on first boot.

The master key comes from `METACLAUDE_MASTER_KEY`, or is generated on first boot
and stored at `/var/lib/metaclaude/master.key` with mode 0600. At startup the
vault self-tests every stored secret and logs loudly if decryption fails, turning
a wrong key into an immediate, actionable error instead of a confusing MCP
failure hours later.

**Back up that key with your data volume.** Without it, stored secrets are
unrecoverable — by design.

**Rotating the key is not supported, and the order matters.** There is no
re-seal command: `resolveMasterKey` loads a key or generates one, and nothing
re-encrypts an existing vault under a new one. Changing the key first therefore
makes every stored ciphertext permanently unreadable — the server starts
happily, and the secrets are simply gone.

If you need to change it, re-enter every MCP secret through the UI *after*
bringing the stack up with the new key, having noted the values beforehand.
`docker compose logs app | grep -i 'could not decrypt'` tells you what did not
survive. This is a different thing from rotating `CLAUDE_CODE_OAUTH_TOKEN`,
which has no ciphertext behind it and is an ordinary `.env` edit.

---

## Audit

Every meaningful action is recorded, and each entry commits to the hash of the
one before it:

```
hash(n) = SHA-256( hash(n-1) ‖ id ‖ timestamp ‖ actor ‖ action ‖ target ‖ ip ‖ outcome ‖ detail )
```

`verifyChain()` — exposed as a button in Settings — recomputes the chain and
reports any entry whose hash no longer matches.

**Be precise about what that buys you.** The chain is a plain SHA-256 with no
key, and the chaining rule is in this repository. It catches an edit, a
reordering, a deletion or a partial-write corruption made *without* rehashing —
which is what a careless edit, a botched restore or a failing disk produces. It
does **not** stop an attacker who has write access to the database and knows the
scheme: they can rewrite an entry and recompute every hash after it, and the
result verifies clean. Keying the chain would not close that either, because the
only key available is `master.key`, which sits on the same volume as the
database.

Detecting a deliberate, informed rewrite needs an anchor the attacker cannot
reach — shipping entries to an append-only store off the host, or publishing the
head hash somewhere they do not control. Neither is built in. Treat the audit log
as a reliable record of what the *application* did, and as evidence of
corruption, not as proof against a host-level intruder.

Two subtleties that took a bug each to get right:

- The chain is ordered by **`rowid`** (insertion order), not by timestamp. Ids
  carry a random suffix, and a single login writes several entries in the same
  millisecond; ordering by `(at, id)` chained onto the wrong predecessor and
  permanently reported tampering on an untouched log.
- Retention pruning **re-anchors** the surviving chain. Deleting old rows
  necessarily breaks the links, so the survivors are rehashed from genesis.
  Retention is an operator decision; it must not leave verification broken
  forever.

Logs redact the cookie, `Authorization` and CSRF request headers, `Set-Cookie`
on the response, and the fields `password`, `passwordHash`, `token`,
`oauthToken`, `apiKey`, `secret` and `totpSecret` — at the top level and one
level down (`*.password` and friends).

That list is exact rather than a principle, because pino's wildcard matches
exactly one level: a credential nested two deep would print. Nothing in the
codebase logs such a shape today — every structured call site logs `{ err }`,
`{ err: error.message }` or `{ err, url }` — so this is a bound on the
redaction, not a known leak. Add the field here as well as to `logger.ts` if a
new one appears.

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
| Network | the app publishes **no** host port; inbound only through the TLS proxy. Egress is open by design — see below |
| Signals | `tini` as PID 1, so CLI subprocesses are reaped |

`/tmp` is `nosuid` but deliberately **not** `noexec`: build tooling the agent
legitimately runs (node-gyp, cargo, pip) executes helpers it writes there.
Forbidding that breaks ordinary development work rather than an attack.

The only route in is Caddy, which terminates TLS, sets HSTS, `nosniff`,
`X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, a restrictive
`Permissions-Policy`, and `X-Robots-Tag: noindex`.

**Egress is not a control here, and nothing above should be read as claiming it
is.** The app container joins both the `internal` network, which reaches the
proxy, and `public`, which is what lets it reach *out* — and without that
nothing the product does works: the Claude CLI cannot call the Anthropic API,
`git clone` cannot resolve a remote, and no HTTP MCP server is reachable. The
approval prompt, not the network, is what stands between a model-authored tool
call and the outside world; that is why every call that reaches the network can
require one.

---

## Deployment advice

**Do not expose this to the open internet unless you need to.** The strongest
control available is not in this codebase: put it on a private network. A
Tailscale address, with `METACLAUDE_SITE` set to the `ts.net` name and
`METACLAUDE_BIND` to the tailnet address, gives you access from every device
with no public attack surface at all — and, because `tailscale cert` issues a
genuinely trusted certificate for that name, without the per-device certificate
install a private CA would need. See docs/DEPLOYMENT.md.

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
