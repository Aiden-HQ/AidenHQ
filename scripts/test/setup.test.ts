import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
    "https://alice.tail1234.ts.net/google/callback",
  ]) assert.ok(out.includes(want), `missing: ${want}\n${out}`);
  for (const secret of ["mgmt-SECRET-123", "gsecret-456"]) assert.ok(!out.includes(secret), `printed a secret: ${secret}`);
});

test("refuses a config without the owner, and a line that isn't KEY=value", () => {
  assert.throws(() => dry(conf(["OWNER_NAME=Bob"])), /OWNER_NAME, OWNER_EMAIL and TIMEZONE are required/);
  assert.throws(() => dry(conf([...person, "$(touch /tmp/pwned)"])), /not KEY=value/);
});

test("refuses a service user whose uid isn't 1000 before the compose apply (Paperclip only runs as 1000)", () => {
  const realId = execFileSync("sh", ["-c", "command -v id"], { encoding: "utf8" }).trim();
  const bin = mkdtempSync(join(tmpdir(), "setup-bin-"));
  writeFileSync(join(bin, "id"), `#!/bin/sh\ncase "$*" in\n  "-u alice"|"-g alice") echo 501 ;;\n  *) exec ${realId} "$@" ;;\nesac\n`, { mode: 0o755 });
  let err;
  try {
    execFileSync("bash", [setup, "--dry-run", "--config", conf(person)], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { PATH: `${bin}:${process.env.PATH}` } });
  } catch (e) { err = e; }
  assert.ok(err, "setup accepted uid 501");
  assert.match(String(err.stderr), /setup: the service user alice has uid 501, but the Paperclip container runs as that uid and only works as 1000/);
  assert.match(String(err.stderr), /AIDENHQ_USER to a user whose uid is 1000/);
  assert.ok(!String(err.stdout).includes("ops/apply-config.sh"), `compose apply ran:\n${err.stdout}`);
  assert.ok(!String(err.stdout).includes(".env: PUID"), `PUID was written:\n${err.stdout}`);
});

test("every unit setup enables carries an [Install] section, or systemctl enable stops setup", () => {
  const dir = join(dirname(setup), "units");
  const enabled = [];
  for (const line of readFileSync(setup, "utf8").split("\n")) {
    if (line.trimStart().startsWith("#")) continue;
    const m = /systemctl --user enable(?: --now)? (.*)$/.exec(line);
    if (!m) continue;
    for (const word of m[1].split(/\s+/)) {
      const unit = word.includes(".") ? word : `${word}.service`;
      if (/^[a-z0-9-]+\.(service|timer|path|socket)$/.test(unit) && existsSync(join(dir, unit))) enabled.push(unit);
    }
  }
  assert.ok(enabled.includes("prune-docker.service") && enabled.includes("prune-docker.timer"), `prune units not enabled: ${enabled}`);
  for (const unit of enabled) {
    const body = readFileSync(join(dir, unit), "utf8");
    assert.match(body, /^\[Install\]$/m, `${unit} has no [Install] section: systemctl enable ${unit} fails`);
    assert.match(body, /^WantedBy=\S+/m, `${unit} has no WantedBy=: systemctl enable ${unit} fails`);
  }
});

test("--unattended: no config file, settings from the environment, the SSH-tunnel route without Tailscale", () => {
  const run = (env, ...args) => execFileSync("bash", [setup, "--dry-run", "--unattended", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH, AIDENHQ_USER: "alice", ...env } });
  const out = run({ OWNER_EMAIL: "alice@example.com", TIMEOUT_MINUTES: "120", CI_RUNNERS: "2", OPENROUTER_KEY: "sk-SECRET" }, "--no-tailscale");
  for (const want of [
    "env AIDENHQ_EXPOSURE=local AIDENHQ_NO_TAILSCALE=1 AIDENHQ_USER=alice AIDENHQ_CHECKOUT=", // the machine without Tailscale
    ".env: BOARD_LAN_URL=http://localhost:3121",
    "config/runner.yaml: timeout_minutes: 120",
    "CI runners: aidenhq-ci-runner@1..2",
    "Model key: none yet", // secrets never come from the environment
    "AIDENHQ_SSH_TUNNEL=ssh -N -L 3121:127.0.0.1:3121 -L 3120:127.0.0.1:3120 -L 3130:127.0.0.1:3130 -L 8447:127.0.0.1:3130 alice@",
    "kernel: the first-run page's one-time link, last: AIDENHQ_SETUP_URL=", // the full run: ops/test/unattended-install.sh
  ]) assert.ok(out.includes(want), `missing: ${want}\n${out}`);
  for (const not of ["tailscale serve", "APPS_URL_BASE=https", "sk-SECRET"]) assert.ok(!out.includes(not), `unexpected: ${not}\n${out}`);
  assert.throws(() => run({}), /--unattended needs OWNER_EMAIL/);
  assert.throws(() => run({ OWNER_EMAIL: "alice@example.com", TIMEOUT_MINUTES: "8; rm -rf /" }), /TIMEOUT_MINUTES must be a whole number/);
});

test("--unattended, exposure public: the IP's https URLs and 24-hour links, no tailnet and no tunnel", () => {
  const out = execFileSync("bash", [setup, "--dry-run", "--unattended"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH, AIDENHQ_USER: "alice", OWNER_EMAIL: "alice@example.com", AIDENHQ_EXPOSURE: "public", AIDENHQ_PUBLIC_IP: "203.0.113.7" } });
  for (const want of ["env AIDENHQ_EXPOSURE=public AIDENHQ_NO_TAILSCALE=1", ".env: BOARD_LAN_URL=https://203.0.113.7", ".env: AIDENHQ_ADMIN_URL=https://203.0.113.7:8446", ".env: AIDENHQ_PUBLIC_IP=203.0.113.7", ".env: AIDENHQ_LINK_TTL_HOURS=24"])
    assert.ok(out.includes(want), `missing: ${want}\n${out}`);
  for (const not of ["tailscale serve", "AIDENHQ_SSH_TUNNEL"]) assert.ok(!out.includes(not), `unexpected: ${not}\n${out}`);
});

test("--unattended, no mode and no tailnet: a new install is public; --exposure names a mode or is refused", () => {
  const bin = mkdtempSync(join(tmpdir(), "setup-bin-"));
  writeFileSync(join(bin, "tailscale"), "#!/bin/sh\nexit 1\n", { mode: 0o755 }); // installed, not logged in
  const run = (...args) => execFileSync("bash", [setup, "--dry-run", "--unattended", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { PATH: `${bin}:${process.env.PATH}`, AIDENHQ_USER: "alice", OWNER_EMAIL: "alice@example.com" } });
  const out = run();
  for (const want of ["env AIDENHQ_EXPOSURE=public AIDENHQ_NO_TAILSCALE=1", ".env: AIDENHQ_LINK_TTL_HOURS=24", "AIDENHQ_EXPOSURE=public\n"])
    assert.ok(out.includes(want), `missing: ${want}\n${out}`);
  assert.ok(run("--exposure", "local").includes("env AIDENHQ_EXPOSURE=local AIDENHQ_NO_TAILSCALE=1"));
  assert.throws(() => run("--exposure", "funnel"), /--exposure is public, tailscale or local/);
});
