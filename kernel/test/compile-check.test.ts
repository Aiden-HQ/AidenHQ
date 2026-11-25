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
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { checkoutTree } from "../src/settings-change.ts";
import { createCompileCheck, firstDiagnostic, run, stagedEnv } from "../src/compile-check.ts";

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
  const env = stagedEnv("/p", "/i", { configDir: "/c", dataDir: "/d", secretsDir: "/s" });
  assert.equal(env.AIDENHQ_COMPILE_STAGE, "1");
  assert.equal(env.AIDENHQ_INSTANCE_DIR, "/i");
  assert.equal(env.AIDENHQ_CONFIG_DIR, "/c");
  assert.equal(firstDiagnostic("at foo (x.ts:1)\nError: boom\nmore"), "Error: boom");
  assert.equal(firstDiagnostic("noise\ncompile: the setting is gone\nstack"), "compile: the setting is gone");
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
