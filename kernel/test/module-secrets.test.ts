// Guided setup: a ready admin saves a module's declared setup secret from the board (POST /v1/accounts/save_secret); the
// kernel writes it to the vault and recreates that module's services under the apply lock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModuleSecrets, vaultWriter } from "../src/module-secrets.ts";
import { authApiServer } from "./auth-helpers.ts";

const FIELDS = [
  { module: "channel-telegram", secret: "telegram_bot_token", label: "Bot token", pattern: "^[0-9]{6,12}:[A-Za-z0-9_-]{30,50}$" },
  { module: "design", secret: "ui_logins", label: "UI test logins", pattern: "^\\{[\\s\\S]*\\}$" },
  { module: "slack", secret: "slack_bot_token", label: "Slack bot token", pattern: "^xoxb-[A-Za-z0-9-]{20,200}$" },
];
const SERVICES = { "channel-telegram": ["telegram"], "slack": ["slack-live"], design: ["design"], google: [] };
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
    get: (name) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8") : ""),
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
  // A second save writes the same file in place: a container bind-mounting it sees the new value without a restart.
  const ino = statSync(f).ino;
  assert.equal((await post("save_secret", { module: "channel-telegram", secret: "telegram_bot_token", value: "987654321:" + "B".repeat(35) })).status, 200);
  assert.equal(statSync(f).ino, ino);
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

// Real flock(1) (util-linux, as on the host); macOS has none, so CI judges this one.

test("save_secret with a key sets one key of a JSON map in place, restarts nothing and reads no other key back", async (t) => {
  const v = vault();
  const post = await api(t, v);
  const beta = { login_url: "https://beta.example.com/in", username: "b", password: "existing-beta-password" };
  writeFileSync(join(v.dir, "ui_logins"), JSON.stringify({ beta }));
  const ino = statSync(join(v.dir, "ui_logins")).ino;
  const entry = (o) => JSON.stringify(o);
  const r = await post("save_secret", { module: "design", secret: "ui_logins", key: "acme", value: entry({ username: "u", password: "p" }) });
  assert.equal(r.status, 200, r.body);
  assert.deepEqual(JSON.parse(readFileSync(join(v.dir, "ui_logins"), "utf8")), { beta, acme: { username: "u", password: "p" } });
  assert.equal(statSync(join(v.dir, "ui_logins")).ino, ino, "written in place");
  assert.deepEqual(v.calls, [], "the module reads the map on each use: nothing restarts");
  // Which keys are set is all anyone can read: names, never a value.
  const keys = await post("secret_keys", { module: "design", secret: "ui_logins" });
  assert.deepEqual(keys.json, { keys: ["beta", "acme"] });
  assert.ok(!keys.body.includes("existing-beta-password") && !r.body.includes("password"));
  assert.ok(!v.lines.join("\n").includes("existing-beta-password"));
  // Clear removes just that key; a bad entry, a bad key and a non-owner are refused.
  assert.equal((await post("save_secret", { module: "design", secret: "ui_logins", key: "acme", value: "" })).status, 200);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(v.dir, "ui_logins"), "utf8"))), ["beta"]);
  for (const [body, token, status] of [
    [{ key: "acme", value: "not json" }, "ready", 400], [{ key: "Acme Co", value: entry({ a: "b" }) }, "ready", 400], [{ key: "acme", value: entry({ a: 1 }) }, "ready", 400],
    [{ key: "acme", value: entry({ a: "b" }) }, "admin", 403],
  ]) assert.equal((await post("save_secret", { module: "design", secret: "ui_logins", ...body }, token)).status, status, JSON.stringify(body));
});
