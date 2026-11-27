// Guided setup: a ready admin saves a module's declared setup secret from the board (POST /v1/accounts/save_secret); the
// kernel writes it to the vault and recreates that module's services under the apply lock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModuleSecrets, vaultWriter } from "../src/module-secrets.ts";
import type { SetupField } from "../src/admin.ts";
import { createModuleValidate } from "../src/module-validate.ts";
import { openFacts } from "../src/facts.ts";
import { DatabaseSync } from "node:sqlite";
import { serve } from "./helpers.ts";
import { authApiServer } from "./auth-helpers.ts";
import { createResolver } from "../src/net.ts";

const FIELDS = [
  { module: "channel-telegram", secret: "telegram_bot_token", label: "Bot token", pattern: "^[0-9]{6,12}:[A-Za-z0-9_-]{30,50}$" },
  { module: "design", secret: "ui_logins", label: "UI test logins", pattern: "^\\{[\\s\\S]*\\}$" },
  // A module page's map secret (board.pages secret_maps): its fields and their caps, as compile carries them (scripts/modules.ts).
  { module: "design", secret: "design_keys", label: "SSH keys", pattern: "^\\{[\\s\\S]*\\}$", fields: [
    { name: "label", kind: "text" }, { name: "private_key", kind: "key", maxLength: 4096 },
  ] },
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

function vault(recreate = async () => {}, fields = FIELDS as SetupField[]) {
  const dir = mkdtempSync(join(tmpdir(), "module-secrets-"));
  const calls = [], lines = [];
  const secrets = createModuleSecrets({
    fields: () => fields,
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

async function api(t, v, { validate } = {}) {
  const s = await authApiServer(accounts, { secrets: v.secrets, validate });
  t.after(s.close);
  return (op, body, token = "ready") => s.post(`/v1/accounts/${op}`, { token, ...body }, { authorization: `Bearer ${s.boardKey}` });
}

/** The real module-validate.ts in front of a fake module hook at `url` (an IP, so the resolver uses it as it is): what it was asked, and its answer. */
async function validator(t, fields = FIELDS, answer = { ok: true }) {
  const asked: unknown[] = [];
  const hook = await serve(async (req, res) => {
    let text = "";
    for await (const c of req) text += c;
    asked.push(JSON.parse(text));
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(answer));
  });
  t.after(() => hook.s.close());
  const validate = createModuleValidate({
    registry: () => ({ "design.validate": { module: "design", at: "validate", url: `${hook.url}/validate`, auth_secret: "gateway_job_secret" } }),
    services: (m) => (m === "design" ? [new URL(hook.url).hostname] : SERVICES[m]),
    secret: () => "k".repeat(40), resolver: createResolver({ inspect: async () => "127.0.0.1" }), facts: openFacts(new DatabaseSync(":memory:")), log: () => {},
  });
  return { validate, asked };
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

// A sample private key's armour, built from parts so the repo's leak scan doesn't read this test as one.
const PEM_HEAD = ["-----BEGIN", "OPENSSH", "PRIVATE KEY-----"].join(" ");
const PEM_END = ["-----END", "OPENSSH", "PRIVATE KEY-----"].join(" ");
// The map secret a module page declares (board.pages secret_maps): its fields' kinds and caps come from compile.
const ENTRY = (o) => JSON.stringify({ label: "alpha", ...o });

test("a map secret's key field is capped at its declared maxLength, stored whole and read back byte for byte", async (t) => {
  const v = vault();
  const post = await api(t, v);
  const pem = `${PEM_HEAD}\nAAAAB3NzaC1yc2E\n\tindented\n${PEM_END}\n`;
  const r = await post("save_secret", { module: "design", secret: "design_keys", key: "alpha", value: ENTRY({ private_key: pem }) });
  assert.equal(r.status, 200, r.body);
  // The whole file is read as the module reads it: the key's newlines are all there, its trailing newline included.
  assert.equal(JSON.parse(readFileSync(join(v.dir, "design_keys"), "utf8")).alpha.private_key, pem);
  assert.ok(JSON.parse(readFileSync(join(v.dir, "design_keys"), "utf8")).alpha.private_key.endsWith("\n"));
  // Over the declared cap (4096) is refused; the file is unchanged.
  const over = await post("save_secret", { module: "design", secret: "design_keys", key: "alpha", value: ENTRY({ private_key: "k".repeat(4097) }) });
  assert.equal(over.status, 400);
  assert.ok(!over.body.includes("k".repeat(4097)));
  assert.equal(JSON.parse(readFileSync(join(v.dir, "design_keys"), "utf8")).alpha.private_key, pem);
  // An undeclared field still caps at 300, as every other module's do.
  assert.equal((await post("save_secret", { module: "design", secret: "design_keys", key: "beta", value: JSON.stringify({ label: "l".repeat(301) }) })).status, 400);
  // And a 4 KB key (which the old 1000/4000 request cap refused) goes through.
  const fourk = "k".repeat(4096);
  const big = await post("save_secret", { module: "design", secret: "design_keys", key: "gamma", value: ENTRY({ private_key: fourk }) });
  assert.equal(big.status, 200, big.body);
  assert.equal(JSON.parse(readFileSync(join(v.dir, "design_keys"), "utf8")).gamma.private_key, fourk);
});

test("a whole-map paste is held to its declared field caps and refused over 64 KB", async (t) => {
  const v = vault();
  const post = await api(t, v);
  const fitting = JSON.stringify({ alpha: { label: "a", private_key: "k\n".repeat(2000) } });
  assert.equal((await post("save_secret", { module: "design", secret: "design_keys", value: fitting })).status, 200);
  assert.equal(JSON.parse(readFileSync(join(v.dir, "design_keys"), "utf8")).alpha.private_key, "k\n".repeat(2000));
  const tooLong = JSON.stringify({ alpha: { label: "a", private_key: "k".repeat(4097) } });
  assert.equal((await post("save_secret", { module: "design", secret: "design_keys", value: tooLong })).status, 400);
  // Over 64 KB in total: refused, and the stored map left as it was.
  const huge = JSON.stringify({ alpha: { label: "a", private_key: "k".repeat(65 * 1024) } });
  const r = await post("save_secret", { module: "design", secret: "design_keys", value: huge });
  assert.equal(r.status, 400);
  assert.equal(JSON.parse(readFileSync(join(v.dir, "design_keys"), "utf8")).alpha.private_key, "k\n".repeat(2000), "the stored map is what it was");
});

test("a clear is offered to the module's check, and its no refuses it", async (t) => {
  const v = vault();
  writeFileSync(join(v.dir, "design_keys"), JSON.stringify({ alpha: { label: "a", private_key: "k" } }));
  const { validate, asked } = await validator(t, FIELDS, { ok: false, errors: [{ field: "alpha", message: "alpha still names this key" }] });
  const post = await api(t, v, { validate });
  const r = await post("save_secret", { module: "design", secret: "design_keys", key: "alpha", value: "" });
  assert.equal(r.status, 400);
  assert.match(r.body, /alpha still names this key/);
  assert.deepEqual(asked, [{ secret: { name: "design_keys" }, key: "alpha" }], "the hook sees the key, with no value");
  assert.deepEqual(JSON.parse(readFileSync(join(v.dir, "design_keys"), "utf8")), { alpha: { label: "a", private_key: "k" } }, "the entry is still there");
});

test("a set still asks the hook with its top-level value, the shape modules already read", async (t) => {
  const v = vault();
  const { validate, asked } = await validator(t, FIELDS, { ok: true });
  const post = await api(t, v, { validate });
  assert.equal((await post("save_secret", { module: "design", secret: "design_keys", key: "alpha", value: ENTRY({ private_key: "k\n" }) })).status, 200);
  assert.deepEqual(asked, [{ secret: { name: "design_keys" }, value: JSON.stringify({ alpha: { label: "alpha", private_key: "k\n" } }) }]);
});

test("a clear goes ahead when the module's check allows it, and when the module has no validate hook", async (t) => {
  const v = vault();
  writeFileSync(join(v.dir, "design_keys"), JSON.stringify({ alpha: { label: "a", private_key: "k" }, beta: { label: "b", private_key: "k2" } }));
  const { validate, asked } = await validator(t, FIELDS, { ok: true });
  const post = await api(t, v, { validate });
  assert.equal((await post("save_secret", { module: "design", secret: "design_keys", key: "alpha", value: "" })).status, 200);
  assert.deepEqual(asked, [{ secret: { name: "design_keys" }, key: "alpha" }]);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(v.dir, "design_keys"), "utf8"))), ["beta"]);
  // The same vault, the kernel's own validate (a module with no hook): the clear still goes ahead.
  const plain = vault();
  writeFileSync(join(plain.dir, "design_keys"), JSON.stringify({ alpha: { label: "a", private_key: "k" } }));
  const postPlain = await api(t, plain);
  assert.equal((await postPlain("save_secret", { module: "design", secret: "design_keys", key: "alpha", value: "" })).status, 200);
  assert.deepEqual(JSON.parse(readFileSync(join(plain.dir, "design_keys"), "utf8")), {});
});
