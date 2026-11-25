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
import { execFile, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";

const SHA = /^[0-9a-f]{40}$/;
/** The apply's compiler (ops/apply-config-work.sh validate), run from the product tree it applies. */
export const COMPILER = "scripts/compile.ts";

/** What a staged compile says of its inputs: it compiles, or the compiler's own first message line. */
export type Verdict = { ok: true } | { ok: false; error: string };
/**
 * What the check answers: the verdict, with the instance commit it compiled (`base`), so the caller's commit builds on exactly
 * that revision — never a main that moved since.
 */
export type CompileCheck = Verdict & { base: string };
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
  run?: (o: RunInput) => Promise<Verdict>;
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

/** `git` in the product checkout, asynchronously (a slow fetch must not stall the kernel's event loop). */
function git(repo: string, args: string[]): Promise<Buffer> {
  return new Promise<Buffer>((ok, no) => {
    execFile("git", ["-C", repo, ...args], { timeout: 120_000, maxBuffer: 256 * 1024 * 1024, encoding: "buffer" }, (e, out, err) => {
      if (e) return no(new Error(`git ${args[0]}: ${String(err ?? e.message).toString().trim().slice(0, 300)}`));
      ok(out as Buffer);
    });
  });
}

/**
 * The target product's tree at `sha` into `to`, from this host's product checkout: main is fetched first (the train's tip
 * comes from the change feed, which may be ahead of this checkout) and only a commit on main is staged, as the apply refuses
 * anything unmerged. A commit the checkout doesn't have after the fetch, or one not on main, is operational: the caller retries.
 */
async function stageProduct(repo: string, sha: string, to: string) {
  // The host's checkout has `origin`; a bare repo a test made may not. A failed fetch of a remote that is there is
  // operational (a network the train retries), never a verdict on the target.
  const remotes = (await git(repo, ["remote"])).toString().split("\n").map((l) => l.trim());
  if (remotes.includes("origin")) await git(repo, ["fetch", "--quiet", "origin", "main"]);
  await git(repo, ["cat-file", "-e", `${sha}^{commit}`]);
  // Nothing unmerged runs (ops/apply-config-work.sh: the pin must be on product main). Compare against the fetched main when
  // there is one, else the local main the checkout has.
  let mainRef: string | undefined;
  for (const r of ["refs/remotes/origin/main", "refs/heads/main"]) {
    try { await git(repo, ["rev-parse", "--verify", "--quiet", `${r}^{commit}`]); mainRef = r; break; } catch {}
  }
  if (mainRef) {
    try { await git(repo, ["merge-base", "--is-ancestor", sha, mainRef]); }
    catch { throw new Error(`the target product ${sha.slice(0, 12)} isn't on the product's main`); }
  }
  await extract(repo, sha, to);
}

/** A commit's tree (from this checkout) into `to`. */
async function extract(repo: string, sha: string, to: string) {
  mkdirSync(to, { recursive: true });
  await new Promise<void>((ok, no) => {
    const tar = spawn("tar", ["-x", "-C", to], { stdio: ["pipe", "ignore", "pipe"] });
    let err = "";
    tar.stderr.on("data", (d) => (err += String(d)));
    tar.on("error", no);
    tar.on("close", (code) => (code === 0 ? ok() : no(new Error(`tar: ${err.trim().slice(0, 300)}`))));
    void git(repo, ["archive", "--format=tar", sha]).then((tree) => tar.stdin.end(tree), (e) => { tar.stdin.destroy(); no(e); });
  });
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

/**
 * A child run's exit: ok with its stdout, or a failure carrying its stderr and, when it never ran to completion (a timeout,
 * a missing binary), the spawn error. `ran` is true only for a real non-zero exit, which is the compiler refusing the inputs.
 */
export function run(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeout: number) {
  return new Promise<{ ok: boolean; ran: boolean; stdout: string; stderr: string; error?: string }>((ok) => {
    execFile(cmd, args, { cwd, env, timeout, maxBuffer: 64 * 1024 * 1024 }, (e, out, err) => {
      const ex = e as (Error & { code?: number | string; killed?: boolean; signal?: string }) | null;
      const ran = !ex || (typeof ex.code === "number" && !ex.killed);
      ok({ ok: !ex, ran, stdout: String(out ?? ""), stderr: String(err ?? ""), error: ex ? `${ex.code ?? ""}${ex.killed ? " (timed out)" : ""}`.trim() || ex.message : undefined });
    });
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
    // Installs run the target's own lifecycle scripts: they get no path to the host's config, data or vault, unlike the
    // compiler below, which the apply's own staged compile reads those with.
    const installed = await run("npm", ["ci", "--prefix", d, "--silent"], o.productDir, { ...o.env, AIDENHQ_CONFIG_DIR: "", AIDENHQ_DATA_DIR: "", AIDENHQ_SECRETS_DIR: "" }, 300_000);
    if (!installed.ok) throw new Error(`the target product's ${d} deps didn't install: ${firstDiagnostic(installed.stderr) || "npm ci failed"}`);
  }
}

/** The default `run`: the target tree's compiler deps, then its own compiler, staged — as the apply does both. */
async function stagedCompile(o: RunInput, install: (o: RunInput) => Promise<void>): Promise<Verdict> {
  await install(o);
  const compiled = await run(process.execPath, [COMPILER], o.productDir, o.env, 300_000);
  if (compiled.ok) return { ok: true };
  // A compiler that never finished (a timeout, a killed child) is operational: the caller retries, never records a refusal the
  // compiler didn't make. Only a real non-zero exit is the target refusing the instance.
  if (!compiled.ran) throw new Error(`the staged compile didn't finish: ${compiled.error ?? "killed"}${compiled.stderr.trim() ? `: ${firstDiagnostic(compiled.stderr)}` : ""}`);
  return { ok: false, error: firstDiagnostic(compiled.stderr) || "the staged compile failed with no error text" };
}

/**
 * The kernel tree the apply runs for an instance: its `product_fork:` when that descends from the pin (`kernelRun`,
 * ops/apply-config-work.sh), else the pin itself. The fork is fetched by sha from its url when this checkout lacks it, as the
 * apply fetches it. A fork that doesn't descend from the target is what the apply refuses, so it is operational here (the train
 * retries; the pin has not moved to a target the fork covers), never a compile verdict on the target.
 */
async function kernelTree(repo: string, product: string, instanceDir: string): Promise<string> {
  let fork: { sha?: unknown; url?: unknown; source?: unknown; repo?: unknown } | undefined;
  try { fork = (YAML.parse(readFileSync(join(instanceDir, "instance.yaml"), "utf8")) ?? {}).product_fork; } catch { return product; }
  if (fork == null) return product;
  const sha = String(fork.sha ?? "");
  if (!SHA.test(sha)) throw new Error("instance.yaml product_fork: a fork needs a 40-character sha");
  const url = fork.source === "github" ? `https://github.com/${String(fork.repo ?? "")}.git` : String(fork.url ?? "");
  const present = async (c: string) => { try { await git(repo, ["cat-file", "-e", `${c}^{commit}`]); return true; } catch { return false; } };
  if (!(await present(sha))) {
    if (!url) throw new Error(`couldn't fetch product_fork ${sha.slice(0, 12)}: no url or github repo`);
    try { await git(repo, ["-c", "credential.helper=", "-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "fetch", "--quiet", "--no-tags", "--no-recurse-submodules", "--", url, sha]); }
    catch (e) { throw new Error(`couldn't fetch product_fork ${sha.slice(0, 12)} from ${url}: ${(e as Error).message.slice(0, 200)}`); }
  }
  try { await git(repo, ["merge-base", "--is-ancestor", product, sha]); }
  catch { throw new Error(`product_fork ${sha.slice(0, 12)} does not descend from product ${product.slice(0, 12)}`); }
  return sha;
}

/** The compile preflight: `POST /v1/compile/check {product, instance?}` -> `{ok, base}`, or `{ok: false, error, base}`. */
export function createCompileCheck(d: CompileDeps) {
  const log = d.log ?? (() => {});
  return async function compileCheck(body: { product?: unknown; instance?: unknown }): Promise<CompileCheck> {
    const product = String(body?.product ?? "");
    if (!SHA.test(product)) throw new Error(`product ${JSON.stringify(product.slice(0, 60))} isn't a 40-character commit`);
    if (body?.instance !== undefined && !SHA.test(String(body.instance))) throw new Error(`instance ${JSON.stringify(String(body.instance).slice(0, 60))} isn't a 40-character commit`);
    // The instance as the bump would build on it: its main, read here, returned so the caller commits on this same revision.
    const base = body?.instance === undefined ? (await d.main()).base : String(body.instance);
    const dir = mkdtempSync(join(tmpdir(), "aidenhq-preflight-"));
    let productDir = join(dir, "product");
    const instanceDir = join(dir, "instance");
    const t0 = Date.now();
    try {
      // The product first, so a target this checkout doesn't have costs no instance read.
      await stageProduct(d.repo, product, productDir);
      await d.tree(base, instanceDir);
      // The tree the apply actually runs: the instance's fork when it descends from the target, in its own folder. Compiling the
      // pin while the apply runs the fork would check different inputs.
      const kernelSha = await kernelTree(d.repo, product, instanceDir);
      if (kernelSha !== product) {
        productDir = join(dir, "kernel-fork");
        await extract(d.repo, kernelSha, productDir);
      }
      seedInputs(d.repo, productDir);
      const env = stagedEnv(productDir, instanceDir, d.inputs);
      const o = { productDir, instanceDir, repo: d.repo, env };
      const r = d.run ? await d.run(o) : await stagedCompile(o, d.install ?? installCompiler);
      log("compile check", { product, instance: base, ok: r.ok, ms: Date.now() - t0 });
      return { ...r, base };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}
