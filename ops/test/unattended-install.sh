#!/usr/bin/env bash
# The unattended install end to end (lean-core 5d, spec §6.10), as root in a throwaway container. The kernel and the release
# come from local bare repos; the kernel is checked out the way the installer does; then ops/setup.sh --unattended runs for
# real, with stand-ins only for what a container can't do: the host packages, the vault's FUSE mount and the stack's apply
# (recorders in the fixture commit), Docker and systemd (shims on PATH; the systemctl shim starts the real kernel). The
# kernel's /setup is then completed over HTTP: account, TOTP code, then the model step with a pasted key, checked against a
# stubbed OpenRouter (the kernel's AIDENHQ_GATEWAY_UPSTREAM; it answers 402 once, so Retry is exercised). Then the real board
# (built from the checkout, started beside the kernel as the compose service would be) takes the owner through its welcome
# finished at once; Paperclip, where the kernel files onboarding's task for Aiden, is a stub that records the request.
# It asserts:
#   - one AIDENHQ_SETUP_URL line, the last; without a tailnet the SSH-tunnel route and a loopback URL;
#   - root's steps ran from root-owned /opt/aidenhq/kernel/<sha>, never from the user's checkout (its ops/setup.sh and
#     ops/vm/setup.sh tampered after the copy);
#   - the kernel token reaches setup's fetch, and never the checkout or the output; no key in the kernel's log;
#   - the kernel answers from the checkout at the release's kernel sha, and the instance pins that release;
#   - /setup takes the account only, then the TOTP enrolment, then /setup/model the model key (paste first on a plain-http
#     loopback address, "Add credit" and Retry on a 402, then the board's welcome); the recovery key then shows once on
#     /recovery-key; a second /setup is refused;
#   - the board's session comes through the kernel's handoff; its welcome is unfinished; finishing it files one task for
#     Aiden (source welcome, through the kernel's board tasks) and no chat, writes the welcome-sent marker, and a second
#     finish files none.
#   sudo bash ops/test/unattended-install.sh   (root, git, curl, node 24, kernel/, scripts/ and services/board installed (bun install); it adds a user and
#                                               /opt/aidenhq, so it runs only where /.dockerenv exists or CI is set)
# Not in CI: our runners' job containers set no-new-privileges, so sudo can't reach root there. Run it in a container,
# e.g. a Node 24 Debian image with the checkout mounted, after bun install in kernel/, scripts/ and services/board. The release
# pins the kernel alone: the official modules are its own modules/.
set -euo pipefail
src="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
[ "$(id -u)" = 0 ] || exec sudo -n env PATH="$PATH" CI="${CI:-}" bash "$0" "$@"
[ -f /.dockerenv ] || [ -n "${CI:-}" ] || { echo "refusing: this test adds a user and /opt/aidenhq; run it in a throwaway container" >&2; exit 1; }
[ -d "$src/kernel/node_modules" ] && [ -d "$src/scripts/node_modules" ] && [ -d "$src/services/board/node_modules" ] || { echo "bun install in kernel/, scripts/ and services/board first" >&2; exit 1; }
U=alice H=/home/alice
work="$(mktemp -d /tmp/unattended.XXXXXX)"; chmod 0755 "$work"
ok() { echo "ok   $*"; }
fail() { echo "FAIL $*"; for f in setup.out kernel.log openrouter.log board.log paperclip.log; do [ -s "$work/$f" ] && { echo "--- $f"; tail -40 "$work/$f"; }; done; exit 1; }
pid_of() { local p; for p in /proc/[0-9]*; do [ "$(stat -c %U "$p" 2>/dev/null)" = "$U" ] && tr '\0' ' ' < "$p/cmdline" 2>/dev/null | grep -q "^node .*$1" && { echo "${p#/proc/}"; return; }; done; }
kernel_pid() { pid_of 'kernel/src/main\.ts'; }
cleanup() { local p; for p in "$(kernel_pid)" "$(pid_of 'board/dist/src/main\.js')" "${stub_pid:-}" "${pc_pid:-}"; do [ -z "$p" ] || kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT
g() { git -c user.name=t -c user.email=t@example.com -c init.defaultBranch=main "$@"; }

# ---------------------------------------------------------------- fixtures: the kernel and distro repos
# The kernel: this tree's files (uncommitted edits included), with recorders for the three host scripts a container can't run.
mkdir -p "$work/k" "$work/git"
(cd "$src" && git -c safe.directory="$src" ls-files -z --cached --others --exclude-standard | tar --null -T - --ignore-failed-read -cf - 2>/dev/null) | tar -xf - -C "$work/k"
recorder() { # path body: logs its own path and user to root-steps.log, then runs body
  { echo '#!/usr/bin/env bash'
    echo 'echo "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}") $(id -un)" >> '"$work"'/root-steps.log'
    echo "$2"; } > "$work/k/$1"
}
recorder ops/vm/setup.sh ':'
# The vault: its cipher dir (setup's "already made" marker) and a recovery key in root's home, as ops/vault/init.sh leaves it.
recorder ops/vault/init.sh "runuser -u $U -- mkdir -p $H/.local/share/aidenhq/vault.enc; printf '0123456789abcdef%.0s' 1 2 3 4 > /root/aidenhq-vault-recovery.txt"
# The apply (as the user): the real compile (the kernel's generated secrets, the modules' /setup fields in
# config/kernel/modules.json), then what Paperclip's setup records: the company, and the grants table (Aiden, fleet-admin).
recorder ops/apply-config.sh 'cd "$(dirname "${BASH_SOURCE[0]}")/.." && node scripts/compile.ts > /dev/null || exit 1
sed -i "s/^  company_id: \"\"/  company_id: \"00000000-0000-4000-8000-000000000001\"/" config/system.yaml
mkdir -p config/grants && echo "{\"agents\":{\"agent-aiden\":{\"key\":\"chief-of-staff\",\"roles\":[\"fleet-admin\"]}}}" > config/grants/grants.json'
g -C "$work/k" init -q && g -C "$work/k" add -A && g -C "$work/k" commit -qm kernel
g clone -q --bare "$work/k" "$work/git/kernel.git"
KSHA="$(git -C "$work/k" rev-parse HEAD)"
mkdir -p "$work/d/releases"
printf '{ "release": "2026.11", "kernel": "%s" }\n' "$KSHA" > "$work/d/releases/2026.11.json"
g -C "$work/d" init -q && g -C "$work/d" add -A && g -C "$work/d" commit -qm release
g clone -q --bare "$work/d" "$work/git/distro.git"
RSHA="$(git -C "$work/d" rev-parse HEAD)"

# ---------------------------------------------------------------- the installer's part: user, verified checkout, token file
id "$U" >/dev/null 2>&1 || useradd -m -s /bin/bash "$U"
chown -R "$U:$U" "$work/git"   # as a remote it fetches from: git refuses a repository someone else owns
runuser -u "$U" -- git clone -q "file://$work/git/kernel.git" "$H/aidenhq"
runuser -u "$U" -- git -C "$H/aidenhq" -c advice.detachedHead=false checkout -q --detach "$(git --git-dir="$work/git/distro.git" show "$RSHA:releases/2026.11.json" | sed -n 's/.*"kernel": "\([0-9a-f]*\)".*/\1/p')"
for d in kernel scripts services/board; do cp -a "$src/$d/node_modules" "$H/aidenhq/$d/" && chown -R "$U:$U" "$H/aidenhq/$d/node_modules"; done
TOKEN="ghp_$(head -c 18 /dev/urandom | od -An -tx1 | tr -d ' \n')"   # random: this file is in the checkout too
(umask 077; printf '%s\n' "$TOKEN" > "$work/ktoken")
# Root's copy, as install.sh's root_verify makes it: a --no-local clone of the checkout, the release's sha exported into
# /opt/aidenhq/kernel/<sha>; setup is started from there.
K="/opt/aidenhq/kernel/$KSHA"
GIT_NO_REPLACE_OBJECTS=1 git clone -q --bare --no-local --upload-pack="runuser -u $U -- git upload-pack" "$H/aidenhq" "$work/rv.git"
install -d -m 0755 /opt/aidenhq /opt/aidenhq/kernel && mkdir -m 0755 "$work/tree"
git --git-dir="$work/rv.git" archive "$KSHA" | tar -x --no-same-owner --no-same-permissions -C "$work/tree"
chown -R root:root "$work/tree" && chmod -R u+rwX,go+rX,go-w "$work/tree" && mv "$work/tree" "$K"
# The user's checkout is writable by the user: what root runs must not come from it, setup itself included.
for f in ops/setup.sh ops/vm/setup.sh; do echo 'echo TAMPERED >> '"$work"'/root-steps.log; exit 0' > "$H/aidenhq/$f"; done

# ---------------------------------------------------------------- a stubbed OpenRouter (the model step's 1-token check)
# Logs each call's path and whether it carried the expected key (never the key); the first chat call answers 402 (no credit).
cat > "$work/openrouter.mjs" <<'EOF'
import http from "node:http";
import { appendFileSync } from "node:fs";
const [port, log, key] = process.argv.slice(2);
let calls = 0;
http.createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
    const chat = req.url === "/api/v1/chat/completions", n = chat ? ++calls : 0;
    appendFileSync(log, `${req.method} ${req.url} key=${req.headers.authorization === `Bearer ${key}`} max_tokens=${JSON.parse(b || "{}").max_tokens}\n`);
    if (!chat) return void res.writeHead(404).end();
    if (n === 1) return void res.writeHead(402, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: 402, message: "Insufficient credits" } }));
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
  });
}).listen(Number(port), "127.0.0.1");
EOF
MODEL_KEY="sk-or-v1-$(printf 'f%.0s' $(seq 64))"
STUB_PORT=3999
: > "$work/openrouter.log"; chmod 0666 "$work/openrouter.log"
node "$work/openrouter.mjs" "$STUB_PORT" "$work/openrouter.log" "$MODEL_KEY" & stub_pid=$!

# ---------------------------------------------------------------- shims: systemd and Docker
mkdir -p "$work/bin"
: > "$work/kernel.log"; : > "$work/systemctl.log"; : > "$work/root-steps.log"; chmod 0666 "$work/kernel.log" "$work/systemctl.log" "$work/root-steps.log"
cat > "$work/bin/systemctl" <<EOF
#!/usr/bin/env bash
echo "systemctl \$*" >> $work/systemctl.log
case "\$*" in
  *"show -p MainPID"*) echo 0 ;;
  *"is-active"*) exit 3 ;;
  *"enable --now"*aidenhq-kernel*)
    dir="\$(sed -n 's/^AIDENHQ_DIR=//p' "\$HOME/.config/aidenhq-checkout.env")"
    cd "\$dir" && AIDENHQ_KERNEL_BACKPLANE=127.0.0.1:3130 AIDENHQ_GATEWAY_LISTEN=127.0.0.1:8201 AIDENHQ_GATEWAY_CI_LISTEN= \\
      AIDENHQ_GATEWAY_UPSTREAM=http://127.0.0.1:$STUB_PORT/api/v1 \\
      setsid nohup node --disable-warning=ExperimentalWarning kernel/src/main.ts >> $work/kernel.log 2>&1 < /dev/null & ;;
esac
exit 0
EOF
printf '#!/bin/sh\ncase "$1" in info) echo "[]" ;; esac\nexit 0\n' > "$work/bin/docker"
# git: notes whether a fetch carries the kernel token's header for github.com (that it is set, never its value).
: > "$work/git-auth.log"; chmod 0666 "$work/git-auth.log"
# The release's repository (compile resolves instance.yaml's release from it) is the local bare one, offline.
cat > "$work/bin/git" <<EOF
#!/usr/bin/env bash
case " \$* " in *" fetch "*) [ -n "\${GIT_CONFIG_VALUE_0:-}" ] && echo "fetch \$GIT_CONFIG_KEY_0" >> $work/git-auth.log ;; esac
a=(); for x in "\$@"; do [ "\$x" = https://github.com/acme/aidenhq-distro.git ] && x=$work/git/distro.git; a+=("\$x"); done
exec $(command -v git) "\${a[@]}"
EOF
printf '#!/bin/sh\nexit 0\n' > "$work/bin/codex"; cp "$work/bin/codex" "$work/bin/opencode"
chmod 0755 "$work/bin"/*

# ---------------------------------------------------------------- ops/setup.sh --unattended
env PATH="$work/bin:$PATH" AIDENHQ_USER="$U" OWNER_EMAIL=owner@example.com AIDENHQ_KERNEL_BACKPLANE=127.0.0.1:3130 \
  AIDENHQ_RELEASE=2026.11 AIDENHQ_RELEASE_REPO=acme/aidenhq-distro AIDENHQ_RELEASE_SHA="$RSHA" \
  bash "$K/ops/setup.sh" --checkout "$H/aidenhq" --unattended --kernel-token-file "$work/ktoken" > "$work/setup.out" 2>&1 < /dev/null || fail "ops/setup.sh --unattended (exit $?)"
ok "ops/setup.sh --unattended ran with no terminal and no tailnet"

[ "$(grep -c '^AIDENHQ_SETUP_URL=' "$work/setup.out")" = 1 ] || fail "not exactly one AIDENHQ_SETUP_URL line"
URL="$(tail -1 "$work/setup.out" | sed -n 's/^AIDENHQ_SETUP_URL=//p')"
[[ "$URL" =~ ^http://localhost:3120/setup\?token=[A-Za-z0-9_-]{43}$ ]] || fail "the last line isn't the loopback /setup URL: $(tail -1 "$work/setup.out")"
grep -q '^AIDENHQ_SSH_TUNNEL=ssh -N -L 3121:127.0.0.1:3121 -L 3120:127.0.0.1:3120 -L 3130:127.0.0.1:3130 alice@' "$work/setup.out" || fail "no SSH tunnel line"
ok "one AIDENHQ_SETUP_URL line, the last: $URL (SSH tunnel printed)"

[ "$(stat -c '%U:%G %a' "$K")" = "root:root 755" ] || fail "$K isn't root:root 0755"
[ -z "$(find "$K" -perm /022 -print -quit)" ] && [ -z "$(find "$K" ! -user root -print -quit)" ] || fail "$K has a file others may write or root doesn't own"
grep -q TAMPERED "$work/root-steps.log" && fail "root ran the user's checkout"
grep -qx "$K/ops/vm/setup.sh root" "$work/root-steps.log" && grep -qx "$K/ops/vault/init.sh root" "$work/root-steps.log" || fail "root's steps didn't run from $K: $(cat "$work/root-steps.log")"
grep -qx "$H/aidenhq/ops/apply-config.sh $U" "$work/root-steps.log" || fail "the apply didn't run as $U from the checkout"
ok "root's steps ran from $K (root:root 0755), never the tampered checkout"

grep -rqF --exclude-dir=node_modules "$TOKEN" "$H/aidenhq" "$work/setup.out" && fail "the kernel token was written to the checkout or printed"
grep -qF "$TOKEN" "$H/aidenhq/.git/config" && fail "the kernel token is in the checkout's git config"
[ "$(cat "$work/git-auth.log")" = "fetch http.https://github.com/.extraheader" ] || fail "setup's fetch didn't carry the token's header, once: $(cat "$work/git-auth.log")"
ok "the kernel token rode setup's one fetch, and is in neither the checkout nor the output"

[ "$(runuser -u "$U" -- git -C "$H/aidenhq" rev-parse HEAD)" = "$KSHA" ] || fail "the checkout isn't at the release's kernel sha"
grep -qx "product: $KSHA" "$H/aidenhq-instance/instance.yaml" && grep -qF "sha: $RSHA }" "$H/aidenhq-instance/instance.yaml" || fail "instance.yaml doesn't pin the release: $(cat "$H/aidenhq-instance/instance.yaml")"
pid="$(kernel_pid)"
cwd="$(runuser -u "$U" -- readlink "/proc/${pid:-0}/cwd" 2>/dev/null || true)"   # its own user: a container denies root another user's cwd
[ "$cwd" = "$H/aidenhq" ] || fail "the kernel (pid ${pid:-none}, in ${cwd:-?}) does not run from the checkout"
ok "the kernel runs from the checkout at the release's kernel sha $KSHA; instance.yaml pins release $RSHA"

# ---------------------------------------------------------------- the board, and a stubbed Paperclip
# Paperclip answers only what onboarding's finish reads (who it is, the company, its agents with Aiden, Aiden himself, for the
# kernel's board task) and records each write; anything else is a 404.
cat > "$work/paperclip.mjs" <<'EOF'
import http from "node:http";
import { appendFileSync } from "node:fs";
const [port, log] = process.argv.slice(2);
const co = "/api/companies/00000000-0000-4000-8000-000000000001";
const reads = { "/api/cli-auth/me": { userId: "owner" }, [co]: { issuePrefix: "TST" }, [`${co}/agents`]: [{ id: "agent-aiden", name: "Aiden", status: "idle", metadata: { setupKey: "aidenhq:chief-of-staff" } }], [`${co}/labels`]: [{ id: "label-chat", name: "chat", color: "#0ea5e9" }], "/api/agents/agent-aiden": { id: "agent-aiden", companyId: "00000000-0000-4000-8000-000000000001", status: "idle" } };
http.createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
    const json = (status, v) => void res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(v));
    if (req.method === "GET") return reads[req.url] ? json(200, reads[req.url]) : json(404, { error: "stub" });
    appendFileSync(log, `${JSON.stringify({ method: req.method, url: req.url, body: JSON.parse(b || "{}") })}\n`);
    return req.url === `${co}/issues` ? json(201, { id: "issue-1", identifier: "TST-1" }) : json(404, { error: "stub" });
  });
}).listen(Number(port), "127.0.0.1");
EOF
PC_PORT=3100 # the kernel's default control plane: the board reaches it only through the kernel
: > "$work/paperclip.log"; : > "$work/board.log"; chmod 0666 "$work/paperclip.log" "$work/board.log"
node "$work/paperclip.mjs" "$PC_PORT" "$work/paperclip.log" & pc_pid=$!
S="$H/.config/aidenhq" B="$H/aidenhq/services/board"
runuser -u "$U" -- bash -c "cd '$B' && node_modules/.bin/tsc -p tsconfig.build.json" || fail "the board doesn't build"
# As compose runs it: its points, system config and secrets from the checkout and the vault, the kernel on the backplane.
runuser -u "$U" -- env BOARD_SYSTEM_CONFIG="$H/aidenhq/config/system.yaml" BOARD_POINTS_FILE="$H/aidenhq/config/points/board.json" \
  BOARD_SECRETS_DIR="$S" GATEWAY_BOARD_KEY_FILE="$S/gateway_board_key" \
  BOARD_DB="$H/aidenhq/data/board/board.sqlite" BOARD_STATIC_DIR="$B/web" BOARD_LAN_HOSTS=127.0.0.1:3121 \
  AIDENHQ_KERNEL_URL=http://127.0.0.1:3130 AIDENHQ_GATEWAY_URL=http://127.0.0.1:8201 \
  AIDENHQ_ADMIN_URL=http://localhost:3120 setsid nohup node "$B/dist/src/main.js" >> "$work/board.log" 2>&1 < /dev/null &
for _ in $(seq 30); do curl -fsS -o /dev/null http://127.0.0.1:3121/healthz 2>/dev/null && break; sleep 1; done
curl -fsS -o /dev/null http://127.0.0.1:3121/healthz || fail "the board didn't start"

# ---------------------------------------------------------------- /setup over HTTP
cat > "$work/http.mjs" <<'EOF'
import { request } from "node:http";
import { readFileSync } from "node:fs";
import { totp } from "./totp.mjs";
const [url, modelKey, boardPoints, paperclipLog] = process.argv.slice(2);
const u = new URL(url), token = u.searchParams.get("token"), jar = new Map();
// The kernel's admin listener (3120) by default; the board (3121) takes JSON with its header.
const call = (method, path, form, port = 3120) => new Promise((resolve, reject) => {
  const body = form ? (port === 3121 ? JSON.stringify(form) : new URLSearchParams(form).toString()) : undefined;
  const type = port === 3121 ? { "content-type": "application/json", "x-aidenhq-board": "1" } : { "content-type": "application/x-www-form-urlencoded" };
  const req = request({ host: "127.0.0.1", port, method, path, headers: { origin: `http://127.0.0.1:${port}`, cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "), ...(body ? type : {}) } }, (res) => {
    for (const c of res.headers["set-cookie"] ?? []) { const [kv] = c.split(";"); const i = kv.indexOf("="); jar.set(kv.slice(0, i), kv.slice(i + 1)); }
    let text = ""; res.on("data", (d) => (text += d)); res.on("end", () => resolve({ status: res.statusCode, location: res.headers.location, text }));
  });
  req.on("error", reject); req.end(body);
});
const want = (cond, what) => { if (!cond) { console.error(`FAIL ${what}`); process.exit(1); } console.log(`ok   ${what}`); };
const account = { token, email: "owner@example.com", name: "Owner", password: "correct horse battery staple" };

const page = await call("GET", u.pathname + u.search);
want(page.status === 200 && !page.text.includes("01234567") && !page.text.includes('name="saved"'), "GET /setup shows the form, and no recovery key");
want(page.text.includes('name="password"') && !page.text.includes('name="secret_'), "it asks for the account only: no module keys");
const badPassword = await call("POST", "/setup", { ...account, password: "short" });
want(badPassword.status === 400 && (await call("GET", u.pathname + u.search)).status === 200, "a short password is refused and the token stays unspent");
const done = await call("POST", "/setup", account);
want(done.status === 303 && done.location === "/auth/enrol", `the submit makes the account and hands over to the authenticator (${done.status} ${done.location})`);
want((await call("GET", u.pathname + u.search)).status === 410, "a second GET /setup is refused");
want((await call("POST", "/setup", account)).status === 410, "a second POST /setup is refused");
const csrfOf = (t) => /name="csrf" value="([0-9a-f]+)"/.exec(t)?.[1];
const enrol = await call("GET", "/auth/enrol");
const shown = await call("POST", "/auth/enrol", { csrf: csrfOf(enrol.text), password: account.password });
const key = /Key: <code>([A-Z2-7 ]+)<\/code>/.exec(shown.text)?.[1]?.replace(/ /g, "");
want(shown.status === 200 && key, "the authenticator key is shown");
const fin = await call("POST", "/auth/enrol", { csrf: csrfOf(shown.text), code: totp(key) });
want(fin.status === 303 && fin.location === "/setup/model", "the TOTP code finishes enrolment and leads to the model step");
const step = await call("GET", "/setup/model");
want(step.status === 200 && step.text.includes('name="openrouter_key"') && !step.text.includes(">Connect OpenRouter</a>"), "on plain-http 127.0.0.1 the key field stands alone (OpenRouter calls back only to https or localhost)");
const bad = await call("POST", "/setup/model", { csrf: csrfOf(step.text), action: "paste", openrouter_key: "not-a-key" });
want(bad.status === 400 && /valid OpenRouter API key/.test(bad.text), "a malformed model key is refused");
const credit = await call("POST", "/setup/model", { csrf: csrfOf(step.text), action: "paste", openrouter_key: modelKey });
want(credit.status === 200 && credit.text.includes("Add credit in OpenRouter") && credit.text.includes('value="retry"'), "a 402 from OpenRouter asks for credit, with Retry");
const retried = await call("POST", "/setup/model", { csrf: csrfOf(credit.text), action: "retry" });
want(retried.status === 303 && /\/#\/welcome$/.test(retried.location), `Retry passes and goes on to the board's welcome (${retried.location})`);
const rk = await call("GET", "/recovery-key");
want(rk.status === 200 && rk.text.includes("01234567 89abcdef"), "the recovery key shows on its own page after sign-in");
const rkDone = await call("POST", "/recovery-key", { csrf: csrfOf(rk.text), choice: "saved" });
want(rkDone.status === 303, "saving it redirects on");
want(/No recovery key is waiting/.test((await call("GET", "/recovery-key")).text), "it is shown once");
want((await call("GET", "/auth/password")).status === 200, "the owner is a signed-in admin with an authenticator");

// The board's welcome (#/welcome, Welcome.tsx): its own session through the kernel's handoff, then finished at once.
const board = (method, path, json) => call(method, path, json, 3121).then((r) => ({ ...r, json: JSON.parse(r.text || "null") }));
let hop = await call("GET", "/auth/start", undefined, 3121);
for (let i = 0; i < 2 && hop.location?.startsWith("http://127.0.0.1:"); i++) { const l = new URL(hop.location); hop = await call("GET", l.pathname + l.search, undefined, Number(l.port)); }
want(hop.status === 303 && hop.location === "/" && jar.has("aidenhq-board"), "the board's session comes through the kernel's handoff");
const first = await board("GET", "/api/welcome");
want(first.status === 200 && first.json.finished === false && first.json.modelReady === true && first.json.recoveryKeyWaiting === false, `the board's welcome is unfinished, the model ready and the recovery key saved (${first.text})`);
want(!("wizard" in first.json), `it lists no wizard flows (${first.text})`);
const fin2 = await board("POST", "/api/welcome/finish", {});
want(fin2.status === 200 && fin2.json.ok === true, `finishing it answers ok (${fin2.text})`);
want((await board("GET", "/api/welcome")).json.finished === true, "the welcome is finished");
want((await board("POST", "/api/welcome/finish", {})).status === 200, "a second finish is a no-op");
const writes = readFileSync(paperclipLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const made = writes.filter((w) => w.method === "POST" && /\/issues$/.test(w.url));
want(made.length === 1 && made[0].body.assigneeAgentId === "agent-aiden", `one task, for Aiden (${made.length})`);
want(made[0].body.description.includes("<!-- source:welcome -->") && !(made[0].body.labelIds ?? []).includes("label-chat"), "it is onboarding's board task (source welcome), not a chat");
EOF
# The RFC 6238 code, as the kernel's tests compute it (no dependency).
sed -n '/^export function totp/,/^}/p' "$src/kernel/test/auth-helpers.ts" | sed '1i import { createHmac } from "node:crypto";' > "$work/totp.mjs"
node "$work/http.mjs" "$URL" "$MODEL_KEY" "$H/aidenhq/config/points/board.json" "$work/paperclip.log" || fail "/setup and the welcome over HTTP"

[ "$(cat "$S/openrouter_key")" = "$MODEL_KEY" ] && [ "$(stat -c '%U %a' "$S/openrouter_key")" = "$U 600" ] || fail "the model key isn't in the vault as $U, 0600"
[ ! -e "$S/github_bot_token" ] || fail "the first run asked for a GitHub token"
[ "$(cat "$S/openrouter_key_checked")" = "$(printf %s "$MODEL_KEY" | sha256sum | cut -d' ' -f1)" ] || fail "the model key's passing check isn't recorded (model_ready)"
[ "$(grep -c 'POST /api/v1/chat/completions key=true max_tokens=1' "$work/openrouter.log")" = 2 ] || fail "the model check didn't make two 1-token calls with the key: $(cat "$work/openrouter.log")"
[ ! -e "$S/vault_recovery_key" ] && [ ! -e /root/aidenhq-vault-recovery.txt ] || fail "the recovery key is still on disk after it was shown"
grep -qF -e "$MODEL_KEY" -e "${URL#*token=}" "$work/kernel.log" && fail "the kernel logged a secret"
ok "the keys are in the vault (0600), the recovery key is gone, and the kernel's log holds no secret"
[ -e "$H/aidenhq/data/board/welcome-sent" ] || fail "the welcome-sent marker (ops/setup.sh's \"welcome had\") isn't written"
ok "the welcome-sent marker is written"
echo "all passed"
