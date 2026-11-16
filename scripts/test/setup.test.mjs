import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const setup = join(dirname(fileURLToPath(import.meta.url)), "../../ops/setup.sh");
const conf = (lines) => {
  const p = join(mkdtempSync(join(tmpdir(), "setup-")), "person.env");
  writeFileSync(p, lines.join("\n") + "\n");
  return p;
};
const dry = (file, ...extra) => execFileSync("bash", [setup, "--dry-run", "--config", file, ...extra], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const person = [
  "AIDENHQ_USER=alice",
  "OWNER_NAME=Alice Doe",
  "OWNER_EMAIL=alice@example.com",
  "TIMEZONE=Europe/London",
  "BOARD_HOST=alice.tail1234.ts.net",
  "OPENROUTER_MANAGEMENT_KEY=mgmt-SECRET-123",
  "GOOGLE_CLIENT_ID=cid.apps.googleusercontent.com",
  "GOOGLE_CLIENT_SECRET=gsecret-456",
];

test("dry run prints the plan and no secrets", () => {
  const out = dry(conf(person));
  for (const want of [
    "DRY RUN",
    "AIDENHQ_USER=alice bash", // the machine, for this user
    "git init --quiet --bare -b main /home/alice/aidenhq-instance.git", // the local instance repo
    ".env: AIDENHQ_INSTANCE_PUSH_URL=/home/alice/aidenhq-instance.git",
    ".env: BOARD_LAN_URL=https://alice.tail1234.ts.net",
    ".env: APPS_URL_BASE=https://aidenhq-alice-apps.tail1234.ts.net", // apps on their own tailnet node, never the board's name
    "with OPENROUTER_MANAGEMENT_KEY,AIDENHQ_SECRETS_DIR) node", // the key goes in through the environment
    "openrouter-key.mjs create aidenhq-alice 50",
    "write /home/alice/.config/aidenhq/modules/google/google_oauth.json",
    "write /home/alice/aidenhq-instance/apps.yaml", // instance.yaml's heredoc ends where it should
    "ops/apply-config.sh",
    "tailscale serve --bg --https=443 http://127.0.0.1:3121",
    "new chat to Aiden",
    "https://alice.tail1234.ts.net/google/callback",
  ]) assert.ok(out.includes(want), `missing: ${want}\n${out}`);
  for (const secret of ["mgmt-SECRET-123", "gsecret-456"]) assert.ok(!out.includes(secret), `printed a secret: ${secret}`);
});

test("refuses a config without the owner, and a line that isn't KEY=value", () => {
  assert.throws(() => dry(conf(["OWNER_NAME=Bob"])), /OWNER_NAME, OWNER_EMAIL and TIMEZONE are required/);
  assert.throws(() => dry(conf([...person, "$(touch /tmp/pwned)"])), /not KEY=value/);
});

test("person.env: an unquoted value ends at ' #', a quoted one keeps it", () => {
  const out = dry(conf([...person, "OPENROUTER_LIMIT_USD=75   # a month", "COMPANY_NAME='Acme # Co'"]));
  assert.ok(out.includes("openrouter-key.mjs create aidenhq-alice 75"), out);
});

test("dry run needs no node, and a missing OpenRouter key is 'would fail'", () => {
  const file = conf(person.filter((l) => !l.startsWith("OPENROUTER")));
  const out = execFileSync("/bin/bash", [setup, "--dry-run", "--config", file], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent" } });
  assert.ok(out.includes("would fail: set OPENROUTER_MANAGEMENT_KEY"), out);
  assert.ok(out.includes("write /home/alice/.config/aidenhq/modules/google/google_oauth.json"), out);
});
