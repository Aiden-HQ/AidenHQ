// Admission (spec §4.2a): a dispatcher module asks for a job on a wake it claimed; the kernel admits it in one SQLite
// transaction (the wake still claimed by this module, no live job on the task, a free computer among the agent jobs'
// (settings.computers_max) and the agent's max_parallel, the task's spend cap and the install's limits not used up), freezing the job's authority from its profile and grants at
// that instant (the job row's `authority`), and only then gets it a computer and starts it (`launch`, boxes.ts). A grant
// edited later never changes a running job. Everything the job gets comes from the wake's task and agent, never the request.
import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { CODEHOSTS } from "./codehost.ts";
import { heldRoles } from "./identity.ts";
import { inTx, iso, strictFact } from "./factlog.ts";
import type { Facts } from "./facts.ts";
import { JobError, queueFacts } from "./jobs.ts";
import type { JobTools } from "./jobtools.ts";
import type { Skill } from "./sandbox.ts";
import type { Pool } from "./pool.ts";

export const PROFILES = ["crew", "engineer", "check"] as const;
export type Profile = (typeof PROFILES)[number];
/** The role the code host reads as the product line (requester.platform), and the roles whose filed tasks may carry it (the Architect, the Fleet Steward). */
const PLATFORM = "platform-engineer";
const PLATFORM_FILERS = ["architect", "fleet-audit"];
/** The computer image a profile's jobs run in when the agent names none (`image:` wins). */
const IMAGE: Record<Profile, string> = { crew: "agent-base", engineer: "engineer", check: "engineer" };

/** A grants-table entry (config/grants/grants.json `agents`, compiled by scripts/modules.ts grantEntry). */
export type AgentGrant = {
  key?: string; roles?: string[]; web_search?: string; profile?: Profile; image?: string; engine?: string; engines?: string[]; model?: string; effort?: string; models?: string[]; skills?: Skill[];
  tools?: Record<string, string[]>; jobcaps?: string[]; max_parallel?: number; routines?: Record<string, { model?: string; effort?: string }>;
  /** A team record (compile's teams): it never runs; its members do. A member names its team record's key. */
  team?: { name: string; members: string[] }; member_of?: string;
};
/** What a job may do, frozen at admission: the job token and the tool proxy read this, never the grants table again. */
export type Authority = {
  /** `engines`: the engines a job may ask its next turn to run on (`aidenhq engine`): the grant's, else only its own. */
  profile: Profile; image: string; engine: string; engines: string[]; model: string; effort: string; models: string[]; skills: Skill[];
  tools: Record<string, string[]>; jobcaps: string[]; writes: string[]; roles: string[];
  /** Web search: off for an agent whose definition turns it off (web_search: disabled). */
  web: boolean;
};
/** A wake in the inbox (wakes.ts): the task and agent it is for and why (`routine:<key>` names the routine whose run it is). */
export type Wake = { task: string; agent: string; cause: string; at?: number };
export type Wakes = {
  /** The wake, if this module claimed it and no job is bound to it yet. Synchronous: it runs inside the admission transaction. */
  claimed(module: string, key: string): Wake | undefined;
  /** The admitted job is this wake's (at most one job per wake). */
  bind(key: string, job: string): void;
  /** A job that started on the task ends the agent's own wait (idle.ts): its open timed wakes are dropped, and their keys
   * returned. Only once the job is running: a deferred job leaves the waits armed. */
  endWaits(key: string): string[];
  /** No job came of it (deferred): no job bound, claimable again by the same module at once. */
  unclaim(key: string): void;
};

/** The kernel's wake inbox (wakes.ts's table) as admission uses it. */
export const wakeInbox = (db: DatabaseSync): Wakes => ({
  claimed: (module, key) => db.prepare("SELECT task, agent, cause, at FROM wakes WHERE key = ? AND state = 'claimed' AND claimed_by = ? AND job IS NULL").get(key, module) as Wake | undefined,
  bind: (key, job) => { db.prepare("UPDATE wakes SET job = ? WHERE key = ?").run(job, key); },
  endWaits: (key) => {
    const waits = db.prepare("SELECT key FROM wakes WHERE task = (SELECT task FROM wakes WHERE key = ?) AND state = 'open' AND key LIKE 'wait:%' AND key != ?").all(key, key) as { key: string }[];
    for (const w of waits) db.prepare("UPDATE wakes SET state = 'dropped', until = NULL WHERE key = ?").run(w.key);
    return waits.map((w) => w.key);
  },
  unclaim: (key) => { db.prepare("UPDATE wakes SET job = NULL, until = 0 WHERE key = ?").run(key); },
});
/** `fresh`: the last job asked for a fresh session (`aidenhq reset`): no session resumes, the dispatcher's included. */
export type Admitted = { id: string; module: string; agent: string; task: string; identifier: string; profile: Profile; authority: Authority; prompt: string; fullPrompt?: string; fresh: boolean; wake: string };

const LIVE = "state IN ('admitted', 'running')";
const ID = /^[\w.:-]{1,200}$/;

export function createAdmission({ db, grants, kinds, capacity, pool, spend, mayDispatch, cp, wakes, nextTurn, launch, release, facts, routineKey = () => undefined, log }: {
  /** A Paperclip routine's compiled key (grants.json routine_keys): a routine run's task names its routine (originId), so a
   * later job on it (a retry, a reopen) is still that routine's. */
  routineKey?: (id: string) => string | undefined;
  /** Flow's fact log (facts.ts): job.queued and wake.bound with a job's first start (jobs.ts queueFacts) or its couldn't-start end, job.held when it is refused or deferred. */
  facts?: Facts;
  /** What the task's last job asked of this turn (jobtools.ts): read in the transaction, spent once the job has started. */
  nextTurn: Pick<JobTools, "pending" | "taken" | "refusal">;
  /** kernel.db, with the jobs table (jobs.ts) already made. */
  db: DatabaseSync;
  grants: () => Record<string, AgentGrant | undefined>;
  /** Write kinds (config/kernel/writes.json and the kernel's): a job may request the reviewed ones (floor 1+) whose tools it
   * holds; an engineer job also the code host's kinds and kernel.apply. */
  kinds: () => Record<string, { module: string; floor: number; tools: string[]; filer?: string }>;
  /** settings.computers_max (config/computers.json `max`): the launcher's pool, so no job is admitted it can't box. */
  capacity: () => number;
  /** The computer pool (pool.ts): agent jobs take at most `capacity`, apart from check jobs' own number. */
  pool: Pool;
  /** The spend limits a new job of this agent on this task would start over (the gateway's `exhausted`). */
  spend: (agent: string, task: string) => { scope: string }[];
  mayDispatch: (module: string, agent: string) => boolean;
  cp: { task(id: string): Promise<{ id: string; identifier?: string; assigneeAgentId?: string | null; status?: string; description?: string | null; originKind?: string | null; originId?: string | null; createdByAgentId?: string | null } | undefined> };
  wakes: Wakes;
  /** Gets the job its computer and starts it (boxes.ts); a 503 means the computers are full: the job waits for the next tick. */
  launch: (job: Admitted) => Promise<void>;
  /** Gives a job's box back (boxes.ts); a box the launcher can't take back now lapses with its lease. */
  release: (job: string) => Promise<void>;
  log: (msg: string, fields?: Record<string, unknown>) => void;
}) {
  // Strict: each fact is written in the transaction of the change it describes, which fails with it.
  const fact = facts ? strictFact(facts) : () => {};
  /** The jobs this process admitted and is launching now: its drain waits for them, and recover() never takes them. */
  // Who filed a task with no agent creator, as the kernel itself saw it: the owner on the board (cp.ts createBoardCp) or a module
  // through /v1/tasks with the role it filed to (modtasks.ts). Made here too, so admission reads it in any order.
  db.exec("CREATE TABLE IF NOT EXISTS task_filers (task TEXT PRIMARY KEY, filer TEXT NOT NULL)");
  const launching = new Set<string>();
  const keyOf = (agent: string) => grants()[agent]?.key ?? agent;
  /**
   * Why an admission waits (flow's idle reasons), once per wake and reason. It follows a refusal or a deferral that already
   * happened, so it moves nothing: one that can't be written is logged and the admission's own answer stands.
   */
  const held = (wake: string, task: string, agent: string, reason: string) => {
    try {
      fact({ type: "job.held", subject: `wake:${wake}`, version: `${wake}:${reason}`, at: iso(Date.now()), actor: `agent:${keyOf(agent)}`, task, data: { reason } });
    } catch (e) {
      log("job.held not recorded", { wake, task, reason, err: (e as Error).message });
    }
  };

  /**
   * Platform authority comes only from a known filer, never from a missing one: a job holds the platform-engineer role on a
   * task the owner filed (on the board or with his own message: cp.ts, channels.ts), one the Architect or the Fleet Steward filed (the control plane's creator: the kernel's plugin creates a job's task as that job's
   * agent, and no write changes it), or a routine's run (an event routine never runs as a platform agent: compile). Anything
   * else (a Slack mention, a module's task, a task whose filer the kernel never saw) holds no platform authority.
   */
  function platformTask(t: { id?: string; originKind?: string | null; createdByAgentId?: string | null }): boolean {
    if (t.originKind === "routine_execution") return true;
    if (t.createdByAgentId) return heldRoles(grants(), t.createdByAgentId).some((r) => PLATFORM_FILERS.includes(r));
    const filer = t.id ? (db.prepare("SELECT filer FROM task_filers WHERE task = ?").get(t.id) as { filer: string } | undefined)?.filer : undefined;
    return filer === "owner";
  }

  function freeze(g: AgentGrant, key: string | undefined, platform: boolean): Authority {
    const profile: Profile = g.profile ?? "crew";
    if (!PROFILES.includes(profile)) throw new JobError(403, "bad-profile", `profile ${profile} isn't one of ${PROFILES.join(", ")}`);
    const routine = key ? g.routines?.[key] : undefined;
    // A check job runs repo code: no tools, no writes, nothing to reach.
    const tools = profile === "check" ? {} : Object.fromEntries(Object.entries(g.tools ?? {}).map(([c, t]) => [c, [...t]]));
    const holds = (ct: string) => { const [c, t] = ct.split("."); return Boolean(tools[c!]?.includes(t!)); };
    // An Engineer publishes its workspace's commits (push, PR, merge, close, a new repo) and applies instance changes: each
    // a record its tier decides, filed with the job's own workspace.
    const engineer = (id: string, k: { module: string }) => profile === "engineer" && (CODEHOSTS.includes(k.module) || id === "kernel.apply");
    // A kind only the owner's own save files (`filer: owner`, a share's publish) is no job's.
    const writes = Object.entries(kinds()).filter(([id, k]) => !k.filer && ((k.floor >= 1 && k.tools.length > 0 && k.tools.some(holds)) || engineer(id, k))).map(([id]) => id).sort();
    return {
      profile, image: g.image ?? IMAGE[profile], engine: String(g.engine ?? ""), engines: [...(g.engines ?? [g.engine ?? ""])].filter(Boolean), model: String(routine?.model ?? g.model ?? ""), effort: String(routine?.effort ?? g.effort ?? ""),
      models: [...(g.models ?? [])], skills: (g.skills ?? []).map((k) => ({ ...k })), tools, jobcaps: profile === "check" ? [] : [...(g.jobcaps ?? [])], writes,
      roles: profile === "check" ? [] : (g.roles ?? []).filter((r) => platform || r !== PLATFORM),
      web: g.web_search !== "disabled",
    };
  }

  async function admit(module: string, b: { wake: string; prompt: string; full_prompt?: string }) {
    if (!b || typeof b !== "object" || !ID.test(String(b.wake)) || typeof b.prompt !== "string" || (b.full_prompt !== undefined && typeof b.full_prompt !== "string")) throw new JobError(400, "bad-request", "send {wake, prompt, full_prompt?}");
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
      const own = grants()[agent];
      if (!own) throw new JobError(403, "no-grants", `agent ${agent} has no grants`);
      if (own.team) throw new JobError(409, "team-record", `agent ${agent} is team ${own.team.name}'s record: the kernel routes its tasks to a member, and it never runs`);
      // A member holds its team record's roles (heldRoles); the platform filter below still applies.
      const g: AgentGrant = { ...own, roles: heldRoles(grants(), agent) };
      if (!pool.mayAgent()) throw new JobError(429, "busy", `the computers agent jobs may take are taken (of ${capacity()}); try again shortly`);
      const mine = (db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE agent = ? AND ${LIVE}`).get(agent) as { n: number }).n;
      if (mine >= (g.max_parallel ?? 1)) throw new JobError(429, "max-parallel", `agent ${agent} already runs ${mine} job(s), its max_parallel`);
      const over = spend(agent, task);
      if (over.length) throw new JobError(429, "over-cap", `${over.map((o) => (o.scope === "task" ? "the task's spend cap" : `the install's ${o.scope === "day" ? "daily" : "monthly"} spend limit`)).join(" and ")} is used up`);
      // The routine whose run this is: the wake's cause, else the routine its task came from (a retry or reopen of a run).
      const routineOf = /^routine:(.+)$/.exec(w.cause)?.[1] ?? (t.originKind === "routine_execution" && t.originId ? routineKey(t.originId) : undefined);
      const authority = freeze(g, routineOf, platformTask(t));
      // The last job's `aidenhq engine`: applied when the agent may still run it now, else ignored loudly (refusing would
      // wedge the task: the request would stand at every retry). Never widens `models`.
      const asked = nextTurn.pending(task);
      if (asked?.engine) {
        const why = nextTurn.refusal(asked.engine, authority);
        if (why) log("a job's next-turn engine request is ignored", { job: asked.job, task, why });
        else Object.assign(authority, { engine: asked.engine.kind }, asked.engine.model ? { model: asked.engine.model } : {});
      }
      const fresh = asked?.fresh === true;
      db.prepare("INSERT INTO jobs (id, module, agent, task, engine, pid, log, dir, at, jobcaps, observing, live_input, state, profile, wake, authority, routine, identifier) VALUES (?, ?, ?, ?, ?, 0, '', '', ?, ?, 0, 0, 'admitted', ?, ?, ?, ?, ?)")
        .run(id, module, agent, task, authority.engine, Date.now(), JSON.stringify(authority.jobcaps), authority.profile, b.wake, JSON.stringify(authority), routineOf ?? null, identifier);
      wakes.bind(b.wake, id);
      db.exec("COMMIT");
      job = { id, module, agent, task, identifier, profile: authority.profile, authority, prompt: b.prompt, ...(b.full_prompt ? { fullPrompt: b.full_prompt } : {}), fresh, wake: b.wake };
    } catch (e) {
      if (db.isTransaction) db.exec("ROLLBACK");
      const reason = ({ busy: "capacity", "max-parallel": "max_parallel", "over-cap": "spend_cap" } as Record<string, string>)[(e as JobError).code];
      if (reason) held(b.wake, task, agent, reason);
      throw e;
    }
    log("job admitted", { job: id, module, agent, task, profile: job.authority.profile });
    launching.add(id);
    try {
      await launch(job);
    } catch (e) {
      launching.delete(id);
      if ((e as { status?: number }).status !== 503) {
        const why = `couldn't start: ${(e as Error).message}`.slice(0, 500);
        // The end and its fact in one transaction. If they can't be written the row stays admitted (the task runs nothing more)
        // until the next kernel's recover() gives its wake back.
        try {
          inTx(db, "job_unstarted", () => {
            if (db.prepare("UPDATE jobs SET state = 'failed', final = ?, ended = ? WHERE id = ? AND state = 'admitted'").run(why, Date.now(), id).changes) {
              queueFacts(db, fact, id, keyOf(agent));
              fact({ type: "job.ended", subject: `job:${id}`, version: "ended", at: iso(Date.now()), actor: `agent:${keyOf(agent)}`, task, data: { state: "failed", exit: null, why, model: "", cost_usd: 0, input: 0, cached: 0, output: 0, acted: false } });
            }
          });
        } catch (fe) {
          log("a job that couldn't start isn't recorded as ended", { job: id, task, err: (fe as Error).message });
        }
        throw e;
      }
      const v = view(id);
      defer(id, b.wake);
      const reason = (e as JobError).code === "launcher-unavailable" ? "launcher_unavailable" : "no_computer";
      held(b.wake, task, agent, reason);
      log("job deferred", { job: id, task, reason, err: (e as Error).message.slice(0, 300) });
      return { ...v, state: "deferred" };
    }
    launching.delete(id);
    nextTurn.taken(task);
    // The job is running: its waits and their facts end together, and a failure here never fails the admission.
    try {
      inTx(db, "waits_end", () => { for (const k of wakes.endWaits(b.wake)) fact({ type: "wake.dropped", subject: `wake:${k}`, version: "dropped", at: iso(Date.now()), actor: "kernel", task, data: { why: "the task's next job started" } }); });
    } catch (e) {
      log("a started job's waits stay armed", { job: id, task, err: (e as Error).message });
    }
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
    /**
     * Once the previous kernel has exited (main.ts afterPrevious: a draining kernel may still be launching what it admitted): a
     * job admitted but never started by it never runs; its box (it may have been cloning) goes back, then its wake. This
     * process's own launches are never touched.
     */
    async recover() {
      const rows = db.prepare("SELECT id, wake FROM jobs WHERE state = 'admitted'").all() as { id: string; wake: string }[];
      await Promise.all(rows.filter((r) => !launching.has(r.id)).map(async (r) => {
        await release(r.id).catch((e: Error) => log("couldn't release an abandoned launch's computer", { job: r.id, err: e.message }));
        defer(r.id, r.wake);
      }));
    },
    /** Launches in flight in this process (a drain waits for them). */
    inflight: () => launching.size,
  };
}
export type Admission = ReturnType<typeof createAdmission>;
