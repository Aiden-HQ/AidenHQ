# A minimal-core install, with Tailscale optional

Status: built, simplified (2026-11-20). The owner's decision stands: a server off a tailnet gets **public HTTPS +
mandatory TOTP** by default. The rest of this note is the original design (2026-11-16); where it and the section below
disagree, the section below and the code win.

## As built / simplified

**The first install.** `curl -fsSL https://get.aidenhq.ai | sh` on a Linux server:
- on a tailnet already (or with `TS_AUTHKEY`): `tailscale`, as before;
- otherwise with a public IPv4: `public`. Caddy gets a Let's Encrypt certificate for the IP, the installer prints
  `https://<ip>` and the one-time setup link (24 hours), and the owner sets a password and an authenticator there;
- behind NAT (no public IPv4 on the default route): `local`, said in one plain line, and the SSH tunnel is printed;
- asked-for public that gets no certificate within 3 minutes (443 blocked upstream): the loud fallback to `local`;
- on a Mac: `local` inside the Lima VM (its ports forwarded to the Mac's localhost).

`--exposure public|tailscale|local` (installer and `ops/setup.sh`; `--no-tailscale` stays as `local`) overrides the
default. Without it a rerun keeps the instance's mode. Tailscale is installed only in `tailscale` mode.

**Switching mode is a rerun.** The installer, or `sudo ops/setup.sh --unattended --exposure tailscale` in the
checkout, run over SSH:
- it writes `settings.exposure` into the instance and commits it, and the mode into `.env`;
- it re-renders the firewall before the apply when leaving public, and after the apply (once Caddy is compiled) when
  entering it;
- it turns off the board's two `tailscale serve` doors when leaving `tailscale` on a host that stays on the tailnet;
- asked for `tailscale` on a host that isn't signed in to one (a public install has no Tailscale yet), it installs
  Tailscale, leaves the firewall and the mode as they are, and stops with the sign-in step (`sudo tailscale up`, then
  the same command again);
- it rewrites the `.env` URLs, and the apply removes Caddy when it is no longer compiled.

SSH stays open in every mode, so a switch can't lock the owner out.

**Cut, and why:**
- **U5, the secure-your-server card and the two-phase switch.** It existed to stop one click on the board from locking
  the owner out. A rerun over SSH can't, and it needs no board code, no `exposure: *-pending` state and no `tier.ts`
  change. Agents can't move the door at all:
  - the firewall is rendered only by root's `ops/vm/setup.sh`, which only an operator's setup run starts;
  - setup writes the mode into the host's `.env` (`AIDENHQ_EXPOSURE`), and compile refuses an instance whose
    `settings.exposure` differs. An agent's edit of the setting (a Tier 1 panel change, like every setting) therefore
    fails its apply, in either direction. The approved design's owner-only tier for the setting isn't needed.
  The installer and `ops/setup.sh` print the Tailscale recommendation and the switch command instead of the card.
- **The containerised `edge-tailscale` node (D6 a).** Tailscale mode keeps the host package. It is installed only in
  that mode, so a public or local install has none.
- **U6, Caddy ingress for apps on the owner's domain.** App doors ([app-doors.md](app-doors.md)) already give admins
  their apps in public mode (`https://<app>.<ip-with-dashes>.sslip.io`). Sharing with other people stays on
  `settings.edge`. A domain front door waits for an owner who has a domain to use.
- **The `cloudflare` exposure for the board, the boot-time IP-change recompile, and the migration to a containerised
  node.** None is needed for a first install. A changed IP is fixed by rerunning setup.
- **The rest of U7 (host features from `pins.json`; browser, gh and the engine CLIs per module; passt mandatory).** It
  is unrelated to Tailscale. It stays a separate piece of work.

**Kept:**
- U1 (trusted client address, address bans, sign-in notices), U2 (Caddy, the IP certificate), U3 (the mode-aware
  firewall) and voice;
- the security floor: sign-in is password and TOTP; every route on 3120 and 3121 needs a signed-in admin; 3120, 3121
  and 3130 stay on loopback, behind Caddy;
- the public firewall opens tcp 22, 443 and 8446 only. 8446 is the kernel's admin listener (sign-in) on
  its own origin, as U2 built it, the same layout as `tailscale serve`. Port 80 stays closed.

`scripts/verify-security.sh` in public mode checks:
- the firewall's open ports are exactly that set;
- both sites serve a publicly trusted certificate;
- `https://<ip>/api/board` without a session gives exactly 401.

This fits the lean-core spec (instance repo, `docs/product-history/superpowers/specs/2026-11-16-lean-core-design.md`):
optional host software follows the modules that need it. It **supersedes** the lean-core text that says first-run setup
is "never a public port" (section 10).

## 1. Summary

- **Mandatory host software shrinks to four things.** Docker, Node 24, the job jail (bwrap with its AppArmor profile,
  passt) and nftables. The vault (gocryptfs) stays on by default (decision D4).
  - Everything else follows a setting or a module: Tailscale, gVisor, Chrome and agent-browser, gh, the Codex and
    opencode CLIs, whisper, fail2ban and the CI and computer nets.
- **Tailscale needs no host package.** The board's tailnet door becomes a pinned container (userspace `tailscaled`),
  like the apps node already is. Turning it on later needs no apt run.
- **Caddy is the public door.** It runs as a pinned container on the host network, with a Let's Encrypt **IP-address
  certificate** (the `shortlived` profile, 160 hours). Only 443 opens; port 80 stays closed.
- **Four code changes come before any public port opens.**
  - The board learns the real client address from Caddy. Today every request looks like one address, so the lockout
    and rate limits fall apart behind a proxy.
  - A per-address ban across emails.
  - A new-sign-in notice to the owner.
  - The firewall becomes mode-aware.
- **On a bare IP only the board can be served safely.** Browsers send a host's cookies to every port, so apps, my-apps,
  Paperclip, Grafana and lean-core's "module UIs on their own port" cannot share that IP. Apps need a **domain** (served
  by Caddy through the gate) or the **Tailscale apps node**. Without one, apps run but aren't published.

Pushback, said plainly:
- **bwrap, its AppArmor profile, passt and nftables are load-bearing for security.** They are not optional. passt
  should become *more* mandatory (decision D3).
- **gVisor is optional only together with the apps platform.** When the platform is installed, untrusted apps never fall
  back to `runc`.
- **The public mode costs things.**
  - Google Connect on the board breaks: Google refuses raw-IP redirect URIs.
  - SSH and the sign-in page are scanned by the whole Internet.
  - The owner depends on Let's Encrypt renewing every few days.

## 2. Exposure modes

One core setting, `settings.exposure`, in `instance.yaml`. Compile generates the matching front-door container. None
of these needs a host package.

| Mode | Default for | Front door (generated container) | Board URL | Public inbound ports |
|---|---|---|---|---|
| `public` | Linux servers with a public IPv4 | `caddy` (host network, binds `0.0.0.0:443`) | `https://203.0.113.7` (or `https://board.<domain>`) | 22, 443 |
| `tailscale` | opt-in, recommended after install | `edge-tailscale` (host network, userspace `tailscaled`, `tailscale serve` to 127.0.0.1:3121) and `apps-edge` (existing) | `https://aidenhq-<user>.<tailnet>.ts.net` | 22, UDP 41641 |
| `cloudflare` | opt-in | `cloudflared` (exists today for shared apps; extended to the board's host) behind Cloudflare Access | `https://board.<domain>` | 22 |
| `local` | Lima on macOS, LAN VMs, and SSH-tunnel users (today's `--no-tailscale`) | none | `http://aidenhq.localhost:3121` (Lima) or a tunnel to `127.0.0.1:3121` | 22 |

**Why one core setting rather than exposure modules.** The front door is part of the trusted base, like the gate. A
mode switch also changes a root-owned firewall (section 4.4), which modules must never touch. The four modes are a
closed list, and each costs a pinned image, never a host package. Decision D5 asks whether to turn them into
`provides: exposure` modules later.

## 3. Dependency table

"Module" below means the setting or module that pulls the dependency in, through the host-feature list in section 5.

| Dependency | What it is | Features that need it | Optional? | What breaks without it | Security impact of making it optional |
|---|---|---|---|---|---|
| **Docker Engine + compose, buildx** (Docker apt repo, pinned) | Container runtime | Everything: Paperclip, board, apps-mcp, modules, gate, front doors | **No** | Nothing runs | none (stays) |
| **Node 24** (NodeSource, pinned) | Host JS runtime | `aidenhq-kernel` and the runner (host user units: they run bwrap jobs, so they can't be containers); compile and setup scripts; the Engineer CLIs | **No** | Kernel, runner, compile | none (stays) |
| **Paperclip image** (`ghcr.io/paperclipai/paperclip`, by digest) | Control plane: agents, tasks, routines | Every agent | **No** (lean-core keeps Paperclip as the control plane) | No agents | none. Its UI stays on 127.0.0.1:3100 in every mode and is never public (section 4.2). |
| **bubblewrap + private copy `/opt/aidenhq/bwrap/bwrap` + AppArmor profile `aidenhq-bwrap`** | The Engineer job jail | Every Engineer job (the runner's or the kernel's `sandboxConfig`): it hides the vault, the data dir, Docker, tailscaled and `/run/user/<uid>` | **No** | Jobs die on start (26.04's own profile strips the caps the jail needs). | **Load-bearing.** Without it a job holding a prompt-injected instruction can read every secret and the Docker socket (root). Never optional. |
| **passt (pasta)** | Each job gets its own network namespace | Engineer jobs | **Should be no** (today: a warning on 22.04) | Jobs share the host network: they reach the board's loopback listener, Paperclip 3100, the gate, apps and the LAN. | **Load-bearing.** The board's "every loopback route needs a session" rule exists because jobs can reach loopback. In public mode a job would also reach the host's own public 443. Recommend refusing Engineer jobs without pasta, so 22.04 runs no Engineer jobs (D3). |
| **nftables** (and `aidenhq-public-fw`) | Host firewall: the public interface's allowlist | Every host with a public address; the computer and CI nets | **No** (more load-bearing in public mode) | Docker-published ports and every host listener become reachable on the public IP. | Required. The rule set changes per mode (section 4.2). |
| **ufw** | Not installed by us | n/a | n/a | n/a | When ufw is already active, its default deny drops 443. Setup detects `ufw status` = active and adds `ufw allow 443/tcp` in public mode (or tells the owner). It never installs ufw. |
| **gVisor `runsc`** (gVisor apt repo) | Docker runtime for untrusted apps (`runtime: runsc`, `modules/apps-platform/apps-mcp/src/policy.ts:148`) | apps-platform, `untrusted` apps only | **Yes, as part of apps-platform** (a default module, so installed by default) | Deploying an `untrusted` app fails (Docker: unknown runtime). That is a fail-closed failure, which is right. | None as long as there is no fallback to `runc`. Keep `verify-security` checking that every untrusted app runs `runsc`. |
| **Tailscale (host package `tailscale`, apt repo, `tailscale set --operator`)** | Tailnet node for the board, plus SSH | Today: the board's HTTPS address, setup's `BOARD_HOST`, `tailscale serve` | **Yes, as an exposure mode, run as a container** (no host package) | Nothing in public or local mode. The board is reached by IP or tunnel. | Without it the board is on the Internet behind password and TOTP; section 4 is the mitigation. The containerised node can't proxy the host's SSH. Owners who want SSH on the tailnet install host Tailscale themselves (`--host-tailscale`, documented, not default). |
| **`tailscale/tailscale` image (`apps-edge`)** | The apps' own tailnet node | Exposed non-shared apps | **Yes** (generated only in `tailscale` mode; today it sits in `compose.yaml` unconditionally) | Unshared apps aren't reachable. In public mode they go through the gate instead (section 4.6). | None, provided `AIDENHQ_ANONYMOUS=tailnet` is set **only** for apps behind this node (section 4.6). |
| **cloudflared image** | Tunnel for shared apps (exists) | `settings.edge` with `access` or `password` login | **Yes** (already) | Shared apps via Cloudflare | none |
| **Caddy image** (new, `caddy:2.11.9` by digest, released 2026-11-05) | Public HTTPS door and ACME client | `public` mode | **Yes** (generated only in `public` mode) | No public HTTPS | Caddy is the Internet-facing parser. Keep it pinned and on the image-scan list. It holds no app secrets: only its cert store and the edge secret. |
| **gocryptfs + fuse3 + TPM2 libs** (`aidenhq-vault`, `docker-requires-vault`) | Encrypts `~/.config/aidenhq` at rest | Vault, safe off-site backups, the recovery key | **Could be a setup option; recommend it stays on** (D4) | Secrets are plaintext on disk (mode 0600). Backups then carry plaintext secrets. Docker no longer waits on the vault. | With a TPM: protects a stolen disk. Without one (most dedicated servers and many cloud VMs): the key sits on the same disk, so it protects only a *copied* vault (backups). Distro packages only, so it adds no third-party repo. |
| **fail2ban + python3-systemd** | Bans repeated SSH failures | SSH on the public interface | **Yes** (a setting, default on) | More SSH log noise. SSH is already key-only. | Low: key-only SSH can't be guessed. The board's own bans are in-app (section 4.3), not fail2ban. |
| **Chrome for Testing + agent-browser + ~16 shared libs** (`/opt/aidenhq/browser`) | Headless browser for Engineer jobs (`aidenhq-browse`) | `engineering` and `design` (screenshots and click-throughs) | **Yes, as a module feature (`browser`)** | Engineers can't screenshot the apps they build; the UI review loses its evidence. | none |
| **gh CLI** (checksummed .deb) | GitHub CLI in the runner's cache clone | `codehost-github` (default bundle) | **Yes, as a module feature (`gh`)** | No PRs or merges through gh | none |
| **Codex CLI, opencode CLI** (`npm -g`, `ops/setup.sh:188-189`) | Engine binaries | `engine-codex` (default), `engine-opencode` (optional) | **Yes, per engine module** (features `codex-cli`, `opencode-cli`) | That engine can't run | none. Today opencode is installed even when unused. |
| **whisper** (built from `modules/channel-telegram/whisper`, 2 GB RAM) | Local speech-to-text for Telegram voice notes | Voice notes on the owner channel | **Yes, as its own `voice` module** (today it is in `channel-telegram`, which is always installed, so it is built and run on every instance) | Voice notes aren't transcribed; text still works. | none (audio stays on the host either way) |
| **computer-net and ci-net units** (nft rules) | Keep agent computers and CI runners off the host, LAN and tailnet | `computer`, `ci` modules | **Yes, as module features** | Nothing until those modules are on | None, provided the units are installed *before* the module's containers start (the root step runs first; section 5). |
| **unattended-upgrades** | Distro security updates | The host | **No** (keep; free) | Unpatched host | Removing it is a real risk for an Internet-facing host |
| **qemu-guest-agent** | VM integration | VMs only (already conditional) | already optional | n/a | none |
| **git, jq, curl, openssl, iproute2, ca-certificates, gnupg** | Base tools | setup, pins check, firewall | **No** | Setup | none |

The mandatory set after this change: Docker, Node 24, bwrap with its profile, passt, nftables, unattended-upgrades and
the base tools, plus the vault by default. Every vendor apt repo except Docker's and NodeSource's leaves the base
install. gVisor's repo stays when apps-platform is on, which is the default.

## 4. The default: public HTTPS on the server's IP

### 4.1 HTTPS: Let's Encrypt IP certificates through Caddy

**Availability.** Let's Encrypt made IP-address certificates and short-lived certificates generally available on
2026-01-15.
- IPv4 and IPv6 are both supported.
- IP certificates are issued **only** under the `shortlived` ACME profile (160 hours, just over six days). The ACME
  client must support ACME Profiles.
- Validation for an IP identifier is `http-01` or `tls-alpn-01` (RFC 8738). `dns-01` can't apply to an IP. The GA
  post doesn't list challenge types, so U2's staging issuance confirms TLS-ALPN-01.

Sources:
[Let's Encrypt GA post](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability.html),
[first IP certificate](https://letsencrypt.org/2025/07/01/issuing-our-first-ip-address-certificate.html).

**Caddy.** Caddy supports profiles and IP identifiers. Caddy 2.10.0 failed to issue them
([caddy#7399](https://github.com/caddyserver/caddy/issues/7399)) because of three bugs:
- a stale list of CAs that allow IP certificates;
- a TLS-ALPN-01 bug for IPs in acmez;
- IPv6 bracket handling in HTTP-01.

The issue closed on 2026-04-25 with the fixes on master. The 2.11.3 release (2026-05-12) and later postdate them. Pin
**`caddy:2.11.9`** (2026-11-05, past the 7-day rule) by digest. Because the release notes don't name the fix, unit U2's
exit check is a live issuance against Let's Encrypt **staging**: IPv4 over TLS-ALPN-01.

Generated Caddyfile (compile writes it, from the detected public IP):

```caddyfile
{
	admin off
	email {$ACME_EMAIL}            # the owner's email: expiry notices
	cert_issuer acme {
		profile shortlived
		disable_http_challenge     # 443 only (TLS-ALPN-01); port 80 stays closed (decision D1)
	}
}
203.0.113.7 {
	reverse_proxy 127.0.0.1:3121 {
		header_up X-Forwarded-Proto https
		header_up X-AidenHQ-Client-IP {remote_host}   # set replaces any client-sent value
		header_up X-AidenHQ-Edge {$EDGE_BOARD_SECRET}
	}
	header Strict-Transport-Security "max-age=86400"
}
```

- **As built (U2, `scripts/front-door.ts`).** Since lean-core 3a, sign-in lives on the kernel's admin listener (3120),
  which needs its own origin. So Caddy serves two sites on the one IP, as `tailscale serve` does: `https://<ip>` → the
  board and `https://<ip>:8446` → the admin listener, which alone gets the two headers. Public mode opens tcp 8446 too.
  Each site names its ACME issuer (a global `cert_issuer` let Caddy pick its local CA for the IP), and `default_sni`
  names the IP for clients that send none. No owner email: Let's Encrypt no longer sends expiry mail.
- **Header order.** No wildcard delete (`-X-AidenHQ-*`). Whether Caddy applies deletes before or after sets is
  unverified, and a delete that runs last would strip the two headers just set. `set` already replaces a client's
  value, and the board drops every other inbound `x-aidenhq-*` (`accounts.ts:507`). U2 tests that a client-sent
  `X-AidenHQ-Edge` never reaches the board.
- **Container.** `caddy`, host network, `cap_drop: ALL` plus `cap_add: NET_BIND_SERVICE`, read-only root, and the cert
  store in `data/caddy`. `EDGE_BOARD_SECRET` is read from the vault by the entrypoint, the same pattern as Paperclip's
  secrets in `compose.yaml`; it is never put in env from compose.
- **Renewal.** Caddy is expected to renew short-lived certificates early and honour ACME Renewal Information
  (unverified for the pinned build; U2 watches one renewal on staging). The board alerts the
  owner on the channel when the served certificate has less than 48 hours left.
- **ACME success is the reachability proof.** Setup waits up to 3 minutes for Caddy to obtain the certificate. Issuance
  fails on a host behind NAT, a cloud security group that blocks 443, or a private IP only. When it fails, setup:
  - says which of those it looks like;
  - takes Caddy down and drops 443 from the firewall;
  - falls back loudly to `local` mode and prints the tunnel (the `AIDENHQ_SSH_TUNNEL=` line the installer already
    shows).

  A self-signed certificate is never served as the default.
- **IP changes.** A boot-time check in the front-door unit compares the detected public IP with the one compiled. If it
  changed, it recompiles, and the owner is told the new URL. Hetzner-style static IPs never trigger it; cloud ephemeral
  IPs do.

**Fallbacks considered.**
- **The owner's own domain (recommended fallback, and required for apps).** `settings.exposure.domain: example.com`.
  - Board at `board.example.com` with a normal 90-day certificate. A domain also allows passkeys later; WebAuthn
    refuses IP origins.
  - Apps at `<app>.apps.example.com`, my-apps at `apps.example.com`.
  - One wildcard `A` record, set by the owner.
- **sslip.io / nip.io (rejected).**
  - Neither is on the Public Suffix List (checked 2026-11-16). Every sslip user worldwide therefore shares one
    registered domain for Let's Encrypt's per-domain weekly limit, so issuance is unreliable. The size of that limit
    and any exemption sslip.io holds are unverified.
  - Every other user's `*.sslip.io` host is also *same-site* with ours. Strangers' pages could toss non-`__Host-`
    cookies at us and send same-site requests.
- **Self-signed with a printed fingerprint (rejected).** Owners click through warnings, which trains exactly the wrong
  habit.

### 4.2 Ports and who binds them

| Port | Bind | Service | Public mode | Tailscale mode | Local mode |
|---|---|---|---|---|---|
| 22/tcp | host sshd | SSH (key-only, no root, fail2ban) | open | open (or closed with `--host-tailscale`) | open |
| 443/tcp | `0.0.0.0` | `caddy` → 127.0.0.1:3121 (board) and, with a domain, → 127.0.0.1:3130 (gate) | **open** | closed (firewall) | closed |
| 80/tcp | none | nothing (D1) | closed | closed | closed |
| 41641/udp | host netns | `edge-tailscale` and `apps-edge` direct connections | closed | open | closed |
| 3120 | 127.0.0.1 | the kernel's admin listener (sign-in; lean-core 3a) | loopback | loopback | loopback |
| 3121 | 127.0.0.1 | board browser listener (`mode: "lan"`) | loopback, behind Caddy | loopback, behind `tailscale serve` | loopback, forwarded by Lima or reached by tunnel |
| 3122, 3129 | 127.0.0.1 | board internal API, gate sign-in listener | loopback | loopback | loopback |
| 3130 | 127.0.0.1 | gate | loopback, behind Caddy (domain only) | loopback | loopback (Lima: forwarded) |
| 3100 | 127.0.0.1 | Paperclip UI | **never public**: tunnel `ssh -L 3100:127.0.0.1:3100` | `tailscale serve --https=8443` (as today) | tunnel or Lima forward |
| 3131 | 127.0.0.1 | Grafana (monitoring module) | never public: tunnel | tailnet serve | tunnel |

`ops/vm/public-fw.sh` changes from a fixed allowlist (22, UDP 41641) to one rendered from the mode:
- `public`: tcp 22, 443;
- `tailscale`: tcp 22, udp 41641;
- `cloudflare` and `local`: tcp 22.

The forward chain keeps dropping everything new on the public interface. Caddy is host-networked, so 443 is an input
rule, never a Docker DNAT. Compile refuses any `0.0.0.0` publish in every mode.

**The board listener in public mode.**
- Setup sets `BOARD_LAN_HOSTS=203.0.113.7` (or `board.<domain>`) and `BOARD_LAN_URL=https://203.0.113.7`.
- The board already uses `__Host-` cookies with `Secure` when `X-Forwarded-Proto` is `https`
  (`services/board/src/accounts.ts:121-146`). It trusts that header from whoever reaches 3121. That stays acceptable
  only because 3121 binds to loopback; `verify-security` asserts it in every mode.

### 4.3 Sign-in hardening

What already holds:
- **Admins can't use the board before TOTP.** An admin session is refused on every route except enrolment until TOTP is
  set up (`accounts.ts:317`, the `ready` flag).
- **Credentials.** Passwords are argon2id with at least 12 characters. TOTP codes are single-use (a replay cache).
  Sessions last 30 days, sliding.
- **Lockout.** 5 failures in 15 minutes per (email, listener, address) pause new sign-ins for 15 minutes.
- **Rate limits.** Better Auth's limiter: 20 a minute on `/sign-in/email`, `/two-factor/verify-totp` and
  `/reset-password`; 10 on `/two-factor/enable`; 200 a minute overall.
- **Writes.** Same-origin `Origin`, `Sec-Fetch-Site` same-origin or none, JSON only, and the `x-aidenhq-board` header.

What breaks behind a proxy, and must be fixed first (**U1, before any public port opens**):
- **The address is the socket's.** `accounts.ts:514` keys the lockout and the limiter on `req.socket.remoteAddress`
  (3129 is the exception, where it trusts the gate's header with the gate secret). Behind Caddy, and behind Docker's
  port publishing too, every client is one address. A stranger's 5 bad guesses would then lock the owner out for 15
  minutes, and 20 guesses a minute would exhaust the sign-in bucket for everyone. The code comment already notes this
  for `tailscale serve`.
- **Fix.** On the browser listener (3121), take `X-AidenHQ-Client-IP` only when the request carries
  `X-AidenHQ-Edge: <edge_board_secret>`. This is the 3129 pattern, with a new generated secret held only by the board
  and the front door. Otherwise keep the socket address. Caddy strips client-sent `X-AidenHQ-*` and sets both headers.

New rules, all in-app (no fail2ban jail for the board):
- **Per-address ban across emails.** 20 failures in 15 minutes from one address refuse that address on 3121 for 1
  hour. This catches attackers who rotate emails, which the per-(email, address) lockout misses.
- **No account-wide lockout on the board listener.** It would let anyone lock the owner out. Instead, more than 30
  failures in an hour for one account across all addresses sends one alert to the owner channel ("someone is guessing
  your password from N addresses") (D8). Distributed guessing still has to beat argon2id, a 12+ character password
  *and* TOTP.
- **New-sign-in notice.** Every new admin session sends the owner a notice on the channel with the address and user
  agent, and a link to the board's session list (which exists) to revoke it.
- **The pre-auth surface stays tiny.** Before sign-in, 3121 serves only the sign-in page, the setup-link page and
  Better Auth's exposed endpoints (`EXPOSED.board`). Everything else answers 401 with no body detail. The board sends
  `frame-ancestors 'none'`.

**The one-time setup token** (`/api/accounts/setup`, `mintLink`):
- Properties today: 192 random bits, single use, the setup URL is accepted only while no owner exists, and a newer link
  kills older ones.
- In public mode: the TTL drops from 72 hours to **24 hours** (D9).
- The link is printed only on the installing terminal and in the root-only install log, never sent anywhere.
- Until the owner claims it there are no accounts, so nothing can be guessed.
- **Claim race.** If someone else claims the link first, the owner sees "link already used". Today `--reset` sends the
  new link only to the owner channel, which doesn't exist yet on a fresh install. Change: while the owner account has
  never completed TOTP enrolment, `--reset <owner>` also prints the link on the terminal. The caller has root, so they
  could run the board's operator routes anyway.
- The lean-core `/setup` page (spec §2.5) inherits all of this: it disappears once an admin has enrolled TOTP.

### 4.4 Post-install: "Secure your server"

After TOTP enrolment, the board shows a full-width card in public mode until the owner acts on it or snoozes it (it
reappears weekly):

> **Your board is on the public Internet.** Password and authenticator protect it, but anyone can reach the sign-in page.
> Put it behind Tailscale (free, two minutes) or Cloudflare Access and close the public port. **[Switch to Tailscale]**
> **[Use Cloudflare Access]** [Keep it public]

**Switch to Tailscale, two-phase so one click can't lock the owner out:**
1. The click files a settings change: `exposure: tailscale-pending`. It runs through the settings-change path
   (`docs/design/settings-changes.md`) as the owner's own typed change.
   - Compile adds `edge-tailscale`: the pinned `tailscale/tailscale` image, userspace, host network, state in
     `data/edge-tailscale`, `TS_SERVE_CONFIG` → 127.0.0.1:3121, hostname `aidenhq-<user>`.
   - Caddy and 443 stay up.
   - The board shows Tailscale's sign-in link, read from the container's `tailscale status --json` `AuthURL`, or takes
     an auth key typed into the card.
2. The board polls until the node is up and shows its `https://aidenhq-<user>.<tailnet>.ts.net` URL with "open it from
   a device on your tailnet".
3. **Only a session that arrives over the tailnet path can confirm.**
   - `tailscale serve` only proxies; it can't add our secret. So the board accepts the confirm only when `Host` is the
     tailnet name and the request has **no** `X-AidenHQ-Edge`.
   - Caddy adds that header to every request it forwards, and only proxies its own site's `Host`. So no request over
     the public path can pass.
   - A loopback process could forge the `Host`, but it would still need the owner's session.
   - Confirming sets `exposure: tailscale`:
   - Caddy is removed.
   - The root helper re-renders the firewall without 443.
   - The apps node starts if a key was given.
   - The public URL stops answering.
4. If the owner never confirms, nothing closes. The pending node can be cancelled from the card.

**Cloudflare Access** uses the same two phases. It needs a domain and a tunnel token, and confirming must come from a
request carrying a valid Access JWT for the board's audience.

**Who may change exposure.** `settings.exposure` is classified in `tier.ts` as **Tier 2, owner only**. It is never
decided by AI review, whoever proposes it. The owner's own click on the card is that tap; an agent-proposed change
waits for the owner. Widening (to `public`) and narrowing are classified alike, so the classifier stays simple. This
touches `tier.ts`, so U5 needs the paid reviewer eval at 100%.

**The root helper** (`aidenhq-exposure.path` and `.service`, root, installed by setup):
- It watches `~/.local/state/aidenhq/exposure` and runs `public-fw.sh` from the verified root copy
  (`/opt/aidenhq/kernel/<sha>`, lean-core §6.10).
- It accepts only the closed list `public|tailscale|cloudflare|local`; any other content is ignored and logged.
- The same helper installs host features (section 5).
- Why the helper is still worth having even though the AidenHQ user's docker group is root-equivalent: it means no
  user-writable file is ever executed as root.

### 4.5 What does not work on a bare IP

- **Google Connect from the board** needs nothing from the board's address: the client is a Desktop app, which Google sends
  back only to `http://localhost:3121/google/callback`. On the board's own host that completes at once; from another browser
  the person pastes the address the tab ends on into the Connect dialog. It works the same in every mode.
- **Glean, Grafana, ClickHouse and Jira sign-ins** (`app.ts:2394-2425`) already work only on the local listener through
  a tunnel (`mode !== "local"` gives 403). This is unchanged in every mode, but in public mode it is the owner's only
  reason to open a tunnel; the board says so.
- **A mode switch changes the board's URL.** Saved links break. (Google's Desktop client has no redirect to move.)
- **GitHub** is one device sign-in on the board (a code typed at github.com): it needs no inbound port or redirect, so it
  works the same in every mode (#1065 deleted the old setup helper on port 8765).
- **Module UIs on their own port** (lean-core §2.3) can't be safe on one IP, because cookies ignore ports. They need a
  hostname (domain or tailnet). This adds a line to spec §2.3.
- **Passkeys**, if added later: WebAuthn refuses IP origins.

### 4.6 Apps without the Tailscale apps node

Today:
- An exposed, unshared app is served by `apps-edge` at `https://<user>-apps.<tailnet>:<port>`.
- It runs with `AIDENHQ_ANONYMOUS=tailnet` (`modules/apps-platform/apps-mcp/src/policy.ts:166-179`): token-less callers are
  accepted as anonymous, and the tailnet is the perimeter.
- Shared apps go through the gate (`modules/apps-platform/gate/gate.ts`), which maps by `Host` and has the `password` login.

In public mode:
- **With a domain**, every app goes through the gate. No app is exposed directly.
  - Compile gains an `ingress: caddy` arm in `scripts/edge.ts` beside cloudflared's. Every `share.host`, the my-apps
    host and the preview wildcard go to `127.0.0.1:3130` (the gate), and nothing else. The existing `checkIngress`
    refusal applies to the Caddyfile.
  - `app_login` defaults to `password`. Sign-in happens on `apps.<domain>`, and each app host gets its own `__Host-`
    cookie through the one-time handoff (exists).
  - Caddy obtains certificates per compiled host, never on-demand TLS, so strangers can't make it request certificates
    for arbitrary names.
  - An app's `expose: true` without `share` becomes `share.host: <app>.apps.<domain>` with `default_role: blocked`, so
    only admins get in until roles are set.
- **Without a domain**, apps build, deploy and run. Agents test them from the jail's browser on loopback. Nothing is
  published.
  - The board's Apps tab says the app opens in a browser through Tailscale's apps node or a shared host (apps-mcp's
    status row: `unpublished`, no URL). Built; it names only the doors that exist today, not the domain ingress above.
  - An SSH tunnel to an app's loopback port gets 401 (on a Mac, so does the owner's own browser): the app requires a gate
    token and no gate runs without `settings.edge`. Opening apps in `local` mode needs a signed browser door first (not
    built; an owner decision). An unverified sketch: the gate without `edge`, on loopback, with the `password` login
    through the kernel's 3129, each app on its own host name (`<app>.localhost`, since cookies ignore ports) and a my-apps
    host for sign-in; whether `__Host-` cookies and the handoff work on plain-http `localhost` names is unchecked.
- **`AIDENHQ_ANONYMOUS=tailnet` is set only when the app's exposure is the tailnet apps node** (built: compile's
  `config/apps-node`, read by apps-mcp at each deploy and probe). In any other mode every app requires a gate token, and
  the deploy's identity probe refuses an app that answers a token-less request. `verify-security` checking this per app
  is not built yet.
- **The gate's client address.** `gate.ts:270` reads `cf-connecting-ip` unconditionally. Under Caddy, a client could
  forge it. Change: the gate takes the client address from a header only when the front door's edge secret accompanies
  it (as the board will). Caddy sets `X-AidenHQ-Client-IP` and the secret, and strips both from the client.
- **Same-site siblings.** With a domain, apps and the board share a registrable domain, so they are same-site.
  - Board writes stay safe: an exact-`Origin` compare and `Sec-Fetch-Site: same-origin|none` (`app.ts:200-208`) refuse
    same-site requests.
  - Reads are protected by CORS, and the cookies are host-only `__Host-`.
  - Owners who want full separation can put apps on a second registrable domain. That setting already works:
    `share.host` is free-form.

### 4.7 What `verify-security.sh` checks in each mode

All modes (existing, kept):
- the board's 3120, 3122 and 3129 publish on 127.0.0.1 only;
- 3121 publishes on 127.0.0.1 only, **except** in `local` mode on a LAN VM (`BOARD_LAN_BIND=0.0.0.0` with
  `AIDENHQ_PUBLIC_IF=none`). That case exists today and stays, with its session check. In `public`, `tailscale` and
  `cloudflare` modes, a 3121 bind beyond loopback is a failure: a plain-http LAN listener next to a public door is
  not allowed. What we lose: phones on the home network reach a public-mode board through its public URL, not the
  LAN;
- reads and writes without a session give 401;
- cross-origin writes give 403;
- an unknown `Host` gives 403;
- Paperclip publishes on 127.0.0.1 only;
- the jail reaches no host listener, including the host's own public address;
- module isolation;
- no `0.0.0.0` publishes.

New in all modes:
- the live nft table `aidenhq_public` equals the rendering for the compiled mode;
- `settings.exposure` matches the running front door (exactly one of caddy, edge-tailscale, cloudflared or none);
- no app has `AIDENHQ_ANONYMOUS` unless the mode is `tailscale` and the app is served by `apps-edge`;
- 3121 refuses a forged `X-AidenHQ-Client-IP` without the edge secret: 6 failures under one forged address still lock
  only the socket's address.

| Mode | Checks |
|---|---|
| `public` | From outside (the host's public IP, a request with `--resolve`): <br>- 443 serves a publicly trusted certificate for the IP with more than 24 hours left; <br>- `/api/board` without a session gives 401; <br>- 80, 3100, 3120-3131 and 8765 are closed on the public IP. <br><br>Also: <br>- Caddy's routes are the board plus the gate's compiled hosts only; <br>- Caddy strips a client-sent `X-AidenHQ-Edge` (a probe through 443 with a forged one is treated as unauthenticated); <br>- the owner account has TOTP enrolled, or no owner exists yet. |
| `tailscale` | Existing `scripts/host-serve.ts check`, run inside `edge-tailscale`: the board node serves only Paperclip, the board and Grafana. <br>Also: <br>- `apps-edge` has its own node name; <br>- 443 is closed on the public IP; <br>- Funnel is off on both nodes. |
| `cloudflare` | Existing `checkIngress`; every ingress rule targets the board or the gate; 443 is closed on the public IP; the board's host requires Access. |
| `local` | No front door; only 22 open on the public interface. Lima: 3121 and 3130 are reached only through Lima's forwarder (the guest's public-interface rule still applies). |

### 4.8 macOS: Lima, localhost only

AidenHQ runs in a Lima Ubuntu VM in `local` mode. Lima forwards the guest's loopback ports to the Mac's 127.0.0.1.
There is no public port, no Caddy and no certificate.

**Board URL.** `http://aidenhq.localhost:3121`, rather than `localhost:3121`:
- `*.localhost` is a secure context and resolves to loopback in Chrome and Firefox.
- A distinct name keeps the board's cookie away from every other dev server the owner runs on `localhost:<port>`.
- Safari's resolution of `*.localhost` needs checking. If it fails, setup offers an `/etc/hosts` line, or the owner uses
  `localhost`, accepting that risk.

**The rest.**
- **TOTP stays mandatory.** Every process on the Mac shares that loopback.
- **Apps:** gate hosts `<app>.apps.aidenhq.localhost:3130`, password login.
- **Jobs:** bwrap with its AppArmor profile and passt work inside the guest, as on any Ubuntu host.
- **gVisor:** runs without KVM (systrap platform). Check the Lima template's kernel when that agent builds it.
- **Phone access** from a Mac install: the opt-in `tailscale` mode, the same container.

## 5. How the other dependencies become optional

**Host features (one small mechanism).**
- `ops/vm/pins.json` gains `features`: a closed map from feature name to its apt pins, keys, repos and download
  checksums. The names are `tailscale-host`, `runsc`, `browser`, `gh`, `codex-cli`, `opencode-cli`, `fail2ban`,
  `computer-net` and `ci-net`.
- Base pins (Docker, Node, bubblewrap, passt, nftables, gocryptfs) stay at the top level.
- A module declares `host: [browser]` from that closed list. The list is a kernel contract, so a third-party module
  can't name new root work.
  - `host:` is a new manifest field, so it is a contract change and goes into `contract.lock.json` (lean-core §3.3.5).
  - Each feature is shown on the module's install card as new authority, so it needs the owner's tap (lean-core
    decision 7).
- Compile writes `config/host-features.json`, the union of installed modules' features plus settings (for example
  fail2ban on).
- `ops/vm/setup.sh` installs exactly that union. Recipes come only from `pins.json`; modules never ship scripts that
  root runs.

**When a module is enabled later.**
- Apply has no root, so compile compares the wanted features with `/var/lib/aidenhq/host-features.installed`, which
  root writes.
- If something is missing, apply writes the request file and waits up to 10 minutes for the root helper (section 4.4)
  to install it from the verified root copy.
- If the helper isn't there (an old host), apply refuses the module with "run `sudo ops/setup.sh` (installs browser)".
- A module's containers never start before its features exist. This matters for computer-net and ci-net, which must
  isolate before the boxes start.

**Per dependency, the smallest change:**
- **Tailscale.** Drop the repo and package from the default `ops/vm/setup.sh` path. Add `edge-tailscale` to the
  generated compose. Move `apps-edge` from `compose.yaml` into the generated compose (only in `tailscale` mode).
  `ops/setup.sh` stops reading `tailscale status` and stops running `tailscale serve`. `--host-tailscale` keeps the old
  path for owners who want tailnet SSH.
- **whisper.** Move the `whisper` service from `modules/channel-telegram/module.yaml` into a new `modules/voice`. The
  channel-telegram `WHISPER_URL` becomes optional (unset: voice notes get "voice notes are off; install the voice module").
  Default off (D7).
- **browser, gh, Codex and opencode CLIs.** Feature tags on `engineering`/`design`, `codehost-github`, `engine-codex`
  and `engine-opencode`. `ops/setup.sh:188-189` and the browser block in `ops/vm/setup.sh` move under their features.
- **gVisor.** The `runsc` feature on apps-platform (core's apps-mcp today). The `daemon.json` registration runs only
  when the feature is present.
- **fail2ban.** The `fail2ban` feature, on by default (the `settings.host.fail2ban: false` opt-out). The SSH hardening
  stays unconditional.
- **The vault.** Stays mandatory by default (D4). An opt-out would mean `settings.host.vault: false`: skip `init.sh`,
  skip the `docker-requires-vault` drop-in, and warn that backups carry plaintext secrets.
- **passt.** Becomes mandatory. The kernel refuses to start an Engineer job without pasta (today it only warns), and
  `ops/vm/setup.sh` stops treating it as optional. On 22.04, Engineer jobs need a passt backport, or the release is
  supported for everything except Engineer jobs (D3).

## 6. Implementation units (small PRs)

Order: U1 → (U2, U3 in parallel) → U4 → U5, U6 → U7, U8. No public port opens before U1 and U3 are deployed.

| Unit | PR title | What changes | Tests | Notes |
|---|---|---|---|---|
| **U1** | `feat(board): trusted client address from the front door, address bans and sign-in notices` | `accounts.ts` changes: <br>- `X-AidenHQ-Client-IP` on 3121 only with `edge_board_secret` (a new generated secret in compile); <br>- a per-address ban (20 in 15 minutes → 1 hour); <br>- an account-wide alert (no lock); <br>- a new-session notice; <br>- setup-link TTL 24 hours in public mode; <br>- `--reset` prints on the terminal while the owner has never enrolled TOTP. | Two vitest cases: a forged address without the secret locks only the socket address, and 20 failures from one address across emails get banned. | Board sign-in is gate core: panel review and the paid reviewer eval apply. |
| **U2** | `feat(ops): the exposure setting and a Caddy front door with an IP certificate` | `settings.exposure` in `modules.ts` and `compile.ts`; generated `caddy` service and Caddyfile; `BOARD_LAN_*` derived from the mode; `apps-edge` moved into generated compose for `tailscale` only. | `scripts/test` compile cases per mode. | Exit check: live staging issuance of an IPv4 certificate over TLS-ALPN-01 on a throwaway VM. |
| **U3** | `feat(ops): mode-aware public firewall and host features from pins.json` | `public-fw.sh` renders its ports from the mode. `pins.json` gains `features`; `ops/vm/setup.sh` installs the compiled union. Tailscale is out of the base. Also: ufw detection and the root helper units. | A `pins.ts` CI check over `features`; `public-fw.sh --check` per mode. | Supply chain: `pins.ts` dates every feature pin. |
| **U4** | `feat(ops): install public by default, Tailscale and tunnel opt-in` | `ops/setup.sh` changes: <br>- default `public`, plus `--exposure tailscale\|local\|cloudflare`; `--no-tailscale` keeps its promise of no public port and means `--exposure local`; <br>- detects the public IPv4 and waits for the certificate; <br>- falls back to `local` loudly; <br>- prints `https://<ip>` and the link. <br>`distro/install.sh`: messages and flags; uninstall removes Caddy and the helper. | The installer's container test runs with `--exposure local`; a live VM test for public. | Lean-core 5d's exit check changes (section 10). |
| **U5** | `feat(board): secure-your-server card with a two-phase switch to Tailscale or Cloudflare` | The board card; `exposure: *-pending`; `edge-tailscale` auth-URL readout; confirmation only from the new path; `settings.exposure` as Tier 2 in `tier.ts`. | A vitest case: a confirm carrying `X-AidenHQ-Edge`, or under any `Host` other than the tailnet name, is refused. | Settings changes ride the existing settings-change flow. A `tier.ts` change: the paid reviewer eval must stay at 100%. |
| **U6** | `feat(apps): publish apps through the gate behind Caddy with a domain` | `edge.ts` `ingress: caddy`; `checkIngress` for the Caddyfile; gate client address from the edge secret; apps-mcp sets `AIDENHQ_ANONYMOUS` only for `apps-edge` apps; an Apps-tab notice when there's no domain. | `scripts/test` edge cases; the gate test for a forged client address. | Gate changes are gate core: panel review. |
| **U7** | `refactor(modules): voice, browser, gh and engine CLIs follow their modules; passt required` | The `voice` module; `host:` tags; the kernel refuses jobs without pasta. | Existing suites; one test that a job without pasta is refused. | |
| **U8** | `feat(ops): verify-security per exposure mode, and docs` | Section 4.7's checks. Docs: `access.md`, `SETUP.md`, `CLAUDE.md` Inbound, `docs/architecture.md`. Instance repo: spec §2.3 and §6.10, plan 5d. | `scripts/verify-security.sh` on a live host in each mode. | |

Migration of existing instances:
- An instance with host Tailscale and `tailscale serve` gets `exposure: tailscale` and `--host-tailscale`, written by
  apply when it finds `tailscale serve status` serving 3121. Nothing changes for it.
- The containerised node is for new installs.
- An instance with `--no-tailscale` gets `local`.

## 7. Risks

1. **Internet exposure of the sign-in page.** Zero-days in Caddy, Node's HTTP parser, Better Auth or the board's
   pre-auth routes become remotely reachable.
   - Mitigations: a tiny pre-auth surface, pinned images on the image scan, unattended upgrades and the
     secure-your-server nudge.
   - What we lose: today's "zero inbound ports" property, by default.
2. **The default mode breaks the default module's one-click connect.** Google Connect needs a domain or Tailscale;
   on a bare IP it takes a tunnel (section 4.5).
3. **Lockout regression if U1 slips.** Without the trusted client address, one stranger can lock the owner out (section
   4.3). U4 must not merge before U1 is deployed.
4. **Six-day certificates.** A Let's Encrypt or Caddy renewal failure lasting more than about four days takes the board
   down.
   - Mitigations: the 48-hour alert, and the tunnel to 127.0.0.1:3121, which always works.
   - The owner channel (Telegram) doesn't depend on the board.
5. **Caddy IP-certificate maturity.** The fixes landed in 2026-04, and the release notes don't name them. U2's staging
   issuance proves the pinned build before anything ships.
6. **Lock-out by the switch.** Prevented by the two-phase confirm over the new path. A bug there could still strand an
   owner; SSH and `sudo ops/setup.sh --exposure public` is the documented way back.
7. **Setup-link theft before the claim.** The link is on the terminal and in a root-only log. A 24-hour TTL, a visible
   "already used" result and terminal reissue limit the damage.
8. **Same-site apps under a domain.** Covered by the exact-Origin and `Sec-Fetch-Site` checks and host-only cookies. A
   future board route that skips `csrfReason` would be exposed to every app, so `verify-security` keeps the
   cross-origin probe.
9. **IP changes on cloud VMs** break the URL and the certificate until the boot-time recompile runs.
10. **The host-feature helper** runs root work on a user-written request. That is acceptable only because the vocabulary
   is closed and recipes come from the verified root copy's `pins.json`.

## 8. Decisions for the owner

- **D1 Port 80.** (a) Closed: TLS-ALPN-01 on 443 only (recommended); (b) open, for HTTP-01 and a redirect to https.
- **D2 Apps with no domain.** (a) Not published; the board asks for a domain or Tailscale (recommended); (b) sslip.io
  names (unreliable issuance, and strangers are same-site); (c) path-based under the board's IP (unsafe: app scripts
  would run on the board's origin).
- **D3 passt.** (a) Mandatory: Engineer jobs refuse to run without it, so 22.04 runs no Engineer jobs (recommended);
  (b) keep the warning and let jobs share the host network.
- **D4 The vault.** (a) Stays on by default, with an opt-out setting (recommended); (b) off by default, with an opt-in;
  (c) remove it.
- **D5 Where exposure lives.** (a) One core setting that generates a pinned container per mode (recommended); (b) four
  `provides: exposure` modules.
- **D6 Tailscale mode.** (a) A containerised userspace node with no host package, plus `--host-tailscale` for tailnet
  SSH (recommended); (b) keep the host package for the Tailscale mode.
- **D7 whisper.** (a) Its own `voice` module, off by default (recommended); (b) keep it in channel-telegram, always on.
- **D8 Many failures across addresses for one account.** (a) Alert the owner and never lock (recommended); (b) lock the
  account's sign-ins for 15 minutes after 50 failures in an hour (anyone can then lock the owner out).
- **D9 Setup-link lifetime in public mode.** (a) 24 hours (recommended); (b) 72 hours, as today; (c) 1 hour.

## 9. Every place that assumes Tailscale or loopback-only today

| Where | Assumption | Change (unit) |
|---|---|---|
| `ops/vm/setup.sh` (Tailscale repo, package, `tailscale set --operator`; the `NO_TS` default 0) | Tailscale is on by default | `tailscale-host` feature, off by default (U3) |
| `ops/vm/public-fw.sh` | Inbound is always 22 + UDP 41641 | Rendered from the mode (U3) |
| `ops/vm/setup.sh` fail2ban `ignoreip 100.64.0.0/10` | The tailnet is trusted | Harmless; kept |
| `ops/setup.sh:137-146, 199-221, 252-259, 382, 427-435` | `BOARD_HOST` comes from `tailscale status`; unattended setup dies without TS; `tailscale serve`; `APPS_TS_HOSTNAME`; "on the tailnet" messages | Mode-driven (U4) |
| `compose.yaml` `apps-edge` (with the `tailscale_apps_authkey` secret) and board comments | The apps node always exists | Generated only in `tailscale` mode (U2) |
| `compose.yaml` board `BOARD_LAN_HOSTS` default `aidenhq.local` | LAN or mDNS | Derived from the mode (U2) |
| `services/board/src/accounts.ts:290, 514` | Peer = socket ("behind `tailscale serve` everyone shares one") | Trusted edge address (U1) |
| `services/board/src/accounts.ts:732` `forwardedProto` | Anyone reaching 3121 may claim https | Kept; 3121 is loopback-only, asserted (U8) |
| `modules/apps-platform/apps-mcp/src/tailnet.ts`, `policy.ts:166-179` (`AIDENHQ_ANONYMOUS=tailnet`) | Exposure means the tailnet, and the tailnet is the perimeter | Anonymous only for `apps-edge` apps (U6) |
| `modules/apps-platform/gate/gate.ts:270` | `cf-connecting-ip` comes from cloudflared | Edge-secret-bound address (U6) |
| `scripts/edge.ts` `header-jwt` `edge.front` | The front door reaches the gate over the tailnet | Kept (an opt-in mode) |
| `scripts/host-serve.ts`, `ops/apply-config.sh` prune, `verify-security.sh` "Tailnet" section | Host `tailscale serve` | Run against `edge-tailscale` in `tailscale` mode; skipped otherwise (U8) |
| `distro/install.sh:13, 259, 482, 536-545, 570` | Tailscale default; "same tailnet"; `tailscale serve off` on uninstall | Mode-driven (U4) |
| `docs/design/access.md` ("the host keeps zero inbound ports"; "An instance without the `edge` setting stays tailnet-only") | | Rewritten (U8) |
| `SETUP.md:32-34, 57, 137, 183, 215` ("No inbound ports are needed") | | Rewritten (U8) |
| `CLAUDE.md` "Inbound" | 3120 loopback; Tailscale serve | Adds the public mode and the edge secret (U8) |
| Lean-core spec §2.3 (admin listener "reached through Tailscale serve / Cloudflare Access"; module UIs on "their own port") and §6.10 ("never a public port") | | Superseded (section 10) |

## 10. What this supersedes

- **Lean-core spec §6.10** "never a public port (inbound protection unchanged)" is replaced by the owner's 2026-11-16
  decision. The default is public HTTPS with mandatory TOTP; Tailscale, Cloudflare and the tunnel are opt-in.
- **Lean-core spec §2.3.** The admin listener is also reached through the `public` front door. Module UIs need their
  own *hostname*, not just their own port.
- **Lean-core plan unit 5d.** The "Tailscale optional" row and the exit check ("a VM with no Tailscale installs end to
  end through the SSH tunnel route") become: a VM with no Tailscale installs end to end on `https://<public ip>`, and
  falls back to the tunnel when issuance fails.
- **`docs/design/access.md`, `SETUP.md`, `CLAUDE.md` "Inbound"** as listed in section 9.
