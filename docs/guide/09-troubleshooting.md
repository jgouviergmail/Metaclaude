# Troubleshooting

The failures people actually hit, and what each one means. The operator-side
diagnostics — container logs, boot self-checks, the external verifier — are in
the repository's deployment guide; this page is the view from the interface.

## Start with the doctor

Before hunting a specific symptom, **Settings → System → Doctor → Run checks**
(owner only). It runs every self-check the system knows — database integrity,
the audit chain, the secrets vault, disk space on both volumes, the age of
the last completed backup, whether anything can reach the internet from this
container at all, the Claude CLI and its credential, and any automation the
failure guard switched off — and answers with a verdict per
check plus the evidence. It reads and reports; nothing is changed.

## "The doctor warns about backups"

The server backs itself up nightly: a host-side timer stops the app for a
few seconds, archives the database, workspaces, CLI sessions and the TLS
authority, restarts, and leaves a marker the doctor reads. The warning means
that marker is missing or more than a day old — backups have stopped, or
were never set up. On a server installed before this existed, re-running
`deploy/install-app.sh` from the repository adds the timer; the operator
detail (where archives land, retention, restoring one) is in the
repository's `docs/DEPLOYMENT.md`. The one thing no nightly job can do for
you: keep a copy of the master key somewhere that is not this server.

## "A run is stuck on Working"

First, check for an open permission prompt — a run waiting for your approval
is working, from its point of view. If there is none and nothing streams for
minutes, press **Stop**: the turn ends cleanly, the transcript is kept, and
the run records as interrupted. A follow-up message resumes the same
conversation. If every run does this, the deployment is behind: this exact
symptom was a bug fixed in 0.1.0, and an operator rebuild picks up the fix.

## "The model I expect is not in the picker"

The picker lists what the **CLI inside the deployment** reports, not what
your other devices show — apps update themselves; your server updates when
the operator rebuilds. Check **From Claude** for the live list, refresh it,
and if the model is still absent the pinned CLI needs a rebuild to advance.

## "My second factor is refused"

Codes are time-based and single-use: wait for the next code rather than
retrying the same one, and check the device clock — a phone more than a
minute adrift generates codes the server rightly refuses. Locked out
entirely, a recovery code signs you in once; then re-enrol.

## "The agent cannot see a file I know exists"

If the path is outside the workspace, that is the jail doing its job — grants
beyond the workspace are a server policy, not something a prompt can widen.
Inside the workspace, note that a few names are deliberately unaddressable
through the file panel (`.git` internals, credential files); the agent's own
git tools reach git state through the permission prompt instead.

## "An automation stopped firing"

Open it: a banner says why. The usual causes are its consecutive-failure
limit (fix the underlying failure, then re-enable) or an overlap — firings
are skipped while the previous run is still going, so a too-tight interval
around a slow prompt fires less often than its schedule says.

## "The agent will not search the web"

Three different things wear this face, and the doctor separates the first from
the other two.

**Nothing can leave the container.** Run the doctor: if its *network* check
fails, no run works at all — the CLI cannot reach the API, `git clone` cannot
resolve a remote, and no HTTP MCP server connects. That is a deployment fault,
not a permission one.

**The run was not allowed to.** Under **Don't ask** — which is where every
automation and every MCP gateway call should be — a tool that this workspace
does not pre-approve is refused outright, with no card and no waiting. Tick
*Web search* (and *Fetch a page*, if it needs to read a page you name) under
**Workspace settings → Pre-approved tools**. The run's timeline ends with a
line naming whatever it was refused, so the transcript will already say which
tool it wanted.

**Nobody answered.** In **Ask** or **Accept edits** the run raises an approval
card and holds. If nobody is there, the card expires after ten minutes and is
declined — which is why an unattended run belongs on *Don't ask* with a
pre-approval list rather than on a mode that waits.

## "The agent cannot open a page in a browser"

It cannot, and that is a property of the deployment rather than a setting.
There is no browser in the container and none can be installed into it: the
image ships no Chromium and none of the libraries one needs, the filesystem is
read-only outside the volumes, and the agent runs as an unprivileged user with
every Linux capability dropped — so `apt-get` refuses, and a browser downloaded
into the home volume would not start.

That is deliberate. A browser is a large, network-facing attack surface next
to a process that already executes model-authored commands, and it would not
fit the memory a small VPS has to spare.

What to reach for instead:

- **Fetch a page** reads a URL you or the agent names and hands its content to
  the model. It covers nearly everything people want a browser for: reading
  documentation, a changelog, an issue, an API response.
- **Web search** finds the pages worth fetching.
- For a site that only yields to a real browser — one behind a login, or an
  application rendered entirely client-side — an MCP connector that runs the
  browser *elsewhere* is the honest answer. **Settings → Connections** lists
  the vetted ones; anything that scrapes on your behalf from its own
  infrastructure works here, while anything that expects to drive a browser on
  this machine will not.

## "My MCP token is refused"

Every refusal answers the same way — 401, with no detail — because saying
*which* reason applies would tell an unauthenticated caller that a token id
exists. Check these in order: the token has not been revoked or expired (the
listing under Settings → Connections, which shows both and tells them
apart), the
value is sent as an `Authorization: Bearer` header rather than in the URL, and
the address ends in `/api/gateway/mcp`.

Two failures that look like a bad token and are not. A **403** means the request
carried an `Origin` header: something is calling from a browser, and the gateway
refuses that on purpose. And a client reporting a broken server while every call
works is usually reaching the endpoint over the wrong URL entirely — a proxy
that rewrites the path, or `http` where the deployment is `https`.

If a tool answers "there is no workspace called…" for one you can see, the
token was not given that workspace. That is the same answer it gives for a
workspace that does not exist, deliberately; edit is not offered, so mint a new
token with the right reach and revoke the old one.

## "A certificate warning appeared"

By IP, the deployment uses its own certificate authority — install its root
once per device, or reach the server by its hostname, which carries a
publicly trusted certificate. A warning on the *hostname* is worth reporting
to your operator, not clicking through.
