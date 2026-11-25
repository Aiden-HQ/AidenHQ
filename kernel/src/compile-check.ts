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
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";

const SHA = /^[0-9a-f]{40}$/;
/**
 * A failure that says a source couldn't be fetched (not the target refusing the instance): the compiler's own network errors, each
 * matched by the phrase git/npm/node print, never by a bare `SSL`/`TLS` token — a target's *refusal* can legitimately name TLS
 * (a setting the new product dropped reads "kernel TLS module … is gone"), and reading that as operational would retry the tip
 * for ever instead of refusing it.
 */
const NETWORK = /(could not resolve host|unable to access ['"]|failed to connect|connection (timed out|refused|reset)|operation timed out|could not read from remote repository|the remote end hung up|network is unreachable|\b(ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|EHOSTUNREACH|ERR_TLS_[A-Z_]+|UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT|CERT_HAS_EXPIRED)\b|ssl certificate problem|(ssl|tls)[^.\n]{0,40}handshake|certificate verify failed|self[- ]signed certificate|unable to (get|verify) (the )?(local )?issuer)/i;
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
export type RunInput = { productDir: string; instanceDir: string; repo: string; env: NodeJS.ProcessEnv; until?: number };
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
  /**
   * npm's package cache (default: the host's own, under its HOME). Never the vault or the host home itself: it is read for the
   * tarballs the last real apply downloaded, so an offline host can still check a target the apply could install.
   */
  cache?: string;
  /** The staged compile in the extracted product tree (default: install, then the target's own compiler). */
  run?: (o: RunInput) => Promise<Verdict>;
  log?: (msg: string, f?: Record<string, unknown>) => void;
};

/** The process env a staged compile keeps: a shell's own basics, never a credential. */
const BASE_ENV = new Set(["PATH", "LANG", "LC_ALL", "TMPDIR", "USER", "SHELL", "TERM", "NODE_PATH", "NODE_OPTIONS", "NODE_VERSION"]);

/** The host `.env` names the staged compile reads (scripts/compiler/inputs.ts hostEnv, scripts/compile.ts's env() calls). */
const ENV_KEYS = new Set(["AIDENHQ_INSTANCE_REPO", "TRANSCRIPTS_DIR",
  "AIDENHQ_PUBLIC_IP", "AIDENHQ_ADMIN_URL", "BOARD_LAN_URL", "AIDENHQ_EXPOSURE", "AIDENHQ_GITHUB_AGENTS_ORG",
  "VAULT_DIR", "VAULT_FOLDERS", "KNOWLEDGE_BASES"]);

/**
 * The host's `.env`, filtered to ENV_KEYS. A host `.env` holds tokens and channel secrets beside the paths the compile reads
 * (AIDENHQ_PRODUCT_REPO's sibling keys, `paperclip_board_key`, model keys); only the names above are carried, so a target's
 * compiler — a commit nobody has applied — never sees the rest. Blanked, not copied: nothing is written into the target tree.
 * `AIDENHQ_DIR`/`AIDENHQ_STATE_DIR`/`AIDENHQ_SOURCES_DIR` are deliberately absent: the compiler reads none of them as an input, and
 * each hands the target a host path — the checkout whose `.env` holds what this filter just dropped, or the source cache it could
 * write into. The source cache follows `HOME`, which is this check's temp dir, so a fetch lands there and nowhere else.
 */
export function dotenvOf(repo: string, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  let text = "";
  try { text = readFileSync(join(repo, ".env"), "utf8"); } catch { return out; }
  for (const line of text.split("\n")) {
    const m = /^\s*([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m && ENV_KEYS.has(m[1]!)) out[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
  // The process's own values win, as hostEnv() has them.
  for (const k of ENV_KEYS) if (base[k] !== undefined) out[k] = base[k]!;
  return out;
}

/** Where a target compiler's inputs are cut down to (snapshotInputs): the snapshot dirs, and the host's vault *settings*. */
export type Snapshot = Inputs & { vaultDir: string; transcriptsDir: string; vaultFolders: string; knowledgeBases: string; vaultSet?: boolean };

/**
 * The compile's host inputs, cut down to exactly what it reads. A target is a commit nobody has applied yet, so its compiler is
 * untrusted code running as this user: whatever path it is handed it can open, and handing it the real vault, data dir or config
 * dir would let it read the owner's secrets and live data before an apply is approved. So it gets a private copy of the facts:
 *   - secrets: the retired GitHub App id (a value the compile writes into settings), and placeholder files standing in for
 *     `tailscale_apps_authkey` and `cloudflared_credentials.json`, whose presence and non-emptiness are all the compile checks;
 *   - data: the modules' `data_version` markers, the only files a staged compile reads there;
 *   - config: `runner.yaml`, the one file it reads;
 *   - vault and transcripts: empty folders, which only build compose mount strings (their contents are never read).
 * A read that fails is operational (the caller retries), never a verdict on the target.
 */
function snapshotInputs(i: Inputs, to: string, host: NodeJS.ProcessEnv = process.env, env: Record<string, string> = {}): Snapshot {
  const secretsDir = join(to, "secrets"), dataDir = join(to, "data"), configDir = join(to, "config");
  const vaultDir = join(to, "vault"), transcriptsDir = join(to, "transcripts");
  for (const d of [secretsDir, dataDir, configDir, vaultDir, transcriptsDir]) mkdirSync(d, { recursive: true });
  // The retired app id is the one secret *value* the compile reads (settings.github_migrate_from_app). Only that one.
  const retired = [join(i.secretsDir, "github_retired_app_id"), join(i.secretsDir, "github-app", "app_id")].find((f) => existsSync(f));
  if (retired) copyFileSync(retired, join(secretsDir, "github_retired_app_id"));
  // Presence-only reads: a non-empty file stands for "the host has this", an absent one for "it does not". No real bytes.
  for (const n of ["tailscale_apps_authkey", "cloudflared_credentials.json"]) {
    const f = join(i.secretsDir, n);
    if (existsSync(f) && statSync(f).isFile() && statSync(f).size > 0) writeFileSync(join(secretsDir, n), "present\n", { mode: 0o600 });
  }
  // data_version markers: the staged compile's only data read (checkDataVersion, spec §6.4.1). Names, not contents, matter.
  try {
    for (const m of readdirSync(join(i.dataDir, "modules"))) {
      const marker = join(i.dataDir, "modules", m, ".data_version");
      if (!existsSync(marker)) continue;
      mkdirSync(join(dataDir, "modules", m), { recursive: true });
      copyFileSync(marker, join(dataDir, "modules", m, ".data_version"));
    }
  } catch { /* no data modules on this host: nothing to reproduce */ }
  if (existsSync(join(i.dataDir, "bundle-state.json"))) copyFileSync(join(i.dataDir, "bundle-state.json"), join(dataDir, "bundle-state.json"));
  if (existsSync(join(i.configDir, "runner.yaml"))) copyFileSync(join(i.configDir, "runner.yaml"), join(configDir, "runner.yaml"));
  // VAULT_FOLDERS and KNOWLEDGE_BASES are not paths the compile opens: they are *settings* hostMounts() validates and turns
  // into compose mount strings. Handing them over verbatim keeps those refusals ("invalid vault folder", "invalid
  // KNOWLEDGE_BASES entry") and the staged compose identical, while the folders they name stay outside the snapshot tree.
  // From the host's `.env` first, its process env second: a systemd-run kernel does not export `.env` into its environment, and
  // these two must be the apply's, or its `hostMounts()` refusals never fire here.
  const setting = (k: string) => env[k] ?? host[k] ?? "";
  return { configDir, dataDir, secretsDir, vaultDir, transcriptsDir,
    vaultFolders: String(setting("VAULT_FOLDERS")), knowledgeBases: String(setting("KNOWLEDGE_BASES")),
    // VAULT_DIR is validated whenever VAULT_FOLDERS is set (`must be an absolute path without ':'`), and its value becomes a
    // compose mount source; handing the snapshot dir keeps the staged compose ours while the validation still runs.
    vaultSet: String(setting("VAULT_DIR")) !== "" };
}

/**
 * The previous product's default bundle, as the apply derives it (ops/apply-config-work.sh:145): `git show <before>:modules/
 * marketplace.json`'s `bundle`, `before` being the product this host applied last (data/applied-product, else HEAD). compile()
 * uses it to tell a module the target *gained* from one already seen (scripts/modules.ts); without it the preflight treats the
 * target's own bundle as already seen and can pass a bump the apply then refuses. `undefined` when there is nothing to read,
 * as the apply's own fallback leaves it.
 */
async function oldBundleOf(repo: string, until: number): Promise<string | undefined> {
  let before = "";
  try { before = readFileSync(join(repo, "data", "applied-product"), "utf8").trim(); } catch { /* no marker yet: the checkout's HEAD */ }
  try {
    const sha = (await git(repo, ["rev-parse", "--verify", "--quiet", before || "HEAD"], until)).toString().trim();
    const b = (JSON.parse((await git(repo, ["show", `${sha}:modules/marketplace.json`], until)).toString()) as { bundle?: unknown }).bundle;
    return b === undefined ? undefined : JSON.stringify(b);
  } catch { return undefined; }
}

/**
 * The env the apply's staged compile runs with (ops/apply-config-work.sh: `AIDENHQ_COMPILE_STAGE=1 node scripts/compile.ts`):
 * the staged mode, the instance tree to compile, and the snapshot inputs above. The compiler's outputs go to
 * `<productDir>/config.next` and `<productDir>/compose.modules.next.yaml`, inside the extracted target tree, never the host's.
 *
 * Only what the compile reads is carried over: the process env is filtered to PATH/locale/temp helpers plus the host `.env`'s
 * ENV_KEYS, and the kernel's own keys, tokens and unrelated secrets never pass (`base` is a test seam; production passes
 * `process.env`). `HOME` is the check's own temp dir, never the host's, so `~/.config/aidenhq`'s keys are unreachable too.
 */
export const stagedEnv = (productDir: string, instanceDir: string, i: Snapshot, dotenv: Record<string, string> = {}, home?: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(Object.entries(base).filter(([k]) => BASE_ENV.has(k))), ...dotenv,
  ...(home ? { HOME: home } : {}), AIDENHQ_COMPILE_STAGE: "1", AIDENHQ_INSTANCE_DIR: instanceDir,
  AIDENHQ_CONFIG_DIR: i.configDir, AIDENHQ_DATA_DIR: i.dataDir, AIDENHQ_SECRETS_DIR: i.secretsDir,
  // VAULT_DIR is the snapshot dir only when the host has one: empty, it reproduces hostMounts' "VAULT_DIR must be an absolute
  // path without ':'" refusal exactly as the apply would make it, and non-empty it is a path inside this check's temp tree.
  VAULT_DIR: i.vaultSet === false ? "" : i.vaultDir,
  VAULT_FOLDERS: i.vaultFolders, KNOWLEDGE_BASES: i.knowledgeBases, TRANSCRIPTS_DIR: i.transcriptsDir,
});
/**
 * The env a target tree's `npm ci` runs with. It runs the target's own lifecycle scripts before anything is checked, so it gets
 * the least there is: a PATH, a HOME (npm's cache), a locale and a temp dir — no host checkout, state, transcripts, vault or
 * config path, and none of the kernel's keys. `HOME` stays the host's so npm's cache is the warm one the apply's own install
 * uses (an empty cache would turn a cached offline install into a network failure, which the check must not read as a verdict).
 */
const INSTALL_ENV = ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR"];
/** `npm_config_cache`: where npm keeps the tarballs it has already downloaded. */
export const installEnv = (base: NodeJS.ProcessEnv = process.env, cache?: string): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(Object.entries(base).filter(([k]) => INSTALL_ENV.includes(k))),
  ...(cache ? { npm_config_cache: cache } : {}),
});

/** The apply's first message line from a failed compile: from `compile: …` (or a thrown error's line) on, the first line. */
export function firstDiagnostic(stderr: unknown): string {
  const lines = String(stderr ?? "").split("\n").map((l) => l.replace(/\r$/, ""));
  const at = lines.findIndex((l) => /^(compile:|[A-Za-z]*Error\b)/.test(l));
  const first = (at >= 0 ? lines[at]! : lines.find((l) => l.trim()) ?? "").trim();
  return first.slice(0, 300);
}

/** The most `until` leaves for this step, at most `cap`: every child is bounded by both, so one slow step can't outrun the check. */
function left(until: number, cap: number) {
  const ms = Math.min(cap, until - Date.now());
  if (ms <= 0) throw new Error("the compile check ran out of time");
  return ms;
}

/** `git` in the product checkout, asynchronously (a slow fetch must not stall the kernel's event loop). */
function git(repo: string, args: string[], until = Number.POSITIVE_INFINITY): Promise<Buffer> {
  return new Promise<Buffer>((ok, no) => {
    execFile("git", ["-C", repo, ...args], { timeout: left(until, 120_000), maxBuffer: 256 * 1024 * 1024, encoding: "buffer" }, (e, out, err) => {
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
async function stageProduct(repo: string, sha: string, to: string, until: number) {
  // The host's checkout has `origin`; a bare repo a test made may not. A failed fetch of a remote that is there is
  // operational (a network the train retries), never a verdict on the target.
  const remotes = (await git(repo, ["remote"], until)).toString().split("\n").map((l) => l.trim());
  if (remotes.includes("origin")) await git(repo, ["fetch", "--quiet", "origin", "main"], until);
  await git(repo, ["cat-file", "-e", `${sha}^{commit}`], until);
  // Nothing unmerged runs (ops/apply-config-work.sh: the pin must be on product main). Compare against the fetched main when
  // there is one, else the local main the checkout has.
  let mainRef: string | undefined;
  for (const r of ["refs/remotes/origin/main", "refs/heads/main"]) {
    try { await git(repo, ["rev-parse", "--verify", "--quiet", `${r}^{commit}`], until); mainRef = r; break; } catch {}
  }
  if (mainRef) {
    try { await git(repo, ["merge-base", "--is-ancestor", sha, mainRef], until); }
    catch { throw new Error(`the target product ${sha.slice(0, 12)} isn't on the product's main`); }
  }
  await extract(repo, sha, to, until);
}

/**
 * `sha`'s tree into `to`, as a real git checkout at that commit — not a bare extraction. The compiler reads the product's own
 * history (`scripts/compiler/inputs.ts` takes `git rev-parse HEAD` as its `revision`, `officialAt` runs `git cat-file`/`git show`
 * against it), so a tree with no `.git` would compile different inputs than the apply's checkout. A shared clone keeps the
 * objects where they are (the host checkout stays read-only) and `checkout --detach` puts HEAD exactly on the target.
 */
async function extract(repo: string, sha: string, to: string, until: number) {
  await git(repo, ["clone", "-q", "--no-checkout", "--shared", "--", repo, to], until);
  await git(to, ["checkout", "-q", "--detach", sha], until);
}

/**
 * The one host input the compile reads from the tree it runs in: the bundle this host last compiled. The host's `.env` is
 * deliberately *not* copied here — its values arrive filtered, in the env (dotenvOf/stagedEnv), so a target's compiler never
 * receives a token or a channel secret that lives beside the paths in it.
 */
function seedInputs(repo: string, productDir: string) {
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
async function installCompiler(o: RunInput, cache?: string) {
  for (const d of ["scripts", "kernel"]) {
    const lock = join(o.productDir, d, "package-lock.json");
    const running = join(o.repo, d, "package-lock.json");
    const modules = join(o.repo, d, "node_modules");
    if (existsSync(lock) && existsSync(running) && existsSync(modules) && readFileSync(lock).equals(readFileSync(running))) {
      symlinkSync(modules, join(o.productDir, d, "node_modules"), "dir");
      continue;
    }
    // Installs run the target's own lifecycle scripts: they get installEnv() — no path to the host's checkout, config, data or
    // vault — unlike the compiler below, which the apply's own staged compile reads those with. `npm_config_cache` is the package
    // *cache* only (a directory of tarballs keyed by integrity hash, never the host home or the vault), so the apply's warm cache
    // serves here too: an offline host reuses what the last real apply already downloaded instead of failing the check.
    const installed = await run("npm", ["ci", "--prefix", d, "--silent"], o.productDir, installEnv(o.env, cache), left(o.until ?? Number.POSITIVE_INFINITY, 240_000));
    if (!installed.ok) throw new Error(`the target product's ${d} deps didn't install: ${firstDiagnostic(installed.stderr) || "npm ci failed"}`);
  }
}

/** The default `run`: the target tree's compiler deps, then its own compiler, staged — as the apply does both. */
async function stagedCompile(o: RunInput, install: (o: RunInput) => Promise<void>, cache?: string): Promise<Verdict> {
  // The deps install first, before the host's .env is in the tree: a target's lifecycle scripts shouldn't find it. The compiler
  // needs it exactly as the apply's checkout has it, so it is seeded after.
  await install(o);
  seedInputs(o.repo, o.productDir);
  const compiled = await run(process.execPath, [COMPILER], o.productDir, o.env, left(o.until ?? Number.POSITIVE_INFINITY, 240_000));
  if (compiled.ok) return { ok: true };
  // A compiler that never finished (a timeout, a killed child) is operational: the caller retries, never records a refusal the
  // compiler didn't make. Only a real non-zero exit is the target refusing the instance.
  if (!compiled.ran) throw new Error(`the staged compile didn't finish: ${compiled.error ?? "killed"}${compiled.stderr.trim() ? `: ${firstDiagnostic(compiled.stderr)}` : ""}`);
  // The compiler fetches third-party modules and releases while it runs. A fetch that failed for the network's sake is
  // operational: the apply would be retried, and the same target can pass once the network does, so the tip is not dropped.
  if (NETWORK.test(compiled.stderr)) throw new Error(`the staged compile couldn't reach a source it needs: ${firstDiagnostic(compiled.stderr)}`);
  return { ok: false, error: firstDiagnostic(compiled.stderr) || "the staged compile failed with no error text" };
}

/**
 * The kernel tree the apply runs for an instance: its `product_fork:` when that descends from the pin (`kernelRun`,
 * ops/apply-config-work.sh), else the pin itself. The fork is fetched by sha from its url when this checkout lacks it, as the
 * apply fetches it. A fork that doesn't descend from the target is what the apply refuses, so it is operational here (the train
 * retries; the pin has not moved to a target the fork covers), never a compile verdict on the target.
 */
async function kernelTree(repo: string, product: string, instanceDir: string, until: number): Promise<string> {
  let fork: { sha?: unknown; url?: unknown; source?: unknown; repo?: unknown } | undefined;
  try { fork = (YAML.parse(readFileSync(join(instanceDir, "instance.yaml"), "utf8")) ?? {}).product_fork; } catch { return product; }
  if (fork == null) return product;
  const sha = String(fork.sha ?? "");
  if (!SHA.test(sha)) throw new Error("instance.yaml product_fork: a fork needs a 40-character sha");
  const url = fork.source === "github" ? `https://github.com/${String(fork.repo ?? "")}.git` : String(fork.url ?? "");
  const present = async (c: string) => { try { await git(repo, ["cat-file", "-e", `${c}^{commit}`], until); return true; } catch { return false; } };
  if (!(await present(sha))) {
    if (!url) throw new Error(`couldn't fetch product_fork ${sha.slice(0, 12)}: no url or github repo`);
    try { await git(repo, ["-c", "credential.helper=", "-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "fetch", "--quiet", "--no-tags", "--no-recurse-submodules", "--", url, sha], until); }
    catch (e) { throw new Error(`couldn't fetch product_fork ${sha.slice(0, 12)} from ${url}: ${(e as Error).message.slice(0, 200)}`); }
  }
  try { await git(repo, ["merge-base", "--is-ancestor", product, sha], until); }
  catch { throw new Error(`product_fork ${sha.slice(0, 12)} does not descend from product ${product.slice(0, 12)}`); }
  return sha;
}

/** The whole check's own bound: a target that changes both lockfiles installs two dep trees, then compiles. */
export const CHECK_DEADLINE_MS = 540_000;

/** The compile preflight: `POST /v1/compile/check {product, instance?}` -> `{ok, base}`, or `{ok: false, error, base}`. */
export function createCompileCheck(d: CompileDeps) {
  const log = d.log ?? (() => {});
  return async function compileCheck(body: { product?: unknown; instance?: unknown; pin?: unknown }): Promise<CompileCheck> {
    const product = String(body?.product ?? "");
    if (!SHA.test(product)) throw new Error(`product ${JSON.stringify(product.slice(0, 60))} isn't a 40-character commit`);
    // The pin the bump would write. It is what the *real* apply compiles, so the staged instance must carry it: a module fork is
    // validated against `instance.product` (scripts/compiler/sources.ts forkBase), and compiling the old pin would validate a
    // fork against a base the apply never uses — passing a bump the apply then refuses. Defaults to `product`.
    const pin = body?.pin === undefined ? product : String(body.pin);
    if (!SHA.test(pin)) throw new Error(`pin ${JSON.stringify(String(body?.pin).slice(0, 60))} isn't a 40-character commit`);
    if (body?.instance !== undefined && !SHA.test(String(body.instance))) throw new Error(`instance ${JSON.stringify(String(body.instance).slice(0, 60))} isn't a 40-character commit`);
    // The instance as the bump would build on it: its main, read here, returned so the caller commits on this same revision.
    const base = body?.instance === undefined ? (await d.main()).base : String(body.instance);
    const dir = mkdtempSync(join(tmpdir(), "aidenhq-preflight-"));
    let productDir = join(dir, "product");
    const instanceDir = join(dir, "instance");
    const t0 = Date.now();
    const until = t0 + CHECK_DEADLINE_MS;
    try {
      // The product first, so a target this checkout doesn't have costs no instance read.
      await stageProduct(d.repo, product, productDir, until);
      await d.tree(base, instanceDir);
      // The one edit the bump makes, applied to the tree that is compiled: `product:` becomes the pin. Nothing else in the
      // instance changes, so the verdict is about exactly the revision and pin the apply would run. Always rewritten — the
      // instance's own pin is the old one even when `pin` is `product`.
      {
        const file = join(instanceDir, "instance.yaml");
        const text = readFileSync(file, "utf8");
        const lines = text.split("\n");
        const hits = lines.flatMap((l, n) => (/^product:[ \t]*["']?[0-9a-f]{40}["']?/.test(l) ? [n] : []));
        if (hits.length !== 1) throw new Error(`the instance's instance.yaml has ${hits.length} \`product:\` lines, not one, so it can't be pinned to ${pin.slice(0, 12)}`);
        lines[hits[0]!] = lines[hits[0]!]!.replace(/[0-9a-f]{40}/, pin);
        writeFileSync(file, lines.join("\n"));
      }
      // The tree the apply actually runs: the instance's fork when it descends from the target, in its own folder. Compiling the
      // pin while the apply runs the fork would check different inputs.
      // `pin`, not `product`: the apply resolves the fork against the pin the instance.yaml carries (apply-config-work.sh
      // kernelRun "$inst/instance.yaml" "$product"), and the tree compiled here carries `pin`.
      const kernelSha = await kernelTree(d.repo, pin, instanceDir, until);
      if (kernelSha !== pin) {
        productDir = join(dir, "kernel-fork");
        await extract(d.repo, kernelSha, productDir, until);
      }
      // The compile gets a private copy of the host facts it reads, never the host's own vault, data or config dirs: a target is
      // an unapplied commit, so whatever path it is handed it can open.
      const snap = snapshotInputs(d.inputs, join(dir, "inputs"), process.env, dotenvOf(d.repo));
      const env = stagedEnv(productDir, instanceDir, snap, dotenvOf(d.repo), join(dir, "home"));
      // The one env input that is not a path: the previous product's bundle (the apply's AIDENHQ_OLD_BUNDLE, :145).
      const old = await oldBundleOf(d.repo, until);
      if (old !== undefined) env.AIDENHQ_OLD_BUNDLE = old;
      mkdirSync(join(dir, "home"), { recursive: true });
      const o = { productDir, instanceDir, repo: d.repo, env, until };
      const r = d.run ? await d.run(o) : await stagedCompile(o, d.install ?? ((x) => installCompiler(x, d.cache)), d.cache);
      log("compile check", { product, instance: base, ok: r.ok, ms: Date.now() - t0 });
      return { ...r, base };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}
