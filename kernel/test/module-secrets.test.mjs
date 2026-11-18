// Guided setup: a ready admin saves a module's declared setup secret from the board (POST /v1/accounts/save_secret); the
// kernel writes it to the vault and recreates that module's services under the apply lock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeRecreate, createModuleSecrets, vaultWriter } from "../src/module-secrets.ts";
import { authApiServer } from "./auth-helpers.mjs";

const FIELDS = [
  { module: "channel-telegram", secret: "telegram_bot_token", label: "Bot token", pattern: "^[0-9]{6,12}:[A-Za-z0-9_-]{30,50}$" },
  { module: "channel-slack", secret: "slack_bot_token", label: "Slack bot token", pattern: "^xoxb-[A-Za-z0-9-]{20,200}$" },
];
const SERVICES = { "channel-telegram": ["telegram"], "channel-slack": ["slack-live"], google: [] };
// Who mounts each secret, any module's (compile: `mounts`): another module's service reads the Slack token too.
const MOUNTS = { telegram_bot_token: ["telegram"], slack_bot_token: ["apps-mcp", "slack-live"] };
const TOKEN = "123456789:" + "A".repeat(35);
// The accounts' board sessions as uiSession answers them: the owner, another ready admin, else null (a non-ready admin
// never gets one).
const session = (id, owner) => ({ account: { id, email: `${id}@example.com`, role: "admin", owner }, session: { id: `s-${id}` }, ready: true });
const accounts = { uiSession: async (_m, t) => (t === "ready" ? session("owner", true) : t === "admin" ? session("admin", false) : null) };

function vault(recreate = async () => {}) {
  const dir = mkdtempSync(join(tmpdir(), "module-secrets-"));
  const calls = [], lines = [];
  const secrets = createModuleSecrets({
    fields: () => FIELDS,
    services: (m) => SERVICES[m],
    mounts: (s) => MOUNTS[s] ?? [],
    save: vaultWriter(dir),
    has: (name) => existsSync(join(dir, name)),
    recreate: async (s, locked) => { calls.push(s); await recreate(s, locked); },
    log: (msg, o) => lines.push(JSON.stringify([msg, o])),
  });
  return { dir, calls, lines, secrets };
}

async function api(t, v) {
  const s = await authApiServer(accounts, { secrets: v.secrets });
  t.after(s.close);
  return (op, body, token = "ready") => s.post(`/v1/accounts/${op}`, { token, ...body }, { authorization: `Bearer ${s.boardKey}` });
}

test("save_secret writes a declared secret and recreates its module's services", async (t) => {
  const v = vault();
  const post = await api(t, v);
  const r = await post("save_secret", { module: "channel-telegram", secret: "telegram_bot_token", value: ` ${TOKEN}\n` });
  assert.equal(r.status, 200, r.body);
  assert.deepEqual(r.json, { ok: true, restarted: ["telegram"] });
  const f = join(v.dir, "telegram_bot_token");
  assert.equal(readFileSync(f, "utf8"), TOKEN);
  assert.equal(statSync(f).mode & 0o777, 0o600);
  assert.deepEqual(v.calls, [["telegram"]]);
  assert.ok(!v.lines.join("\n").includes(TOKEN), "the value is never logged");
});

test("save_secret recreates every service that mounts the secret, not only its module's", async (t) => {
  const v = vault();
  const post = await api(t, v);
  const r = await post("save_secret", { module: "channel-slack", secret: "slack_bot_token", value: "xoxb-" + "a".repeat(30) });
  assert.equal(r.status, 200, r.body);
  assert.deepEqual(r.json.restarted, ["apps-mcp", "slack-live"]);
  assert.deepEqual(v.calls, [["apps-mcp", "slack-live"]]);
});

test("save_secret refuses an undeclared secret, another module's secret, a pattern mismatch and an off module", async (t) => {
  const v = vault();
  const post = await api(t, v);
  for (const [body, status] of [
    [{ module: "channel-telegram", secret: "not_declared", value: TOKEN }, 400],
    [{ module: "channel-telegram", secret: "slack_bot_token", value: "xoxb-" + "a".repeat(30) }, 400],
    [{ module: "channel-telegram", secret: "telegram_bot_token", value: "not a token" }, 400],
    [{ module: "channel-discord", secret: "telegram_bot_token", value: TOKEN }, 404],
    [{ module: "channel-telegram", secret: "../../etc/passwd", value: TOKEN }, 400],
  ]) {
    const r = await post("save_secret", body);
    assert.equal(r.status, status, JSON.stringify(body));
    assert.ok(!r.body.includes(body.value), "the value is never echoed");
  }
  assert.deepEqual(spawnSync("ls", [v.dir]).stdout.toString().trim(), "");
  assert.deepEqual(v.calls, []);
});

test("save_secret is the owner's: another admin gets 403, a session that isn't ready 401", async (t) => {
  const v = vault();
  const post = await api(t, v);
  const body = { module: "channel-telegram", secret: "telegram_bot_token", value: TOKEN };
  assert.equal((await post("save_secret", body, "not-ready")).status, 401);
  assert.equal((await post("save_secret", body, "admin")).status, 403);
  assert.ok(!existsSync(join(v.dir, "telegram_bot_token")));
  assert.deepEqual(v.calls, []);
  assert.equal((await post("setup_status", { module: "channel-telegram" }, "not-ready")).status, 401);
  assert.equal((await post("setup_status", { module: "channel-telegram" }, "admin")).status, 200, "any ready admin sees which are set");
});

test("a save answers once the value is written, while the recreate is still waiting on the apply lock", async () => {
  const v = vault(() => new Promise(() => {}));
  const r = await v.secrets.save("channel-telegram", "telegram_bot_token", TOKEN);
  assert.deepEqual(r, { restarted: ["telegram"] });
  assert.equal(readFileSync(join(v.dir, "telegram_bot_token"), "utf8"), TOKEN);
});

test("a failed recreate is logged, the secret kept, the save still answered", async () => {
  const v = vault(async () => { throw new Error("service \"telegram\" failed to start"); });
  await v.secrets.save("channel-telegram", "telegram_bot_token", TOKEN);
  await new Promise((r) => setImmediate(r));
  assert.match(v.lines.join("\n"), /recreate failed.*failed to start/);
  assert.equal(readFileSync(join(v.dir, "telegram_bot_token"), "utf8"), TOKEN);
});

test("setup_status reports booleans only", async (t) => {
  const v = vault();
  const post = await api(t, v);
  assert.deepEqual((await post("setup_status", { module: "channel-telegram" })).json, { secrets: { telegram_bot_token: false } });
  await post("save_secret", { module: "channel-telegram", secret: "telegram_bot_token", value: TOKEN });
  const r = await post("setup_status", { module: "channel-telegram" });
  assert.deepEqual(r.json, { secrets: { telegram_bot_token: true } });
  assert.ok(!r.body.includes(TOKEN));
  assert.equal((await post("setup_status", { module: "channel-discord" })).status, 404);
});

// Real flock(1) (util-linux, as on the host); macOS has none, so CI judges this one.
const hasFlock = spawnSync("flock", ["-V"]).status === 0;
test("save_secret answers at once; the recreate waits for the apply lock", { skip: !hasFlock && "needs flock(1)" }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "checkout-"));
  mkdirSync(join(dir, "data"));
  const marker = join(dir, "recreated");
  const docker = join(dir, "fake-docker");
  writeFileSync(docker, `#!/bin/sh\nprintf '%s %s\\n' "$COMPOSE_FILE" "$*" >> "${marker}"\n`);
  chmodSync(docker, 0o755);
  // An apply holds the lock for a second.
  const lock = join(dir, "data", "apply.lock");
  const apply = spawn("flock", [lock, "sleep", "1"]);
  t.after(() => apply.kill());
  while (spawnSync("flock", ["-n", lock, "true"]).status === 0) await new Promise((r) => setTimeout(r, 20));
  const v = vault(composeRecreate({ dir, docker, wait: 10 }));
  const post = await api(t, v);
  const started = Date.now();
  const second = "987654321:" + "B".repeat(35);
  const [a, b] = await Promise.all([
    post("save_secret", { module: "channel-telegram", secret: "telegram_bot_token", value: TOKEN }),
    post("save_secret", { module: "channel-telegram", secret: "telegram_bot_token", value: second }),
  ]);
  assert.equal(a.status, 200, a.body);
  assert.equal(b.status, 200, b.body);
  assert.ok(Date.now() - started < 500, "the saves didn't wait for the apply's lock");
  assert.ok(!existsSync(marker), "the recreate hasn't run while the apply holds the lock");
  // Both were saved while the apply held the lock: one recreate after it, reading the last value saved.
  assert.equal(readFileSync(join(v.dir, "telegram_bot_token"), "utf8"), second);
  const lines = async (n) => { for (let i = 0; i < 200; i++) { const l = existsSync(marker) ? readFileSync(marker, "utf8").trim().split("\n").length : 0; if (l >= n) return l; await new Promise((r) => setTimeout(r, 50)); } return 0; };
  assert.equal(await lines(1), 1);
  assert.equal(readFileSync(marker, "utf8"), "compose.yaml:compose.modules.yaml compose up -d --force-recreate --no-deps telegram\n");
  // Once that recreate has run, the next save gets its own.
  assert.equal((await post("save_secret", { module: "channel-telegram", secret: "telegram_bot_token", value: TOKEN })).status, 200);
  assert.equal(await lines(2), 2);
});
