import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
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

// The setup link goes to the owner over a channel: on an install with no address of its own it is a loopback URL, so
// the output says so right above it, keeps the AIDENHQ_SETUP_URL line a bare URL, and says nothing when there is one.
const local = ["AIDENHQ_USER=alice", "OWNER_NAME=Alice Doe", "OWNER_EMAIL=alice@example.com"];
const CAVEAT = /^This address is loopback-only: open it on this host or through the SSH tunnel printed above\. For a public address, run: sudo ops\/setup\.sh --unattended --exposure public \(or --exposure tailscale\)\.$/;

test("unattended local: one loopback caveat line immediately before the setup link, which stays a bare URL", () => {
  const out = dry(conf(local), "--unattended", "--exposure", "local").split("\n");
  const lines = out.filter((l) => CAVEAT.test(l));
  assert.equal(lines.length, 1, `expected exactly one caveat line\n${out.join("\n")}`);
  const url = out.findIndex((l) => l.includes("AIDENHQ_SETUP_URL="));
  assert.ok(url > 0, `no setup link\n${out.join("\n")}`);
  assert.equal(out[url - 1], lines[0]);
  assert.match(out[url]!, /AIDENHQ_SETUP_URL=(<url>|https?:\/\/[^\s"]+\/setup\?token=[A-Za-z0-9_-]+)$/);
});

test("unattended with a tailnet address: no loopback caveat", () => {
  const out = dry(conf([...local, "BOARD_HOST=alice.tail1234.ts.net"]), "--unattended", "--exposure", "tailscale");
  assert.ok(out.includes("AIDENHQ_SETUP_URL=<url>"), out);
  assert.ok(!out.split("\n").some((l) => CAVEAT.test(l)), `caveat with a real address\n${out}`);
});

// A --link rerun prints only the link, so where it opens comes from the URL the kernel returned: a loopback one gets the
// caveat and the tunnel command (built from the SSH destination the owner reached the host by), a tailnet one the
// "on the tailnet" note and no caveat.
const here = [...local, "TIMEZONE=Europe/London"];
const linkRun = (file, extra = [], env = {}) => execFileSync("bash", [setup, "--dry-run", "--config", file, ...extra, "--link"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });

test("unattended --link prints the tunnel to the address the owner reached this host by, not a private hostname", () => {
  const out = linkRun(conf(here), ["--unattended", "--exposure", "local"], { SSH_CONNECTION: "10.0.0.9 51234 203.0.113.7 22" });
  assert.ok(out.includes("ssh -N -L 3121:127.0.0.1:3121 -L 3120:127.0.0.1:3120 -L 3130:127.0.0.1:3130 alice@203.0.113.7"), out);
});

test("the tunnel keeps the host and port that reach the server, never the VM's private server-side address", () => {
  // A forward or NAT to a private VM: SSH_CONNECTION's server side is the VM's own address, unreachable from the laptop.
  const out = linkRun(conf(here), ["--unattended", "--exposure", "local"], { SSH_CONNECTION: "10.0.0.9 51234 10.231.0.4 2222" });
  const line = (out.split("\n").find((l) => l.includes("ssh -N")) ?? "").trim();
  assert.ok(line.startsWith("ssh -N -p 2222 -L 3121:127.0.0.1:3121"), line);
  assert.ok(!line.includes("alice@10.231.0.4"), `printed the VM's private address\n${out}`);
  assert.ok(line.includes("alice@"), line);
});

test("a config-based --link on a local install says the link is loopback-only rather than 'on the tailnet'", () => {
  const out = linkRun(conf(here), ["--exposure", "local"]);
  assert.ok(out.includes("the owner's one-time setup link"), out);
  assert.ok(!out.includes("on the tailnet; one use"), `claims the tailnet for a loopback link\n${out}`);
  assert.ok(out.split("\n").some((l) => CAVEAT.test(l)), `no loopback caveat\n${out}`);
});

// The plan of a setup run in a checkout of its own: the repo's own .env never leaks in, and `lines` (when given) become
// its .env, over .env.example. Without `lines` it is a fresh install, with no .env at all.
const vaultPlan = (lines?: string[]) => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "../.."), repo = mkdtempSync(join(tmpdir(), "setup-checkout-"));
  for (const name of readdirSync(root)) if (name !== ".env") symlinkSync(join(root, name), join(repo, name));  // the checkout
  if (lines) {
    const base = readFileSync(join(root, ".env.example"), "utf8").split("\n").filter((l) => !/^VAULT_(DIR|FOLDERS)=/.test(l));
    writeFileSync(join(repo, ".env"), [...base, ...lines].join("\n"));
  }
  return execFileSync("bash", [setup, "--dry-run", "--config", conf(person), "--checkout", repo], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
};

// The vault folders are seeded, never blanked: an empty VAULT_FOLDERS leaves meetings' ops-mcp without a /vault mount.
// The folders are made at setup as the owner (the module's uid 1000), so they exist before the module's health check runs.
test("the plan keeps the vault folder default and creates the vault folders as the owner", () => {
  const out = vaultPlan();
  assert.ok(!out.split("\n").some((l) => l.trim() === "+ .env: VAULT_FOLDERS="), `blanked VAULT_FOLDERS\n${out}`);
  assert.ok(out.includes("+ .env: VAULT_FOLDERS=Meetings"), out);
  assert.ok(out.includes("(as alice) mkdir -p /home/alice/obsidian/vault /home/alice/obsidian/vault/Meetings"), out);
});

// A rerun after the owner drops the vault: setup clears the folders too, since compile refuses a folder with no VAULT_DIR.
test("a rerun with no vault path clears VAULT_FOLDERS, so compile accepts .env", () => {
  const out = vaultPlan(["VAULT_DIR=", "VAULT_FOLDERS=Meetings"]);
  assert.ok(out.split("\n").some((l) => l.trim() === "+ .env: VAULT_FOLDERS="), `kept folders with no vault path\n${out}`);
  assert.ok(!out.includes("/obsidian/vault"), `still made the folders\n${out}`);
});

// An existing .env is read as the compiler reads it (any indent, quotes stripped) and as the apply's `set -a; . ./.env`
// expands it ($HOME), so setup makes the same directory compile mounts; an indented configured list is never rewritten.
test("a rerun reads .env as the apply does, and keeps a configured list", () => {
  const out = vaultPlan(['VAULT_DIR="$HOME/notes/vault"', '  VAULT_FOLDERS="Meetings, Ark"']);   // as the apply can source it
  assert.ok(out.includes("(as alice) mkdir -p /home/alice/notes/vault /home/alice/notes/vault/Meetings /home/alice/notes/vault/Ark"), out);
  assert.ok(!out.includes("+ .env: VAULT_FOLDERS="), `rewrote a configured list\n${out}`);
});

// A quoted value keeps a trailing ' #' that merely comments it (the apply does the same), so the comment is not the path:
// reading the quotes as the outer characters would leave a literal one and setup would refuse the valid absolute path.
test("a quoted vault path with a trailing comment is read without the quote or the comment", () => {
  const out = vaultPlan(['VAULT_DIR="$HOME/notes/vault" # meeting notes', 'VAULT_FOLDERS="Meetings"']);
  assert.ok(out.includes("(as alice) mkdir -p /home/alice/notes/vault /home/alice/notes/vault/Meetings"), out);
});

// An upgrade from the old installer: it wrote the default path and emptied the folders, but never made the directory.
// Setup restores Meetings and makes the root, so the apply mounts a directory the owner (uid 1000) can write.
test("an upgrade from the old installer makes the default vault", () => {
  const out = vaultPlan(["VAULT_DIR=/home/alice/obsidian/vault", "VAULT_FOLDERS="]);
  assert.ok(out.includes("+ .env: VAULT_FOLDERS=Meetings"), out);
  assert.ok(out.includes("(as alice) mkdir -p /home/alice/obsidian/vault /home/alice/obsidian/vault/Meetings"), out);
});

// A path compile refuses stops setup here, naming the value: left in place it would fail the apply after the install.
test("a vault path compile refuses stops setup with that message", () => {
  assert.throws(() => vaultPlan(["VAULT_DIR=obsidian/vault", "VAULT_FOLDERS=Meetings"]), /VAULT_DIR must be an absolute path in .*\.env \(it is \"obsidian\/vault\"\)/);
});
// A folder compile refuses is named the same way.
test("a vault folder compile refuses stops setup with that message", () => {
  assert.throws(() => vaultPlan(["VAULT_DIR=/srv/v", "VAULT_FOLDERS=Meetings, a:b"]), /invalid vault folder: a:b/);
});
// A configured custom path is the owner's to have made: setup creates it and every listed folder, as the owner, so a
// fresh operator with no notes folder still ends up with one the module (uid 1000) can write.
test("a configured custom vault root is created with its folders", () => {
  const vault = join(mkdtempSync(join(tmpdir(), "custom-")), "vault");  // it doesn't exist yet
  const out = vaultPlan([`VAULT_DIR=${vault}`, 'VAULT_FOLDERS="Meetings, Ark"']);   // sourceable by the apply
  assert.ok(out.includes(`(as alice) mkdir -p ${vault} ${vault}/Meetings ${vault}/Ark`), out);
});

// The value the old installer always wrote is empty, so a rerun must repair it, not keep it: that is the 503 this fixes.
test("a rerun repairs the empty VAULT_FOLDERS the old installer wrote", () => {
  const out = vaultPlan(["VAULT_DIR=/srv/v", "VAULT_FOLDERS="]);
  assert.ok(out.includes("+ .env: VAULT_FOLDERS=Meetings"), out);
});
// An unquoted value ends at ' #' as the shell ends it; a quoted one keeps the text. Either way the folder is the apply's.
test("a vault folder's trailing comment is not part of its name", () => {
  const vault = join(mkdtempSync(join(tmpdir(), "comment-")), "vault");
  const out = vaultPlan([`VAULT_DIR=${vault}`, "VAULT_FOLDERS=Meetings # meeting notes"]);
  assert.ok(out.includes(`mkdir -p ${vault} ${vault}/Meetings`), out);
  assert.ok(!out.includes("# meeting notes"), out);
});

test("is_loopback_url knows every loopback form and no real one", () => {
  const fn = `source <(sed -n '/^is_loopback_url()/,/^}/p' ${JSON.stringify(setup)}); `;
  const check = (u) => { try { execFileSync("bash", ["-c", `${fn} is_loopback_url "$1"`, "_", u]); return true; } catch { return false; } };
  for (const u of ["http://localhost", "http://localhost/x", "http://localhost:3120/setup?token=a", "http://127.0.0.1", "http://127.0.0.1:3121/connect/x", "http://[::1]", "http://[::1]/x", "http://[::1]:8446/x"]) assert.ok(check(u), `missed ${u}`);
  for (const u of ["https://alice.tail1234.ts.net:8446/x", "http://board.example/connect/x", "https://203.0.113.7/x"]) assert.ok(!check(u), `called ${u} loopback`);
});
