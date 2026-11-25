// The release train's compile preflight (POST /v1/compile/check, a module with role kernel.apply): does this instance, as it
// stands on its main, compile against a product commit? It is the apply's own check, run the way the apply runs it
// (ops/apply-config-work.sh validate): the product tree at the pin, the instance's config files at its main, then
// `AIDENHQ_COMPILE_STAGE=1 node scripts/compile.ts` in that tree. So a target the apply would refuse is refused before the
// release train commits a pin bump to it, and the bad pin never lands. Read-only: both trees are compiled in a temp folder,
// nothing on the host is configured, and no record is filed (the one host write is the checkout's own `git fetch`, as the
// apply planner already makes).
//
// It compiles with the *target's* compiler, never the running one: a product that changes what a setting means refuses the
// instance in its own scripts/modules.ts, and only its compiler catches that (#1730 is exactly that break).
import { execFile, execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SHA = /^[0-9a-f]{40}$/;
/** The apply's compiler (ops/apply-config-work.sh validate), run from the product tree it applies. */
export const COMPILER = "scripts/compile.ts";

/** What the check answers: it compiles, or the compiler's first message line (the apply's own diagnostic). */
export type CompileCheck = { ok: true } | { ok: false; error: string };
/** The host's inputs the apply's compile reads, as absolute paths. */
export type Inputs = { configDir: string; dataDir: string; secretsDir: string };
/** What the staged compile is handed: the two trees and the env the apply's own staged compile runs with. */
export type RunInput = { productDir: string; instanceDir: string; repo: string; env: NodeJS.ProcessEnv };
export type CompileDeps = {
  /** This host's product checkout (AIDENHQ_DIR): its git has the product commits, its .env and data are the host's inputs. */
  repo: string;
  /** The instance repo's main, fetched first (settings-change.ts checkoutMain). */
  main: () => Promise<{ base: string }>;
  /** The instance's config files at a commit, into an empty folder (settings-change.ts checkoutTree). */
  tree: (commit: string, to: string) => Promise<void>;
  inputs: Inputs;
  /**
   * Installs the target tree's compiler deps into its `scripts/node_modules` (default: the apply's own rule). Injected by a
   * test so the check runs offline; production never overrides it.
   */
  install?: (o: RunInput) => Promise<void>;
  /** The staged compile in the extracted product tree (default: install, then the target's own compiler). */
  run?: (o: RunInput) => Promise<CompileCheck>;
  log?: (msg: string, f?: Record<string, unknown>) => void;
};

/**
 * The env the apply's staged compile runs with (ops/apply-config-work.sh: `AIDENHQ_COMPILE_STAGE=1 node scripts/compile.ts`):
 * the staged mode, the instance tree to compile, and this host's config, data and vault. The compiler's outputs go to
 * `<productDir>/config.next` and `<productDir>/compose.modules.next.yaml`, inside the extracted target tree, never the host's.
 */
export const stagedEnv = (productDir: string, instanceDir: string, i: Inputs, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => ({
  ...base, AIDENHQ_COMPILE_STAGE: "1", AIDENHQ_INSTANCE_DIR: instanceDir,
  AIDENHQ_CONFIG_DIR: i.configDir, AIDENHQ_DATA_DIR: i.dataDir, AIDENHQ_SECRETS_DIR: i.secretsDir,
});

/** The apply's first message line from a failed compile: from `compile: …` (or a thrown error's line) on, the first line. */
export function firstDiagnostic(stderr: unknown): string {
  const lines = String(stderr ?? "").split("\n").map((l) => l.replace(/\r$/, ""));
  const at = lines.findIndex((l) => /^(compile:|[A-Za-z]*Error\b)/.test(l));
  const first = (at >= 0 ? lines[at]! : lines.find((l) => l.trim()) ?? "").trim();
  return first.slice(0, 300);
}

/** `git` in the product checkout; a failure is an Error carrying git's own message (bounded). */
function git(repo: string, args: string[], input?: Buffer): Buffer {
  try {
    return execFileSync("git", ["-C", repo, ...args], { input, timeout: 120_000, maxBuffer: 256 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] });
  } catch (e) {
    const err = e as Error & { stderr?: Buffer };
    throw new Error(`git ${args[0]}: ${String(err.stderr ?? err.message).trim().slice(0, 300)}`);
  }
}

/**
 * The target product's tree at `sha` into `to`, from this host's product checkout: main is fetched first (the train's tip
 * comes from the change feed, which may be ahead of this checkout) and only a commit on main is staged, as the apply refuses
 * anything unmerged. A commit the checkout doesn't have after the fetch, or one not on main, is operational: the caller retries.
 */
function stageProduct(repo: string, sha: string, to: string) {
  // The host's checkout has `origin`; a bare repo a test made may not. A failed fetch of a remote that is there is
  // operational (a network the train retries), never a verdict on the target.
  const remotes = git(repo, ["remote"]).toString().split("\n").map((l) => l.trim());
  if (remotes.includes("origin")) git(repo, ["fetch", "--quiet", "origin", "main"]);
  git(repo, ["cat-file", "-e", `${sha}^{commit}`]);
  // Nothing unmerged runs (ops/apply-config-work.sh: the pin must be on product main). Compare against the fetched main when
  // there is one, else the local main the checkout has.
  const mainRef = ["refs/remotes/origin/main", "refs/heads/main"].find((r) => {
    try { git(repo, ["rev-parse", "--verify", "--quiet", `${r}^{commit}`]); return true; } catch { return false; }
  });
  if (mainRef) {
    try { git(repo, ["merge-base", "--is-ancestor", sha, mainRef]); }
    catch { throw new Error(`the target product ${sha.slice(0, 12)} isn't on the product's main`); }
  }
  mkdirSync(to, { recursive: true });
  execFileSync("tar", ["-x", "-C", to], { input: git(repo, ["archive", "--format=tar", sha]), timeout: 180_000, maxBuffer: 4 * 1024 * 1024 });
}

/** The host's inputs the apply's compile reads from the checkout it runs in: its .env and the bundle it last compiled. */
function seedInputs(repo: string, productDir: string) {
  const env = join(repo, ".env");
  if (existsSync(env)) copyFileSync(env, join(productDir, ".env"));
  const bundle = join(repo, "data", "bundle-state.json");
  if (existsSync(bundle)) {
    mkdirSync(join(productDir, "data"), { recursive: true });
    copyFileSync(bundle, join(productDir, "data", "bundle-state.json"));
  }
}

/** A child run's exit: ok with its stdout, or a failure carrying its stderr. */
function run(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeout: number) {
  return new Promise<{ ok: boolean; stdout: string; stderr: string }>((ok) => {
    execFile(cmd, args, { cwd, env, timeout, maxBuffer: 64 * 1024 * 1024 }, (e, out, err) => ok({ ok: !e, stdout: String(out ?? ""), stderr: String(err ?? "") }));
  });
}

/**
 * The target tree's compiler deps, by the apply's own rule (ops/apply-config-work.sh:170-173: `npm ci` for `scripts` and
 * `kernel` when a lockfile differs from what is installed). The checkout's install is the running product's, so it is reused,
 * linked, when the target's lockfile is byte-identical; otherwise `npm ci` installs the target's own. A failed install is
 * operational (an offline host), so the caller retries: never a refusal of the target.
 */
async function installCompiler(o: RunInput) {
  for (const d of ["scripts", "kernel"]) {
    const lock = join(o.productDir, d, "package-lock.json");
    const running = join(o.repo, d, "package-lock.json");
    const modules = join(o.repo, d, "node_modules");
    if (existsSync(lock) && existsSync(running) && existsSync(modules) && readFileSync(lock).equals(readFileSync(running))) {
      symlinkSync(modules, join(o.productDir, d, "node_modules"), "dir");
      continue;
    }
    const installed = await run("npm", ["ci", "--prefix", d, "--silent"], o.productDir, o.env, 300_000);
    if (!installed.ok) throw new Error(`the target product's ${d} deps didn't install: ${firstDiagnostic(installed.stderr) || "npm ci failed"}`);
  }
}

/** The default `run`: the target tree's compiler deps, then its own compiler, staged — as the apply does both. */
async function stagedCompile(o: RunInput, install: (o: RunInput) => Promise<void>): Promise<CompileCheck> {
  await install(o);
  const compiled = await run(process.execPath, [COMPILER], o.productDir, o.env, 300_000);
  return compiled.ok ? { ok: true } : { ok: false, error: firstDiagnostic(compiled.stderr) || "the staged compile failed with no error text" };
}

/** The compile preflight: `POST /v1/compile/check {product, instance?}` -> `{ok: true}` or `{ok: false, error}`. */
export function createCompileCheck(d: CompileDeps) {
  const log = d.log ?? (() => {});
  return async function compileCheck(body: { product?: unknown; instance?: unknown }): Promise<CompileCheck> {
    const product = String(body?.product ?? "");
    if (!SHA.test(product)) return { ok: false, error: `product ${JSON.stringify(product.slice(0, 60))} isn't a 40-character commit` };
    if (body?.instance !== undefined && !SHA.test(String(body.instance))) return { ok: false, error: `instance ${JSON.stringify(String(body.instance).slice(0, 60))} isn't a 40-character commit` };
    // The instance as the bump would build on it: its main, read here, never the caller's word.
    const base = body?.instance === undefined ? (await d.main()).base : String(body.instance);
    const dir = mkdtempSync(join(tmpdir(), "aidenhq-preflight-"));
    const productDir = join(dir, "product");
    const instanceDir = join(dir, "instance");
    const t0 = Date.now();
    try {
      // The product first, so a target this checkout doesn't have costs no instance read.
      stageProduct(d.repo, product, productDir);
      await d.tree(base, instanceDir);
      seedInputs(d.repo, productDir);
      const env = stagedEnv(productDir, instanceDir, d.inputs);
      const o = { productDir, instanceDir, repo: d.repo, env };
      const r = d.run ? await d.run(o) : await stagedCompile(o, d.install ?? installCompiler);
      log("compile check", { product, instance: base, ok: r.ok, ms: Date.now() - t0 });
      return r;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}
