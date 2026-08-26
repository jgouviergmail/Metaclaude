# Troubleshooting

The failures people actually hit, and what each one means. The operator-side
diagnostics — container logs, boot self-checks, the external verifier — are in
the repository's deployment guide; this page is the view from the interface.

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

## "A certificate warning appeared"

By IP, the deployment uses its own certificate authority — install its root
once per device, or reach the server by its hostname, which carries a
publicly trusted certificate. A warning on the *hostname* is worth reporting
to your operator, not clicking through.
