# Deployment

Metaclaude runs on one Linux server that you control. This document takes it
from a freshly-provisioned box to a deployment you can update from GitHub, and
tells you what to do when a step goes wrong.

The target this was written against: **a VPS with a public IP and no domain
name**, reached from a laptop, a tablet and a phone.

> **Before anything else.** Confirm your provider's VNC or serial console works,
> and log into it once. Every mistake below is a five-minute fix with console
> access and a rebuild without it. This is not general advice — it is the
> difference between an inconvenience and starting over.

---

## The one decision that shapes everything: how you get TLS

Metaclaude sets a `Secure` session cookie and registers a service worker. Both
require a **secure context**. Over plain HTTP the browser refuses to store the
session and refuses to register the worker, so the app does not become less
safe — it stops working. There is no "HTTP for now" option.

Without a domain name there is no ordinary certificate, so this is a real
choice. Four modes, selected by one variable, `METACLAUDE_TLS_MODE`.

### The comparison

| | `file` (Tailscale) | `acme-ip` | `internal` | `acme-dns` |
|---|---|---|---|---|
| Browser warning | none | none | until you install the CA | none |
| Setup per device | install Tailscale | none | install a certificate, twice on iOS | none |
| PWA installs on iPhone | yes | yes | only after the CA is trusted | yes |
| Inbound ports needed | **none** | 80 and 443, permanently | none | 80 or 443 |
| Needs a domain | no | no | no | **yes** |
| Certificate lifetime | 90 days | **160 hours** | 1 year | 90 days |
| Fails if you… | lose the tailnet | are firewalled 2 days | lose `caddy-data` | lose DNS |

### `file` — Tailscale. The recommendation.

You get a real hostname (`metaclaude.your-tailnet.ts.net`) and a genuinely
publicly-trusted certificate, without owning a domain. And the decisive part:
**the server needs no inbound ports at all.** It stops being scannable. For a
box that executes model-authored shell commands, removing it from the public
internet is worth more than every other control in this document combined.

```bash
# On the server
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up
tailscale cert --cert-file /opt/metaclaude/docker/certs/metaclaude.crt \
               --key-file  /opt/metaclaude/docker/certs/metaclaude.key \
               "$(tailscale status --json | jq -r .Self.DNSName | sed 's/\.$//')"
```

```bash
# /opt/metaclaude/.env
METACLAUDE_SITE=metaclaude.your-tailnet.ts.net
METACLAUDE_TLS_MODE=file
METACLAUDE_BIND=100.x.y.z          # tailscale ip -4
```

Three honest costs:

- Every device needs the Tailscale app connected, with MagicDNS on.
- **Your machine and tailnet names go into public Certificate Transparency logs,
  permanently.** Choose a neutral machine name and keep Tailscale's generated
  random tailnet name *before* you enable HTTPS. This cannot be undone.
- Tailscale controls the DNS zone and could therefore issue certificates for
  your names. That is the same trust you already place in a registrar, but it is
  a real party in the chain.

`tailscale cert` does **not** renew on its own. Add a daily timer that re-runs
it and then `docker compose kill -s HUP proxy`.

If Docker starts before tailscaled has an address, binding to `100.x.y.z` fails
with "cannot assign requested address". Add `After=tailscaled.service` to the
docker unit (`systemctl edit docker.service`); `restart: unless-stopped` is the
backstop. The address is stable for the life of the node, so this is a
boot-ordering problem, not a churn problem.

### `acme-ip` — a real certificate for the bare IP

Let's Encrypt has issued for IP addresses since January 2026. No VPN, no device
setup, no warning. The constraints are sharp and worth reading before choosing:

- **Only the `shortlived` profile issues for IPs: 160-hour certificates.** Caddy
  renews with roughly 53 hours of slack. Two days firewalled or offline and every
  device gets a hard error. There is no 30-day grace period to save you.
- Only `http-01` (port 80) and `tls-alpn-01` (port 443) can validate an IP;
  `dns-01` cannot, by construction. Both ports must stay reachable **forever**,
  not just at first issuance.
- **Five certificates per identifier per 7 days, with no override.** Get it
  wrong five times and you wait a week. Set `METACLAUDE_ACME_DIR` to
  `https://acme-staging-v02.api.letsencrypt.org/directory` while you iterate.
- Requires the pinned `caddy:2.11.4-alpine`. Earlier releases hand IP subjects
  to the internal CA and never even try.
- Your IP, and the fact something is served on it, land in public CT logs.
- Private ranges are refused outright — RFC1918, and CGNAT `100.64/10`, which is
  what Tailscale uses. This mode needs a genuinely public address.

We have not found a first-hand report of Caddy issuing an LE IP certificate in
production. **Test against staging first.** If it does not work, the fallback is
`acme.sh --certificate-profile shortlived` writing into `docker/certs/` and
switching to `file` mode.

### `internal` — Caddy's own certificate authority

Works with nothing at all: no DNS, no third party, no open ports beyond your
own. It is the default because it is the only mode that always works.

The cost is per-device trust:

```bash
docker compose exec proxy \
  cat /data/caddy/pki/authorities/local/root.crt > metaclaude-ca.crt
```

- **macOS** — open it, add to the login keychain, set to *Always Trust*.
- **iOS/iPadOS — two steps, and missing the second is the usual failure.**
  1. Email or AirDrop the file, then Settings → Profile Downloaded → Install.
  2. **Settings → General → About → Certificate Trust Settings**, and enable
     full trust for it. Until you do, the origin is not secure and the PWA will
     not install.
- **Android** — Settings → Security → Encryption & credentials → Install a
  certificate → CA certificate.

Two things to know before choosing this long-term:

- **Set `METACLAUDE_PROTOCOLS="h1 h2"`.** Chrome will not use QUIC against a
  locally-installed trust anchor, so HTTP/3 is advertised, declined, and falls
  back to TCP — leaving a UDP port open for nothing.
- **Back up the `caddy-data` volume.** Lose it and Caddy mints a brand-new CA.
  Once a browser has recorded this site's HSTS header, the resulting mismatch is
  an interstitial you *cannot click through*.

### `acme-dns` — if you do get a domain later

The ordinary case. Point a name at the server, set `METACLAUDE_TLS_MODE=acme-dns`
and `METACLAUDE_TLS_EMAIL`, and nothing else changes.

Nothing else changes because nothing else is asked of you: Caddy requests the
certificate itself at first start, proves control of the name by answering a
challenge Let's Encrypt fetches over port 80, and renews at about two-thirds of
the 90-day lifetime. There is no command to run and no cron to add. What the
email is for is expiry warnings, and it is never shown to visitors.

Three things have to hold, and all three fail loudly in the Caddy log:

1. the name resolves to this server;
2. ports 80 **and** 443 are reachable from the internet — 80 carries the
   challenge even though the site itself redirects away from it;
3. nothing terminates TLS in front (the grey cloud, not the orange one).

**The one limit worth knowing before you iterate.** Production allows five
*duplicate* certificates per week for the same set of names, with no override
and no appeal. A reinstall that discards the `caddy-data` volume asks for a
fresh one every time, so a few rounds of "wipe it and try again" spend the
quota and lock the name out for days. Two defences, and they compose:

- back up `caddy-data` with the other volumes and restore it, which reuses the
  certificate instead of asking for another;
- rehearse on `METACLAUDE_TLS_MODE=acme-dns-staging`, which is the same mode
  against Let's Encrypt's staging directory — effectively unlimited, and
  untrusted, so browsers warn and the app genuinely does not work there. Prove
  the chain with `curl -k` and the log, then switch to `acme-dns` and restart.
  Caddy keys stored certificates by issuer URL, so the switch requests a real
  one rather than reusing the staging cert; nothing needs clearing by hand.

Staging is a separate mode rather than a variable on this one because `tls
<email>` uses Caddy's default *issuer pair* — Let's Encrypt with a ZeroSSL
fallback. Naming a single issuer to make the directory configurable would drop
that fallback from the production path in exchange for a knob only used while
rehearsing.

> **Not chosen:** `sslip.io`/`nip.io` gives you a name, but it is not on the
> Public Suffix List, so you share one rate-limit bucket with the whole
> internet, and a volunteer DNS service becomes a hard dependency of your
> hostname. Cloudflare Tunnel needs a domain for a named tunnel, and Cloudflare
> sees your plaintext.

---

## First run

Steps 2 to 5 can be run as a single command once you have the keys from step 1:

```bash
sudo ./deploy/bootstrap.sh \
  --admin-key  "$(cat ~/.ssh/metaclaude_admin.pub)" \
  --deploy-key "$(cat ~/.ssh/metaclaude_deploy.pub)"
```

It calls the same two scripts in the same order, prompts for the three secrets
that cannot be generated, generates the ones that can, and starts the stack. The
lockout guards are unchanged and still interactive — including the confirmation
from a second SSH session — so run it somewhere you can answer them.

**No registry credential is ever required.** By default it runs the image CI
published for the commit you are standing on, `ghcr.io/<owner>/<repo>:sha-<sha>`.
If that image cannot be pulled — the package is private, or CI has not finished
this commit — it builds the same source, on the spot, and says which of the two
happened. Three consequences worth knowing:

- A GHCR package attached to a **private repository is private too**, and making
  the repository public does not change that. They are separate settings. If you
  want the pull to work, flip the package's own visibility, or run
  `docker login ghcr.io` before the script.
- `--build` skips the registry entirely. It is the only way to deploy a change
  you have not committed and pushed.
- Building needs about 2 GB of memory. On a 1 GB VPS the bundler is OOM-killed
  and Docker reports a bare `exit code 137`; add swap first. The script checks
  and warns before spending the time.

The steps are written out below anyway. A script that provisions your only
server is not one to run without knowing what it does.

### 1. Keys, generated on your laptop

Two, never one. They have different authority and different blast radius.

```bash
ssh-keygen -t ed25519 -a 100 -f ~/.ssh/metaclaude_admin  -C "admin@laptop"
ssh-keygen -t ed25519 -a 100 -f ~/.ssh/metaclaude_deploy -C "github-actions-deploy"
```

The admin key never leaves your laptop. The deploy key's private half goes into
a GitHub environment secret and nowhere else.

### 2. Provision

```bash
git clone https://github.com/jgouviergmail/Metaclaude.git && cd Metaclaude

sudo ./deploy/provision.sh \
  --admin-key  "$(cat ~/.ssh/metaclaude_admin.pub)" \
  --deploy-key "$(cat ~/.ssh/metaclaude_deploy.pub)" \
  --mode public          # or: --mode vpn --vpn-interface tailscale0
```

Accounts, sshd, ufw, Docker, fail2ban, unattended upgrades. Idempotent.

It stages every step that could lock you out: the admin key is confirmed present
before password login is disabled, the result is asserted against `sshd -T`
rather than the file it wrote, SSH is allowed before the firewall comes up, and
enabling the firewall **arms a dead man's switch** that disables it again in ten
minutes unless you confirm — from a second, new connection — that you are still
reachable. Answer that prompt honestly.

### 3. Install the application files

```bash
sudo ./deploy/install-app.sh
```

`compose.yml`, the Caddyfile, the TLS snippets and the deploy command, all owned
by root. The deploy account can run them and cannot edit them.

### 4. Configure

```bash
sudo -e /opt/metaclaude/.env
```

The ones that matter:

```bash
CLAUDE_CODE_OAUTH_TOKEN=       # `claude setup-token` where you are signed in
METACLAUDE_BOOTSTRAP_PASSWORD= # ≥ 12 chars, creates the owner account
METACLAUDE_MASTER_KEY=         # openssl rand -hex 32
METACLAUDE_SITE=               # your IP, or the Tailscale name
METACLAUDE_TLS_MODE=           # internal | acme-ip | file | acme-dns
METACLAUDE_BIND=0.0.0.0        # or the Tailscale address. Default is loopback.
```

**A dollar sign in any of these values needs quoting.** Compose expands `.env`
before the container sees it, so `pa$sword` arrives as `pa` — the login simply
fails, with nothing in any log to say why. Write it `"pa$$sword"`. Quote the
value either way if it begins with `'` or `"`, or compose rejects the whole file
and every other setting goes with it. `bootstrap.sh` does this for you; hand
edits are on you.

**`METACLAUDE_PUBLIC_URL` is the address a browser reaches you on**, scheme
included — `https://metaclaude.example.com`. Two things need it, and nothing
else does. Authorising an MCP server over OAuth: an authorization server has to
be able to send that browser back to `/api/mcp/oauth/callback` here. And the
MCP gateway screen, which shows the endpoint to paste into another application
— an address it cannot otherwise know, and a wrong one produces a connection
error that reads exactly like a bad token. The gateway itself works without it;
only the screen goes quiet, and says so rather than guessing. It
cannot be derived from the request: a `Host` header is set by whoever is
calling, and a redirect URI is the one value in OAuth that must never come from
the client. Leave it unset and everything else runs exactly as before; the
Authorise button then refuses and names this setting rather than building a
return address nobody can reach.

**Set `METACLAUDE_MASTER_KEY` explicitly and keep a copy in your password
manager.** Left empty, it is generated into `/var/lib/metaclaude/master.key` —
inside the same volume as the database it encrypts. One snapshot then carries
both the ciphertext and the key that opens it, and the encryption buys nothing
against a stolen backup. Worse: restoring a database without its key silently
mints a new one. The server starts, reports healthy, and every stored MCP
credential is quietly gone.

### 5. Start

```bash
cd /opt/metaclaude && sudo docker compose up -d
curl -fsS -k https://127.0.0.1/api/health      # {"status":"ok", ...}
```

Then open `https://<your-site>` and sign in. **Turn on two-factor authentication
immediately** — Settings → Two-factor authentication.

Note what `/api/health` does and does not tell you: it returns `ok`
unconditionally, without checking credentials or the CLI. A misprovisioned box
boots green and useless. After the first deploy, actually send a prompt.

---

## Continuous delivery

```
push to any branch  →  CI: typecheck, tests, live check, browser check, image
push a tag v1.2.3   →  Deploy: the image CI already built for that commit
```

Deployment never rebuilds. CI publishes `sha-<commit>` on every push, and the
deploy workflow resolves a tag to its commit and asks the server for that exact
image — so what runs is the artefact the tests ran against.

### Repository setup

Create an environment named **`production`** (Settings → Environments) and add
these as *environment* secrets, not repository secrets. That distinction is the
point: an environment secret is unreadable until the environment's protection
rules pass, so a required-reviewer rule becomes a real control rather than
advice.

| Secret | Value |
|---|---|
| `DEPLOY_HOST` | the server's IP or Tailscale name |
| `DEPLOY_USER` | `mcdeploy` |
| `DEPLOY_SSH_KEY` | the **private** half of the deploy key |
| `DEPLOY_KNOWN_HOSTS` | `ssh-keyscan -t ed25519 <host>` |
| `DEPLOY_PORT` | only if you moved SSH off 22 |

`DEPLOY_KNOWN_HOSTS` is not optional. Without it the workflow would deploy to
whatever answers on that address.

### Deploying, and going back

Every push to main bumps the version (`node deploy/bump.mjs patch|minor` —
CI's version-guard refuses the push otherwise) and, once the push is green,
CI tags it `v<version>`. Those tags are created with the workflow token, whose
pushes deliberately do not trigger the tag-driven deploy — so deploying stays
an explicit act:

```bash
# Actions → Deploy → Run workflow → ref: v1.2.3, action: deploy
# or, from a machine with push access, a hand-pushed tag still deploys directly:
git tag v1.2.3 && git push origin v1.2.3
```

Set the repository variable `METACLAUDE_AUTO_DEPLOY` to `true` and every green
push to main dispatches the deploy itself — the health gate and automatic
rollback below still apply to each one.

Actions → Deploy → Run workflow also offers `rollback` and `status`.

The server does the deciding, not the workflow: a runner that loses its network
mid-deploy must not leave a broken version serving. A new image has to come up
healthy **and** answer through the proxy, or the previous digest is restored
automatically. Digests, not tags — GHCR tags are mutable, so a recorded tag would
resolve to wherever it had since been moved.

A successful deploy also reclaims the disk it just filled: it keeps the newest
`IMAGE_KEEP` images of the pinned repository (three by default,
`/opt/metaclaude/deploy.conf`), always sparing whatever `releases/current` and
`releases/previous` resolve to so the rollback button keeps its target, and
drops the build cache — nothing on this host builds. Retention by count and
not by age is deliberate: at several releases a day, an age-based filter never
fires at all, which is how one host reached 97% full with 23 images and 15 GB
of build cache it had never used.

### When you change `compose.yml` or the Caddyfile

Those live on the server, deliberately: `compose.yml` is what confines the
container, so an image that supplied its own could ask for a host mount and walk
out of its own jail. **A deploy does not update them.**

```bash
cd ~/Metaclaude && git pull && sudo ./deploy/install-app.sh
```

Every deploy prints the checksums it ran with and the workflow compares them, so
drift shows up as a warning rather than as a mystery.

---

## What can lock you out, and the guard for each

| What | Guard |
|---|---|
| `ufw enable` with no SSH rule | The dead man's switch. Never pass `--yes` on a box you cannot console into. |
| sshd drop-in loses to `50-cloud-init.conf` | The file is `00-metaclaude.conf`; sshd takes the **first** value for a keyword, so it must sort first. Verified against `sshd -T`. |
| Moving the SSH port under socket activation | On Debian 13 / Ubuntu 22.10+, `Port` in sshd_config is ignored — `ssh.socket` owns the listener. provision.sh sets it on the socket and refuses to firewall a port nothing answers on. **Simplest guard: don't move the port.** On a key-only box it buys quieter logs and nothing else. |
| Disabling passwords before the key works | provision.sh confirms the key is installed first. Also: keep your current session open and test from a *second* terminal. |
| `METACLAUDE_BIND` unset | Defaults to `127.0.0.1`. Unreachable, not world-open. |
| Losing `caddy-data` under `internal` | HSTS is already recorded; the new CA gives a non-bypassable interstitial. Back the volume up. |
| Tailscale node key expiry | Disable expiry for the server node **before** closing port 22. |
| The `acme-ip` 160-hour clock | Two days of broken ACME is a hard outage. Monitor expiry as a first-class alert. |
| Losing `master.key` | Not lockout — permanent, silent loss of every stored MCP secret. Password manager. |
| fail2ban banning you | Private and CGNAT ranges are already excluded. `fail2ban-client set sshd unbanip <ip>`. |

---

## Verify it from outside

On-box tools agree with themselves. A firewall that believes it is closed is
not evidence that it is. Run this **from your laptop**, never on the server:

```bash
./deploy/verify.sh <ip> --ipv6 <ipv6>
```

Its counterpart needs no server at all. `./deploy/check.sh` checks the deploy
scripts themselves — that they parse and lint, that compose is valid under every
TLS mode, and that a password full of awkward characters still reaches the
container intact. CI runs it on every push; run it yourself after editing
anything in `deploy/`.

It checks that your key opens a session and that passwords and root do not, that
the ports which should be shut are shut on **both** address families, that HTTP
redirects, and that the security headers are present. It refuses to report on
those headers unless the application itself answered first — otherwise an
intercepting proxy's headers read as a pass, which is worse than reporting
nothing.

For the complete answer, sweep every port rather than the short list:

```bash
nmap -Pn -p-       <ip>      # public mode: 22, 80, 443 — nothing else
                             # vpn mode: 22, or nothing at all
nmap -6 -Pn -p-    <ipv6>    # do not skip this
```

Pass the host's v6 **address**, not the /64 prefix your provider shows you.
`2a01:db8:1:2::/64` is the allocation; the machine holds one address inside it,
usually `…::1`. `ip -6 addr show scope global` on the box is the authority.

IPv6 is the most-missed gap: ufw, iptables and Docker keep entirely separate v6
rulesets, so a host with a global v6 address is reachable over it whether or not
anyone configured it. provision.sh handles this symmetrically — it turns on
ufw's v6 support, mirrors the `DOCKER-USER` block into `/etc/ufw/after6.rules`,
and prints what is actually listening on v6 at the end. Verify it from outside
anyway; a v4 firewall beside an unmanaged v6 one reads as "firewalled" and is
not.

**HTTPS over v6 is reported, not required.** compose publishes
`${METACLAUDE_BIND}:443:443`, and that variable holds one address; set to
`0.0.0.0` — what bootstrap.sh writes in public mode, and the only value that
makes sense there — the host side is an IPv4 wildcard, so Docker binds v4 and
nothing else. Serving over v6 as well is a deliberate change and needs an `AAAA`
record to be worth anything: a name with only an `A` record is never reached
over v6 whatever the server binds. What the v6 section does assert is SSH, and
that nothing unexpected answers — which is the gap it exists for.

To see the bypass this defends against, on a scratch machine:

```bash
ufw deny 8080/tcp
docker run -d --rm -p 8080:80 nginx:alpine
curl -o /dev/null -w '%{http_code}\n' http://<ip>:8080/   # 200 means bypassed
```

ufw filters `INPUT`; Docker DNATs in `nat/PREROUTING` and filters in `FORWARD`,
so a packet for a published port never traverses `INPUT` at all. `DOCKER-USER`
is the one chain Docker consults first and never rewrites, which is why the
rules live there and in `after.rules` — a bare `iptables -I` evaporates on the
next `ufw reload` and on every `systemctl restart docker`.

---

## Backups

`install-app.sh` leaves a nightly systemd timer behind
(`metaclaude-backup.timer`) that runs the tool it installed:

```bash
sudo /opt/metaclaude/bin/metaclaude-backup backup    # take one now
sudo /opt/metaclaude/bin/metaclaude-backup list      # what exists, and what the app believes
sudo /opt/metaclaude/bin/metaclaude-backup prune     # apply retention now
```

Each run stops the app (seconds — the proxy stays up), archives the four
named volumes into one timestamped `tar.gz` under `/var/backups/metaclaude`,
restarts, writes a marker into the data volume, and keeps the newest 14
archives. The marker is what **Settings → System → Doctor** reads: a timer
that quietly stops firing becomes a visible warning in the app within a day.
Destination and retention are `METACLAUDE_BACKUP_DIR` and
`METACLAUDE_BACKUP_KEEP` in `/opt/metaclaude/deploy.conf`. Archives live
outside `/opt/metaclaude` on purpose — `uninstall.sh` deletes that tree, and
backups must survive it.

Retention is applied **before** the new archive is written as well as after,
so lowering `METACLAUDE_BACKUP_KEEP` frees the room on the very next run
rather than needing one more archive's worth of space first. A run that would
not fit refuses while the app is still serving, and says so: it never buys an
outage for a truncated archive. What counts as "would not fit" is twice the
last archive, or `METACLAUDE_BACKUP_MIN_FREE_BYTES` (1 GiB by default),
whichever is larger. It will not prune below the ceiling to make room —
trading a known-good archive for one that has not been written yet can leave
you with less than you started with.

Point `METACLAUDE_BACKUP_DIR` at a separate volume if you have one; that is
the recommended layout, and it is also a volume nothing else watches. The
container does not mount it, so the app cannot measure it — which is why each
marker records the space left where the archives are kept, and why the doctor
can warn about a filling backup volume it has no other way of seeing.

The four volumes, in order of how much it hurts to lose them: the database
and sealed vault (`metaclaude-data`), the agent's files
(`metaclaude-workspaces`), the CLI's transcripts (`metaclaude-home`), and
Caddy's CA (`caddy-data`).

`metaclaude-home` is the one that looks skippable and is not. It holds the
Claude CLI's own session transcripts, and a session row without them cannot be
resumed: the kernel passes `claudeSessionId` straight through to the SDK with
no fallback for an id the CLI no longer knows. Nothing the *operator* wrote is
lost — the database holds every session, run and transcript event, and the
workspaces volume holds the files — but every pre-restore conversation stops
being continuable, and it fails at the next run rather than at restore time.
And losing `caddy-data` under `internal` TLS costs the CA every browser has
recorded HSTS against — see the table above.

Two things the archive deliberately does **not** contain, because a backup
of them next to the data would defeat them:

- `METACLAUDE_MASTER_KEY` (and `.env` generally). A key that travels with
  the ciphertext it opens is a formality, not a key. Keep the key in your
  password manager; `uninstall.sh` also saves `.env` to `/root` on its way
  out for the same reason.
- The machine itself. Copy archives **off the server** —
  `rsync -a /var/backups/metaclaude/ elsewhere:` — or a dead disk takes the
  backups with the data they back up.

### Restoring

```bash
sudo /opt/metaclaude/bin/metaclaude-backup restore \
  /var/backups/metaclaude/metaclaude-backup-<stamp>.tar.gz --yes
```

It refuses without `--yes`, stops the whole stack, replaces the volumes'
contents with the archive's, and starts everything again. On a fresh host,
run `install-app.sh`, restore `.env` (the saved copy, or rewrite it with the
*original* master key), start the stack once so the volumes exist, then
restore.

Then verify the vault actually came back, with the check the code performs:

```bash
docker compose logs app | grep -i 'could not decrypt'
```

No output means every stored secret opened. Do **not** verify this from the
Settings screen: the MCP list is built from the `env_keys` and `header_keys`
columns, which are plain text the vault never touches, so it renders
identically whether the key was right or wrong. `Vault.resolveEnv` returns
`null` on a failed AEAD verify and simply omits the key rather than throwing,
so nothing else on screen changes either. The boot self-test is the only signal,
and it logs rather than refusing to start.

---

## Upgrading

```bash
git pull
sudo ./deploy/install-app.sh    # only if compose.yml or the Caddyfile changed
# then deploy the version CI already tagged:
# Actions → Deploy → Run workflow → ref: v<version>, action: deploy
```

Migrations run automatically at boot, inside a transaction, recorded in
`_migrations`. They are append-only, so an upgrade cannot corrupt an existing
database. Back up first anyway.

Migration 4 does more than add a column: it moves MCP **header values** into the
encrypted vault, because an HTTP MCP server authenticates through
`Authorization` and those values used to sit in plaintext on the row. Migrations
run before the vault key is loaded, so the drain happens on the first boot of the
new version instead. That upgrade needs `master.key` present — which it must be
anyway.

The Claude CLI version is pinned in the Dockerfile (`CLAUDE_CLI_VERSION`).
Bumping it is a deliberate, reviewable change: an upstream CLI update should not
silently alter how your agent behaves.

### Upgrading past the workspaces-directory move

The workspaces root moved once, from `/var/lib/metaclaude/workspaces` to
`/srv/metaclaude/workspaces`. It had to: the data directory holds the database
and `master.key`, so every workspace used to sit one `..` from the key, and any
check phrased as "is this under the data directory?" was true for every
legitimate workspace path. The server now **refuses to start** when the two
directories contain one another, rather than warning.

If you deployed before that change, the upgrade is still a restart, not a
rebuild — but two things have to line up.

**The `.env` must not pin the old path.** If yours sets
`METACLAUDE_WORKSPACES_DIR` to anything under `METACLAUDE_DATA_DIR`, the
container exits at boot with the configuration error naming both values. Delete
the line and let the image's default apply, or set a sibling directory:

```bash
grep -n 'METACLAUDE_WORKSPACES_DIR\|METACLAUDE_DATA_DIR' /opt/metaclaude/.env
```

**The files come across on their own; the rows are repaired at boot.** The named
volume is unchanged — only the path it is mounted at moved — so nothing is
copied and nothing is lost. What does not move by itself is the `path` column:
it is written once, when the workspace is created, as
`<workspaces root>/<slug>`. On the first boot after the move, the server
re-points every workspace whose directory is named after its slug and logs one
line each:

```bash
docker compose logs app | grep 'workspaces root moved'
```

All three outcomes share that prefix, so one grep shows every workspace:

| The line says | What it means |
| --- | --- |
| `re-pointed this workspace at its directory` | The expected case. Row repaired, files present. |
| `re-pointed this workspace, but nothing is at the new path` | Row repaired, but the directory is not in the volume. Go and find the files before creating anything under the same name. |
| `cannot be re-pointed automatically` | A directory placed by hand under a name that is not the workspace's slug. Nothing can derive its new location, so it is left alone for you to move. |

`deploy/check.sh` asserts that every phrase this document tells you to grep for
is one the code still writes — the third case above used to lack the shared
prefix, which made it unreachable through the command printed here.

Nothing here is retroactive. A deployment that has never seen the old layout
logs none of these lines.

---

## Logs and diagnostics

Everything the server has to say goes to one place: structured JSON on stdout,
collected by Docker. There is no log file to find and no rotation to configure —
Docker's own `local` driver handles retention.

```bash
cd /opt/metaclaude
docker compose logs app --tail 100          # the application
docker compose logs proxy --tail 100        # TLS, ACME, every HTTP request
docker compose logs -f app                  # follow live
```

`LOG_LEVEL` in `.env` sets the verbosity (`info` by default; `debug` narrates
every run's plumbing). It is read at boot, so changing it means
`docker compose up -d` — not `restart`, which re-reads nothing.

**The server checks itself at every boot** and says so in the log. Worth
knowing, because each line is the only signal of a problem that is otherwise
silent:

| Boot line | What it means |
| --- | --- |
| `could not decrypt some entries` | The master key does not match the database. Stop and fix the key **before** saving any new secret. |
| `recovered state left behind by an unclean shutdown` | Runs/tool calls left `running` by a crash were closed out. Informational. |
| `workspaces root moved — …` | Workspace rows were re-pointed after a root move. See the table under Upgrading. |
| `applied N database migration(s)` | Schema upgrades ran. Append-only, in a transaction. |

Beyond the log, three surfaces answer questions from the outside in:

- `GET /api/health` — liveness only, deliberately public and uninformative.
- `GET /api/system` — versions, uptime, CLI status, disk. Any signed-in
  account; never anonymous.
- `GET /api/audit` and `/api/audit/verify` — the append-only audit log and its
  hash-chain check: every login, run, permission decision and settings change,
  and whether the chain is intact end to end.

And two from outside the box entirely: `./deploy/verify.sh <ip> --ipv6 <addr>`
from your laptop (firewall, TLS, headers — never run it on the server, where
every answer is self-referential), and `./deploy/check.sh` from any checkout
(the deploy tooling checking itself; CI runs it on every push).

For the failure that *looks* like several of these at once — container
unhealthy, `docker exec` failing, site fine — see the next section.

---

## Uninstalling

```bash
cd ~/Metaclaude
sudo ./deploy/uninstall.sh                # stop and remove the app, KEEP all data
sudo ./deploy/uninstall.sh --purge-data   # ...and delete the volumes, after a typed confirmation
```

Without `--purge-data` the named volumes survive — database, vault, workspaces,
CLI transcripts — and a later reinstall resumes from them as if nothing
happened. With it, they are gone; the script shows what exists and demands the
exact phrase `delete my data` first, because a reflexive `y` must not be able
to destroy a database.

Either way, `.env` is first copied to a root-only file under `/root/`
(`metaclaude-env-<timestamp>.bak`). It holds the master key, which is the one
value that cannot be regenerated: restoring a database without it silently
mints a new key and every stored MCP credential is quietly gone. Delete the
backup yourself once you are sure.

What the script deliberately leaves alone: everything `provision.sh` did to the
*operating system* — the accounts, sshd, ufw, fail2ban, Docker. An uninstaller
that edits the firewall and sshd on its way out can lock you out on its way
out, and it has no dead man's switch to catch that. The safe way to undo
provisioning is the one a script cannot offer: reinstall the OS image from your
provider's console.

`deploy/check.sh` rehearses the uninstaller's three promises against a real
Docker daemon on every run — volumes kept without the flag, `.env` saved before
the tree is deleted, the confirmation phrase enforced.

---

## If the proxy reads `unhealthy` while the site works fine

Look at the health log before anything else:

```bash
docker inspect metaclaude-proxy-1 \
  --format '{{range .State.Health.Log}}[{{.ExitCode}}] {{println .Output}}{{end}}' | tail -5
```

An exit code of `-1` with `OCI runtime exec failed: … procReady not received`
means Docker could not *start* the probe, which is a different failure from the
probe failing. Check the container's task count:

```bash
CID=$(docker inspect metaclaude-proxy-1 --format '{{.Id}}')
find /sys/fs/cgroup -name pids.current -path "*$CID*" -exec cat {} \;
find /sys/fs/cgroup -name pids.max     -path "*$CID*" -exec cat {} \;
```

Sitting at the ceiling with one live process is the signature of probes leaking
tasks: PID 1 in that container is not reaping them. `init: true` is the fix and
is now set on the proxy — a deployment from before it needs `docker compose up
-d proxy` to pick it up, and `deploy/check.sh` refuses a service that has a
healthcheck and no reaper.

Restarting clears the backlog and buys another few hours, so a restart that
"fixes" it is a symptom, not a repair.

---

## Two things to be clear-eyed about

**The deploy account is in the `docker` group, and that group is
root-equivalent** (`docker run -v /:/host --privileged` is all it takes). So the
forced command is the *only* real boundary: a stolen deploy key buys "deploy an
image from our own registry", but a bug in that script's argument parsing buys
root. That is why its grammar is anchored, why the image allow-list is the exact
repository rather than the registry, and why root owns the script itself.

**A single approved `env` command discloses your Claude token.** It lives in the
CLI subprocess's environment, and Bash tool calls are that subprocess's
children. Treat it as compromised after running an untrusted repository.
Rotating it means editing `.env` and recreating the container — there is no
reload path.
