// The check jobs' computers (checkjobs.ts CheckBox) and the code host's snapshots (checkjobs.ts Snapshot), as main.ts wires them.
//
// A check box comes from the computer launcher's /check route (launcher_kernel_key): a fresh gVisor box per run with only the
// check's snapshot (read-only for the eval), its out folder and the product's supply-chain checks mounted, and no credential
// of any kind but the eval's `check` model token, which the launcher's gateway knows by its hash. The kernel runs the command
// there itself (`docker exec`, the env through a 0600 file, never argv) and always ends the box (/job/release).
//
// A snapshot comes from the module that provides one (`providers.snapshot`, codehost-github's /ops/snapshot: `git archive`,
// no .git and no credentials), asked with the token of the module that asked for the check, so a module checks only what its
// own grant may read. The commit it answers with must be the one asked for.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { Readable } from "node:stream";
import type { DatabaseSync } from "node:sqlite";
import { BOX_WORKSPACE, createChecks, type CheckBox, type Snapshot } from "./checkjobs.ts";
import { mintToken } from "./gateway/token.ts";
import type { Resolver } from "./net.ts";

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
function untar(body: ReadableStream<Uint8Array>, into: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = spawn("tar", ["-xzf", "-", "-C", into, "--no-same-owner", "--no-same-permissions"], { stdio: ["pipe", "ignore", "pipe"] });
    let err = "";
    t.stderr.on("data", (d) => (err += d));
    t.on("error", reject);
    t.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`the snapshot didn't unpack: ${err.trim().slice(0, 300) || `tar ${code}`}`))));
    t.stdin.on("error", () => {});
    Readable.fromWeb(body as never).on("error", (e) => { t.kill(); reject(e); }).pipe(t.stdin);
  });
}

/** The snapshot op of the module that provides one, asked as `module` (its own token). */
export function snapshots({ provider, token, resolver, fetchImpl = fetch }: {
  /** The providing module's snapshot URL (config/kernel/modules.json `snapshot`), or undefined: no module provides one. */
  provider: () => string | undefined;
  /** A module's own token (its generated `<module>_token`), or "" when it has none. */
  token: (module: string) => string;
  resolver: Pick<Resolver, "resolve">;
  fetchImpl?: typeof fetch;
}): (module: string) => Snapshot {
  return (module) => async (repo, ref, into) => {
    const url = provider();
    if (!url) throw new Error("no module provides snapshots (providers.snapshot)");
    const key = token(module);
    if (!key) throw new Error(`module ${module} has no token to ask for a snapshot with`);
    const t = await resolver.resolve(url);
    const res = await fetchImpl(`http://${t.host}:${t.port}${t.path}`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ repo, ref }), signal: AbortSignal.timeout(10 * 60_000) });
    if (!res.ok || !res.body) throw new Error(`the snapshot of ${repo}@${ref.slice(0, 12)} was refused (${res.status}): ${(await res.text().catch(() => "")).slice(0, 200)}`);
    // The tree must be the commit asked for, or the receipt's head binding would be a name only.
    if (res.headers.get("x-aidenhq-commit") !== ref) { await res.body.cancel().catch(() => {}); throw new Error(`the snapshot of ${repo} is of ${String(res.headers.get("x-aidenhq-commit")).slice(0, 12)}, not ${ref.slice(0, 12)}`); }
    await untar(res.body, into);
  };
}

/** The kernel's check jobs (checkjobs.ts) on these: the launcher's check boxes, the snapshot provider, `check` model tokens. */
export function checkJobsFrom({ db, secret, modules, resolver, call, workDir, gatewayUrl, log, docker }: {
  db: DatabaseSync; secret: (name: string) => string;
  /** config/kernel/modules.json: `snapshot` (the providing module's URL) and each module's own token's secret name. */
  modules: () => { snapshot?: string; modules?: Record<string, { token?: string }> };
  resolver: Pick<Resolver, "resolve">; call: Call; workDir: string;
  /** The model gateway's API base as a box reaches it (the launcher's gateway, `…/api/v1`). */
  gatewayUrl: string;
  log: (msg: string, f?: Record<string, unknown>) => void;
  /** Tests: how a command runs in a box. */
  docker?: typeof dockerRun;
}) {
  return createChecks({
    db, log, workDir, gatewayUrl, box: checkBoxes({ call, ...(docker ? { docker } : {}) }),
    secret: () => secret("receipt_secret"),
    snapshot: snapshots({ provider: () => modules().snapshot, token: (m) => { const t = modules().modules?.[m]?.token; return t ? secret(t) : ""; }, resolver }),
    modelToken: (head) => mintToken(secret("gateway_job_secret"), { kind: "check", component: `eval:${head}`, ttlMs: 3 * 3600_000 }),
  });
}
