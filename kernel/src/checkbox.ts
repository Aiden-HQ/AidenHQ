// The check jobs' computers (checkjobs.ts CheckBox) and the code host's snapshots (checkjobs.ts Snapshot), as main.ts wires them.
//
// A check box comes from the computer launcher's /check route (launcher_kernel_key): a fresh gVisor box per run with only the
// check's snapshot (read-only for the eval), its out folder and the product's supply-chain checks mounted, and no credential
// of any kind but a `check` model token (the eval's, or a model recipe's own capped one), which the launcher's gateway knows by its hash. The kernel runs the command
// there itself (`docker exec`, the env through a 0600 file, never argv) as a detached run (jobs.ts spawnDetached: a restart
// leaves it running, and the next kernel follows it from its pid, log and exit file), and the kernel that sees its end ends
// the box (/job/release). The box's lease is its time limit (launcher /check), so no kernel needs to renew it.
//
// A snapshot comes through the kernel's codehost broker (codehost.ts: codehost-github's /ops/snapshot, `git archive`, no .git
// and no credentials), under the `codehost:` snapshot grant of the module that asked for the check, so a module checks only
// what its own grant may read. The commit it answers with must be the one asked for.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { posix } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Answer } from "./codehost.ts";
import { BOX_WORKSPACE, createChecks, type BoxOut, type BoxRun, type CheckBox, type Recipes, type Snapshot } from "./checkjobs.ts";
import { mintToken } from "./gateway/token.ts";
import type { Pool } from "./pool.ts";
import { alive, exitStatus, logTail, runAlive, spawnDetached } from "./jobs.ts";

type Call = (route: string, body: Record<string, unknown>) => Promise<Record<string, unknown>>;
const KEEP = 64 * 1024; // the output's tail the kernel keeps

/** How a check's `docker exec` starts: detached (jobs.ts spawnDetached), so the next kernel follows it after a restart. */
type Spawn = (argv: string[], logPath: string) => number;

/** How long a check waits for a free computer (the launcher answers 503 when every one is busy) before it can't run. */
const BUSY_WAIT_MS = 60 * 60_000;
const BUSY_RETRY_MS = 30_000;
const POLL_MS = 1_000;

export function checkBoxes({ call, spawnRun = spawnDetached, sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)), pollMs = POLL_MS, pool }: { call: Call; spawnRun?: Spawn; sleep?: (ms: number) => Promise<void>; pollMs?: number; pool?: Pool }): CheckBox {
  // The boxes this kernel's checks hold in the pool's check computers, from their slot until their release.
  const holding = new Set<string>();
  const release = (container: string) => { if (holding.delete(container)) pool?.freeCheck(); return call("/job/release", { container }).then(() => {}, () => {}); };
  return {
    // The check computers (pool.ts): with every one taken, a check waits for its slot here, queued, never failed.
    async launch(o) {
      o.waiting?.(true);
      let boxed = false;
      try {
        await pool?.takeCheck();
        return await start(o, (container) => { boxed = true; holding.add(container); });
      } catch (e) {
        if (!boxed) pool?.freeCheck();
        throw e;
      } finally {
        o.waiting?.(false);
      }
    },
    async follow(run, signal) {
      // A run an earlier kernel launched holds a box this kernel never counted: it counts from here to its release.
      if (pool && !holding.has(run.container)) { holding.add(run.container); pool.adopt(); }
      return await following(run, signal);
    },
  };
  async function start({ check, image, workspace, cwd, argv, env: given, timeoutMs, readOnly, out, mint }: Parameters<CheckBox["launch"]>[0], boxed: (container: string) => void): Promise<BoxRun> {
    {
      // The eval's model token is its only credential: the launcher's gateway passes calls on for this box's token alone. It is
      // minted here, once the slot is held (`mint`), so its lifetime never counts the wait in the pool or for a free computer.
      let env = given, token = env.OPENROUTER_API_KEY || undefined;
      // Every computer busy (agent jobs hold them) is a wait, not a check that can't run: a merge gate gives up after a few of those.
      let box: { container: string } | undefined;
      for (let waited = 0; !box; waited += BUSY_RETRY_MS) {
        try {
          if (mint) env = { ...given, OPENROUTER_API_KEY: (token = mint()) };
          box = (await call("/check", { check, image, workspace, out, readOnly: readOnly === true, timeoutMs, ...(token ? { token } : {}) })) as { container: string };
        } catch (e) {
          if ((e as { status?: number }).status !== 503 || waited >= BUSY_WAIT_MS) throw e;
          await sleep(BUSY_RETRY_MS);
        }
      }
      const { container } = box;
      const at = Date.now();
      boxed(container);
      // The env file, the log and its exit status sit beside the out folder, in the attempt's own folder: the kernel's, never
      // mounted in the box. The env file stays until the attempt's folder goes (docker reads it as the run starts).
      const envFile = `${out}.env`, log = `${out}.log`;
      try {
        writeFileSync(envFile, Object.entries(env).map(([k, v]) => `${k}=${String(v).replace(/[\r\n]/g, " ")}`).join("\n") + "\n", { mode: 0o600 });
        const pid = spawnRun(["docker", "exec", "--env-file", envFile, "-w", posix.join(BOX_WORKSPACE, cwd), container, ...argv], log);
        return { container, pid, log, deadline: Date.now() + timeoutMs, at };
      } catch (e) {
        await release(container);
        throw e;
      }
    }
  }
  async function following({ container, pid, log, deadline }: BoxRun, signal: AbortSignal): Promise<BoxOut | "gone" | "detached"> {
    {
      // The run is still that run (a reused pid isn't), checked once; then only whether its pid lives (no `ps` each poll).
      let running = (p: number) => runAlive(p, log);
      for (;;) {
        // An exit status is the run's end, whoever started it; then the box goes.
        const status = exitStatus(`${log}.exit`);
        if (status !== "") return (await release(container), { exit: Number(status), out: logTail(log, KEEP), timedOut: false });
        // Neither ended nor running (a host reboot, killed by hand): gone. A run that wrote its status just now is read next time.
        if (!running(pid)) {
          if (exitStatus(`${log}.exit`) !== "") continue;
          return (await release(container), "gone");
        }
        if (Date.now() > deadline) {
          try { process.kill(-pid, "SIGKILL"); } catch {}
          return (await release(container), { exit: null, out: logTail(log, KEEP), timedOut: true });
        }
        // A draining kernel stops following; the box runs on for the next kernel.
        if (signal.aborted) return "detached";
        running = alive;
        await sleep(pollMs);
      }
    }
  }
}

/** Untar a gzipped tar stream into `into`: no owners or modes from the archive, nothing above `into` (tar's own rules). */
function untar(body: NodeJS.ReadableStream, into: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = spawn("tar", ["-xzf", "-", "-C", into, "--no-same-owner", "--no-same-permissions"], { stdio: ["pipe", "ignore", "pipe"] });
    let err = "";
    t.stderr.on("data", (d) => (err += d));
    t.on("error", reject);
    t.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`the snapshot didn't unpack: ${err.trim().slice(0, 300) || `tar ${code}`}`))));
    t.stdin.on("error", () => {});
    body.on("error", (e: Error) => { t.kill(); reject(e); });
    body.pipe(t.stdin);
  });
}

/** codehost-github's snapshot op through the kernel's broker (codehost.ts), under `module`'s own `codehost:` snapshot grant. */
export function snapshots(ask: Ask): (module: string) => Snapshot {
  return (module) => async (repo, ref, into) => {
    const res = await ask(module, "snapshot", { repo, ref });
    if (res.statusCode !== 200) {
      let text = "";
      for await (const c of res) { text += c; if (text.length > 400) break; }
      throw new Error(`the snapshot of ${repo}@${ref.slice(0, 12)} was refused (${res.statusCode}): ${text.slice(0, 200)}`);
    }
    // The tree must be the commit asked for, or the receipt's head binding would be a name only.
    if (res.headers["x-aidenhq-commit"] !== ref) { res.destroy(); throw new Error(`the snapshot of ${repo} is of ${String(res.headers["x-aidenhq-commit"]).slice(0, 12)}, not ${ref.slice(0, 12)}`); }
    await untar(res, into);
  };
}
type Ask = (module: string, op: string, body: Record<string, unknown>) => Promise<Answer>;

/** The kernel's check jobs (checkjobs.ts) on these: the launcher's check boxes, the snapshot provider, `check` model tokens. */
export function checkJobsFrom({ db, pool, secret, recipes, ask, call, workDir, gatewayUrl, spent, tokens, refused, log, spawnRun, pollMs }: {
  db: DatabaseSync; secret: (name: string) => string;
  /** The computer pool (pool.ts): a check takes one of the check computers before it asks the launcher for a box. */
  pool: Pool;
  /** The installed modules' check recipes (config/kernel/modules.json `check_jobs`). */
  recipes: () => Recipes;
  /** The kernel's codehost broker (codehost.ts ask): snapshots under the asking module's grant. */
  ask: Ask; call: Call; workDir: string;
  /** The model gateway's API base as a box reaches it (the launcher's gateway, `…/api/v1`). */
  gatewayUrl: string;
  /** A model token's spend so far (the gateway's ledger). */
  spent?: (runKey: string) => number;
  /** A model token's tokens so far (the same ledger). */
  tokens?: (runKey: string) => { input: number; cached: number; output: number };
  /** The caps a model token was refused at (the same ledger). */
  refused?: (runKey: string) => string[];
  log: (msg: string, f?: Record<string, unknown>) => void;
  /** Tests: how a box's `docker exec` starts (detached), and how often its follower looks. */
  spawnRun?: Spawn; pollMs?: number;
}) {
  return createChecks({
    db, log, workDir, gatewayUrl, recipes, box: checkBoxes({ call, pool, ...(spawnRun ? { spawnRun } : {}), ...(pollMs ? { pollMs } : {}) }),
    secret: () => secret("receipt_secret"),
    snapshot: snapshots(ask),
    modelToken: (component, { ttlMs }) => mintToken(secret("gateway_job_secret"), { kind: "check", component, ttlMs }),
    ...(spent ? { spent } : {}),
    ...(tokens ? { tokens } : {}),
    ...(refused ? { refused } : {}),
  });
}
