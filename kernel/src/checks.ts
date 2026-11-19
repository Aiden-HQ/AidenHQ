// P5 checks at task.finish (spec §3.5): the finish gate every move to `done` passes, an agent's own (a module acting for it) through
// /v1/cp/agent (cp.ts) and the runner's own closes through /v1/finish. A module declares its checks (`checks:`, compiled
// into config/kernel/checks.json); all that match run in parallel and none sees another's verdict. Any deny refuses the
// close and moves nothing; any reopen reopens; any hold or pending holds the task in review with the check's label and a
// scheduled check; otherwise it passes. A check never marks a task done. Fail closed: a check that errors, answers non-2xx
// or malformed, or takes over 10 s refuses the close, and so do a checks file that is missing or won't load, and a graded
// agent's task (the grants table's `graded`) that no check covers: the gate never fails open. The check's module later
// releases its label, or resolves a hold it placed (POST /v1/checks/:task). A check in observe mode (`mode: observe`, gates.ts)
// is asked like the others, but a verdict other than ok, or its failure, is only recorded as a would-block: it never moves,
// holds or refuses the task, and it doesn't count as covering a graded agent's task. A task with an undecided approval card
// (a record of its own in review, owner or approved) doesn't close, whatever the modules' checks say: the card would be
// claimed on a closed task and its write dropped, so it is refused until it is decided or has run (the `pending` source).
import http from "node:http";
import { randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type { Api } from "./channels.ts";
import type { Resolver } from "./net.ts";
import { gateMode } from "./gates.ts";
import { fail } from "./proxy.ts";
import { noteFact, openFacts } from "./facts.ts";

export type Check = { module: string; at: string; url: string; rubric?: string; auth_secret: string; agents?: string[]; label?: string; mode?: "observe" };
type Verdict = { verdict: "ok" | "hold" | "pending" | "reopen" | "deny"; reason?: string; until?: string; state?: string; status?: number; unlabel?: boolean; accepts?: boolean };
export type Finish = { pass: true } | { pass: false; held: true; state: string; reason: string } | { pass: false; reopened: true; reason: string };
type Issue = { id: string; identifier?: string; companyId?: string; status?: string; assigneeAgentId?: string | null; assigneeUserId?: string | null; createdByAgentId?: string | null; parentId?: string | null; labelIds?: string[]; labels?: { id: string }[]; executionPolicy?: Record<string, unknown> | null };
/** A hold's resolving verdicts and the status each moves the task to. */
const RESOLVES = new Map([["ok", "done"], ["reopen", "todo"], ["block", "blocked"]]);
const VERDICTS = ["ok", "hold", "pending", "reopen", "deny"];

/** config/kernel/checks.json, reread when it changes. Missing, unreadable or not a map throws: a load error, never "no checks". */
export function checksFile(file: string): () => Record<string, Check> {
  let cache: { mtimeMs: number; size: number; v: Record<string, Check> } | undefined;
  return () => {
    const st = statSync(file);
    if (!cache || cache.mtimeMs !== st.mtimeMs || cache.size !== st.size) {
      const v = JSON.parse(readFileSync(file, "utf8"));
      if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not a map of checks");
      cache = { mtimeMs: st.mtimeMs, size: st.size, v };
    }
    return cache.v;
  };
}

export function createChecks({ db, registry, owner, secret, resolver, agentKey = () => undefined, graded = () => false, pending = () => [], log = () => {} }: {
  db: DatabaseSync; registry: () => Record<string, Check>; owner: Api; secret: (n: string) => string; resolver: Resolver;
  /** An agent id's key (the grants table), for a check scoped to `agents`. */
  agentKey?: (id: string) => string | undefined;
  /** Whether an agent's work is graded (the grants table): its task closes only through a check. */
  graded?: (id: string) => boolean;
  /** The task's records still undecided (records.list over review, owner and approved): none may when it closes. */
  pending?: (task: string) => { id: string; kind: string }[];
  log?: (msg: string, f?: Record<string, unknown>) => void;
}) {
  db.exec("CREATE TABLE IF NOT EXISTS check_holds (task TEXT NOT NULL, check_id TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (task, check_id))");
  db.exec("CREATE TABLE IF NOT EXISTS graded_tasks (task TEXT PRIMARY KEY, module TEXT NOT NULL)"); // written by modtasks.ts
  const facts = openFacts(db);
  const finishing = () => {
    try {
      const all = Object.entries(registry()).filter(([, c]) => c.at === "task.finish" && c.url);
      for (const [id, c] of all) gateMode(id, c.mode);
      return all;
    } catch (e) {
      log("finish checks didn't load", { err: String((e as Error).message) });
      throw fail(503, "check_failed", `the finish gate is unavailable: the finish checks didn't load (${(e as Error).message}): the task stays as it is`);
    }
  };

  async function issue(ref: string): Promise<Issue> {
    const r = await owner("GET", `/api/issues/${encodeURIComponent(ref)}`);
    if (r.status === 404) throw fail(404, "not_found", `no task ${ref}`);
    if (r.status !== 200) throw fail(502, "upstream", `the control plane answered ${r.status}`);
    return r.json as Issue;
  }
  const labelIds = (i: Issue) => i.labelIds ?? (i.labels ?? []).map((l) => l.id);
  async function label(i: Issue, name: string) {
    const r = await owner("GET", `/api/companies/${encodeURIComponent(i.companyId ?? "")}/labels`);
    const l = (Array.isArray(r.json) ? r.json : []).find((x: { name?: string }) => x.name === name) as { id: string } | undefined;
    if (!l) log(`label "${name}" missing in the control plane (run the setup)`);
    return l;
  }
  async function patch(i: Issue, body: Record<string, unknown>) {
    if (!Object.keys(body).length) return;
    const r = await owner("PATCH", `/api/issues/${encodeURIComponent(i.id)}`, body);
    if (r.status >= 300) throw fail(502, "upstream", `the control plane answered ${r.status}`);
  }
  /** Removes a check's label from the task, if it carries it. */
  async function unlabel(i: Issue, c: Check) {
    const l = c.label ? await label(i, c.label) : undefined;
    const ids = labelIds(i);
    if (l && ids.includes(l.id)) await patch(i, { labelIds: ids.filter((x) => x !== l.id) });
  }

  function ask(id: string, c: Check, body: unknown, at = c.url): Promise<Verdict> {
    const key = secret(c.auth_secret);
    if (!key) return Promise.reject(new Error("its key is missing"));
    return resolver.resolve(at).then((to) => new Promise<Verdict>((resolve, reject) => {
      const data = Buffer.from(JSON.stringify(body));
      const req = http.request({ host: to.host, port: to.port, path: to.path, method: "POST", timeout: 10_000, headers: { host: new URL(at).host, authorization: `Bearer ${key}`, "content-type": "application/json", "content-length": data.length } }, (res) => {
        let text = "";
        res.setEncoding("utf8").on("data", (d) => { if (text.length < 100_000) text += d; }).on("end", () => {
          let v: Verdict;
          try { v = JSON.parse(text); } catch { return reject(new Error(`answered ${res.statusCode} with no JSON`)); }
          if ((res.statusCode ?? 500) >= 300 || !v || !VERDICTS.includes(v.verdict)) return reject(new Error(`answered ${res.statusCode}${v?.verdict ? ` (${v.verdict})` : ""}`));
          resolve(v);
        });
      });
      req.on("timeout", () => req.destroy(new Error("didn't answer in 10 s")));
      req.on("error", (e) => { resolver.forget(at); reject(e); });
      req.end(data);
    })).catch((e: Error) => { throw fail(503, "check_failed", `the finish check ${id} failed (${e.message}): the task stays as it is; try again`); });
  }

  /**
   * The finish gate for one task: `agent` and `tool` for an agent's own close, `via` for the runner's. Throws on a deny.
   * `cross`: an agent closing a task that isn't its job's own (its delegator's acceptance of an escalated grade): refused
   * before anything moves unless a check answers `accepts`, so no other cross-task close passes.
   */
  /** A finish check's verdict on a task (a grader's reopen, say): an outcome the routing learning loop trusts (routing-tune.ts), never its words. */
  const verdictEvent = (task: string, check: string, verdict: string) => noteFact(facts, { type: "finish.verdict", subject: `task:${task}`, version: `e-${randomBytes(8).toString("hex")}`, task, at: new Date().toISOString(), actor: "kernel", data: { check, verdict } });

  async function finish(ref: string, caller: { agent?: string; tool?: string; via: string; cross?: boolean }): Promise<Finish> {
    const refuseCross = () => fail(403, "forbidden", `only this job's own task is finished here; ${ref} is finished by its assignee, or accepted by its delegator once grading has escalated it`);
    const all = finishing();
    const i = await issue(ref);
    // An approval card still undecided would be claimed on the closed task and fail its write (writes.ts run): the task
    // stays as it is until every card of it is decided or has run.
    const undecided = pending(i.id);
    if (undecided.length) {
      const named = undecided.slice(0, 10).map((r) => `${r.id} (${r.kind})`).join(", ");
      throw fail(409, "refused", `${undecided.length} approval${undecided.length === 1 ? " is" : "s are"} on ${i.identifier ?? i.id} still undecided: ${named}${undecided.length > 10 ? `, and ${undecided.length - 10} more` : ""}. They run when approved, so the task can't be done until they are decided: decide or reject them, or finish again once they have run.`);
    }
    const key = i.assigneeAgentId ? agentKey(i.assigneeAgentId) : undefined;
    const scoped = all.filter(([, c]) => !c.agents?.length || (key !== undefined && c.agents.includes(key)));
    const mine = scoped.filter(([, c]) => c.mode !== "observe");
    const observing = scoped.filter(([, c]) => c.mode === "observe");
    const task = { id: i.id, identifier: i.identifier, status: i.status, assigneeAgentId: i.assigneeAgentId ?? null, assigneeUserId: i.assigneeUserId ?? null, createdByAgentId: i.createdByAgentId ?? null, parentId: i.parentId ?? null, ...(db.prepare("SELECT 1 FROM graded_tasks WHERE task = ?").get(i.id) ? { graded: true } : {}) };
    const body = { task, agent: caller.agent ?? null, tool: caller.tool ?? null, via: caller.via };
    // Observing checks run beside the gate and never change its outcome.
    const watched = Promise.all(observing.map(async ([id, c]) => {
      let v: Verdict;
      try { v = await ask(id, c, body); } catch (e) { v = { verdict: "deny", reason: String((e as Error).message) }; }
      if (v.verdict === "ok") return;
      const entry = { gate: id, task: i.identifier ?? i.id, verdict: v.verdict, reason: String(v.reason ?? "").slice(0, 500), via: caller.via };
      noteFact(facts, { type: "gate.would_block", subject: `task:${entry.task}`, version: `e-${randomBytes(8).toString("hex")}`, task: i.id, at: new Date().toISOString(), actor: "kernel", data: entry });
      log("gate would block", entry);
    }));
    if (!mine.length) {
      await watched;
      if (i.assigneeAgentId && graded(i.assigneeAgentId)) throw fail(503, "check_failed", `the finish gate is unavailable: ${i.identifier ?? i.id}'s assignee is graded and no finish check covers it: the task stays as it is`);
      if (caller.cross) throw refuseCross();
      return { pass: true };
    }
    const [verdicts] = await Promise.all([Promise.all(mine.map(async ([id, c]) => ({ id, c, v: await ask(id, c, body) }))), watched]);
    if (caller.cross && !verdicts.some((x) => x.v.verdict === "ok" && x.v.accepts)) throw refuseCross();
    const deny = verdicts.find((x) => x.v.verdict === "deny");
    if (deny) throw fail(deny.v.status === 409 ? 409 : 403, "refused", String(deny.v.reason ?? `refused by ${deny.id}`).slice(0, 500));
    const reopen = verdicts.find((x) => x.v.verdict === "reopen");
    if (reopen) {
      const reason = String(reopen.v.reason ?? "").slice(0, 2000);
      for (const x of verdicts) await unlabel(i, x.c);
      await patch(i, { status: "todo", ...(reason ? { comment: `[${reopen.id}] ${reason}` } : {}) });
      verdictEvent(i.id, reopen.id, "reopen");
      log("finish reopened", { task: i.identifier, check: reopen.id });
      return { pass: false, reopened: true, reason };
    }
    const held = verdicts.filter((x) => x.v.verdict === "hold" || x.v.verdict === "pending");
    if (held.length) {
      // In review, with each holding check's label and the first scheduled check (the control plane's review path: without
      // one it wakes the assignee to repair the review instead of leaving it to the check).
      const ids = labelIds(i);
      const add = (await Promise.all(held.map((x) => (x.c.label ? label(i, x.c.label) : undefined)))).filter((l): l is { id: string } => Boolean(l) && !ids.includes(l!.id));
      const timed = held.find((x) => x.v.until);
      const monitor = timed && i.assigneeAgentId && !i.assigneeUserId ? { executionPolicy: { ...(i.executionPolicy ?? {}), monitor: { nextCheckAt: timed.v.until, notes: String(timed.v.reason ?? "").slice(0, 500) } } } : {};
      await patch(i, { ...(i.status !== "in_review" ? { status: "in_review" } : {}), ...(add.length ? { labelIds: [...ids, ...new Set(add.map((l) => l.id))] } : {}), ...monitor });
      for (const x of held) db.prepare("INSERT OR REPLACE INTO check_holds (task, check_id, at) VALUES (?, ?, ?)").run(i.id, x.id, new Date().toISOString());
      log("finish held", { task: i.identifier, via: caller.via, checks: held.map((x) => x.id) });
      return { pass: false, held: true, state: String(held[0]!.v.state ?? held[0]!.v.verdict), reason: String(held[0]!.v.reason ?? "") };
    }
    for (const x of verdicts) if (x.v.unlabel) await unlabel(i, x.c);
    return { pass: true };
  }

  /**
   * A check's module on a task: `release` takes its label off (the hold is over; the module's own flow moves the task on);
   * `ok`, `reopen` and `block` resolve a hold this check placed, moving the task to done, todo or blocked as the owner. Only
   * the check's own module, and ok/reopen/block only on a task it holds.
   */
  async function resolve(module: string, ref: string, b: { check?: unknown; verdict?: unknown; comment?: unknown }) {
    const mine = finishing().filter(([id, c]) => c.module === module && (b.check === undefined || id === `${module}.${String(b.check)}`));
    if (mine.length !== 1) throw fail(403, "forbidden", `${module} has ${mine.length ? "several finish checks: name one (check)" : "no finish check"}`);
    const [id, c] = mine[0]!;
    const to = RESOLVES.get(String(b.verdict));
    if (!to && b.verdict !== "release") throw fail(400, "bad_request", "verdict is release, ok, reopen or block");
    const i = await issue(ref);
    const held = db.prepare("SELECT 1 FROM check_holds WHERE task = ? AND check_id = ?").get(i.id, id);
    if (b.verdict !== "release" && !held) throw fail(409, "conflict", `${id} holds no finish on ${i.identifier ?? i.id}`);
    await unlabel(i, c);
    db.prepare("DELETE FROM check_holds WHERE task = ? AND check_id = ?").run(i.id, id);
    const comment = typeof b.comment === "string" && b.comment ? { comment: b.comment.slice(0, 60_000) } : {};
    if (to) await patch(await issue(i.id), { status: to, ...comment });
    if (to) verdictEvent(i.id, id, String(b.verdict));
    log("finish check resolved", { task: i.identifier, check: id, verdict: b.verdict });
    return { ok: true };
  }
  /** Whether one of this module's finish checks holds the task now (its label is on it): the module's work is that task. */
  const held = (module: string, task: string) => finishing().some(([id, c]) => c.module === module && db.prepare("SELECT 1 FROM check_holds WHERE task = ? AND check_id = ?").get(task, id) !== undefined);
  /**
   * A rubric for a task a module filed (modtasks.ts, after its own check of kernel.tasks): asked of the finish checks that take
   * one (`rubric:`), with their own key, so the filer is the kernel's word and never a body field. They answer `ok`. None
   * takes one, or one fails: the filing fails and the module files again (same source, same task, same rubric row).
   */
  async function rubric(task: { id: string; identifier?: string }, module: string, b: { rubric: string[]; deliverable: unknown }) {
    const takers = finishing().filter(([, c]) => c.rubric);
    if (!takers.length) throw fail(409, "conflict", "no check takes a rubric, so this task can't be graded");
    for (const [id, c] of takers) await ask(id, c, { task, module, ...b }, c.rubric);
  }
  return { finish, resolve, held, rubric };
}
export type Checks = ReturnType<typeof createChecks>;
