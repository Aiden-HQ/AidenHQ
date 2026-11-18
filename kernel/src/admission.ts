// Admission (spec §4.2a): a dispatcher module asks for a job on a wake it claimed; the kernel admits it in one SQLite
// transaction (the wake still claimed by this module, no live job on the task, a free computer within the one capacity
// setting and the agent's max_parallel, spend caps not used up), freezing the job's authority from its profile and grants at
// that instant (the job row's `authority`), and only then gets it a computer and starts it (`launch`, boxes.ts). A grant
// edited later never changes a running job. Everything the job gets comes from the wake's task and agent, never the request.
import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { rolesOf } from "./identity.ts";
import { JobError } from "./jobs.ts";
import type { JobTools } from "./jobtools.ts";
import type { RoutineCap } from "./tier.ts";
import type { Skill } from "./sandbox.ts";

export const PROFILES = ["crew", "engineer", "check"] as const;
export type Profile = (typeof PROFILES)[number];
/** The computer image a profile's jobs run in when the agent names none (`image:` wins). */
const IMAGE: Record<Profile, string> = { crew: "agent-base", engineer: "engineer", check: "engineer" };

/** A grants-table entry (config/grants/grants.json `agents`, compiled by scripts/modules.mjs grantEntry). */
export type AgentGrant = {
  key?: string; roles?: string[]; trial?: boolean; private_reads?: boolean; web_search?: string; profile?: Profile; image?: string; engine?: string; model?: string; effort?: string; models?: string[]; skills?: Skill[];
  tools?: Record<string, string[]>; jobcaps?: string[]; max_parallel?: number; routines?: Record<string, { model?: string; effort?: string }>;
};
/** What a job may do, frozen at admission: the job token and the tool proxy read this, never the grants table again. */
export type Authority = {
  profile: Profile; image: string; engine: string; model: string; effort: string; models: string[]; skills: Skill[];
  tools: Record<string, string[]>; jobcaps: string[]; writes: string[]; roles: string[];
  /** The agent reads private data (private_reads): its jobs get no web search, and only they its private jobcaps. */
  reads: boolean;
  /** Web search: off for an agent that reads private data or whose definition turns it off (web_search: disabled). */
  web: boolean;
};
/** A wake in the inbox (wakes.ts): the task and agent it is for and why (`routine:<key>` names the routine whose run it is). */
export type Wake = { task: string; agent: string; cause: string };
export type Wakes = {
  /** The wake, if this module claimed it and no job is bound to it yet. Synchronous: it runs inside the admission transaction. */
  claimed(module: string, key: string): Wake | undefined;
  /** The admitted job is this wake's (at most one job per wake). */
  bind(key: string, job: string): void;
  /** No job came of it (deferred): no job bound, claimable again by the same module at once. */
  unclaim(key: string): void;
};

/** The kernel's wake inbox (wakes.ts's table) as admission uses it. */
export const wakeInbox = (db: DatabaseSync): Wakes => ({
  claimed: (module, key) => db.prepare("SELECT task, agent, cause FROM wakes WHERE key = ? AND state = 'claimed' AND claimed_by = ? AND job IS NULL").get(key, module) as Wake | undefined,
  bind: (key, job) => { db.prepare("UPDATE wakes SET job = ? WHERE key = ?").run(job, key); },
  unclaim: (key) => { db.prepare("UPDATE wakes SET job = NULL, until = 0 WHERE key = ?").run(key); },
});
/** `fresh`: the last job asked for a fresh session (`aidenhq reset`): no session resumes, the dispatcher's included. */
export type Admitted = { id: string; module: string; agent: string; task: string; identifier: string; profile: Profile; authority: Authority; prompt: string; session?: string; fresh: boolean; wake: string };

const LIVE = "state IN ('admitted', 'running')";
const ID = /^[\w.:-]{1,200}$/;

export function createAdmission({ db, grants, kinds, capacity, spend, mayDispatch, cp, wakes, provenance, routineCap, nextTurn, launch, log }: {
  /** What the task's last job asked of this turn (jobtools.ts): read in the transaction, spent once the job has started. */
  nextTurn: Pick<JobTools, "pending" | "taken" | "refusal">;
  /** Kernel provenance (provenance.ts): a task carrying a creation intent with no row yet is not admitted until reconciled. */
  provenance: { pending(issue: { id: string; description?: string | null }): boolean };
  /** The task's routine cap as the kernel traces it now (tier.ts taskRoutineCap): frozen on the job row at admission. */
  routineCap: (task: string) => Promise<RoutineCap | undefined>;
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
  cp: { task(id: string): Promise<{ id: string; identifier?: string; assigneeAgentId?: string | null; status?: string; description?: string | null } | undefined> };
  wakes: Wakes;
  /** Gets the job its computer and starts it (boxes.ts); a 503 means the computers are full: the job waits for the next tick. */
  launch: (job: Admitted) => Promise<void>;
  log: (msg: string, fields?: Record<string, unknown>) => void;
}) {

  function freeze(g: AgentGrant, cause: string): Authority {
    const profile: Profile = g.profile ?? "crew";
    if (!PROFILES.includes(profile)) throw new JobError(403, "bad-profile", `profile ${profile} isn't one of ${PROFILES.join(", ")}`);
    const key = /^routine:(.+)$/.exec(cause)?.[1];
    const routine = key ? g.routines?.[key] : undefined;
    // A check job runs repo code: no tools, no writes, nothing to reach.
    const tools = profile === "check" ? {} : Object.fromEntries(Object.entries(g.tools ?? {}).map(([c, t]) => [c, [...t]]));
    const holds = (ct: string) => { const [c, t] = ct.split("."); return Boolean(tools[c!]?.includes(t!)); };
    const writes = Object.entries(kinds()).filter(([, k]) => k.floor >= 1 && k.tools.length > 0 && k.tools.some(holds)).map(([id]) => id).sort();
    return {
      profile, image: g.image ?? IMAGE[profile], engine: String(g.engine ?? ""), model: String(routine?.model ?? g.model ?? ""), effort: String(routine?.effort ?? g.effort ?? ""),
      models: [...(g.models ?? [])], skills: (g.skills ?? []).map((k) => ({ ...k })), tools, jobcaps: profile === "check" ? [] : [...(g.jobcaps ?? [])], writes,
      roles: profile === "check" ? [] : rolesOf(g), reads: g.private_reads === true,
      web: g.private_reads !== true && g.web_search !== "disabled",
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

    // The routine cap is traced now and frozen on the row: never recomputed from mutable parents later, never the dispatcher's.
    const cap = await routineCap(task);
    // From here to COMMIT nothing awaits: two admits never interleave.
    const id = `j-${randomBytes(8).toString("hex")}`;
    let job: Admitted;
    db.exec("BEGIN IMMEDIATE");
    try {
      const w = wakes.claimed(module, b.wake);
      if (!w || w.task !== task || w.agent !== agent) throw new JobError(409, "wake-not-claimed", `wake ${b.wake} isn't one this module claimed`);
      if (db.prepare(`SELECT 1 FROM jobs WHERE task = ? AND ${LIVE}`).get(task)) throw new JobError(409, "job-running", `task ${task} already has a job`);
      // A task a job created whose provenance row isn't written yet: its routine cap is unknown, so nothing runs on it.
      if (provenance.pending({ id: task, description: t.description ?? null })) throw new JobError(409, "provenance-pending", `task ${task}'s provenance isn't settled yet`);
      const g = grants()[agent];
      if (!g) throw new JobError(403, "no-grants", `agent ${agent} has no grants`);
      const live = (db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE ${LIVE}`).get() as { n: number }).n;
      if (live >= capacity()) throw new JobError(429, "busy", `all ${capacity()} computers are taken; try again shortly`);
      const mine = (db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE agent = ? AND ${LIVE}`).get(agent) as { n: number }).n;
      if (mine >= (g.max_parallel ?? 1)) throw new JobError(429, "busy", `agent ${agent} already runs ${mine} job(s), its max_parallel`);
      const over = spend(agent, task);
      if (over.length) throw new JobError(429, "over-cap", `the ${over.map((o) => o.scope).join(", ")} spend cap is used up`);
      const authority = freeze(g, w.cause);
      // The last job's `aidenhq engine`: applied when the agent may still run it now, else ignored loudly (refusing would
      // wedge the task: the request would stand at every retry). Never widens `models`.
      const asked = nextTurn.pending(task);
      if (asked?.engine) {
        const why = nextTurn.refusal(asked.engine, authority.models);
        if (why) log("a job's next-turn engine request is ignored", { job: asked.job, task, why });
        else Object.assign(authority, { engine: asked.engine.kind }, asked.engine.model ? { model: asked.engine.model } : {});
      }
      const fresh = asked?.fresh === true;
      db.prepare("INSERT INTO jobs (id, module, agent, task, engine, pid, log, dir, at, jobcaps, observing, live_input, state, profile, wake, authority, routine, routine_cap) VALUES (?, ?, ?, ?, ?, 0, '', '', ?, ?, 0, 0, 'admitted', ?, ?, ?, ?, ?)")
        .run(id, module, agent, task, authority.engine, Date.now(), JSON.stringify(authority.jobcaps), authority.profile, b.wake, JSON.stringify(authority), cap?.routine ?? null, cap?.cap ?? null);
      wakes.bind(b.wake, id);
      db.exec("COMMIT");
      job = { id, module, agent, task, identifier, profile: authority.profile, authority, prompt: b.prompt, ...(b.session && !fresh ? { session: b.session } : {}), fresh, wake: b.wake };
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
      const v = view(id);
      defer(id, b.wake);
      log("job deferred: no free computer", { job: id, task });
      return { ...v, state: "deferred" };
    }
    nextTurn.taken(task);
    return view(id);
  }

  /**
   * No computer for it now: the job never ran, so its row goes (a job row would read as the task's last job, and the inbox
   * would drop the wake as older) and the wake goes back to its dispatcher for the next tick.
   */
  function defer(id: string, wake: string) {
    wakes.unclaim(wake);
    db.prepare("DELETE FROM jobs WHERE id = ? AND state = 'admitted'").run(id);
  }

  const view = (id: string) => {
    const r = db.prepare("SELECT id, module, agent, task, state, profile, wake, authority FROM jobs WHERE id = ?").get(id) as Record<string, string>;
    if (!r) throw new JobError(404, "no-job", `no job ${id}`);
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
