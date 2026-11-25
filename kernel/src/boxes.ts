// The kernel owns an admitted job's computer (spec §4.2a): it gets the box from the computer launcher (its job routes, bearer
// launcher_kernel_key), mints the job's only credential (an `ahqj_` job token naming the job, whose authority is its row's,
// frozen at admission), has an engineer job's box clone its task's named repositories itself (`aidenhq clone`), builds the job's engine home (per agent and task: its skills, its compiled handbook, its granted
// connections as Codex config), starts the run (jobs.ts runAdmitted), renews the box's lease while the job lives and releases
// it when the job ends: the launcher parks it for the task's next job (warm: no new box on a follow-up), or destroys it when
// the job asked for its workspace to go (`aidenhq cleanup`, jobtools.ts), which then goes too. The lease is the job's and its
// generation's (the row's box `gen`), so a late release of one job never touches the next one's. A kernel restart changes
// nothing: the renewals and releases are driven from the job rows.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, normalize } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { jobServers, mcpBlock, unemittedServers } from "../../services/computer/lib.ts";
import type { Admitted } from "./admission.ts";
import { mintToken } from "./gateway/token.ts";
import type { Whoami } from "./identity.ts";
import { JobError, insideNoLinks, type Jobs } from "./jobs.ts";
import type { Once } from "./once.ts";
import { outFiles } from "./outfiles.ts";
import { publishTools, TOOLS_DIR } from "./codemode.ts";
import { engineEntry, engineState, type Box, type SandboxConfig } from "./sandbox.ts";
import { trashAway } from "./trash.ts";

const RENEW_MS = 5 * 60_000; // the launcher's lease is 15 minutes
/** A session job's token outlives any session; it still dies with its job (identity.ts whoami re-reads the job row). */
export const SESSION_TOKEN_TTL_MS = 365 * 24 * 3600_000;
/** Where a job's workspace lives under the work dir: a session's in the standing box's sessions folder, any other job's in tasks. */
const workRoot = (cfg: Pick<SandboxConfig, "workDir">, profile: string) => join(cfg.workDir, profile === "session" ? "sessions" : "tasks");

type Call = (route: string, body: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** The launcher's job routes as the kernel: a non-2xx answer throws with its status (503: no free computer). */
export function launcherClient(url: string, key: () => string, fetchImpl: typeof fetch = fetch): Call {
  return async (route, body) => {
    const res = await fetchImpl(new URL(route, url), { method: "POST", headers: { authorization: `Bearer ${key()}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(120_000) });
    const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw Object.assign(new Error(`the computer launcher answered ${res.status} on ${route}: ${String(j.error ?? "").slice(0, 300)}`), { status: res.status });
    return j;
  };
}

/**
 * Every owner/name a task's text names (a GitHub URL or a bare org/repo token), first mention first: the runner's rule. An
 * all-digit name is an issue or board number, not a repository.
 */
export function mentionedRepos(text: string): string[] {
  const found = new Map<string, string>();
  const re = /(?:https?:\/\/github\.com\/|git@github\.com:|(?<![\w./@:-]))([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?=[\s/#?)\]>,;:'"`]|\.(?:[\s)\]>,;:'"`]|$)|$)/g;
  for (const m of text.matchAll(re)) {
    if (/^\.+$/.test(m[1]!) || /^\.+$/.test(m[2]!) || /^\d+$/.test(m[2]!)) continue;
    const slug = `${m[1]}/${m[2]}`;
    if (!found.has(slug.toLowerCase())) found.set(slug.toLowerCase(), slug);
  }
  return [...found.values()];
}

/** An engineer job's clones: the repos its task names that its dispatcher's clone grant covers (codehost.ts bundle). */
export type Clones = {
  /** The task's title and description (the control plane, as the owner). */
  text: (task: string) => Promise<string>;
  /** Whether `module`'s codehost grant lets it clone `repo` (checked here, so a token that names no repository never reaches GitHub). */
  may: (module: string, repo: string) => boolean;
};
const MAX_CLONES = 5;
/** The in-box `aidenhq`'s exit code when the kernel or the code host can't answer now (a 5xx, or unreachable). */
export const CLONE_UNAVAILABLE = 75;

/** A command in a job's box as the job (its env file: the job token), in /workspace: its exit code and its output. */
export type BoxExec = (box: Box, argv: string[]) => Promise<{ code: number; out: string }>;
export const dockerExec: BoxExec = (box, argv) => new Promise((ok) => {
  execFile("docker", ["exec", "--env-file", box.envFile, "-w", "/workspace", box.container, ...argv], { timeout: 15 * 60_000, maxBuffer: 1 << 20 }, (e, stdout, stderr) => {
    const code = e ? (typeof (e as { code?: unknown }).code === "number" ? (e as { code: number }).code : CLONE_UNAVAILABLE) : 0;
    ok({ code, out: `${stdout}${stderr}`.trim() });
  });
});

/** The task's files in the control plane, and a way to attach one (as the owner: the control plane takes an agent key's writes only inside a run). */
export type Attachments = {
  list: (task: string) => Promise<{ originalFilename?: string; byteSize?: number }[]>;
  add: (task: string, name: string, type: string, data: Buffer) => Promise<void>;
};

/** A launcher that can't answer now (a 5xx, a timeout, unreachable): the launch is deferred to the next tick, never failed. */
const unavailable = (e: Error): never => { throw new JobError(503, "launcher-unavailable", `the computer launcher can't answer now (${String(e.message).slice(0, 200)})`); };

export function createBoxes({ db, cfg, jobs, call, secret, whoami, connections, declaredServers, handbook, cleanup, clones, identity, attachments, once, log, boxExec = dockerExec, now = Date.now, stopping = () => false, stateNeed, kernelUrl, toolsClient }: {
  /** The kernel's own backplane (its tool proxy at /c/<connection>/mcp): where a code-mode engine's tools are listed at launch. */
  kernelUrl?: string;
  /** The box's MCP client as generated wrappers import it (codemode.ts CLIENT_IN_BOX; a test's host path). */
  toolsClient?: string;
  db: DatabaseSync; attachments: Attachments; once: Once; cfg: SandboxConfig; jobs: Pick<Jobs, "runAdmitted">; call: Call; secret: (name: string) => string; whoami: Whoami;
  /** Who the agent's commits are authored as: its name and its own address (never the owner's). */
  identity: (agent: string) => Promise<{ name: string; email: string; agent?: string }>;
  /** An engineer job's workspace: the repositories its task names, cloned by its box before the run starts. */
  clones: Clones;
  /** How a command runs in a job's box (docker exec; a test's fake). */
  boxExec?: BoxExec;
  /** Whether a job asked for its workspace to go when it ends (jobtools.ts). */
  cleanup: (job: string) => boolean;
  /** config/computers.json `connections`: each connection's tool timeout, for the box's Codex config. */
  connections: () => Record<string, { tool_timeout_sec?: number }>;
  /** The MCP servers the agent's compiled config declares (config/paperclip.yaml, by its Paperclip id): undefined skips the check. */
  declaredServers?: (agentId: string) => string[] | undefined;
  /** The agent's compiled handbook (setup writes config/handbooks/<agent id>.md), or undefined. */
  handbook: (agent: string) => string | undefined;
  log: (msg: string, fields?: Record<string, unknown>) => void;
  now?: () => number;
  /** The kernel is draining (main.ts): a launch that got its box gives it back instead of starting the run. */
  stopping?: () => boolean;
  /** The state root can't be made (a removed or foreign-owned directory): the owner hears it once per episode, not per job. */
  stateNeed?: (e: Error, episode: string) => void;
}) {

  /** admission.ts `launch`: the job's token, its engine home and workspace, its box, then the run. */
  async function launch(job: Admitted) {
    const { authority: a } = job;
    const session = a.profile === "session";
    const root = workRoot(cfg, a.profile);
    const workspace = join(root, job.identifier);
    const state = engineState(cfg, a.engine, `${job.agent}/${job.task}`, a.skills, stateNeed);
    if (!state) throw new JobError(400, "no-engine-home", `the ${a.engine} engine keeps no state folder, so the job can't have its own home`);
    // The agent's compiled handbook is the engine's instructions file (what Paperclip delivered to crew runs).
    const book = handbook(job.agent);
    if (!book) throw new JobError(500, "no-handbook", `agent ${job.agent} has no compiled handbook (config/handbooks; apply writes it)`);
    writeFileSync(join(state, "AGENTS.md"), book, { mode: 0o600 });
    const token = mintToken(secret("gateway_job_secret"), { kind: "job", job: job.id, agentId: job.agent, issueId: job.task, ttlMs: session ? SESSION_TOKEN_TTL_MS : (cfg.timeout_minutes + 60) * 60_000 }, now());
    // The box's connections: exactly what this job's token resolves to (its frozen authority), never the grants table.
    const tools = (await whoami(token)).tools;
    // The job's connections, resolved once: the one list every engine's config, and the preflight, read.
    const servers = jobServers(tools, connections(), cfg.boxGatewayUrl);
    // A declared server the frozen authority or the connections don't list would start the run silently without it: refuse
    // instead, before the launcher is called. A check job's authority deliberately has no tools, so it is exempt.
    const missing = a.profile === "check" ? [] : unemittedServers([...new Set(declaredServers?.(job.agent) ?? [])], servers);
    if (missing.length) throw new JobError(500, "mcp-server-missing", `declares MCP server(s) ${missing.join(", ")} but this job's frozen authority has no tools for them; refusing to start a run without them`);
    // A code-mode engine (`tools: code`) gets its connections as files in its engine home instead: no MCP config of either kind.
    const code = engineEntry(cfg, a.engine).tools === "code";
    if (code && !kernelUrl) throw new JobError(500, "codemode-unavailable", `the ${a.engine} engine reaches its tools as code, and this kernel has no backplane address to list them from`);
    const mcp = code ? "" : mcpBlock(servers);
    // The task's last job lets its box go first (the launcher keeps one per task and parks it between jobs); while it is still
    // leased, the job waits a tick.
    // A release already in flight (the last job's end) is waited for too, so its cleanup runs before this job touches the workspace.
    for (const r of db.prepare("SELECT id FROM jobs WHERE task = ? AND authority IS NOT NULL AND box IS NOT NULL AND (released IS NULL OR released = -1) AND state NOT IN ('admitted', 'running')").all(job.task) as { id: string }[]) await (releasing.get(r.id) ?? release(r.id)).catch(unavailable);
    // After that release: a cleanup it does removes the last job's workspace, never this one's.
    mkdirSync(workspace, { recursive: true });
    insideNoLinks(root, workspace, "workspace");
    // 409: the task's box is still going (the computers are full for it); a 5xx, a timeout or no answer: the launcher can't now.
    const box = (await call("/job", { job: job.id, agentId: job.agent, issueId: job.task, identifier: job.identifier, workspace, engine: a.engine, state, image: a.image, token, mcp, roles: a.roles, identity: await identity(job.agent), ...(session ? { standing: true } : {}) }).catch((e: Error & { status?: number }) => {
      if (e.status === 409) throw Object.assign(e, { status: 503 });
      if (e.status === undefined || e.status >= 500) unavailable(e);
      throw e;
    })) as unknown as Box;
    // A code-mode engine's tool folder and index, as the box sees its engine home (only a standing box's lease names it).
    const toolsAt = code && box.stateIn ? { dir: `${box.stateIn}/${TOOLS_DIR}`, index: `${box.stateIn}/${TOOLS_DIR}/README.md` } : undefined;
    const spec = { ...box, workspace, servers: code ? [] : servers, ...(toolsAt ? { tools: toolsAt } : {}) };
    // The row's box names its workspace too, for a cleanup at release, and the job's connections, for a run started again.
    db.prepare("UPDATE jobs SET box = ?, renewed = ? WHERE id = ?").run(JSON.stringify(spec), now(), job.id);
    // A kernel draining for its successor starts nothing it wouldn't follow: the box goes back and the wake to its dispatcher.
    if (stopping()) {
      await release(job.id).catch(() => {});
      throw new JobError(503, "draining", "the kernel is restarting; the job starts on the next one");
    }
    try {
      // The job's tool files, listed now through the kernel's own proxy with this job's token (the same filter the box hits),
      // after the task's last lease went: a generator error fails the launch loudly, never a session half-equipped.
      if (code && !box.stateIn) throw new JobError(500, "codemode-unavailable", `the ${a.engine} engine reaches its tools as code, and its box names no engine home`);
      if (code) await publishTools({ kernelUrl: kernelUrl!, token, servers, stateRoot: normalize(cfg.stateDir), home: state, inBox: box.stateIn!, ...(toolsClient ? { client: toolsClient } : {}), log: (msg, f) => log(msg, { job: job.id, ...f }) })
        .catch((e: Error) => { throw new JobError(500, "codemode-failed", `the job's tool files couldn't be generated (${String(e.message).slice(0, 300)})`); });
      const notes = a.profile === "engineer" ? await cloneNamed(job, box) : [];
      const session = job.fresh ? undefined : lastSession(job.agent, job.task, a.engine);
      const withNotes = (text: string) => (notes.length ? `(Kernel note: ${notes.join(" ")})\n\n${text}` : text);
      const prompt = withNotes(session ? job.prompt : job.fullPrompt ?? job.prompt);
      jobs.runAdmitted(job.id, { box: spec as Box, worktree: workspace, prompt, session, fullPrompt: withNotes(job.fullPrompt ?? job.prompt), label: job.identifier });
    } catch (e) {
      await release(job.id).catch(() => {});
      throw e;
    }
  }

  /**
   * An engineer job's repositories: each one its task names that its dispatcher may clone, cloned by its box itself from the
   * code host's bundle (`aidenhq clone <org/name>` in the box, as the job) into /workspace/<name> on its default branch, before
   * the run starts; one already there (`--keep`: <name> or <org>--<name>, its origin this repo) is kept as it is; one
   * whose origin is another repo, or none, is refused. Host git and host fs writes never run in the
   * workspace. A refusal is told to the job (its notes); a kernel or code host that can't answer now makes the launch a 503, so
   * admission tries again.
   */
  async function cloneNamed(job: Admitted, box: Box): Promise<string[]> {
    const named = mentionedRepos(await clones.text(job.task)).filter((r) => clones.may(job.module, r)).slice(0, MAX_CLONES);
    const notes: string[] = [];
    for (const repo of named) {
      const r = await boxExec(box, ["aidenhq", "clone", "--keep", repo]);
      const said = r.out.replace(/^aidenhq: /, "").slice(0, 200);
      if (r.code === 0) { log("repository cloned into the job's workspace", { job: job.id, repo }); continue; }
      if (r.code === CLONE_UNAVAILABLE) throw new JobError(503, "clone-failed", `${repo} couldn't be cloned now (${said})`);
      log("repository not cloned", { job: job.id, repo, code: r.code, err: said });
      notes.push(`\`${repo}\` is named in the task but couldn't be cloned into your workspace (${said}).`);
    }
    return notes;
  }

  /**
   * The session to resume: the one of this agent's last finished job on this task with this engine, when that job's engine ran
   * (it wrote events). A resume that died at start (no events: its session isn't in the engine home) starts the next job
   * fresh, so one lost session never fails every later job; a job the kernel didn't admit (before the engine home was per agent
   * and task) is never resumed. A row that recorded no session and read no engine events never ran (an MCP preflight
   * refusal, no engine home, no handbook, a clone that couldn't finish, a box whose exec never started the engine), so it is
   * not the session's newest word: skip it. A row that did resume but died before any event keeps its session and still
   * starts the next job fresh, as before.
   */
  const lastSession = (agent: string, task: string, engine: string) => {
    const r = db.prepare("SELECT session, offset FROM jobs WHERE agent = ? AND task = ? AND engine = ? AND authority IS NOT NULL AND NOT (offset = 0 AND session IS NULL) AND state NOT IN ('admitted', 'running') ORDER BY at DESC LIMIT 1").get(agent, task, engine) as { session: string | null; offset: number } | undefined;
    return r && r.offset > 0 ? r.session ?? undefined : undefined;
  };

  /**
   * What an engineer job made in <workspace>/.aidenhq/out/ is attached to its task, once per job (the once-key), before its
   * workspace can go. A failure is logged and never holds the box.
   */
  async function shareOutFiles(id: string, task: string, workspace: string) {
    try {
      await once(`outfiles:${id}`, async () => {
        if (!existsSync(workspace)) return [];
        const have = new Set((await attachments.list(task)).map((a) => `${a.originalFilename}:${a.byteSize}`));
        const sent: string[] = [];
        for (const f of outFiles(workspace, have)) {
          try { await attachments.add(task, f.name, f.type, f.data); sent.push(f.name); } catch (e) { log("couldn't attach an output file", { job: id, file: f.name, err: (e as Error).message.slice(0, 200) }); }
        }
        if (sent.length) log("output files attached to the task", { job: id, task, files: sent });
        return sent;
      });
    } catch (e) {
      log("couldn't attach a job's output files", { job: id, err: (e as Error).message.slice(0, 200) });
    }
  }

  /**
   * The job's lease on its box ends, once: a release claims the row first (released = -1), so two at once (the job's end and
   * tend) never both run; a failed launcher call gives the claim back for the next tend. The launcher parks the box for the
   * task's next job, or destroys it: a job that never ran (still admitted: a failed or abandoned launch, its box suspect), or
   * one that asked for its workspace to go (`aidenhq cleanup`), whose workspace then goes too, unless a later job on the task
   * is already admitted or running in it.
   */
  /** Releases in flight in this process: a launch waits for its task's (a restart resets the claims a dead kernel left, start()). */
  const releasing = new Map<string, Promise<void>>();
  function release(id: string): Promise<void> {
    let p = releasing.get(id);
    if (!p) { p = releaseOnce(id).finally(() => releasing.delete(id)); releasing.set(id, p); }
    return p;
  }
  async function releaseOnce(id: string) {
    const r = db.prepare("SELECT task, box, state, profile FROM jobs WHERE id = ? AND authority IS NOT NULL AND released IS NULL").get(id) as { task: string; box: string | null; state: string; profile: string | null } | undefined;
    if (!r?.box || db.prepare("UPDATE jobs SET released = -1 WHERE id = ? AND released IS NULL").run(id).changes !== 1) return;
    const { container, workspace, gen, lease } = JSON.parse(r.box) as Box & { workspace?: string; gen?: number };
    const root = workRoot(cfg, String(r.profile ?? ""));
    // A job that never ran (still admitted: its launch failed or was abandoned) made no output; what is there is an earlier job's.
    if (workspace && r.state !== "admitted") await shareOutFiles(id, r.task, workspace);
    const wipe = Boolean(workspace) && cleanup(id);
    try {
      // A 2xx that isn't a release (Docker didn't remove the box) is none: the claim goes back for the next tend.
      // A lease (a session in the standing box) ends only its own processes: the box, shared by other sessions, never goes.
      const { released, state } = await call("/job/release", { container, gen, ...(lease ? { lease, destroy: false } : { destroy: wipe || r.state === "admitted" }) });
      if (released !== true && state !== "missing") throw new Error(`the computer launcher left ${container} ${String(state)}`);
    } catch (e) {
      db.prepare("UPDATE jobs SET released = NULL WHERE id = ? AND released = -1").run(id);
      throw e;
    }
    // A job admitted next waits for this release before it uses the workspace (launch, above); only a running one is in it.
    if (wipe && existsSync(workspace!) && !db.prepare("SELECT 1 FROM jobs WHERE task = ? AND id != ? AND state = 'running'").get(r.task, id)) {
      insideNoLinks(root, workspace!, "workspace");
      trashAway(workspace!, join(root, ".trash"), log);
      log("job's workspace removed (aidenhq cleanup)", { job: id, workspace });
    }
    db.prepare("UPDATE jobs SET released = ? WHERE id = ?").run(now(), id);
    log("job's computer released", { job: id, container });
  }

  /**
   * Every few minutes and at start: live jobs' leases renewed (an admitted one's too: its box is cloning before the run),
   * ended jobs' boxes released (retried until the launcher agrees).
   */
  async function tend() {
    const rows = db.prepare("SELECT id, task, state, box, renewed FROM jobs WHERE authority IS NOT NULL AND box IS NOT NULL AND released IS NULL").all() as { id: string; task: string; state: string; box: string; renewed: number | null }[];
    for (const r of rows) {
      try {
        if (r.state !== "running" && r.state !== "admitted") await release(r.id);
        else if (now() - (r.renewed ?? 0) >= RENEW_MS) {
          const { container, gen, lease } = JSON.parse(r.box) as Box & { gen?: number };
          await call("/job/renew", { container, issueId: r.task, gen, ...(lease ? { lease } : {}) });
          db.prepare("UPDATE jobs SET renewed = ? WHERE id = ?").run(now(), r.id);
        }
      } catch (e) {
        log("couldn't tend a job's computer", { job: r.id, err: (e as Error).message });
      }
    }
  }

  return {
    launch,
    /** admission.ts recover: an abandoned launch's box goes (a launcher that can't answer throws). */
    release,
    /** jobs.ts onEnd: the job is over, its box goes. */
    ended: (id: string) => void release(id).catch((e: Error) => log("couldn't release a job's computer", { job: id, err: e.message })),
    tend,
    /** Tends now (adopted jobs keep their leases) and every minute after. */
    start() {
      // A release this kernel's last run claimed but never finished is tended again.
      db.prepare("UPDATE jobs SET released = NULL WHERE released = -1").run();
      void tend();
      const t = setInterval(() => void tend(), 60_000);
      t.unref();
      return () => clearInterval(t);
    },
  };
}
export type Boxes = ReturnType<typeof createBoxes>;

/** The compiled handbook setup wrote for an agent (config/handbooks/<id>.md). */
export const handbookFrom = (configDir: string) => (agent: string) => {
  if (!/^[\w-]+$/.test(agent)) return undefined;
  try { return readFileSync(join(configDir, "handbooks", `${agent}.md`), "utf8"); } catch { return undefined; }
};
