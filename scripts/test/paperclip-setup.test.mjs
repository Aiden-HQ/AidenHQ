// An apply pushes the instance repo before it runs this script, so a section literal that doesn't parse leaves the
// instance half-applied. The sections (scripts/prompts/*.md) are where shared handbook text lives: keep them parseable and present.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { section as promptSection } from "../prompts.mjs";

const script = join(dirname(fileURLToPath(import.meta.url)), "../paperclip-setup.mjs");

/** A section setup itself still emits: its markdown file under scripts/prompts, as setup reads it. */
const literal = (name) => ({ APP_FOLLOWUP_SECTION: promptSection("app-followup", "") })[name];
/** A module's prompt contribution (modules/<module>/prompts/<id>.md), as setup appends it: verbatim. */
const prompt = (id) => readFileSync(join(dirname(script), "../modules", id.split(".")[0], "prompts", `${id.split(".")[1]}.md`), "utf8");

/** The rule an agent proposes a correction with: the platform module's improving-rules prompt. */
const improving = () => prompt("platform.improving");

// An unattended install or a rerun from a script has no terminal: setup signs in with what ops/setup.sh made the account
// from (the owner's email, the vault's password), and when something is still missing it stops instead of waiting on a prompt.
test("setup never waits on a prompt without a terminal; the owner's email and the vault's password sign it in", async () => {
  const { createServer } = await import("node:http");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { spawn } = await import("node:child_process");
  const seen = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      seen.push({ path: req.url, body: body ? JSON.parse(body) : undefined });
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/health") return res.end(JSON.stringify({ status: "ok", bootstrapStatus: "bootstrap_pending" }));
      if (req.url === "/api/auth/sign-in/email") { res.statusCode = 401; return res.end("{}"); }
      res.end("{}"); // sign-up without a session cookie: setup stops there
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const dir = mkdtempSync(join(tmpdir(), "pcs-"));
  writeFileSync(join(dir, "paperclip_owner_password"), "vault-pass-123");
  const run = (cfg) => {
    writeFileSync(join(dir, "paperclip.yaml"), cfg);
    writeFileSync(join(dir, ".env"), `AIDENHQ_SECRETS_DIR=${dir}\n`);
    const child = spawn(process.execPath, [script], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH, HOME: dir, AIDENHQ_ENV_FILE: join(dir, ".env"), AIDENHQ_PAPERCLIP_CONFIG: join(dir, "paperclip.yaml"), PAPERCLIP_URL: `http://127.0.0.1:${server.address().port}` } });
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    return new Promise((r) => child.on("close", (code) => r({ code, err })));
  };
  try {
    const ok = await run("company: { name: work }\nowner_name: Sam\nsettings: { owner_email: { value: sam@example.com } }\n");
    assert.match(ok.err, /no session cookie/, ok.err);
    assert.deepEqual(seen.find((s) => s.path === "/api/auth/sign-up/email").body, { name: "Sam", email: "sam@example.com", password: "vault-pass-123", rememberMe: true });
    const missing = await run("company: { name: work }\n");
    assert.notEqual(missing.code, 0);
    assert.match(missing.err, /no terminal to ask "Paperclip email:"/, missing.err);
  } finally { server.close(); }
});

test("setup: a write the instance does not keep is a failure, not a logged success", async () => {
  // The instance answers 200 and still reads back 7 days (a hidden or operator-managed setting): setup stops.
  const api = async (method) => ({ json: method === "PATCH" ? {} : { backupRetention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 } } });
  const { ensureBackupRetention } = await import("../modules.mjs");
  await assert.rejects(() => ensureBackupRetention({ api, dailyDays: 3, step: () => {} }), /backup retention did not take: \{"dailyDays":7/);
});

