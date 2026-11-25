// The release train's compile preflight (kernel/src/compile-check.ts): the product tree at the target sha, the instance's
// config files at its main, and the target's own `AIDENHQ_COMPILE_STAGE=1 scripts/compile.ts` — the apply's check, read-only.
// A target whose compiler refuses the instance is `{ ok: false }` with the compiler's own first message; one that compiles is
// `{ ok: true }`; a target the checkout doesn't have (or one not on main) throws, which the route answers 503 so the train
// retries rather than recording a refusal it didn't make.
//
// The product repo here is a real git repo whose checksum differs between two commits: commit ONE understands the instance's
// `code_review` setting, commit TWO refuses it (the pre/post risk-tier shape, #1730). Nothing is compiled from the running
// tree, so the test proves the preflight runs the *target's* compiler and not the kernel's own.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { checkoutTree } from "../src/settings-change.ts";
import { createCompileCheck, dotenvOf, firstDiagnostic, installEnv, run, stagedEnv } from "../src/compile-check.ts";

process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
const product = join(dirname(fileURLToPath(import.meta.url)), "../..");
const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "init.defaultBranch=main", ...a], { cwd, encoding: "utf8" }).trim();

/** A product repo with the compiler's own files at `HEAD`, and one commit behind it whose compiler accepts any settings. */
function productRepo() {
  const dir = mkdtempSync(join(tmpdir(), "compile-check-product-"));
  // The target tree is the real product, so its compiler, scripts and modules are the ones the apply would run. Only the
  // setting it reads is narrowed, per commit, to the shape the instance has (the #1730 break in miniature).
  const write = (p: string, t: string) => (mkdirSync(dirname(join(dir, p)), { recursive: true }), writeFileSync(join(dir, p), t));
  // One compiler, two versions: the first accepts the pre-tier setting, the second refuses it (its `REFUSE` line).
  write("scripts/compile.ts", compiler(false));
  write("package.json", JSON.stringify({ name: "t", private: true }));
  git(dir, "init", "-q");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "one");
  const one = git(dir, "rev-parse", "HEAD");
  write("scripts/compile.ts", compiler(true));
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "two");
  const two = git(dir, "rev-parse", "HEAD");
  return { dir, one, two };
}

/**
 * The target's compiler: it refuses the pre-tier `code_review` shape when `refuse` (the new product, config.ts OLD), and
 * accepts it otherwise (the old product). It also proves the preflight runs the *target's* compiler, staged, from the target
 * tree: it refuses to run instead of one.
 */
const compiler = (refuse: boolean) => `#!/usr/bin/env node
import { readFileSync } from "node:fs";
import YAML from "yaml";
if (process.env.AIDENHQ_COMPILE_STAGE !== "1") { console.error("compile: not staged"); process.exit(1); }
const text = readFileSync(process.env.AIDENHQ_INSTANCE_DIR + "/instance.yaml", "utf8");
const cr = YAML.parse(text)?.settings?.code_review;
if (${refuse} && JSON.stringify(cr).includes('"on_open"')) {
  console.error("compile: settings.code_review: repos[0]: on_open, on_push and push_rounds are per tier now: by_tier.<tier>.… (see the Reviews page)");
  process.exit(1);
}
console.log("staged 1 modules");
`;

test("a target that compiles the instance is ok; one whose compiler refuses it answers the compiler's first message", async () => {
  const { dir, one, two } = productRepo();
  const inst = mkdtempSync(join(tmpdir(), "compile-check-inst-"));
  const bare = join(inst, "instance.git");
  const src = join(inst, "src");
  mkdirSync(src);
  writeFileSync(join(src, "instance.yaml"), YAML.stringify({ product: one, settings: { code_review: { repos: [{ repo: "acme/x", on_open: [] }] } } }));
  git(src, "init", "-q");
  git(src, "add", "-A");
  git(src, "commit", "-qm", "init");
  git(inst, "clone", "-q", "--bare", src, bare);
  const project = join(inst, "config");
  mkdirSync(project, { recursive: true });
  // Offline, its deps come from this checkout's own install (the production reuse path: scripts/package-lock.json matched).
  const realModules = join(product, "scripts", "node_modules");
  const check = createCompileCheck({ repo: dir, main: async () => ({ base: git(bare, "rev-parse", "main") }), tree: checkoutTree(bare), inputs: { configDir: project, dataDir: join(inst, "data"), secretsDir: join(inst, "secrets") },
  // The real runner: the target's own compiler, staged (AIDENHQ_COMPILE_STAGE=1), as the apply runs it.
  install: async (o) => { execFileSync("ln", ["-s", realModules, join(o.productDir, "scripts", "node_modules")]); } });
  const base = git(bare, "rev-parse", "main");
  // The old compiler (commit one) accepts the pre-tier shape the instance still has.
  assert.deepEqual(await check({ product: one }), { ok: true, base });
  // The new compiler (commit two) refuses it, and the answer is its own diagnostic line, with the commit that was compiled.
  assert.deepEqual(await check({ product: two }), { ok: false, base, error: "compile: settings.code_review: repos[0]: on_open, on_push and push_rounds are per tier now: by_tier.<tier>.… (see the Reviews page)" });
  // A target this checkout doesn't have is operational: it throws, never a refusal of the target.
  await assert.rejects(() => check({ product: "f".repeat(40) }), /git cat-file|isn't on the product's main/);
});

test("the staged env is the apply's own (AIDENHQ_COMPILE_STAGE=1) and the first diagnostic is the message line", () => {
  const snap = { configDir: "/c", dataDir: "/d", secretsDir: "/s", vaultDir: "/v", transcriptsDir: "/t" };
  const env = stagedEnv("/p", "/i", snap, { AIDENHQ_INSTANCE_REPO: "acme/i", AIDENHQ_PUBLIC_IP: "1.2.3.4" }, "/home/check");
  assert.equal(env.AIDENHQ_COMPILE_STAGE, "1");
  assert.equal(env.AIDENHQ_INSTANCE_DIR, "/i");
  assert.equal(env.AIDENHQ_CONFIG_DIR, "/c");
  assert.equal(env.AIDENHQ_SECRETS_DIR, "/s", "the snapshot's dir, never the host's");
  assert.equal(env.HOME, "/home/check", "the check's own home, never the host's ~/.config");
  assert.equal(env.AIDENHQ_INSTANCE_REPO, "acme/i");
  assert.equal(firstDiagnostic("at foo (x.ts:1)\nError: boom\nmore"), "Error: boom");
  assert.equal(firstDiagnostic("noise\ncompile: the setting is gone\nstack"), "compile: the setting is gone");
});

test("the target compiler gets no host secret: only the .env paths it reads, and a copy of the vault's facts", () => {
  // A host .env holds tokens and channel secrets beside the paths the compile reads. Only the compile's own names are carried.
  const dir = mkdtempSync(join(tmpdir(), "compile-check-env-"));
  writeFileSync(join(dir, ".env"), ["AIDENHQ_PUBLIC_IP=1.2.3.4", "AIDENHQ_INSTANCE_REPO=acme/i", "AIDENHQ_PRODUCT_REPO=acme/aidenhq",
    "paperclip_board_key=board-secret", "OPENROUTER_KEY=sk-or-secret", "AIDENHQ_KERNEL_KEY=kernel-secret", "GITHUB_TOKEN=gh-token"].join("\n"));
  const dot = dotenvOf(dir, { PATH: "/bin" });
  assert.deepEqual(Object.keys(dot).sort(), ["AIDENHQ_INSTANCE_REPO", "AIDENHQ_PUBLIC_IP"], "only the names the compile reads");
  assert.equal(dot.paperclip_board_key, undefined);
  assert.equal(dot.OPENROUTER_KEY, undefined);
  assert.equal(dot.GITHUB_TOKEN, undefined);
  // And the process env the compiler runs with carries none of them, even when they are set in the kernel's own environment.
  const env = stagedEnv("/p", "/i", { configDir: "/c", dataDir: "/d", secretsDir: "/s", vaultDir: "/v", transcriptsDir: "/t", vaultFolders: "", knowledgeBases: "" }, dot, "/h",
    { PATH: "/bin", AIDENHQ_KERNEL_KEY: "kernel-secret", OPERATOR_KEY: "op-secret", GITHUB_TOKEN: "tok", OPENROUTER_KEY: "sk", PAPERCLIP_BOARD_KEY: "b", VAULT_DIR: "/real/vault" });
  assert.equal(env.PATH, "/bin");
  assert.equal(env.VAULT_DIR, "/v", "the compile's vault path is the snapshot's, never the host's");
  assert.equal(env.AIDENHQ_KERNEL_KEY, undefined);
  assert.equal(env.OPERATOR_KEY, undefined);
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.OPENROUTER_KEY, undefined);
  assert.equal(env.PAPERCLIP_BOARD_KEY, undefined);
});

test("a target's npm install runs with no host path at all, unlike the compiler that follows it", () => {
  // The install runs the target's own lifecycle scripts before anything is checked: it gets a PATH, HOME, locale and temp only.
  const env = installEnv({ PATH: "/bin", HOME: "/home/u", LANG: "C", AIDENHQ_DIR: "/host/aidenhq", AIDENHQ_STATE_DIR: "/host/state",
    AIDENHQ_INSTANCE_REPO: "acme/i", TRANSCRIPTS_DIR: "/host/tr", VAULT_DIR: "/host/vault", AIDENHQ_SECRETS_DIR: "/host/secrets",
    AIDENHQ_CONFIG_DIR: "/host/config", AIDENHQ_DATA_DIR: "/host/data", AIDENHQ_KERNEL_KEY: "k", OPERATOR_KEY: "o", GITHUB_TOKEN: "t" });
  assert.deepEqual(Object.keys(env).sort(), ["HOME", "LANG", "PATH"]);
  assert.equal(env.HOME, "/home/u", "npm's cache is the warm one the apply's own install uses");
});

test("a compiler that never finished (a timeout) is an operational error, not a refusal", async () => {
  // A real non-zero exit is the target refusing the instance; a killed child is not, so the caller retries rather than
  // dropping the tip on a slow host.
  const refused = await run(process.execPath, ["-e", "console.error('compile: nope'); process.exit(3)"], process.cwd(), process.env, 10_000);
  assert.deepEqual([refused.ok, refused.ran], [false, true]);
  const killed = await run(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], process.cwd(), process.env, 200);
  assert.equal(killed.ok, false);
  assert.equal(killed.ran, false, "a killed child never reached an exit code");
});

test("an instance with product_fork is compiled from the fork, not the pin it descends from", async () => {
  // The apply runs the fork's tree (kernelRun, ops/apply-config-work.sh). A preflight that compiled the pin would pass here while
  // the apply then runs a fork that refuses the instance: the same fails-open class as #1730.
  const { dir, one, two } = productRepo();
  // The fork descends from commit one and carries commit two's refusing compiler.
  git(dir, "checkout", "-q", one);
  writeFileSync(join(dir, "scripts", "compile.ts"), compiler(true));
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "fork: refuses the pre-tier setting");
  const fork = git(dir, "rev-parse", "HEAD");
  git(dir, "checkout", "-q", "-B", "main", two);
  const inst = mkdtempSync(join(tmpdir(), "compile-check-inst-"));
  const bare = join(inst, "instance.git");
  const src = join(inst, "src");
  mkdirSync(src);
  writeFileSync(join(src, "instance.yaml"), YAML.stringify({ product: one, product_fork: { source: "url", url: `file://${dir}`, sha: fork }, settings: { code_review: { repos: [{ repo: "acme/x", on_open: [] }] } } }));
  git(src, "init", "-q");
  git(src, "add", "-A");
  git(src, "commit", "-qm", "init");
  git(inst, "clone", "-q", "--bare", src, bare);
  const project = join(inst, "config");
  mkdirSync(project, { recursive: true });
  const realModules = join(product, "scripts", "node_modules");
  // The fork is extracted from this checkout: a local path fork's sha is here, so no fetch is needed.
  const check = createCompileCheck({ repo: dir, main: async () => ({ base: git(bare, "rev-parse", "main") }), tree: checkoutTree(bare), inputs: { configDir: project, dataDir: join(inst, "data"), secretsDir: join(inst, "secrets") },
    install: async (o) => { execFileSync("ln", ["-s", realModules, join(o.productDir, "scripts", "node_modules")]); } });
  // The pin (commit one) accepts the instance; the fork refuses it, and the fork is what the apply would run.
  const r = await check({ product: one });
  assert.equal(r.ok, false, "the fork's refusal is the verdict, not the pin's acceptance");
  assert.match((r as { error: string }).error, /^compile: settings\.code_review/);
  void two;
});

test("the compiler runs in a git checkout at the target, so its revision input is the target sha", async () => {
  // scripts/compiler/inputs.ts takes `git rev-parse HEAD` as the compile's revision. A bare extraction has no .git and compiles
  // with no revision while the apply's checkout has one: the snapshot must be a real checkout at the target.
  const { dir, one } = productRepo();
  const inst = mkdtempSync(join(tmpdir(), "compile-check-inst-"));
  const bare = join(inst, "instance.git");
  const src = join(inst, "src");
  mkdirSync(src);
  writeFileSync(join(src, "instance.yaml"), YAML.stringify({ product: one, modules: [] }));
  git(src, "init", "-q");
  git(src, "add", "-A");
  git(src, "commit", "-qm", "init");
  git(inst, "clone", "-q", "--bare", src, bare);
  let seen: { head?: string; gitDir?: boolean } = {};
  const project = join(inst, "config");
  mkdirSync(project, { recursive: true });
  const check = createCompileCheck({ repo: dir, main: async () => ({ base: git(bare, "rev-parse", "main") }), tree: checkoutTree(bare), inputs: { configDir: project, dataDir: join(inst, "data"), secretsDir: join(inst, "secrets") },
    // The runner sees the tree the compiler would run in: it must be a git checkout whose HEAD is the target.
    run: async (o) => { seen = { head: execFileSync("git", ["-C", o.productDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), gitDir: existsSync(join(o.productDir, ".git")) }; return { ok: true }; } });
  await check({ product: one });
  assert.equal(seen.gitDir, true, "the target tree is a git checkout, not an extraction");
  assert.equal(seen.head, one, "and HEAD is the target sha");
});

/**
 * The snapshot is not a weakening: the compile still sees the vault facts it reads (an edge instance with an empty
 * cloudflared credentials file is refused exactly as the apply refuses it), while the target compiler is handed no path to the
 * real vault, data or config dir and no host .env file.
 */
test("the compile sees the vault's facts but no path to the host's vault, data or config", async () => {
  const { dir, one } = productRepo();
  // A compiler that records where it was pointed (and whether it can see a real hidden file there), then refuses like the apply.
  writeFileSync(join(dir, "scripts", "compile.ts"), `#!/usr/bin/env node
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
const s = process.env.AIDENHQ_SECRETS_DIR;
const d = process.env.AIDENHQ_DATA_DIR;
const c = process.env.AIDENHQ_CONFIG_DIR;
const creds = join(s, "cloudflared_credentials.json");
console.log(JSON.stringify({ secrets: readdirSync(s).sort(), data: readdirSync(d).sort(), config: readdirSync(c).sort(),
  vault: process.env.VAULT_DIR, hostEnvCopied: existsSync(join(process.cwd(), ".env")),
  credsPresent: existsSync(creds), credsLen: existsSync(creds) ? readFileSync(creds, "utf8").length : 0 }));
process.exit(0);
`);
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "snapshot");
  const sha = git(dir, "rev-parse", "HEAD");
  const inst = mkdtempSync(join(tmpdir(), "compile-check-inst-"));
  const bare = join(inst, "instance.git");
  const src = join(inst, "src");
  mkdirSync(src);
  writeFileSync(join(src, "instance.yaml"), YAML.stringify({ product: one, modules: [] }));
  git(src, "init", "-q"); git(src, "add", "-A"); git(src, "commit", "-qm", "init");
  git(inst, "clone", "-q", "--bare", src, bare);
  // The host: a vault with a real key AND a decoy file the target must never be able to list, a data dir with a live file.
  const vault = join(inst, "secrets");
  mkdirSync(join(vault, "github-app"), { recursive: true });
  writeFileSync(join(vault, "tailscale_apps_authkey"), "tskey-secret");
  writeFileSync(join(vault, "paperclip_board_key"), "board-secret");
  writeFileSync(join(vault, "cloudflared_credentials.json"), "{\"AccountTag\":\"x\"}");
  writeFileSync(join(vault, "github-app", "app_id"), "12345");
  const data = join(inst, "data");
  mkdirSync(join(data, "kernel"), { recursive: true });
  writeFileSync(join(data, "kernel", "kernel.db"), "live-db");
  const config = join(inst, "config");
  mkdirSync(config, { recursive: true });
  writeFileSync(join(config, "runner.yaml"), "work_dir: /tmp/w\n");
  writeFileSync(join(config, "paperclip.yaml"), "company: {}\n");
  const realModules = join(product, "scripts", "node_modules");
  let said;
  const check = createCompileCheck({ repo: dir, main: async () => ({ base: git(bare, "rev-parse", "main") }), tree: checkoutTree(bare), inputs: { configDir: config, dataDir: data, secretsDir: vault },
    install: async (o) => { execFileSync("ln", ["-s", realModules, join(o.productDir, "scripts", "node_modules")]); },
    // The real compiler, run staged, from the target tree — the production path.
    run: async (o) => { const { execFile } = await import("node:child_process"); const out = await new Promise((ok) => execFile(process.execPath, ["scripts/compile.ts"], { cwd: o.productDir, env: o.env }, (e, so) => ok(e ? String(e) : String(so)))); said = JSON.parse(String(out).trim().split("\n").at(-1)); return { ok: true }; } });
  await check({ product: sha });
  assert.deepEqual(said.secrets.sort(), ["cloudflared_credentials.json", "tailscale_apps_authkey"], "the vault facts, and no other vault file");
  assert.equal(said.credsPresent, true, "the credentials file the apply checks is present in the snapshot");
  assert.ok(said.credsLen > 0, "and non-empty, so the apply's check reproduces (the bytes are a stand-in, not the secret)");
  assert.ok(said.credsLen < 40, "the stand-in is not the real credential");
  assert.ok(said.data.every((n) => n !== "kernel"), `no live data dir in the snapshot (saw ${JSON.stringify(said.data)})`);
  assert.deepEqual(said.config, ["runner.yaml"], "only the config file the compile reads");
  assert.notEqual(said.vault, vault, "the vault path is the snapshot's, not the host's");
  assert.equal(said.hostEnvCopied, false, "no host .env file in the tree the target compiler runs in");
});

/**
 * The staged instance carries the pin the bump writes, not the one the instance has today: a fork's base is
 * `instance.product` (scripts/compiler/sources.ts forkBase), so compiling the old pin would validate the fork against a base the
 * real apply never uses.
 */
test("the instance is compiled with the pin the bump writes, not the one it has today", async () => {
  const { dir, one, two } = productRepo();
  const inst = mkdtempSync(join(tmpdir(), "compile-check-inst-"));
  const bare = join(inst, "instance.git");
  const src = join(inst, "src");
  mkdirSync(src);
  writeFileSync(join(src, "instance.yaml"), YAML.stringify({ product: one, modules: [] }));
  git(src, "init", "-q"); git(src, "add", "-A"); git(src, "commit", "-qm", "init");
  git(inst, "clone", "-q", "--bare", src, bare);
  const project = join(inst, "config");
  mkdirSync(project, { recursive: true });
  let seen;
  const check = createCompileCheck({ repo: dir, main: async () => ({ base: git(bare, "rev-parse", "main") }), tree: checkoutTree(bare), inputs: { configDir: project, dataDir: join(inst, "data"), secretsDir: join(inst, "secrets") },
    run: async (o) => { seen = YAML.parse(readFileSync(join(o.instanceDir, "instance.yaml"), "utf8")).product; return { ok: true }; } });
  await check({ product: two, pin: two });
  assert.equal(seen, two, "the compiled tree pins the target, ready for the apply the bump files");
  // The default `pin` is the target itself: "does the instance compile against this product" is asked with the pin moved to it.
  await check({ product: two });
  assert.equal(seen, two);
  // And a distinct `pin` is honoured (a fork case: the pin stays while another tree is asked about).
  await check({ product: two, pin: one });
  assert.equal(seen, one);
});

test("a refusal that merely names TLS or SSL is the target's verdict, not a network failure", async () => {
  // A new product that dropped a setting says so in its own words: "kernel TLS module … is gone". Matching a bare SSL/TLS token
  // would read that as operational and retry the tip for ever instead of refusing it (#1730's own class of refusal).
  const { dir, one } = productRepo();
  writeFileSync(join(dir, "scripts", "compile.ts"), `#!/usr/bin/env node
if (process.env.AIDENHQ_COMPILE_STAGE !== "1") { console.error("compile: not staged"); process.exit(1); }
console.error("compile: settings.modules: the kernel TLS module is gone; drop modules.tls (see the Modules page)");
process.exit(1);
`);
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "tls-refusal");
  const sha = git(dir, "rev-parse", "HEAD");
  const inst = mkdtempSync(join(tmpdir(), "compile-check-inst-"));
  const bare = join(inst, "instance.git");
  const src = join(inst, "src");
  mkdirSync(src);
  writeFileSync(join(src, "instance.yaml"), YAML.stringify({ product: one, modules: ["tls"] }));
  git(src, "init", "-q");
  git(src, "add", "-A");
  git(src, "commit", "-qm", "init");
  git(inst, "clone", "-q", "--bare", src, bare);
  const project = join(inst, "config");
  mkdirSync(project, { recursive: true });
  const realModules = join(product, "scripts", "node_modules");
  const check = createCompileCheck({ repo: dir, main: async () => ({ base: git(bare, "rev-parse", "main") }), tree: checkoutTree(bare), inputs: { configDir: project, dataDir: join(inst, "data"), secretsDir: join(inst, "secrets") },
    install: async (o) => { execFileSync("ln", ["-s", realModules, join(o.productDir, "scripts", "node_modules")]); } });
  assert.deepEqual(await check({ product: sha }), { ok: false, base: git(bare, "rev-parse", "main"), error: "compile: settings.modules: the kernel TLS module is gone; drop modules.tls (see the Modules page)" });
});

test("a compile that failed reaching a source is operational, not the target refusing the instance", async () => {
  // The compiler fetches third-party modules and releases while it runs; a network failure there says nothing about the target.
  const { dir, one } = productRepo();
  writeFileSync(join(dir, "scripts", "compile.ts"), `#!/usr/bin/env node
console.error("fatal: unable to access 'https://github.com/acme/x/': Could not resolve host: github.com");
process.exit(128);
`);
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "network");
  const sha = git(dir, "rev-parse", "HEAD");
  const inst = mkdtempSync(join(tmpdir(), "compile-check-inst-"));
  const bare = join(inst, "instance.git");
  const src = join(inst, "src");
  mkdirSync(src);
  writeFileSync(join(src, "instance.yaml"), YAML.stringify({ product: one, modules: [] }));
  git(src, "init", "-q");
  git(src, "add", "-A");
  git(src, "commit", "-qm", "init");
  git(inst, "clone", "-q", "--bare", src, bare);
  const project = join(inst, "config");
  mkdirSync(project, { recursive: true });
  const realModules = join(product, "scripts", "node_modules");
  const check = createCompileCheck({ repo: dir, main: async () => ({ base: git(bare, "rev-parse", "main") }), tree: checkoutTree(bare), inputs: { configDir: project, dataDir: join(inst, "data"), secretsDir: join(inst, "secrets") },
    install: async (o) => { execFileSync("ln", ["-s", realModules, join(o.productDir, "scripts", "node_modules")]); } });
  await assert.rejects(() => check({ product: sha }), /couldn't reach a source it needs/);
});
