// Admission (spec §4.2a): a dispatcher module asks for a job on a wake it claimed; the kernel admits it in one SQLite
// transaction (the wake still claimed by this module, no live job on the task, a free computer within the one capacity
// setting and the agent's max_parallel, spend caps not used up), freezing the job's authority from its profile and grants at
// that instant (the job row's `authority`), and only then gets it a computer and starts it (`launch`, boxes.ts). A grant
// edited later never changes a running job. Everything the job gets comes from the wake's task and agent, never the request.
import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { JobError } from "./jobs.ts";
import type { Skill } from "./sandbox.ts";

export const PROFILES = ["crew", "engineer", "check"] as const;
export type Profile = (typeof PROFILES)[number];
/** The computer image a profile's jobs run in when the agent names none (`image:` wins). */
const IMAGE: Record<Profile, string> = { crew: "agent-base", engineer: "engineer", check: "engineer" };

/** A grants-table entry (config/grants/grants.json `agents`, compiled by scripts/modules.mjs grantEntry). */
export type AgentGrant = {
  key?: string; profile?: Profile; image?: string; engine?: string; model?: string; effort?: string; models?: string[]; skills?: Skill[];
  tools?: Record<string, string[]>; jobcaps?: string[]; max_parallel?: number; routines?: Record<string, { model?: string; effort?: string }>;
};
/** What a job may do, frozen at admission: the job token and the tool proxy read this, never the grants table again. */
export type Authority = {
  profile: Profile; image: string; engine: string; model: string; effort: string; models: string[]; skills: Skill[];
  tools: Record<string, string[]>; jobcaps: string[]; writes: string[];
};
/** A wake in the inbox (Task F1): the task and agent it is for and why (a routine's run names the routine's key). */
export type Wake = { task: string; agent: string; cause?: { routine?: string } };
export type Wakes = {
  /** The wake, if this module claimed it and no job is bound to it yet. Synchronous: it runs inside the admission transaction. */
  claimed(module: string, key: string): Wake | undefined;
  /** The admitted job is this wake's (at most one job per wake). */
  bind(key: string, job: string): void;
  /** No job came of it (deferred): claimed again, for the next tick. */
  unclaim(key: string): void;
};
export type Admitted = { id: string; module: string; agent: string; task: string; identifier: string; profile: Profile; authority: Authority; prompt: string; session?: string; wake: string };

const LIVE = "state IN ('admitted', 'running')";
const ID = /^[\w.:-]{1,200}$/;

export function createAdmission({ db, grants, kinds, capacity, spend, mayDispatch, cp, wakes, launch, log }: {
  /** kernel.db, with the jobs table (jobs.ts) already made. */
  db: DatabaseSync;
  grants: () => Record<string, AgentGrant | undefined>;
  /** Write kinds (config/kernel/writes.json): a job may request the reviewed ones (floor 1+) whose tools it holds. */
  kinds: () => Record<string, { floor: number; tools: string[] }>;
  /** settings.computers_max (config/computers.json `max`): the launcher's pool, so no job is admitted it can't box. */
  capacity: () => number;
  /** The spend caps a new job of this agent on this task would start over (the gateway's `exhausted`). */
  spend: (agent: string, task: string) => { scope: string }[];
  mayDispatch: (module: string, agent: string) => boolean;
  cp: { task(id: string): Promise<{ id: string; identifier?: string; assigneeAgentId?: string | null; status?: string } | undefined> };
  wakes: Wakes;
  /** Gets the job its computer and starts it (boxes.ts); a 503 means the computers are full: the job waits for the next tick. */
  launch: (job: Admitted) => Promise<void>;
  log: (msg: string, fields?: Record<string, unknown>) => void;
}) {
  const cols = new Set((db.prepare("PRAGMA table_info(jobs)").all() as { name: string }[]).map((c) => c.name));
  for (const c of ["profile", "wake", "authority"]) if (!cols.has(c)) db.exec(`ALTER TABLE jobs ADD COLUMN ${c} TEXT`);

  function freeze(g: AgentGrant, cause: Wake["cause"]): Authority {
    const profile: Profile = g.profile ?? "crew";
    if (!PROFILES.includes(profile)) throw new JobError(403, "bad-profile", `profile ${profile} isn't one of ${PROFILES.join(", ")}`);
    const routine = cause?.routine ? g.routines?.[cause.routine] : undefined;
    if (cause?.routine && !routine) throw new JobError(400, "unknown-routine", `the agent has no routine ${cause.routine}`);
    // A check job runs repo code: no tools, no writes, nothing to reach.
    const tools = profile === "check" ? {} : Object.fromEntries(Object.entries(g.tools ?? {}).map(([c, t]) => [c, [...t]]));
    const holds = (ct: string) => { const [c, t] = ct.split("."); return Boolean(tools[c!]?.includes(t!)); };
    const writes = Object.entries(kinds()).filter(([, k]) => k.floor >= 1 && k.tools.length > 0 && k.tools.some(holds)).map(([id]) => id).sort();
    return {
      profile, image: g.image ?? IMAGE[profile], engine: String(g.engine ?? ""), model: String(routine?.model ?? g.model ?? ""), effort: String(routine?.effort ?? g.effort ?? ""),
      models: [...(g.models ?? [])], skills: (g.skills ?? []).map((k) => ({ ...k })), tools, jobcaps: profile === "check" ? [] : [...(g.jobcaps ?? [])], writes,
    };
  }

  async function admit(module: string, b: { wake: string; prompt: string; session?: string }) {
    if (!b || typeof b !== "object" || !ID.test(String(b.wake)) || typeof b.prompt !== "string") throw new JobError(400, "bad-request", "send {wake, prompt, session?}");
    const first = wakes.claimed(module, b.wake);
    if (!first) throw new JobError(409, "wake-not-claimed", `wake ${b.wake} isn't one this module claimed`);
    const { task, agent } = first;
    if (!mayDispatch(module, agent)) throw new JobError(403, "not-your-agent", `module ${module} doesn't dispatch agent ${agent}'s jobs`);
    const t = await cp.task(task);
    if (!t || t.assigneeAgentId !== agent) throw new JobError(403, "task-not-assigned", `task ${task} isn't assigned to agent ${agent}`);
    if (["done", "cancelled"].includes(String(t.status))) throw new JobError(409, "task-closed", `task ${task} is ${t.status}`);
    const identifier = String(t.identifier ?? "");
    if (!/^[\w.-]{1,100}$/.test(identifier)) throw new JobError(400, "bad-task", `task ${task} has no identifier`);

    // From here to COMMIT nothing awaits: two admits never interleave.
    const id = `j-${randomBytes(8).toString("hex")}`;
    let job: Admitted;
    db.exec("BEGIN IMMEDIATE");
    try {
      const w = wakes.claimed(module, b.wake);
      if (!w || w.task !== task || w.agent !== agent) throw new JobError(409, "wake-not-claimed", `wake ${b.wake} isn't one this module claimed`);
      if (db.prepare(`SELECT 1 FROM jobs WHERE task = ? AND ${LIVE}`).get(task)) throw new JobError(409, "job-running", `task ${task} already has a job`);
      const g = grants()[agent];
      if (!g) throw new JobError(403, "no-grants", `agent ${agent} has no grants`);
      const live = (db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE ${LIVE}`).get() as { n: number }).n;
      if (live >= capacity()) throw new JobError(429, "busy", `all ${capacity()} computers are taken; try again shortly`);
      const mine = (db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE agent = ? AND ${LIVE}`).get(agent) as { n: number }).n;
      if (mine >= (g.max_parallel ?? 1)) throw new JobError(429, "busy", `agent ${agent} already runs ${mine} job(s), its max_parallel`);
      const over = spend(agent, task);
      if (over.length) throw new JobError(429, "over-cap", `the ${over.map((o) => o.scope).join(", ")} spend cap is used up`);
      const authority = freeze(g, w.cause);
      db.prepare("INSERT INTO jobs (id, module, agent, task, engine, pid, log, dir, at, jobcaps, observing, live_input, state, profile, wake, authority) VALUES (?, ?, ?, ?, ?, 0, '', '', ?, ?, 0, 0, 'admitted', ?, ?, ?)")
        .run(id, module, agent, task, authority.engine, Date.now(), JSON.stringify(authority.jobcaps), authority.profile, b.wake, JSON.stringify(authority));
      wakes.bind(b.wake, id);
      db.exec("COMMIT");
      job = { id, module, agent, task, identifier, profile: authority.profile, authority, prompt: b.prompt, ...(b.session ? { session: b.session } : {}), wake: b.wake };
    } catch (e) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw e;
    }
    log("job admitted", { job: id, module, agent, task, profile: job.authority.profile });
    try {
      await launch(job);
    } catch (e) {
      if ((e as { status?: number }).status !== 503) {
        db.prepare("UPDATE jobs SET state = 'failed', final = ?, ended = ? WHERE id = ? AND state = 'admitted'").run(`couldn't start: ${(e as Error).message}`.slice(0, 500), Date.now(), id);
        throw e;
      }
      defer(id, b.wake);
      log("job deferred: no free computer", { job: id, task });
    }
    return view(id);
  }

  /** No computer for it now: the job never ran, so the wake goes back to its dispatcher for the next tick. */
  function defer(id: string, wake: string) {
    db.prepare("UPDATE jobs SET state = 'deferred', ended = ? WHERE id = ? AND state = 'admitted'").run(Date.now(), id);
    wakes.unclaim(wake);
  }

  const view = (id: string) => {
    const r = db.prepare("SELECT id, module, agent, task, state, profile, wake, authority FROM jobs WHERE id = ?").get(id) as Record<string, string>;
    return { id: r.id, module: r.module, agent: r.agent, task: r.task, state: r.state, profile: r.profile as Profile, wake: r.wake, authority: JSON.parse(r.authority!) as Authority };
  };

  return {
    admit,
    /** A job's frozen authority (its job token and the tool proxy resolve it here), or undefined for a job admission didn't make. */
    authority(id: string): Authority | undefined {
      const r = db.prepare("SELECT authority FROM jobs WHERE id = ?").get(id) as { authority: string | null } | undefined;
      return r?.authority ? (JSON.parse(r.authority) as Authority) : undefined;
    },
    /** At kernel start: a job admitted but not started when the last kernel stopped never ran; its wake is given back. */
    recover() {
      for (const r of db.prepare("SELECT id, wake FROM jobs WHERE state = 'admitted'").all() as { id: string; wake: string }[]) defer(r.id, r.wake);
    },
  };
}
export type Admission = ReturnType<typeof createAdmission>;
