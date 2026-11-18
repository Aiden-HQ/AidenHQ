// The check jobs' computers (checkjobs.ts CheckBox) and the code host's snapshots (checkjobs.ts Snapshot), as main.ts wires them.
//
// A check box comes from the computer launcher's /check route (launcher_kernel_key): a fresh gVisor box per run with only the
// check's snapshot (read-only for the eval), its out folder and the product's supply-chain checks mounted, and no credential
// of any kind but the eval's `check` model token, which the launcher's gateway knows by its hash. The kernel runs the command
// there itself (`docker exec`, the env through a 0600 file, never argv) and always ends the box (/job/release).
//
// A snapshot comes through the kernel's codehost broker (codehost.ts: codehost-github's /ops/snapshot, `git archive`, no .git
// and no credentials), under the `codehost:` snapshot grant of the module that asked for the check, so a module checks only
// what its own grant may read. The commit it answers with must be the one asked for.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { BOX_WORKSPACE, createChecks, type CheckBox, type Snapshot } from "./checkjobs.ts";
import { mintToken } from "./gateway/token.ts";
import type { IncomingMessage } from "node:http";

type Call = (route: string, body: Record<string, unknown>) => Promise<Record<string, unknown>>;
const KEEP = 64 * 1024; // the output's tail the kernel keeps

/** `docker` with these args; its exit, its output's tail, whether it ran out of time (killed). */
export function dockerRun(args: string[], timeoutMs: number): Promise<{ exit: number | null; out: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const c = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", timedOut = false;
    const keep = (d: Buffer) => { out = (out + d.toString("utf8")).slice(-KEEP); };
    c.stdout.on("data", keep);
    c.stderr.on("data", keep);
    const t = setTimeout(() => { timedOut = true; c.kill("SIGKILL"); }, timeoutMs);
    c.on("error", (e) => { clearTimeout(t); resolve({ exit: null, out: `docker didn't start: ${e.message}`, timedOut: false }); });
    c.on("close", (code) => { clearTimeout(t); resolve({ exit: timedOut ? null : code, out, timedOut }); });
  });
}

export function checkBoxes({ call, docker = dockerRun }: { call: Call; docker?: typeof dockerRun }): CheckBox {
  return {
    async run({ check, image, workspace, out, cwd, argv, env, timeoutMs, readOnly }) {
      // The eval's model token is its only credential: the launcher's gateway passes calls on for this box's token alone.
      const token = env.OPENROUTER_API_KEY || undefined;
      const { container } = (await call("/check", { check, image, workspace, out, readOnly: readOnly === true, timeoutMs, ...(token ? { token } : {}) })) as { container: string };
      const dir = mkdtempSync(join(tmpdir(), "aidenhq-check-"));
      try {
        const file = join(dir, "env");
        writeFileSync(file, Object.entries(env).map(([k, v]) => `${k}=${String(v).replace(/[\r\n]/g, " ")}`).join("\n") + "\n", { mode: 0o600 });
        return await docker(["exec", "--env-file", file, "-w", posix.join(BOX_WORKSPACE, cwd), container, ...argv], timeoutMs);
      } finally {
        rmSync(dir, { recursive: true, force: true });
        await call("/job/release", { container });
      }
    },
  };
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
type Ask = (module: string, op: string, body: Record<string, unknown>) => Promise<IncomingMessage>;

/** The kernel's check jobs (checkjobs.ts) on these: the launcher's check boxes, the snapshot provider, `check` model tokens. */
export function checkJobsFrom({ db, secret, ask, call, workDir, gatewayUrl, log, docker }: {
  db: DatabaseSync; secret: (name: string) => string;
  /** The kernel's codehost broker (codehost.ts ask): snapshots under the asking module's grant. */
  ask: Ask; call: Call; workDir: string;
  /** The model gateway's API base as a box reaches it (the launcher's gateway, `…/api/v1`). */
  gatewayUrl: string;
  log: (msg: string, f?: Record<string, unknown>) => void;
  /** Tests: how a command runs in a box. */
  docker?: typeof dockerRun;
}) {
  return createChecks({
    db, log, workDir, gatewayUrl, box: checkBoxes({ call, ...(docker ? { docker } : {}) }),
    secret: () => secret("receipt_secret"),
    snapshot: snapshots(ask),
    modelToken: (head) => mintToken(secret("gateway_job_secret"), { kind: "check", component: `eval:${head}`, ttlMs: 3 * 3600_000 }),
  });
}
