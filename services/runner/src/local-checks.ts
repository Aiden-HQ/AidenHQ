// A local change request's named checks (docs/design/codehost-local.md §5), the counterparts of the CI template's `secrets`
// and `tests` jobs, run on the runner's host in the job jail at exactly the change's head. They are the only gate a local
// merge has besides the reviewer, so nothing the change's code does can reach the secret scan's verdict:
// - the scan runs first, in a clone of its own, with its config outside every folder repo code can write and git's object
//   rewriting (replace refs, grafts) off; only then do the tests run, in another clone;
// - the check scripts are this host's product checkout's and the scan's config is the base commit's, never the change's;
// - every process a check started is killed when it ends (its whole process group), so none outlives it.
import { execFile, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { hiding, type SandboxConfig } from "../../../kernel/src/sandbox.ts";

const run = promisify(execFile);
export const CHECK_LIMIT_MS = 20 * 60_000;
const SCAN_LIMIT_MS = 10 * 60_000;
// Host git on the runner's own clones: no hooks, no repository config that runs anything, no rewritten objects.
const SAFE = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=", "-c", "protocol.ext.allow=never"];
const GIT_ENV = { PATH: process.env.PATH ?? "/usr/bin:/bin", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_GRAFT_FILE: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
const git = (args: string[]) => run("git", [...SAFE, ...args], { env: GIT_ENV, maxBuffer: 32 * 1024 * 1024 }).then((o) => o.stdout);

export type CheckResult = { ok: boolean; tail: string };

/**
 * Runs `argv` in the job jail with `rw` the only writable paths, a minimal env and no tokens. When it ends (or its time is
 * up) its whole process group is killed, so nothing it started in the background outlives it.
 */
export function jailRun(sandbox: SandboxConfig, cwd: string, argv: string[], { env = {}, rw = [cwd], ms = CHECK_LIMIT_MS }: { env?: Record<string, string>; rw?: string[]; ms?: number } = {}): Promise<CheckResult> {
  const [cmd, ...args] = hiding(sandbox, argv, [], { rw });
  return new Promise((done) => {
    let out = "";
    let settled = false;
    const child = spawn(cmd!, args, { cwd, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", CI: "1", ...env }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const reap = () => { try { process.kill(-child.pid!, "SIGKILL"); } catch {} };
    const finish = (r: CheckResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reap();
      done({ ok: r.ok, tail: r.tail.slice(-4000) });
    };
    const keep = (b: Buffer) => void (out = (out + b.toString("utf8")).slice(-16_000));
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const timer = setTimeout(() => finish({ ok: false, tail: `${out}\n(stopped: over ${Math.round(ms / 60_000)} minutes)` }), ms);
    child.on("error", (err) => finish({ ok: false, tail: String(err.message) }));
    // `exit`, not `close`: a background process holding the pipes open must not keep the check (or itself) alive.
    child.on("exit", (code) => finish({ ok: code === 0, tail: out }));
  });
}

/** A fresh clone of the bare repo (no shared objects: --no-hardlinks) holding the change's head. */
async function cloneAt(bare: string, n: number, dir: string, checkout: boolean) {
  await git(["clone", "--quiet", "--no-hardlinks", "--no-checkout", bare, dir]);
  await git(["-C", dir, "fetch", "--quiet", "origin", `+refs/changes/${n}/head:refs/aidenhq/change`]);
  if (checkout) await git(["-C", dir, "-c", "advice.detachedHead=false", "checkout", "--quiet", "--detach", "refs/aidenhq/change"]);
}

/**
 * The checks of change `n` of the bare repo at `head` against `base`: `secrets` first (pinned gitleaks over base..head, with
 * the base's .gitleaks.toml), then `tests` (supply chain with this host's scripts, the evidence rule, npm ci, lint, test,
 * build). `root`: a folder of the runner's own (removed after).
 */
export async function localCheckRuns({ sandbox, bare, n, base, head, root, gitleaks, repoRoot }: { sandbox: SandboxConfig; bare: string; n: number; base: string; head: string; root: string; gitleaks: string; repoRoot: string }): Promise<{ secrets: CheckResult; tests: CheckResult }> {
  mkdirSync(root, { recursive: true });
  const work = mkdtempSync(join(root, "check-"));
  try {
    // The scan: its own clone and its config beside it, outside the tests' folder, before any of the change's code runs.
    const scanDir = join(work, "scan");
    await cloneAt(bare, n, scanDir, false);
    const config = join(work, "gitleaks.toml");
    writeFileSync(config, await git(["--git-dir", bare, "show", `${base}:.gitleaks.toml`]).catch(() => "[extend]\nuseDefault = true\n"), { mode: 0o444 });
    const secrets = await jailRun(sandbox, scanDir, [gitleaks, "git", "--redact", "--exit-code", "1", "--config", config, "--log-opts", `${base}..${head}`, "."], { env: GIT_ENV, rw: [], ms: SCAN_LIMIT_MS });

    const testsDir = join(work, "tests");
    await cloneAt(bare, n, testsDir, true);
    const sc = join(repoRoot, "scripts/supply-chain");
    const script = [
      "status=0",
      `node ${JSON.stringify(join(sc, "npm-age.mjs"))} "$BASE" "$HEAD" || status=1`,
      `node ${JSON.stringify(join(sc, "pins.mjs"))} "$BASE" "$HEAD" || status=1`,
      '[ $status = 0 ] || { echo "supply chain: failed"; exit 1; }',
      // The evidence rule (the CI template's): .aidenhq/out/ takes screenshots and reports only, and no app code reads it.
      `bad=$(git diff --name-only --diff-filter=AMR "$BASE...$HEAD" -- .aidenhq/out | grep -viE '\\.(png|jpe?g|webp|gif|json|txt)$' || true)`,
      '[ -z "$bad" ] || { echo ".aidenhq/out/ takes only screenshots and reports: $bad"; exit 1; }',
      `refs=$(git grep -l -F '.aidenhq/out' "$HEAD" -- . ':(exclude).aidenhq/**' ':(exclude).github/**' ':(exclude,glob)**/*.md' ':(exclude)e2e/**' ':(exclude,glob)playwright.config.*' ':(exclude).gitignore' ':(exclude).dockerignore' | sed "s/^$HEAD://" || true)`,
      '[ -z "$refs" ] || { echo "app code may not read an agent\'s evidence in .aidenhq/out/: $refs"; exit 1; }',
      "npm ci && npm run --if-present lint && npm test && npm run --if-present build",
    ].join("\n");
    const home = join(testsDir, ".aidenhq-home");
    const tests = await jailRun(sandbox, testsDir, ["bash", "-c", script], { env: { BASE: base, HEAD: head, HOME: home, npm_config_cache: join(home, ".npm"), npm_config_audit: "false", npm_config_fund: "false", npm_config_update_notifier: "false" } });
    return { secrets, tests };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
