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
    "env AIDENHQ_EXPOSURE=tailscale AIDENHQ_NO_TAILSCALE=0 AIDENHQ_USER=alice AIDENHQ_CHECKOUT=", // the machine, for this user, on the tailnet
    "git init --quiet --bare -b main /home/alice/aidenhq-instance.git", // the local instance repo
    ".env: AIDENHQ_INSTANCE_PUSH_URL=/home/alice/aidenhq-instance.git",
    ".env: BOARD_LAN_URL=https://alice.tail1234.ts.net",
    ".env: APPS_URL_BASE=https://aidenhq-alice-apps.tail1234.ts.net", // apps on their own tailnet node, never the board's name
    "with OPENROUTER_MANAGEMENT_KEY,AIDENHQ_SECRETS_DIR) node", // the key goes in through the environment
    "openrouter-key.ts create aidenhq-alice 100",
    "write /home/alice/.config/aidenhq/modules/google/google_oauth.json",
    "write /home/alice/aidenhq-instance/apps.yaml", // instance.yaml's heredoc ends where it should
    "ops/apply-config.sh",
    "tailscale serve --bg --https=443 http://127.0.0.1:3121",
  ]) assert.ok(out.includes(want), `missing: ${want}\n${out}`);
  for (const secret of ["mgmt-SECRET-123", "gsecret-456"]) assert.ok(!out.includes(secret), `printed a secret: ${secret}`);
});
