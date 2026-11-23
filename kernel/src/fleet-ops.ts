// The Fleet Steward's operations (owner, 2026-11-23: "the Steward owns all fleet operations"): one typed kernel write,
// `kernel.fleet_op`, filed through its tool `fleet_steward.fleet_operate`, at floor 1 (the AI reviewer reads each one) and
// recorded like every write. Only an agent holding role fleet-settle may file it: the role is the requester's, from the
// kernel's identity, never the args. The ops:
//   pause_routine / resume_routine <routine id>   a routine's status in the control plane (resume re-saves its schedules first,
//                                                  so it starts at the next tick instead of catching up every missed one)
//   pause_agent / resume_agent <agent id>         an agent; never the chief of staff or the Steward itself
//   stop_run <task id>                             the task's running jobs end `cancelled`; the task stays open, with a note
//   restart_service <service>                      one compose service of a module, recreated under the host's apply lock
//   rollback last_good                             the host back to its last good apply generation (ops/rollback.sh's path:
//                                                  `aidenhq-apply --generation <n>`, under the apply lock)
// A resume undoes only a pause the Steward made itself (fleet_pauses, below) and that nobody changed since: a pause the owner
// or the chief of staff made stays theirs. The planner checks everything it can before the card; the executor checks again
// right before it acts, since an approved record runs later.
import type { DatabaseSync } from "node:sqlite";
import type { Requester, Rec } from "./records.ts";
import type { Kind, Schema } from "./writes.ts";

export const FLEET_OP = "kernel.fleet_op";
/** The role that files it (cp.ts SETTLE). */
const SETTLER = "fleet-settle";
/** Roles an agent pause never reaches: the chief of staff and the Steward itself. */
const UNPAUSABLE = ["fleet-admin", SETTLER];
const OPS = ["pause_routine", "resume_routine", "pause_agent", "resume_agent", "stop_run", "restart_service", "rollback"] as const;
type Op = (typeof OPS)[number];
const ARGS: Schema = {
  type: "object", additionalProperties: false, required: ["op", "target", "reason"],
  properties: {
    op: { type: "string", enum: [...OPS] },
    target: { type: "string", minLength: 1, maxLength: 100, pattern: "^[A-Za-z0-9][A-Za-z0-9_.:-]*$" },
    reason: { type: "string", minLength: 1, maxLength: 500, pattern: "^[^\\p{Cc}]+$" },
  },
};
export const FLEET_OP_KIND: Kind = { module: "kernel", floor: 1, tools: ["fleet_steward.fleet_operate"], args: ARGS };

type Api = (method: string, path: string, body?: unknown) => Promise<{ status: number; json: any }>;
type Gen = { n: number | null; product: string | null; health: string | null };
const refuse = (message: string, status = 422) => Object.assign(new Error(message), { status });

export function createFleetOps({ db, owner, roles, services, running, stop, note, generations, launch, recreate, log = () => {} }: {
  db: DatabaseSync;
  /** The control plane as the owner (main.ts ownerApi). */
  owner: Api;
  /** An agent's roles (the grants table). */
  roles: (agent: string) => string[];
  /** Every compose service a module runs (the compiled modules file's `services`). */
  services: () => string[];
  /** The task's running jobs (jobs.ts), and stopping them. */
  running: (task: string) => number;
  stop: (task: string) => { id: string; agent: string; task: string }[];
  /** A note on a stopped job's task (outcomes.ts post, kind notice): it wakes nobody. */
  note: (job: { id: string; agent: string; task: string }, body: string) => Promise<unknown>;
  /** The host's apply generations, newest first (generations.ts). */
  generations: () => Gen[];
  /** Starts `aidenhq-apply --unit <unit> <args…>` (apply.ts hostApply launch). */
  launch: (unit: string, args: string[]) => Promise<void>;
  /** Recreates compose services under the apply lock (module-secrets.ts composeRecreate). */
  recreate: (services: string[]) => Promise<void>;
  log?: (msg: string, f?: Record<string, unknown>) => void;
}) {
  db.exec("CREATE TABLE IF NOT EXISTS fleet_pauses (target TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, at TEXT NOT NULL, record TEXT NOT NULL)");
  type Row = { target: string; kind: string; name: string; at: string; record: string };
  const row = (target: string) => db.prepare("SELECT * FROM fleet_pauses WHERE target = ?").get(target) as Row | undefined;

  async function routine(id: string) {
    const r = await owner("GET", `/api/routines/${encodeURIComponent(id)}`);
    if (r.status === 404) throw refuse(`no routine ${id}`);
    if (r.status !== 200) throw refuse(`the control plane answered ${r.status} reading routine ${id}`, 502);
    return r.json as { id: string; title?: string; status?: string; triggers?: { id?: string; kind?: string; enabled?: boolean; cronExpression?: string; timezone?: string }[] };
  }
  async function agent(id: string) {
    const r = await owner("GET", `/api/agents/${encodeURIComponent(id)}`);
    if (r.status === 404) throw refuse(`no agent ${id}`);
    if (r.status !== 200) throw refuse(`the control plane answered ${r.status} reading agent ${id}`, 502);
    return r.json as { id: string; name?: string; status?: string };
  }
  const pausedNow = (status?: string) => status === "paused";

  /** What the op does now, checked against the live state: its card's words, or `satisfied` when nothing is left to do. */
  async function check(op: Op, target: string): Promise<{ sentence: string; name: string; satisfied?: string }> {
    switch (op) {
      case "pause_routine": case "resume_routine": {
        const r = await routine(target), name = String(r.title ?? target).slice(0, 100);
        if (op === "pause_routine") return pausedNow(r.status) ? { sentence: "", name, satisfied: `routine ${name} is already paused` } : { sentence: `Pause routine ${name}.`, name };
        return { ...(await resumable(`routine:${target}`, r, name)), sentence: `Resume routine ${name}.`, name };
      }
      case "pause_agent": case "resume_agent": {
        const a = await agent(target), name = String(a.name ?? target).slice(0, 100);
        if (op === "pause_agent") {
          if (roles(target).some((x) => UNPAUSABLE.includes(x))) throw refuse(`${name} is the chief of staff or the Steward: it is never paused this way`, 403);
          return pausedNow(a.status) ? { sentence: "", name, satisfied: `agent ${name} is already paused` } : { sentence: `Pause agent ${name}.`, name };
        }
        return { ...(await resumable(`agent:${target}`, a, name)), sentence: `Resume agent ${name}.`, name };
      }
      case "stop_run":
        return running(target) ? { sentence: `Stop the running jobs of task ${target}, leaving it open.`, name: target } : { sentence: "", name: target, satisfied: `no job runs on task ${target}` };
      case "restart_service":
        if (!services().includes(target)) throw refuse(`no module service ${target} (a compose service a module runs)`);
        return { sentence: `Restart service ${target} (recreated under the apply lock).`, name: target };
      case "rollback": {
        if (target !== "last_good") throw refuse("a rollback's target is last_good: the kernel picks the generation");
        const to = lastGood();
        return { sentence: `Roll this host back to apply generation ${to.n} (product ${String(to.product).slice(0, 12)}), its last good one.`, name: `generation ${to.n}` };
      }
    }
  }

  /**
   * A resume only of the Steward's own pause: else refused (the owner's or the chief of staff's pause stays theirs). A target
   * found running again drops the Steward's row (someone resumed it, so the pause is no longer the Steward's).
   */
  async function resumable(key: string, live: { status?: string }, name: string): Promise<{ satisfied?: string }> {
    const mine = row(key);
    if (!pausedNow(live.status)) {
      if (mine) db.prepare("DELETE FROM fleet_pauses WHERE target = ?").run(key);
      return { satisfied: `${name} isn't paused (someone resumed it)` };
    }
    if (!mine) throw refuse(`${name} wasn't paused by the Steward: resuming it is the owner's (or the chief of staff's)`, 403);
    return {};
  }

  /** The newest good generation older than the one running now. */
  function lastGood(): Gen {
    const gens = generations().filter((g) => g.health !== "refused");
    const current = gens[0];
    const to = gens.slice(1).find((g) => g.health === "good" && typeof g.n === "number");
    if (!current || !to) throw refuse("no earlier good apply generation to roll back to");
    return to;
  }

  function requireSettler(requester: Requester) {
    if (!(requester.roles ?? []).includes(SETTLER)) throw refuse("only the Fleet Steward (role fleet-settle) operates the fleet this way", 403);
  }

  return {
    /** The kind's planner (writes.ts planners): the card, from the live state. */
    async plan({ args, requester }: { args: unknown; requester: Requester }) {
      requireSettler(requester);
      const a = args as { op: Op; target: string; reason: string };
      const c = await check(a.op, a.target);
      const card = { target: `${a.op} ${a.target}`, sentence: c.sentence || `${a.op} ${a.target}: nothing to do.`, changes: `${c.sentence} Why (the Steward's words): ${a.reason}`, reads: "Nothing new.", cost: "No model cost.", details: `op: ${a.op}\ntarget: ${a.target} (${c.name})\nreason: ${a.reason}` };
      return { args: a, targets: { target: { op: a.op, id: a.target } }, card, ...(c.satisfied ? { satisfied: { evidence: c.satisfied } } : {}) };
    },
    /** The kind's executor (writes.ts native): checks again, then acts. */
    async execute(r: Rec): Promise<{ ok: boolean; text: string }> {
      requireSettler(r.requester);
      const { op, target, reason } = r.args as { op: Op; target: string; reason: string };
      const c = await check(op, target);
      if (c.satisfied) return { ok: true, text: `Nothing to do: ${c.satisfied}.` };
      switch (op) {
        case "pause_routine": case "resume_routine": {
          const t = await routine(target);
          // Only a paused routine's schedules are re-saved on resume: that moves each next run to the next tick from now.
          if (op === "resume_routine") for (const tr of (t.triggers ?? []).filter((x) => x.kind === "schedule" && x.enabled && x.id && x.cronExpression)) {
            const s = await owner("PATCH", `/api/routine-triggers/${tr.id}`, { cronExpression: tr.cronExpression, ...(tr.timezone ? { timezone: tr.timezone } : {}), enabled: true });
            if (s.status !== 200) throw refuse(`the control plane answered ${s.status} re-saving a schedule`, 502);
          }
          const u = await owner("PATCH", `/api/routines/${encodeURIComponent(target)}`, { status: op === "pause_routine" ? "paused" : "active" });
          if (u.status !== 200) throw refuse(`the control plane answered ${u.status}`, 502);
          remember(op === "pause_routine", `routine:${target}`, "routine", c.name, r.id);
          break;
        }
        case "pause_agent": case "resume_agent": {
          const u = await owner("POST", `/api/agents/${encodeURIComponent(target)}/${op === "pause_agent" ? "pause" : "resume"}`, {});
          if (u.status !== 200) throw refuse(`the control plane answered ${u.status}`, 502);
          remember(op === "pause_agent", `agent:${target}`, "agent", c.name, r.id);
          break;
        }
        case "stop_run": {
          const stopped = stop(target);
          for (const j of stopped) await note(j, `**Stopped by the Fleet Steward:** ${reason.slice(0, 300)} (${r.id}). The task stays open.`).catch((e: Error) => log("stop note failed", { job: j.id, err: e.message }));
          log("fleet op", { op, target, stopped: stopped.length, record: r.id });
          return { ok: true, text: `Stopped ${stopped.length} job${stopped.length === 1 ? "" : "s"} on ${target}; the task stays open.` };
        }
        case "restart_service":
          await recreate([target]);
          break;
        case "rollback": {
          const to = lastGood();
          const unit = `aidenhq-apply-rollback-${r.id.replace(/[^A-Za-z0-9-]/g, "").slice(0, 40)}`;
          await launch(unit, ["--generation", String(to.n)]);
          log("fleet op", { op, target, generation: to.n, unit, record: r.id });
          return { ok: true, text: `Rollback to generation ${to.n} queued as ${unit} (under the apply lock). The next apply of the instance's main moves the host forward again: land the fix before it.` };
        }
      }
      log("fleet op", { op, target, record: r.id });
      return { ok: true, text: `${c.sentence.replace(/\.$/, "")}: done.` };
    },
    /** The Steward's open pauses (GET /v1/work?pauses=1): the detector keeps each one an incident until it is resumed. */
    pauses: () => (db.prepare("SELECT target, kind, name, at FROM fleet_pauses ORDER BY at").all() as Row[]).map(({ target, kind, name, at }) => ({ target, kind, name, at })),
  };

  function remember(paused: boolean, target: string, kind: string, name: string, record: string) {
    if (paused) db.prepare("INSERT OR REPLACE INTO fleet_pauses (target, kind, name, at, record) VALUES (?, ?, ?, ?, ?)").run(target, kind, name, new Date().toISOString(), record);
    else db.prepare("DELETE FROM fleet_pauses WHERE target = ?").run(target);
  }
}
export type FleetOps = ReturnType<typeof createFleetOps>;
