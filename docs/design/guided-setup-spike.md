# Guided setup: spike results

Status: measured 2026-11-17 on a throwaway 4-core, 8 GB, 100 GB Ubuntu 24.04 VM (a home Proxmox VM, 1 Gbit-class
uplink), release 2026.11 (kernel `3bc11616`). The VM was destroyed afterwards. Step 4 (module idles) was **not run**:
the owner asked to stop the VM before it was reached.

## Step 1: cold install

Following `https://aidenhq.ai/prompt.md` as an AI would.

| Stage | Wall time |
|---|---|
| Fetch and verify kernel and modules | 5 s |
| Host packages (Docker, Node, gVisor), `ops/setup.sh` | 131 s |
| Config, vault, data dirs | 8 s |
| Apply `validate` (builds the 10 service images) | 429 s |
| Apply `computer-images` (3 agent-computer images) | 299 s |
| Apply `compose` switch (rebuilds the service images, pulls Paperclip and Tailscale, starts) | about 12 min |
| **Total to first failure** | **26 min 54 s** |
| Apply with no model key, 9 agents each waiting out Paperclip's 3 minute verification | 27 min 28 s (`apply timing: total 1647.8s`) |

Images are **built on the server, not pulled**: nothing in the release is prebuilt except Paperclip (and Tailscale,
pulled even with `--no-tailscale`). Disk after the install: about 40 GB of images.

| Image | On disk | Notes |
|---|---|---|
| Paperclip (pulled) | 17.4 GB (5.3 GB compressed, 15 layers) | transfer of all layers in parallel: 109 s (about 49 MB/s) from this VM, extraction not measured |
| channel-telegram-whisper (built) | 7.65 GB | one build step 181 s, image export about 155 s, done twice in one install |
| computer-engineer / agent-base / browser | 5.15 / 3.34 / 1.89 GB | 299 s together |
| 8 service images | 330-690 MB each | |

The "separate parallel `docker pull` of every image" was not possible: only Paperclip and Tailscale are pulled, and the
VM was destroyed before the Paperclip pull-plus-extract could be timed alone. Prebuilt images would be about 5.3 GB
compressed for Paperclip plus the rest; the whisper image alone is a candidate to drop from the default install.

### Where the current release does not install as the prompt describes

1. **No model key: the first apply fails.** `ops/setup.sh` says "Model key: none yet" but the board's compose secret
   `openrouter_key` is a bind mount of a file that is never created, so `board` cannot start (`bind source path does not
   exist`). Every other empty secret is created by `bootstrap.sh`. Workaround used: create an empty file.
2. **A failed generation blocks every rerun** ("this host stays on the last known good until the instance's main
   moves, or run `ops/apply-config.sh --retry` from the owner's shell"). The prompt's "fix the cause and rerun the same
   command" does not work after the first failed apply. A plain `--retry` also lacks `PAPERCLIP_EMAIL`, and the script
   then blocks on an interactive prompt.
3. **Rerun refuses on disk**: after the failed run 53 GB was free and the installer needs 60 GB. Pruning the 10 GB
   build cache fixed it. The prompt says 60 GB; the real need is about 100 GB.
4. **Units are installed after the apply that needs them**: the apply failed with "the computer launcher isn't
   answering", because `aidenhq-computers.service` is installed later in `setup.sh`. I installed and started the unit by
   hand. Unverified whether a clean first run hits this (my first run stopped earlier, on item 1).
5. **No model key makes agent creation wait 3 minutes each** (`awaitVerified`), 9 agents, about 27 minutes of an idle
   server, then "re-run setup later" warnings.
6. **The installer served at `get.aidenhq.ai` carries no digest** and stops at a real run; the release's own
   `install.sh` works. `prompt.md` step 4 and 5 download the former.
7. `provision.sh` fails when `VMID` is empty (ssh drops the empty argument, so `${11}` is unbound). Set `VMID`.
8. My own mistake worth a guard: the install inherited `umask 077` from an ssh session that also wrote the run script,
   so the checkout was mode 0600 and the non-root `board` container could not read `package.json`. The prompt's
   separate ssh calls avoid it, but the installer should set `umask 022` itself.

Items 1, 2 and 5 are the same path the guided setup relies on (install with no model key, OpenRouter later), so they
must be fixed first. The install did reach a healthy state after the workarounds: all services healthy, generation 12
good. The final `setup.sh` pass (setup link) was still running when the VM was stopped.

## Step 2: OpenRouter PKCE callbacks

Documented behaviour (https://openrouter.ai/docs/use-cases/oauth-pkce) and an unauthenticated probe.

| Callback | Result |
|---|---|
| `http://127.0.0.1:3121/setup/openrouter` | `/auth` redirects to sign-in, no up-front rejection. Docs: localhost callbacks are supported on **any port** (documented as `localhost`; `127.0.0.1` is not named). |
| `https://203.0.113.7/setup/openrouter` | same, no up-front rejection. Docs only say use `https://` for hosted apps. |
| `https://<ip-dashes>.sslip.io/setup/openrouter` | same, no up-front rejection |
| no `callback_url` (headless) | **Documented**: the page shows the code on screen to paste; single-use, 10 minutes. Works for any exposure. |

`/auth` only redirects to sign-in for a logged-out client, so whether each callback completes and exchanges at
`POST https://openrouter.ai/api/v1/auth/keys` needs a logged-in human. Callback validation is not visible before login.

**Recommendation:** make the headless flow (no `callback_url`, paste the shown code, exchange with the verifier) the
primary path everywhere, since it needs no reachable callback and works on the SSH tunnel, a bare IP and a Mac alike.
Offer the redirect button only where the callback is `localhost` or an HTTPS name.

**Owner clicks, signed in to OpenRouter:**
- headless: `https://openrouter.ai/auth?code_challenge=<S256 of a verifier>&code_challenge_method=S256&key_label=AidenHQ`
- localhost: the same with `&callback_url=http%3A%2F%2Flocalhost%3A3121%2Fsetup%2Fopenrouter` (try `127.0.0.1` too)
- bare IP and sslip.io: the same with `callback_url` set to each; note whether the page completes or errors.

## Step 3: free server name

| Check | Result |
|---|---|
| `sslip.io` on the Public Suffix List | **No** (no `sslip`, `nip.io` or similar entry in the current list). |
| Let's Encrypt limit for it | Not on the PSL, so all of `sslip.io` is one registered domain with a global 50 certs per 7 days. sslip.io's own page says Let's Encrypt raised its limit to 250,000 per period (stated for nip.io and sslip.io together), and suggests an IP-address certificate if rate-limited. Not verified on this server; `crt.sh` was unavailable. |
| Google redirect URI rules | https://developers.google.com/identity/protocols/oauth2/web-server: HTTPS required (localhost exempt); **hosts cannot be raw IP addresses** (localhost exempt); host TLDs must be on the PSL (`io` is). So `https://<ip-dashes>.sslip.io/google/callback` should pass; a bare IP will not. |
| Let's Encrypt for a bare IP | **Generally available since January 2026** (short-lived, about 6 day certificates, shortlived profile). Gives a trusted bare-IP HTTPS cert for the board and the OpenRouter redirect, but not for Google (raw IPs refused). |

**Recommendation:** the free name works for Google only through an sslip.io style name, and depends on a shared rate
limit the project does not control. Use it as the default for the Google flow and fall back to the bare IP certificate
(plus the paste fallback) if issuance fails; the Google flow stops on a bare IP.

**Owner clicks:** in Google Cloud Console, APIs and Services, Credentials, create a Web client and paste
`https://<ip-dashes>.sslip.io/google/callback` as an authorized redirect URI; record whether it saves. There is no API
for this client type.

## Step 4: module idles

Not run. Remaining: enable `google` and `channel-slack` with no secrets, apply, confirm both containers stay up
healthy and Slack reports not set up. The Slack manifest link is documented
(https://docs.slack.dev/app-manifests/configuring-apps-with-app-manifests/): `https://api.slack.com/apps?new_app=1&manifest_json=<urlencoded>`
or `manifest_yaml=`. Whether it opens a pre-filled app needs a signed-in Slack user. Note `channel-slack` and `google`
were not among the services running in the default 10-service stack.

## Decisions for the owner (install-time options)

1. Prebuilt images: yes. A 27 minute build on a 4-core server, built twice for the large images, is the main wait, and
   the whisper image (7.65 GB) is the worst offender. Publish all service images and the agent-computer images, and
   make voice (whisper) an opt-in module.
2. Install without a model key must be made to work first (items 1, 2 and 5), or the first-run flow cannot be reached.
3. Use the OpenRouter headless paste flow as primary.
