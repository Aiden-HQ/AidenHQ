# Guided Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A non-technical person pastes one prompt into their AI, watches the install's progress, and opens one link. A short
first-run page and an optional three-step wizard take them to the full Aiden. Every module that needs user setup gets a
generic setup flow at `#/setup/<module>`.

**Architecture:**
- **Setup flows are a new board point, `board.setup_flows`.** Modules declare them the way they declare `board.signins`
  today; compile writes them into `config/points/board.json`.
- **The board renders every flow with one component.** It saves pasted secrets through a new kernel account op,
  `save_secret` (the board calls it as the signed-in admin, like every `/v1/accounts/<op>`). The kernel writes the vault
  file and recreates that module's compose services under the apply lock.
- **Pairing codes** are minted by the module's own service through a sibling of its URL.
- **Install** pulls prebuilt images and prints progress lines, then the link.
- **The on-server code host** is recon and a spec here; its build gets its own plan.

**Tech Stack:** Node 24 + TypeScript (kernel, board server, module services), React (board web), POSIX shell (installer,
ops), YAML module manifests, JSON Schema points.

**Spec:** `docs/design/guided-setup.md` (read it first; this plan argues from it).

**Repos:**
- **product:** this repo.
- **modules:** `Aiden-HQ/aidenhq-modules`.
- **distro:** `Aiden-HQ/aidenhq-distro`, the installer, prompt and site.

Every agent works in its own worktree, branched from that repo's `origin/main`, and lands each task as a squash-merged
PR with a Conventional Commit title. A modules change reaches the product through a `modules-pin.json` bump PR.

## Global Constraints

- **Generic core.** No module name appears in kernel or board code. Flows, pairing and secrets come only from module
  declarations.
- **No half-baked features.** A feature is offered in full or not until its setup is done.
- **The first chat is the full Aiden, through Paperclip.** No background install stage: everything installs, then the
  link.
- **GitHub is never asked for** in the install, on the first-run page or in the wizard.
- **The authenticator stays mandatory.** Secrets go only into the vault (`AIDENHQ_SECRETS_DIR`), never into logs,
  replies or command lines.
- **The new privileged paths are security gates and enforce from day one:** `save_secret`, service recreate and
  pairing.
- **Supply chain:** no dependency or image published less than 7 days ago. Pin exactly, and images by digest.
- **Minimal tests:** a few end-to-end tests per task; no tests for obvious code.
- **Wizard steps,** in this order: recovery key, Telegram, Slack. Google is not a wizard step.
- **Pairing codes:** at least 128 bits of entropy, single-use, consumed atomically, expire in 15 minutes, 5 wrong
  attempts per minute. Only a signed-in admin with an authenticator mints one.
- **Progress line format:** `AIDENHQ_PROGRESS=<n>/<total> <percent>% <step> ~<minutes left>`.
- **Board tests:** run `npx tsc -p tsconfig.build.json --noEmit` for every board change.

## Review Focus

1. **A secret saved twice in quick succession, or while an apply runs.** Expect one recreate after the lock, and the
   last value wins. (Task 2 test `save_secret waits for the apply lock`.)
2. **A pairing code sent from a second Telegram chat after the owner paired.** Expect it to be refused and the paired
   chat unchanged. (Task 8 test `a used code pairs nobody`.)
3. **The OpenRouter redirect returns with an error, or the owner reloads mid-flow.** Expect the account and
   authenticator kept, and the model step shown again with the error. (Task 4 test
   `openrouter error keeps the account`.)
4. **A module turned off while its flow is open.** Expect the flow to disappear from `/api/setup-flows`, and
   `save_secret` refused with 404. (Task 2 test `save_secret refuses an off module`.)
5. **The installer interrupted mid-pull and rerun.** Expect progress to resume, with no duplicate link and no second
   setup token. (Task 13 test `rerun after a killed pull`.)

---

## Lane 0: checks before building (one subagent, results gate Lanes A and D)

### Task 0: Spike report

**Files:**
- Create: `docs/design/guided-setup-spike.md` (product)

- [ ] **Step 1: Measure a cold install.** On a fresh 4-core, 8 GB Ubuntu 24.04 VM (a throwaway on the EX44's Proxmox or a
  cloud), run today's `get.aidenhq.ai` unattended install. Record wall time per `==>` stage and per image (transfer,
  extract). Separately, `docker pull` every image the release uses, in parallel, and record the total.
- [ ] **Step 2: OpenRouter PKCE callbacks.** With a test account, start
  `https://openrouter.ai/auth?callback_url=<url>&code_challenge=…&code_challenge_method=S256` for three callbacks:
  - `http://127.0.0.1:3121/setup/openrouter`
  - `https://203.0.113.7/setup/openrouter` (any reachable bare-IP HTTPS test host)
  - `https://<ip-dashes>.sslip.io/setup/openrouter`

  For each, record whether the auth completes and the code exchanges at `POST https://openrouter.ai/api/v1/auth/keys`.
- [ ] **Step 3: Free server name.** Check whether `sslip.io` is on the Public Suffix List, Let's Encrypt's rate limit for
  it, and whether Google Cloud accepts `https://<ip-dashes>.sslip.io/google/callback` as a Web client redirect URI.
- [ ] **Step 4: Module idles.** On the VM, enable `google` and `channel-slack` with no secrets, apply, and confirm both
  containers stay up with health ok and Slack reported as not set up. Also confirm Slack's
  `https://api.slack.com/apps?new_app=1&manifest_json=<urlencoded>` opens a pre-filled app.
- [ ] **Step 5: Write the report and commit.** One table per step, with a recommendation where the owner must pick
  (install-time options from the spec's Part 1).

```bash
git add docs/design/guided-setup-spike.md && git commit -m "docs(design): guided setup spike results"
```

The executor reports the results to the owner before Lane D's Task 13 and Lane A's Task 4 start. A failed check means:
- PKCE fails on a callback: the paste field is primary there.
- sslip.io fails: no free name, and the Google flow stops on a bare IP.

---

## Lane A: kernel (product)

### Task 1: Declared setup flows compile into the board's points

**Files:**
- Create (modules repo): `board/schemas/setup_flows.json`
- Modify (modules repo): `board/module.yaml` (`points:` gains `setup_flows: { schema: schemas/setup_flows.json }`)
- Modify (product): `scripts/modules.mjs` (validation: every `secrets` entry names a secret with `setup:` in the same
  module)
- Test (product): `scripts/test/setup-flows.test.mjs`

**Interfaces:**
- Produces: `config/points/board.json` → `setup_flows: SetupFlow[]`:

```ts
interface SetupFlow {
  module: string;            // the declaring module (compile fills it in)
  order: number;             // 0-999
  title: string;             // ≤ 40 chars
  why: string;               // ≤ 160 chars, one sentence
  effort: string;            // ≤ 60 chars, e.g. "about 2 minutes, needs the Telegram app"
  wizard?: boolean;          // in the first-run wizard
  steps: string;             // markdown, ≤ 1500 chars
  secrets?: string[];        // names of this module's `setup:` secrets, shown as paste fields in this order
  signin?: string;           // an id from this module's board.signins: its connect button
  pair_url?: string;         // ^http://[a-z][a-z0-9-]{0,62}:[0-9]{2,5}/pair$ : the module service's pairing endpoint
  pair_token?: string;       // filled by compile: the generated secret <module>_pair_token the board sends as bearer
}
```

- [ ] **Step 1: Write the failing test** `setup flows compile with their module and refuse undeclared secrets`. Compile a
  fixture module that declares `setup_flows: [{ order: 10, title: "Aiden on your phone", why: "…", effort: "…",
  steps: "1. …", secrets: ["telegram_bot_token"], pair_url: "http://telegram:8090/pair" }]`. Assert that
  `points.board.setup_flows[0].module === "<fixture>"` and that `pair_token` is set. A second fixture names
  `secrets: ["not_declared"]`; assert that compile throws `/names a secret without setup/`.
- [ ] **Step 2: Run it and see it fail:** `cd scripts && node --test test/setup-flows.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - The JSON Schema enforces the field limits above.
  - `scripts/modules.mjs` adds the cross-check against the module's `setup:` secrets.
  - A flow with `pair_url` makes compile generate `<module>_pair_token` (the same generated-secret path as `_auth_token`
    for sign-ins) and mount it into the board and the module's service.
- [ ] **Step 4: Run it and see it pass:** `cd scripts && npm test`. Expected: PASS (all).
- [ ] **Step 5: Commit both repos' changes** as PRs:
  - `feat(board): setup flows as a board point` (modules)
  - `feat(compile): validate setup flows` (product)

### Task 2: `save_secret` and `setup_status` account ops

**Files:**
- Create: `kernel/src/module-secrets.ts`
- Modify: `kernel/src/auth-api.ts` (two ops), `kernel/src/main.ts:190-200` (reuse `firstRun.save`, pass the deps)
- Test: `kernel/test/module-secrets.test.mjs`

**Interfaces:**
- Consumes: `modulesFile().setup` (each entry is a `SetupField`: `{ module, secret, label, pattern, help?, required? }`)
  and `config/modules.json` (each module's compose service names; add them to the kernel's modules file in compile if
  they aren't there).
- Produces:
  - `POST /v1/accounts/save_secret {token, module, secret, value}` → `{ ok: true, restarted: string[] } | 4xx {error}`
  - `POST /v1/accounts/setup_status {token, module}` → `{ secrets: Record<string, boolean> }`
  - `createModuleSecrets(deps: { fields: () => SetupField[], services: (module: string) => string[], save: (name: string, value: string) => void, has: (name: string) => boolean, recreate: (services: string[]) => Promise<void>, log }): { save(module: string, secret: string, value: string): Promise<{ restarted: string[] }>, status(module: string): Record<string, boolean> }`
  - `recreate` runs `docker compose -p $COMPOSE_PROJECT_NAME up -d --force-recreate --no-deps <services>` while holding
    `data/apply.lock`, the same lock as `ops/apply-config.sh`, via `flock -w 600`.

- [ ] **Step 1: Write the failing tests:**
  - `save_secret writes a declared secret and recreates its module's services`: assert that the file mode is 0600, the
    value matches, and `recreate` was called with exactly that module's services.
  - `save_secret refuses an undeclared secret, another module's secret, a pattern mismatch and an off module`: 400 or
    404 each, with nothing written.
  - `save_secret needs an admin session with an authenticator`: 403 for a session that isn't ready.
  - `save_secret waits for the apply lock`: hold the lock in the test, call save, assert that recreate runs only after
    release.
  - `setup_status reports booleans only`: no value appears in the response.
- [ ] **Step 2: Run them and see them fail:** `cd kernel && node --test test/module-secrets.test.mjs`.
- [ ] **Step 3: Implement** `createModuleSecrets` and the two ops. The ops take the session the way the other account
  ops do (`auth: "board+session"`) and need `s.ready`. Log `{ module, secret, restarted }` and never the value. A
  recreate failure returns 502 with the compose error's last line.
- [ ] **Step 4: Run them and see them pass:** `cd kernel && npm test && npm run typecheck`.
- [ ] **Step 5: Commit** as PR `feat(kernel): save a module's declared secret from the board`.

### Task 3: Recovery-key page on the kernel

**Files:**
- Modify: `kernel/src/admin.ts` (routes `GET /recovery-key` admin, `POST /recovery-key` admin+csrf; drop the
  recovery-key box from `setupPage`)
- Test: `kernel/test/recovery-key.test.mjs`

**Interfaces:**
- Consumes: `firstRun.recoveryKey()` and `firstRun.forgetRecoveryKey()`.
- Produces:
  - `GET /recovery-key` shows the key, Copy, Download (a `data:` link to `aidenhq-recovery-key.txt`), and a form with
    `choice=saved|decline`. With no key, it shows "No recovery key is waiting."
  - `POST` with either choice deletes the key and redirects to `${boardUrl}/#/welcome`.
  - `GET /api/recovery-key-waiting` (admin) → `{ waiting: boolean }`, for the board.

- [ ] **Step 1: Write the failing test** `recovery key shows to an admin and is gone after saved`. Assert that a GET
  contains the 64-hex key; after POST `choice=saved`, the file is gone and a GET says no key is waiting. Also: a
  non-ready session gets 403.
- [ ] **Step 2: Run it and see it fail:** `cd kernel && node --test test/recovery-key.test.mjs`.
- [ ] **Step 3: Implement** the routes in the existing `routes` table and page style.
- [ ] **Step 4: Run it and see it pass:** `cd kernel && npm test && npm run typecheck`.
- [ ] **Step 5: Commit** as PR `feat(kernel): the recovery key on its own show-once page`.

### Task 4: Slim `/setup` with Connect OpenRouter and a model check

**Files:**
- Modify: `kernel/src/admin.ts` (`setupPage` and the `/setup` handler; new `GET /setup/openrouter`)
- Create: `kernel/src/openrouter-pkce.ts`
- Modify: `ops/test/unattended-install.sh` (the form has no module fields and no recovery-key tick)
- Test: `kernel/test/setup-openrouter.test.mjs`

**Interfaces:**
- Consumes: `firstRun.save`, and the gateway's model call path (`gw`) for the check.
- Produces:
  - `startPkce(callback: string): { url: string, verifier: string }`
  - `exchange(code: string, verifier: string, fetchImpl?): Promise<string>` (the key)
  - `checkModel(key: string): Promise<"ok" | "no_credit" | "error">`: one max-1-token call to the default model.

The setup page now has, in order:
1. name, email, password;
2. authenticator enrolment (unchanged, `/auth/enrol`);
3. the model.

The model step comes after enrolment:
- It shows a **Connect OpenRouter** button, plus "paste a key instead" revealing the `openrouter_key` field.
- The only module `setup:` field `/setup` still shows is `models-openrouter`'s key. All other fields leave the page.
- The PKCE verifier is kept server-side, keyed by the setup session.
- On `no_credit` the page shows "Add credit in OpenRouter" (link `https://openrouter.ai/settings/credits`) and Retry.
- On ok it redirects to the board's `#/welcome`.
- The `/auth/enrol` page gains one line, "An app on your phone, like Google Authenticator, that shows a 6-digit code",
  and the manual key under the QR code.

Tests:
- [ ] **Step 1: Write the failing tests:**
  - `setup takes account then model`: the account is created, then the model step appears; with a stubbed exchange and
    check `ok`, the key is in the vault and the response redirects to `#/welcome`.
  - `openrouter error keeps the account`: the callback has `?error=access_denied`; the account exists, and the model
    step shows again with the error and no new account form.
  - `no credit shows retry`: `checkModel` returns `no_credit`; the page contains "Add credit" and a Retry form.
- [ ] **Step 2: Run them and see them fail:** `cd kernel && node --test test/setup-openrouter.test.mjs`.
- [ ] **Step 3: Implement.** Use the exact endpoints from Task 0's report. If PKCE failed for this exposure, show the
  paste field first.
- [ ] **Step 4: Run them and see them pass:** `cd kernel && npm test && npm run typecheck`, then the unattended test in
  a container per its header.
- [ ] **Step 5: Commit** as PR `feat(kernel): first run is account, authenticator and Connect OpenRouter`.

---

## Lane B: board (product)

### Task 5: Flow API and the generic flow component

**Files:**
- Create: `services/board/src/setup-flows.ts`, `services/board/web/src/SetupFlow.tsx`
- Modify: `services/board/src/config.ts` (read `setup_flows` from the points file, like `signInPoints`),
  `services/board/src/app.ts` (routes), `services/board/web/src/App.tsx` (`Route` gains
  `{ kind: "setup"; module: string }` for `#/setup/<module>`)
- Test: `services/board/test/setup-flows.test.ts`

**Interfaces:**
- Consumes: Task 1's `SetupFlow[]`; Task 2's `save_secret` and `setup_status` through `accounts.call(op, who, body)`;
  the existing sign-in states (`signInStates()`).
- Produces:
  - `GET /api/setup-flows` → `{ flows: (SetupFlow & { done: boolean, dismissed: boolean })[] }`, with no `pair_token`.
    `done` = every secret present, and the sign-in ok if one is declared, and paired if `pair_url` is set.
  - `POST /api/setup-flows/<module>/secret {secret, value}` → passes through to `save_secret`.
  - `POST /api/setup-flows/<module>/dismiss` → stored in the board store (`setup_dismissed` set).
  - `POST /api/setup-flows/<module>/pair` → proxies `POST <pair_url>` with the bearer `pair_token`, returning
    `{ code, link? }`.
  - `GET /api/setup-flows/<module>/pair` → proxies `GET <pair_url>` → `{ paired: boolean }`.
  - `<SetupFlow module={string} onDone={() => void} />`: renders, in order:
    - title, why and effort;
    - the steps (markdown);
    - one password field per secret, validated client-side against the declared pattern;
    - Save;
    - then the sign-in Connect button or the pairing code and link, polling `GET …/pair` every 2 s;
    - **Later**.

    Errors from Save show inline, with the kernel's message.

- [ ] **Step 1: Write the failing tests:**
  - `setup-flows lists only on modules and never the pair token`
  - `secret save passes through as the signed-in admin`
  - `done needs secrets, sign-in and pairing`
  - `pair mint needs an authenticator session`: 403 otherwise.
- [ ] **Step 2: Run them and see them fail:** `cd services/board && npx vitest run test/setup-flows.test.ts`.
- [ ] **Step 3: Implement** the server routes and the component with the board's existing design-system pieces (no new
  dependencies).
- [ ] **Step 4: Run them and see them pass:**
  `cd services/board && npx vitest run && npx tsc -p tsconfig.build.json --noEmit && npm run typecheck && npm run build`.
- [ ] **Step 5: Commit** as PR `feat(board): generic module setup flows at #/setup/<module>`.

### Task 6: First-run wizard and Aiden's welcome

**Files:**
- Create: `services/board/web/src/Welcome.tsx`
- Modify:
  - `services/board/web/src/App.tsx`: route `#/welcome`, shown on first load while the store has no
    `welcome_finished`.
  - `services/board/src/app.ts`: `POST /api/welcome/finish {done: string[], skipped: string[]}` posts the welcome,
    reusing the `/internal/owner/welcome` code path at `app.ts:982-986` and its `data/board/welcome-sent` marker.
  - `ops/setup.sh:498-511`: stop sending the welcome.
- Test: `services/board/test/welcome.test.ts`

**Interfaces:**
- Consumes: Task 3's `/api/recovery-key-waiting` (via the kernel) and Task 5's `GET /api/setup-flows` and
  `<SetupFlow>`.
- Produces: the wizard's screens.
  - **Recovery key**, only if one is waiting: a button opens the kernel's `/recovery-key`, and it comes back to
    `#/welcome`.
  - **Each flow with `wizard: true`,** in `order`.
  - **The summary screen,** with **Meet Aiden**.

  Every screen has **Meet Aiden now**, a progress row of dots (one per screen) and **Later**. Leaving the wizard any
  way calls `/api/welcome/finish` once.

  The welcome text, verbatim:

  ```
  Welcome

  [setup] <owner name>'s AidenHQ is new. Connected: <done or "nothing yet">. Skipped: <skipped or "nothing">. Start the first chat with a new owner (your handbook).
  ```

  The module list goes inside the existing fence helper.

- [ ] **Step 1: Write the failing tests:**
  - `finish posts one welcome with done and skipped`: a second call posts nothing.
  - `wizard lists only wizard flows in order`.
- [ ] **Step 2: Run them and see them fail:** `cd services/board && npx vitest run test/welcome.test.ts`.
- [ ] **Step 3: Implement.** Remove the welcome step from `ops/setup.sh` and update `scripts/test/setup.test.mjs` if it
  asserts the step.
- [ ] **Step 4: Run them and see them pass:** the board's suite (as in Task 5) and `cd scripts && npm test`.
- [ ] **Step 5: Commit** as PR `feat(board): the first-run wizard ends in Aiden's welcome`.

---

## Lane C: module flows (modules repo; one subagent per task, all after Task 1)

Each task adds `board.setup_flows` to the module, gives every user-provided secret a `setup:` entry, and replaces
shell-only setup text. It also removes host `.env` inputs where the flow now provides the value. Each task ends with
the modules repo's tests for that module, `npm test && npm run typecheck`.

### Task 7: The chief-of-staff tour

**Files:** Modify `chief-of-staff/agents/<aiden key>/AGENTS.md` (its onboarding section).

- [ ] **Step 1: Write the tour.** The section answers a `[setup]` welcome with one reply covering the spec's five
  points (Part 4). It names skipped flows with their `#/setup/<module>` links, offers the guided Google flow and up to
  three catalog modules not on, and ends with "Ask me anything." The wording is positive only (owner rule: handbooks
  say what to do).
- [ ] **Step 2: Run the handbook assertions:**
  `cd services/computer && node --test test/*.test.mjs` and `cd scripts && npm test` in the product, with the pin
  bumped locally.
- [ ] **Step 3: Commit** as PR `feat(chief-of-staff): the new-owner tour`.

### Task 8: Telegram flow and pairing

**Files:**
- Modify: `channel-telegram/module.yaml` (`board.setup_flows` with `wizard: true`, order 20,
  `secrets: [telegram_notify_bot_token]`, `pair_url: http://channel-telegram-telegram:<port>/pair`; drop
  `TELEGRAM_OWNER_CHAT_ID` from env)
- Create: `channel-telegram/connections/telegram/src/pair.ts`
- Modify: `channel-telegram/connections/telegram/src/main.ts` (`/pair` routes; the owner chat comes from
  `store.ownerChat()`), `approvals.ts:62-66` (compare against the stored owner chat)
- Test: `channel-telegram/connections/telegram/test/pair.test.ts`

**Interfaces:**
- Produces:
  - `POST /pair` (bearer `pair_token`) → `{ code, link: "https://t.me/<bot username>?start=<code>" }`
  - `GET /pair` → `{ paired }`
  - Telegram `/start <code>` from any chat: on a valid code, the chat becomes the owner chat, the old chat (if any) gets
    "This chat is no longer paired with AidenHQ.", and the new chat gets "Paired. Say hi to Aiden."
  - `createPairing(store, now = Date.now): { mint(): string, redeem(code: string, chatId: number): boolean, paired(): boolean }`

- [ ] **Step 1: Write the failing tests:**
  - `a fresh code pairs the sending chat`
  - `a used code pairs nobody`
  - `an expired code pairs nobody`: 15 minutes and 1 ms.
  - `six wrong codes in a minute are refused`
  - `re-pairing notifies the old chat`
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.** The code is `randomBytes(16).toString("base64url")`, stored hashed, consumed in one
  transaction.
- [ ] **Step 4: Run them and see them pass.**
- [ ] **Step 5: Commit** as PR `feat(channel-telegram): set up and pair from the board`.

### Task 9: Slack flow and pairing

**Files:** `channel-slack/module.yaml` and its service, the same shape as Task 8. Also:
- `setup:` on `slack_live_app_token` (`^xapp-[A-Za-z0-9-]{20,300}$`) and `slack_live_bot_token`
  (`^xoxb-[A-Za-z0-9-]{20,300}$`);
- `wizard: true`, order 30;
- the steps start with the manifest pre-fill link (Task 0 confirms the URL);
- pairing by DMing the bot the code;
- `OWNER_SLACK_USER_ID` and `OWNER_COMMAND_CHANNEL` leave `.env`; the command channel is the paired DM;
- add `channel-slack` to `marketplace.json`'s `bundle`.

**Tests:** `a DMed code pairs that user` and `a code posted in a channel pairs nobody`.

- [ ] Steps as in Task 8. Commit as PR `feat(channel-slack): set up and pair from the board`.

### Task 10: Guided Google flow

**Files:**
- Modify: `google/module.yaml` (a flow with `wizard: false`, order 40; `secrets: [google_oauth_client]` with a `setup:`
  pattern for `<id>.apps.googleusercontent.com|<secret>`; `signin` = the Google connect)
- Modify: `google/connections/google-workspace-mcp/src/auth.ts` (read the client from the new secret, keeping `accounts`
  in `google_oauth.json`)
- Modify: `marketplace.json` (`google` joins the bundle)
- Modify (product): `ops/setup.sh` (stop writing `google_oauth.json` from `person.env`, unless given)

The steps are the spec's Part 3b. The redirect URI is shown from the board's address. When the board has no name
(bare IP, and no free name per Task 0), the steps say why and stop there.

**Tests:** `a pasted client keeps stored accounts` and `bare-IP board shows the name requirement`.

- [ ] Steps as in Task 8. Commit as PR `feat(google): guided own-client setup from the board`.

### Task 11: Flows for the remaining modules

**Files:** each module's `module.yaml`, plus small service changes where a value still comes from `.env` or a host
script.

- [ ] **Step 1: Confirm the list.** For each of `slack`, `github`, `glean`, `jira`, `primer`, `meetings`, `grafana`,
  `clickhouse`, `codehost-github`, `engine-claude`, `engine-codex`, `monitoring` and `security`, decide:
  - **no flow:** it works with defaults;
  - **flow:** the secrets, sign-in and setting it needs;
  - **host-only:** an `.env` value that must stay host-controlled.

  Write the table into the PR description. List the host-only values for the owner.
- [ ] **Step 2: Add flows in batches.** Each module whose flow needs a URL setting (glean, grafana, clickhouse) sets it
  through the existing settings-change path. Check `services/board/src/settings-change.ts`: if an owner-made change
  becomes a card, the flow shows that card's Approve inline (reuse the existing card component). A sign-in step stays
  disabled until the setting is applied, so nothing half-works. Each batch is one PR,
  `feat(<module>): setup flow`, with the module's tests.
- [ ] **Step 3: Replace `scripts/slack-auth.sh` and similar host scripts** where the flow now covers them. Delete the
  script and its docs.

---

## Lane D: install (distro + product)

### Task 12: Prebuilt release images

**Files:**
- Modify: `distro/.github/workflows/release.yml` (build and push each locally built image to `ghcr.io/aiden-hq/<name>`
  for amd64 and arm64; write the digests into `releases/<version>.json` under `images`)
- Modify (product): `ops/apply-config.sh` (when the release file has `images`, pull those digests in parallel and skip
  builds; with no `images`, it builds as today)
- Test (product): `scripts/test/release-images.test.mjs`

- [ ] **Step 1: Write the failing test** `apply pulls pinned images instead of building`: a fixture release with
  `images` makes the compose override use `image: …@sha256:…` and no `build:` for those services.
- [ ] **Steps 2-4:** fail, then implement, then pass (`cd scripts && npm test`).
- [ ] **Step 5: Commit** two PRs: `ci(release): publish prebuilt images` (distro) and `feat(ops): pull release images
  instead of building` (product).

### Task 13: Progress lines and the one-link finish

**Files:**
- Modify: `distro/install.sh` (`step()` at line 47 also prints the progress line, from a fixed ordered list of steps
  with per-step weights measured in Task 0)
- Modify (product): `ops/setup.sh` and `ops/apply-config.sh` (`apply timing:` phases print progress lines too,
  continuing the installer's numbering through `AIDENHQ_PROGRESS_BASE`)
- Test: `distro/installer/test.sh` (extend)

- [ ] **Step 1: Write the failing tests:**
  - `progress is monotonic and ends at 100% before the link`: parse every `AIDENHQ_PROGRESS=` line in a dry run;
    percent never decreases, and the last one before `AIDENHQ_SETUP_URL=` is 100.
  - `rerun after a killed pull`: kill during the pull, rerun; one `AIDENHQ_SETUP_URL=` line, and the token from the
    rerun is the only valid one.
- [ ] **Steps 2-4:** fail, then implement, then pass (`sh distro/installer/test.sh`).
- [ ] **Step 5: Commit** as PR `feat(installer): progress lines and the link at the end`.

### Task 14: Public HTTPS front door (U2)

Build unit U2 exactly as `docs/design/minimal-core-install.md` sections 4.1 to 4.3 specify:
- a Caddy `caddy:2.11.9` container pinned by digest, with the IP certificate on the `shortlived` profile;
- the board learning the real client address;
- the per-address ban, the new-sign-in notice and the mode-aware firewall;
- its exit check, a live issuance against Let's Encrypt staging.

If Task 0 showed the free name works, Caddy also serves `<ip-dashes>.sslip.io`, and that becomes the board's address.
PR: `feat(ops): public HTTPS front door`.

### Task 15: The prompt and the getting-started page

**Files:**
- Modify (distro): `site/prompt.md`
- Create (distro): `site/start/index.html` and `site/start/index.md`

- [ ] **Step 1: Rewrite `prompt.md` to the spec's Part 1.**
  - Ask only: "server or this machine" (the AI may decide), and the email.
  - No GitHub token, unless the repo is private.
  - No Tailscale question.
  - Relay `AIDENHQ_PROGRESS` as one line: `Installing AidenHQ… 62% (downloading Aiden, ~3 min left)`.
  - The finish box shows one link, plus "keep your Mac awake" on a Mac.
- [ ] **Step 2: Write the `/start` page,** one screen: install with your AI, open the link, three quick steps, talk to
  Aiden. It uses the site's existing styles.
- [ ] **Step 3: Run the site's tests and commit** as PR `docs(site): one-prompt install and getting started`.

---

## Lane E: on-server code host (product + modules)

### Task 16: Recon and spec

**Files:** Create `docs/design/codehost-local.md`.

- [ ] **Step 1: Map every GitHub assumption** with file:line, at least in:
  - `services/runner/src/main.mjs`: clone, `repo_sources`, PRs, merges, CI waits;
  - `modules/codehost-github/src/{git,plan}.mjs`;
  - `modules/apps-platform/apps-mcp/src/git.ts`;
  - the `ci` module;
  - the platform module's self-improvement flow;
  - the board's PR views.
- [ ] **Step 2: Write the spec** from the guided-setup design's Part 4b: the `provides: [codehost]` role, bare repos
  under the data dir, change requests as kernel write records, checks in the job jail at the exact head, an atomic
  squash merge, and apps-mcp reading through the role. Name the reviewer-eval cases that the `plan.mjs` changes need.
- [ ] **Step 3: Commit, open a PR, and send it to the owner for approval.** Its build plan is written after approval.
  GitHub leaves the bundle only when that build lands.

---

## Integration (after Lanes A–D land)

### Task 17: End-to-end and docs

**Files:**
- Modify: `ops/test/unattended-install.sh` (walks install → `/setup` with a stubbed OpenRouter → `/recovery-key` saved →
  `#/welcome` finish with every flow skipped → the welcome chat exists with `Skipped:` naming telegram and slack)
- Modify: `SETUP.md`: the default path becomes "paste the prompt from aidenhq.ai"; today's manual path moves to
  `docs/setup.md`.

- [ ] **Step 1: Extend the test and run it** in a container per its header. Expected: all `ok`.
- [ ] **Step 2: Rewrite `SETUP.md` and move the manual path.** Run `cd scripts && npm test` (the setup-skill test reads
  `SETUP.md`).
- [ ] **Step 3: Live check.** On a fresh VM (the home `agents-old` reinstall is queued for exactly this), run the prompt
  end to end with a stopwatch. Record time to link and time to first reply in the spike report.
- [ ] **Step 4: Commit** as PR `docs(setup): the one-prompt install is the default path`.

## Order and parallelism

- **First:** Task 0.
- **Then in parallel:**
  - Lane A (Tasks 1→2→3→4; 3 can run beside 2);
  - Lane D (12→13, with 14 and 15 alongside);
  - Lane E (16).
- **After Tasks 1 and 2:** Lane B (5→6) and Lane C (7–11, in parallel, each after Task 1; 8–10 also need Task 5 to try
  them in the board).
- **Last:** Task 17.

About 12 subagents in total, most on Sonnet; Opus for Tasks 2, 8 and 16 (security boundaries and the code-host design).
