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

> **Not chosen:** `sslip.io`/`nip.io` gives you a name, but it is not on the
> Public Suffix List, so you share one rate-limit bucket with the whole
> internet, and a volunteer DNS service becomes a hard dependency of your
> hostname. Cloudflare Tunnel needs a domain for a named tunnel, and Cloudflare
> sees your plaintext.

---

## First run

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

```bash
git tag v1.2.3 && git push origin v1.2.3     # deploy
```

Actions → Deploy → Run workflow also offers `rollback` and `status`.

The server does the deciding, not the workflow: a runner that loses its network
mid-deploy must not leave a broken version serving. A new image has to come up
healthy **and** answer through the proxy, or the previous digest is restored
automatically. Digests, not tags — GHCR tags are mutable, so a recorded tag would
resolve to wherever it had since been moved.

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

On-box tools agree with themselves. The only test that counts comes from
somewhere else:

```bash
nmap -Pn -p-       <ip>      # public mode: 22, 80, 443 — nothing else
                             # vpn mode: 22, or nothing at all
nmap -6 -Pn -p-    <ipv6>    # do not skip this
```

IPv6 is the most-missed gap: ufw, iptables and Docker keep entirely separate v6
rulesets, and provision.sh warns rather than managing them. Either disable IPv6
on the box or mirror the `DOCKER-USER` block into `/etc/ufw/after6.rules`.
Half-configured is the worst of the three.

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

Three volumes and one file, in order of how much it hurts to lose them:

```bash
docker run --rm -v metaclaude_metaclaude-data:/d -v "$PWD:/out" \
  alpine tar czf /out/metaclaude-data.tgz -C /d .
docker run --rm -v metaclaude_metaclaude-workspaces:/d -v "$PWD:/out" \
  alpine tar czf /out/metaclaude-workspaces.tgz -C /d .
docker run --rm -v metaclaude_caddy-data:/d -v "$PWD:/out" \
  alpine tar czf /out/caddy-data.tgz -C /d .
```

Plus `METACLAUDE_MASTER_KEY`, which must **not** live in the same place as the
data — that is what makes it a key rather than a formality.

Restore by stopping the stack, untarring into the volumes, and starting again.
Verify the vault came back: Settings should show your MCP servers with their
credentials intact. If the key was wrong the server starts happily and the
credentials are simply gone, so check rather than assume.

---

## Upgrading

```bash
git pull
sudo ./deploy/install-app.sh    # only if compose.yml or the Caddyfile changed
git tag v1.2.4 && git push origin v1.2.4
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
