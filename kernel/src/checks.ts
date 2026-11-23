// P5 checks at task.finish (spec §3.5): the finish gate every move to `done` passes, an agent's own (a module acting for it) through
// /v1/cp/agent (cp.ts) and the runner's own closes through /v1/finish. A module declares its checks (`checks:`, compiled
// into config/kernel/checks.json); all that match run in parallel and none sees another's verdict. Any deny refuses the
// close and moves nothing; any reopen reopens; any hold or pending holds the task in review with the check's label and a
// scheduled check; otherwise it passes. A check never marks a task done. Fail open on infrastructure: a check that errors,
// answers non-2xx or malformed, takes over 10 s or can't be reached (a socket that refuses is asked again a few times first)
// holds the task in review for its scheduled re-check rather than refusing a finish that would be lost; only an explicit deny
// or reopen refuses. A graded agent's task that no check covers passes, recorded as a would-block note (owner, 2026-11-21).
// A checks file that is missing or won't load still refuses. The check's module later resolves a hold it placed
// (POST /v1/checks/:task). A check in observe mode (`mode: observe`, gates.ts)
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
type Verdict = { verdict: "ok" | "hold" | "pending" | "reopen" | "deny"; reason?: string; until?: string; state?: string; status?: number };
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

export function createChecks({ db, registry, owner, secret, resolver, agentKey = () => undefined, graded = () => false, pending = () => [], localChanges = async () => [], log = () => {} }: {
  db: DatabaseSync; registry: () => Record<string, Check>; owner: Api; secret: (n: string) => string; resolver: Resolver;
  /** An agent id's key (the grants table), for a check scoped to `agents`. */
  agentKey?: (id: string) => string | undefined;
  /** Whether an agent's work is graded (the grants table): its task closes only through a check. */
  graded?: (id: string) => boolean;
  /** The task's records still undecided (records.list over review, owner and approved): none may when it closes. */
  pending?: (task: string) => { id: string; kind: string }[];
  /** A task's own change requests on this server that are still open (codehost-local's host), with their checks: none may when it closes. */
  localChanges?: (task: { id: string; identifier?: string }) => Promise<{ url: string; checks: { ok: boolean; pending: boolean }[] }[]>;
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
  /**
   * The company's labels, one read: a resolve that ends several holds names several of them. A read that fails is an error, never
   * an empty list: a resolve that took it for "no such label" would move the task and delete its holds while their labels stayed
   * on it, and `holds()` reads a label as a hold. The caller's retry asks again.
   */
  async function labelsOf(i: Issue) {
    const r = await owner("GET", `/api/companies/${encodeURIComponent(i.companyId ?? "")}/labels`);
    if (r.status !== 200 || !Array.isArray(r.json)) throw fail(502, "upstream", `the control plane answered ${r.status} for the company's labels`);
    return r.json as { id: string; name?: string }[];
  }
  async function label(i: Issue, name: string) {
    const l = (await labelsOf(i)).find((x) => x.name === name);
    if (!l) log(`label "${name}" missing in the control plane (run the setup)`);
    return l;
  }
  /**
   * The owner's PATCH. `expectStatus` is the task state the caller decided on: it is read again here, immediately before the
   * write, and a task that moved on since is refused rather than overwritten. (The control plane takes no conditional write,
   * so this read-then-write is as late as the authority allows; every await a caller does before calling this is outside the
   * window it protects.)
   */
  async function patch(i: Issue, body: Record<string, unknown>, expectStatus?: string) {
    if (!Object.keys(body).length) return;
    if (expectStatus !== undefined) {
      const now = await issue(i.id);
      if (now.status !== expectStatus)
        throw fail(409, "conflict", `${now.identifier ?? now.id} is ${now.status}, not ${expectStatus}: the move it was decided on no longer applies`);
    }
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
   * nothing or its socket refuses — is tagged `unavailable` and retried; any other failure (a status, a malformed body, a
   * timeout) is not retried. Only an explicit deny or reopen verdict, whatever its status, is the check's answer.
   */
  function post(key: string, at: string, body: unknown): Promise<Verdict> {
    return resolver.resolve(at).then((to) => new Promise<Verdict>((resolve, reject) => {
      const data = Buffer.from(JSON.stringify(body));
      const req = http.request({ host: to.host, port: to.port, path: to.path, method: "POST", timeout: 10_000, headers: { host: new URL(at).host, authorization: `Bearer ${key}`, "content-type": "application/json", "content-length": data.length } }, (res) => {
        let text = "";
        res.setEncoding("utf8").on("data", (d) => { if (text.length < 100_000) text += d; }).on("end", () => {
          let v: Verdict;
          try { v = JSON.parse(text); } catch { return reject(new Error(`answered ${res.statusCode} with no JSON`)); }
          if (v && (v.verdict === "deny" || v.verdict === "reopen") && (res.statusCode ?? 500) < 500) return resolve(v);
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
   * replaced container is inspected afresh). Any other failure — a status, a malformed body, its 10 s timeout — is not retried.
   * Every failure carries `unavailable`, and the finish gate holds the task on it: only an explicit verdict refuses.
   */
  async function ask(id: string, c: Check, body: unknown, at = c.url): Promise<Verdict> {
    const key = secret(c.auth_secret);
    if (!key) throw Object.assign(fail(503, "check_failed", `the finish check ${id} failed (its key is missing): the task waits in review`), { unavailable: true, cause: "its key is missing" });
    for (let n = 1; ; n++) {
      try { return await post(key, at, body); }
      catch (e) {
        if (!isUnavailable(e) || n >= ASK_ATTEMPTS) throw Object.assign(fail(503, "check_failed", `the finish check ${id} failed (${(e as Error).message}): the task waits in review`), { unavailable: true, cause: (e as Error).message });
        resolver.forget(at);
        await new Promise((r) => setTimeout(r, ASK_BACKOFF_MS));
      }
    }
  }

  /**
   * The finish gate for one task: `agent` and `tool` for an agent's own close, `via` for the runner's. Throws on a deny. A
   * check that is unavailable hasn't answered, so the close parks in review for the check's re-check rather than being refused.
   */
  /** A finish check's verdict on a task (a grader's reopen, say): an outcome the routing learning loop trusts (routing-tune.ts), never its words. */
  const verdictEvent = (task: string, check: string, verdict: string) => noteFact(facts, verdictFact(task, check, verdict));

  async function finish(ref: string, caller: { agent?: string; tool?: string; via: string }): Promise<Finish> {
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
      if (i.assigneeAgentId && graded(i.assigneeAgentId)) {
        const note = { gate: "finish", task: i.identifier ?? i.id, verdict: "uncovered", reason: "the assignee is graded and no finish check covers it: passed", via: caller.via };
        noteFact(facts, { type: "gate.would_block", subject: `task:${note.task}`, version: `e-${randomBytes(8).toString("hex")}`, task: i.id, at: new Date().toISOString(), actor: "kernel", data: note });
        log("graded task finished with no covering check", note);
      }
      return { pass: true };
    }
    // An enforcing check whose service is still unavailable (a container being replaced) holds the task in review instead of
    // refusing the close: the scheduled re-check asks again once it is back, and a real verdict is never invented here.
    const [verdicts] = await Promise.all([Promise.all(mine.map(async ([id, c]) => {
      try { return { id, c, v: await ask(id, c, body) }; }
      catch (e) {
        const why = String((e as { cause?: unknown }).cause ?? (e as Error).message);
        log("finish check unavailable, holding", { task: i.identifier, check: id, err: why });
        return { id, c, v: { verdict: "pending", state: "pending", reason: `the finish check ${id} couldn't be reached (${why}): the task waits in review while its service comes back` } as Verdict };
      }
    })), watched]);
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
   * A check's module on a task: `ok`, `reopen` and `block` resolve a hold this check placed, moving the task to done, todo or
   * blocked as the owner. Only the check's own module, and only on a task it holds.
   */
  // One resolution at a time per task, so two checks' oks never each see the other's hold and both leave the task in review.
  const resolving = new Map<string, Promise<unknown>>();
  type Resolve = { check?: unknown; verdict?: unknown; comment?: unknown; expectStatus?: unknown };
  /** The module's one finish check and the verdict's target status, or the refusal: asked before any task is looked up. */
  function pick(module: string, b: Resolve) {
    const mine = finishing().filter(([id, c]) => c.module === module && (b.check === undefined || id === `${module}.${String(b.check)}`));
    if (mine.length !== 1) throw fail(403, "forbidden", `${module} has ${mine.length ? "several finish checks: name one (check)" : "no finish check"}`);
    const to = RESOLVES.get(String(b.verdict));
    if (!to) throw fail(400, "bad_request", "verdict is ok, reopen or block");
    return { id: mine[0]![0], c: mine[0]![1], to };
  }
  async function resolve(module: string, ref: string, b: Resolve) {
    pick(module, b);
    const task = (await issue(ref)).id;
    const run = (resolving.get(task) ?? Promise.resolve()).then(() => resolveOne(module, ref, b));
    const tail = run.catch(() => undefined).then(() => { if (resolving.get(task) === tail) resolving.delete(task); });
    resolving.set(task, tail);
    return run;
  }
  async function resolveOne(module: string, ref: string, b: Resolve) {
    const { id, c, to } = pick(module, b);
    const i = await issue(ref);
    if (!recorded(id, i)) throw fail(409, "conflict", `${id} holds no finish on ${i.identifier ?? i.id}`);
    // A resolve may name the task state its decision was made on (a grader's close is decided on the review it read). The
    // check is made in patch(), immediately before the PATCH: a check here would be stale by the time the awaits below
    // (open changes, labels, a fresh label read) finish, and the cancel it was meant to catch would land in between.
    const expectStatus = b.expectStatus === undefined ? undefined : String(b.expectStatus);
    // A module's ok moves the task to done as the owner: the same hold as an agent's finish, so a change still open on this
    // server stops it too, before the hold is released.
    if (b.verdict === "ok") await noOpenChange(i, "the grader or the module that held it can move it on once the merge lands");
    // The move first, in one PATCH with the label's removal: the hold goes only once the task has moved, so a failed call leaves
    // it for the module's retry (and a retry never posts its comment twice).
    const comment = typeof b.comment === "string" && b.comment ? { comment: b.comment.slice(0, 60_000) } : {};
    // A verdict that ends the review (reopen, block) ends every hold of it: the other check's row is a hold of the same
    // review, and leaving it behind would match a later submission of the task and stop its `ok` from closing. `ok` clears
    // only its own row: while another check still holds the task, the task stays in review.
    const ends = b.verdict === "reopen" || b.verdict === "block";
    // The holds this verdict ends: this check's own, and — for a verdict that ends the review — the sibling holds recorded now.
    // One set decides both the labels the PATCH below removes and the rows the transaction deletes, so every row deleted and
    // its label go together: a label left behind is what `holds()` reads as a hold, and one whose row is gone would authorize
    // that module's token with no recorded hold. A hold written while this verdict was being filed is not in this set, so it
    // keeps its row and the label it wrote with it (a later submission's own hold) rather than losing its row alone.
    const recordedNow = ends ? (db.prepare("SELECT check_id FROM check_holds WHERE task = ?").all(i.id) as { check_id: string }[]).map((r) => r.check_id) : [];
    const ended = new Set<string>([id, ...recordedNow]);
    // One read of the company's labels, however many checks the verdict ends — and only when some hold being ended has a label
    // to take off. A check without one needs no label operation, so an outage of that endpoint must not stop its verdict.
    const named = new Map(finishing());
    const wanted = [...ended].some((x) => named.get(x)?.label);
    const labels = wanted ? await labelsOf(i) : [];
    const drop = new Set<string>();
    for (const x of ended) {
      const name = named.get(x)?.label;
      const l = name ? labels.find((y) => y.name === name) : undefined;
      if (l) drop.add(l.id);
      else if (name) log(`label "${name}" missing in the control plane (run the setup)`);
    }
    // The PATCH replaces the whole list, so it is built from the task's labels as they are now, not as this resolve first read
    // them: a hold that landed during the label read above has put its own label on the task, and a list from the older read
    // would drop it while its row (not in `ended`) stays.
    const ids = labelIds(await issue(i.id));
    const left = ids.filter((x) => !drop.has(x));
    // An ok clears only this check's hold: while another check still holds the task it stays in review.
    const others = b.verdict === "ok" && db.prepare("SELECT 1 FROM check_holds WHERE task = ? AND check_id <> ?").get(i.id, id) !== undefined;
    if (!others) await patch(i, { status: to, ...(left.length !== ids.length ? { labelIds: left } : {}), ...comment }, expectStatus);
    else if (left.length !== ids.length || Object.keys(comment).length) await patch(i, { ...(left.length !== ids.length ? { labelIds: left } : {}), ...comment }, expectStatus);
    inTx(db, "finish_resolved", () => {
      // Exactly the rows the label PATCH above ends, one by one: each gets its own verdict fact (with that check's id), so task
      // state pairs held and verdict facts per check and a sibling whose row is gone but whose held fact stands never reads as
      // unresolved.
      for (const x of ended) {
        db.prepare("DELETE FROM check_holds WHERE task = ? AND check_id = ?").run(i.id, x);
        strict(verdictFact(i.id, x, String(b.verdict)));
      }
    });
    log("finish check resolved", { task: i.identifier, check: id, verdict: b.verdict });
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
    for (const [id, c] of takers) {
      const v = await ask(id, c, { task, module, ...b }, c.rubric);
      if (v.verdict !== "ok" && c.mode !== "observe") throw fail(409, "refused", `the finish check ${id} refused the rubric${v.reason ? `: ${v.reason}` : ""}`);
    }
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
/** A check's verdict on a task: ok, reopen or block resolve its hold. */
const verdictFact = (task: string, check: string, verdict: string) => ({ type: "finish.verdict", subject: `task:${task}`, version: `e-${randomBytes(8).toString("hex")}`, task, at: new Date().toISOString(), actor: "kernel", data: { check, verdict } });
