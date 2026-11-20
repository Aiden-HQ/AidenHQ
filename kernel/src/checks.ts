// P5 checks at task.finish (spec §3.5): the finish gate every move to `done` passes, an agent's own (a module acting for it) through
// /v1/cp/agent (cp.ts) and the runner's own closes through /v1/finish. A module declares its checks (`checks:`, compiled
// into config/kernel/checks.json); all that match run in parallel and none sees another's verdict. Any deny refuses the
// close and moves nothing; any reopen reopens; any hold or pending holds the task in review with the check's label and a
// scheduled check; otherwise it passes. A check never marks a task done. Fail closed: a check that errors, answers non-2xx
// or malformed, or takes over 10 s refuses the close, and so do a checks file that is missing or won't load, and a graded
// agent's task (the grants table's `graded`) that no check covers: the gate never fails open. The one exception is a service
// being replaced: a check whose address doesn't resolve yet or whose socket refuses is asked again a few times, and if it is
// still down an enforcing check holds the task in review for its scheduled re-check rather than refusing a finish that would
// be lost. The check's module later
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
import { inTx, strictFact } from "./factlog.ts";
import { parseGraderNote, type GraderNote } from "./grader-note.ts";

export type Check = { module: string; at: string; url: string; rubric?: string; grade?: string; auth_secret: string; agents?: string[]; label?: string; mode?: "observe" };
type Verdict = { verdict: "ok" | "hold" | "pending" | "reopen" | "deny"; reason?: string; until?: string; state?: string; status?: number; unlabel?: boolean; accepts?: boolean };
export type Finish = { pass: true } | { pass: false; held: true; state: string; reason: string } | { pass: false; reopened: true; reason: string };
type Issue = { id: string; identifier?: string; companyId?: string; status?: string; assigneeAgentId?: string | null; assigneeUserId?: string | null; createdByAgentId?: string | null; parentId?: string | null; labelIds?: string[]; labels?: { id: string; name?: string }[]; executionPolicy?: Record<string, unknown> | null };
/** A hold's resolving verdicts and the status each moves the task to. */
const RESOLVES = new Map([["ok", "done"], ["reopen", "todo"], ["block", "blocked"]]);
const VERDICTS = ["ok", "hold", "pending", "reopen", "deny"];
/** The follow-up deadline for a holding check that named none: the task's review path is saved for an hour, never left unscheduled. */
const DEFAULT_HOLD_CHECK_MS = 60 * 60_000;
/** A check's service mid-replacement: how often its address is re-inspected and asked, and how long between attempts. */
const ASK_ATTEMPTS = 3;
const ASK_BACKOFF_MS = 1_000;
/** Socket failures that mean the container isn't there yet (or anymore), not that the check refused. */
const TRANSIENT_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ETIMEDOUT"]);

/** A check nobody answered because its service is being replaced: the caller may hold the task and ask again, not fail the close. */
type Unavailable = Error & { unavailable: true };
const unavailable = (e: Error): Unavailable => Object.assign(e, { unavailable: true as const });
const isUnavailable = (e: unknown) => (e as { unavailable?: boolean } | null)?.unavailable === true;

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

export function createChecks({ db, registry, owner, secret, resolver, agentKey = () => undefined, graded = () => false, pending = () => [], localChanges = async () => [], released = async () => {}, log = () => {} }: {
  db: DatabaseSync; registry: () => Record<string, Check>; owner: Api; secret: (n: string) => string; resolver: Resolver;
  /** An agent id's key (the grants table), for a check scoped to `agents`. */
  agentKey?: (id: string) => string | undefined;
  /** Whether an agent's work is graded (the grants table): its task closes only through a check. */
  graded?: (id: string) => boolean;
  /** The task's records still undecided (records.list over review, owner and approved): none may when it closes. */
  pending?: (task: string) => { id: string; kind: string }[];
  /** A task's own change requests on this server that are still open (codehost-local's host), with their checks: none may when it closes. */
  localChanges?: (task: { id: string; identifier?: string }) => Promise<{ url: string; checks: { ok: boolean; pending: boolean }[] }[]>;
  /** A hold released to the task's delegator (an escalated grade): with no open delegator, the chief of staff hears it (escalate.ts). */
  released?: (task: string, check: string) => Promise<unknown>;
  log?: (msg: string, f?: Record<string, unknown>) => void;
}) {
  db.exec("CREATE TABLE IF NOT EXISTS check_holds (task TEXT NOT NULL, check_id TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (task, check_id))");
  db.exec("CREATE TABLE IF NOT EXISTS graded_tasks (task TEXT PRIMARY KEY, module TEXT NOT NULL)"); // written by modtasks.ts
  const facts = openFacts(db);
  const strict = strictFact(facts);
  // Every hold the gate placed has its fact (task state reads a held task as waiting on the check's module); a hold recorded
  // before the fact was written gets it here, once (its id is the row's own).
  for (const r of db.prepare("SELECT task, check_id, at FROM check_holds").all() as { task: string; check_id: string; at: string }[]) strict(heldFact(r.task, r.check_id, r.at));
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

  /**
   * One POST to the check at `at`. A failure the service may shake off — the container being replaced, so its name resolves to
   * nothing or its socket refuses — is tagged `unavailable`; any other failure (a status, a malformed body, a timeout, a deny
   * wrapped in an error) is the check's own answer and is not.
   */
  function post(key: string, at: string, body: unknown): Promise<Verdict> {
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
      req.on("error", (e: NodeJS.ErrnoException) => { resolver.forget(at); reject(TRANSIENT_CODES.has(String(e.code)) ? unavailable(e) : e); });
      req.end(data);
    }), (e: Error) => { throw /isn't running/.test(String(e.message)) ? unavailable(e) : e; });
  }
  /**
   * A check's verdict, retried a few times when its service is unavailable (the address cache is dropped between attempts so a
   * replaced container is inspected afresh). A check that answered — any status, verdict, body or its 10 s timeout — is never
   * retried. When the service is still down the error carries `unavailable`, and the finish gate holds the task on it.
   */
  async function ask(id: string, c: Check, body: unknown, at = c.url): Promise<Verdict> {
    const key = secret(c.auth_secret);
    if (!key) throw fail(503, "check_failed", `the finish check ${id} failed (its key is missing): the task stays as it is`);
    for (let n = 1; ; n++) {
      try { return await post(key, at, body); }
      catch (e) {
        if (!isUnavailable(e) || n >= ASK_ATTEMPTS) throw Object.assign(fail(503, "check_failed", `the finish check ${id} failed (${(e as Error).message}): the task stays as it is; try again`), { unavailable: isUnavailable(e), cause: (e as Error).message });
        resolver.forget(at);
        await new Promise((r) => setTimeout(r, ASK_BACKOFF_MS));
      }
    }
  }

  /**
   * The finish gate for one task: `agent` and `tool` for an agent's own close, `via` for the runner's. Throws on a deny.
   * `cross`: an agent closing a task that is neither its job's own nor one its agent holds (its delegator's acceptance of an
   * escalated grade): refused before anything moves unless a check answers `accepts`, so no other cross-task close passes.
   * A task the closing agent holds (an orphaned run's task, say) is its own and asks the checks like its job's own task.
   */
  /** A finish check's verdict on a task (a grader's reopen, say): an outcome the routing learning loop trusts (routing-tune.ts), never its words. */
  const verdictEvent = (task: string, check: string, verdict: string) => noteFact(facts, verdictFact(task, check, verdict));

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
    // A task whose own change request on this server is still open does not close: a green-but-unmerged change is not shipped,
    // and a card approved on the closed task would be dropped (`the task is closed`). A store the gate can't read fails closed.
    await noOpenChange(i, "ask for the merge (a green change merges on its own once the reviewer approves it), then finish again");
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
    // An enforcing check whose service is still unavailable (a container being replaced) holds the task in review instead of
    // refusing the close: the scheduled re-check asks again once it is back, and a real verdict is never invented here.
    const [verdicts] = await Promise.all([Promise.all(mine.map(async ([id, c]) => {
      try { return { id, c, v: await ask(id, c, body) }; }
      catch (e) {
        // A cross-task close can only pass with the check's own `accepts`, so an unavailable service still fails it closed
        // (503, as before) instead of parking the task as if a verdict had been given.
        if (!isUnavailable(e) || caller.cross) throw e;
        const why = String((e as { cause?: unknown }).cause ?? (e as Error).message);
        log("finish check unavailable, holding", { task: i.identifier, check: id, err: why });
        return { id, c, v: { verdict: "pending" as const, state: "pending", reason: `the finish check ${id} couldn't be reached (${why}): the task waits in review while its service comes back` } };
      }
    })), watched]);
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
      // one it wakes the assignee to repair the review instead of leaving it to the check). A holding check that named no
      // `until` still saves one, at the default follow-up deadline.
      const ids = labelIds(i);
      const add = (await Promise.all(held.map((x) => (x.c.label ? label(i, x.c.label) : undefined)))).filter((l): l is { id: string } => Boolean(l) && !ids.includes(l!.id));
      const nextCheckAt = held.find((x) => x.v.until)?.v.until ?? new Date(Date.now() + DEFAULT_HOLD_CHECK_MS).toISOString();
      const monitor = i.assigneeAgentId && !i.assigneeUserId ? { executionPolicy: { ...(i.executionPolicy ?? {}), monitor: { nextCheckAt, notes: String(held[0]!.v.reason ?? "").slice(0, 500) } } } : {};
      await patch(i, { ...(i.status !== "in_review" ? { status: "in_review" } : {}), ...(add.length ? { labelIds: [...ids, ...new Set(add.map((l) => l.id))] } : {}), ...monitor });
      const at = new Date().toISOString();
      inTx(db, "finish_held", () => {
        for (const x of held) {
          db.prepare("INSERT OR REPLACE INTO check_holds (task, check_id, at) VALUES (?, ?, ?)").run(i.id, x.id, at);
          strict(heldFact(i.id, x.id, at));
        }
      });
      log("finish held", { task: i.identifier, via: caller.via, checks: held.map((x) => x.id) });
      return { pass: false, held: true, state: String(held[0]!.v.state ?? held[0]!.v.verdict), reason: String(held[0]!.v.reason ?? "") };
    }
    for (const x of verdicts) if (x.v.unlabel) await unlabel(i, x.c);
    return { pass: true };
  }

  /** Whether `c`'s label is on the task: by name when the read carries labels, else by the company's label id. */
  async function labelled(i: Issue, c: Check) {
    if (!c.label) return false;
    if ((i.labels ?? []).some((l) => l.name === c.label)) return true;
    const l = await label(i, c.label);
    return Boolean(l) && labelIds(i).includes(l!.id);
  }
  /** Whether the finish gate recorded its hold of the task: the `check_holds` row `finish()` wrote, which resolving a hold requires. */
  const recorded = (id: string, i: Issue) => Boolean(i.id) && db.prepare("SELECT 1 FROM check_holds WHERE task = ? AND check_id = ?").get(i.id, id) !== undefined;
  /**
   * Whether `id` holds the task for the grader's token: the recorded row, or — without one — a task still waiting in review
   * under this check's own label, which is what the gate puts on a task it holds and what a task left that way before hold rows
   * were written still carries. An observing check never holds, and no other label counts.
   */
  async function holds(id: string, c: Check, i: Issue) {
    if (recorded(id, i)) return true;
    return c.mode !== "observe" && i.status === "in_review" && (await labelled(i, c));
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
    if (b.verdict !== "release" && !recorded(id, i)) throw fail(409, "conflict", `${id} holds no finish on ${i.identifier ?? i.id}`);
    // A release hands the task to its delegator: only a task this check holds (its row, or in review under its label). On any
    // other task it changes nothing and records nothing, so a module can't move a task it never held.
    if (b.verdict === "release" && !(await holds(id, c, i))) return { ok: true, held: false };
    // A module's ok moves the task to done as the owner: the same hold as an agent's finish, so a change still open on this
    // server stops it too, before the hold is released.
    if (b.verdict === "ok") await noOpenChange(i, "the grader or the module that held it can move it on once the merge lands");
    // The move first, in one PATCH with the label's removal: the hold goes only once the task has moved, so a failed call leaves
    // it for the module's retry (and a retry never posts its comment twice).
    const comment = typeof b.comment === "string" && b.comment ? { comment: b.comment.slice(0, 60_000) } : {};
    if (to) {
      const l = c.label ? await label(i, c.label) : undefined;
      const ids = labelIds(i);
      await patch(i, { status: to, ...(l && ids.includes(l.id) ? { labelIds: ids.filter((x) => x !== l.id) } : {}), ...comment });
    } else await unlabel(i, c);
    // The hold ends with its verdict's fact; `release` is one too: the check hands the decision to the task's delegator
    // (grading's escalation), so task state reads the task, still in review, as waiting on its delegator.
    inTx(db, "finish_resolved", () => {
      db.prepare("DELETE FROM check_holds WHERE task = ? AND check_id = ?").run(i.id, id);
      strict(verdictFact(i.id, id, String(b.verdict)));
    });
    log("finish check resolved", { task: i.identifier, check: id, verdict: b.verdict });
    // Released with nobody to decide it: the chief of staff gets it. A failure is logged loudly; the release itself stands.
    if (b.verdict === "release") await released(i.id, id).catch((e: Error) => log("released hold reached nobody: the chief of staff wasn't told", { task: i.identifier, check: id, err: String(e.message).slice(0, 300) }));
    return { ok: true };
  }
  /**
   * A task's own change request on this server still open: refused, with what is true of it now. An open change on another
   * task holds nothing, and neither does one the task closed (closing writes its `closed` ref, so it is no longer open).
   */
  async function noOpenChange(i: { id: string; identifier?: string }, then: string) {
    let changes: Awaited<ReturnType<typeof localChanges>>;
    try {
      changes = await localChanges({ id: i.id, ...(i.identifier ? { identifier: i.identifier } : {}) });
    } catch (e) {
      log("local changes unread", { task: i.identifier ?? i.id, err: String((e as Error).message ?? e).slice(0, 200) });
      throw fail(503, "check_failed", `the finish gate couldn't read ${i.identifier ?? i.id}'s change requests on this server (${String((e as Error).message ?? e).slice(0, 200)}): the task stays as it is`);
    }
    if (!changes.length) return;
    const one = changes[0]!;
    const green = one.checks.length > 0 && one.checks.every((c) => c.ok);
    const settling = green ? "every named check is green, but the merge hasn't landed" : one.checks.some((c) => c.pending) ? "its checks are still running" : "its checks aren't all green";
    throw fail(409, "refused", `${i.identifier ?? i.id}'s change request ${one.url} is still open (${settling}). A task closes after its change merges: ${then}.`);
  }

  /** Whether one of this module's finish checks holds the task now (its label is on it): the module's work is that task. */
  const held = async (module: string, i: Issue) => {
    for (const [id, c] of finishing()) if (c.module === module && (await holds(id, c, i))) return true;
    return false;
  };
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
  /**
   * The latest verdict that sent a task's work back, for the AI reviewer (review-loop.ts): asked of the enforcing finish check
   * that keeps one (`grade:`), with its own key, and checked here. None keeps one: undefined, and the reviewer reads no note.
   */
  async function grade(task: string): Promise<GraderNote | undefined> {
    const keeper = finishing().find(([, c]) => c.grade && c.mode !== "observe");
    if (!keeper) return undefined;
    const v = (await ask(keeper[0], keeper[1], { task: { id: task } }, keeper[1].grade)) as Verdict & { grade?: unknown };
    return parseGraderNote(v.grade);
  }
  return { finish, resolve, held, rubric, grade };
}
export type Checks = ReturnType<typeof createChecks>;

/** The finish gate's hold of a task by one check (its `check_holds` row: the version is the row's own time). */
const heldFact = (task: string, check: string, at: string) => ({ type: "finish.held", subject: `task:${task}`, version: `${check}@${at}`, at, actor: "kernel", task, data: { check } });
/** A check's verdict on a task: ok, reopen or block resolve its hold, release hands the decision to the delegator. */
const verdictFact = (task: string, check: string, verdict: string) => ({ type: "finish.verdict", subject: `task:${task}`, version: `e-${randomBytes(8).toString("hex")}`, task, at: new Date().toISOString(), actor: "kernel", data: { check, verdict } });
