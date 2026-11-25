// The grading module's service (lean-core 3h): the grade rows (grades.ts, its own SQLite file) and every route that reads or
// moves them, each behind its own caller's key:
//   POST /check/finish                     the kernel (grading_check_key): the task.finish check (kernel/src/checks.ts)
//   POST /check/rubric                     the kernel (grading_check_key): the rubric of a task a module filed (kernel.tasks)
//   POST /check/grade                      the kernel (grading_check_key): the latest verdict that sent a task's work back, for the AI reviewer
//   POST /grades                           the tasks module, as the delegating agent (its caller assertion, aud tasks): file a rubric
//   POST /grades/amend                     the same caller: replace a filed rubric in place (the delegator, or the row's filer)
//   POST /grades/rebind                    the Fleet Steward (task_rebind, role fleet-settle in its signed assertion): move a filed
//                                          task's deliverable to the work that landed, rubric kept, graded again at once
//   GET  /grades/<task>                    the same caller: the task's filed grade, before re-filing a corrected one
//   POST /board/grades, POST /board/grades/<task>/settle   the board (grading_board_key): its reads
// It reads tasks and settings from the kernel with its own token (kernel.cp-read); it never writes to the control plane itself. Every five minutes it settles rows whose task closed.
import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { kernelJwks, verifyCaller, type JWKS } from "./aidenhq-sdk/caller.ts";
import { GRADE_CHECK_MS, Conflict, Grades, Invalid, completionGate, parseAmendment, parseFiling, parseVerdict, prRefAllowed, graderNote, rubricHash, settleClosedGrades, type KnownRepos, type CompletionPath } from "./grades.ts";
import { template } from "./grader/grade.ts";

type Issue = { id: string; identifier?: string; status: string; assigneeAgentId?: string | null; createdByAgentId?: string | null; parentId?: string | null };
/** The kernel as this module: its control-plane reads and its directory's settings. */
export type Kernel = {
  issue: (ref: string) => Promise<Issue>;
  repos: () => Promise<KnownRepos>;
};
class HttpError extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } }
/** Tools that hand a task to an agent and file its rubric: task_delegate, task_create with an assignee. */
const FILERS = ["task_delegate", "task_create"];
/** Tools that amend a filed rubric in place (task_amend_rubric). A delegation's own filing tools may amend too: re-filing is the same write. */
const AMENDERS = [...FILERS, "task_amend_rubric"];
const NOTE = "The grader checks this task against its rubric.";

export function createGrading({ db, kernel, keys, kernelUrl = "", jwks = kernelJwks(), log = () => {} }: {
  db: DatabaseSync; kernel: Kernel; keys: { check: string; board: string }; kernelUrl?: string; jwks?: JWKS | (() => Promise<JWKS>);
  log?: (msg: string, f?: Record<string, unknown>) => void;
}) {
  const grades = new Grades(db);
  const keyed = (req: http.IncomingMessage, key: string) => {
    const a = Buffer.from(String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "")), b = Buffer.from(key);
    if (!(b.length > 0 && a.length === b.length && timingSafeEqual(a, b))) throw new HttpError(403, "forbidden");
  };

  /** The finish check (spec §3.5): the board's completion gate as it was, answered as a verdict the kernel acts on. */
  async function finish(b: { task?: Issue & { graded?: boolean }; agent?: string | null; via?: string }) {
    const issue = b.task!;
    if (!issue?.id || typeof b.via !== "string") throw new HttpError(400, "send {task, agent, via}");
    // Ungraded (no row): pass before anything else, so the gate never blocks other closes.
    // A task filed with a rubric whose row isn't there (the filing failed after the task was made) never passes ungraded.
    if (!grades.get(issue.id)) return b.task!.graded ? { verdict: "deny", status: 409, reason: "this task is graded and its rubric isn't filed yet: its filer files it again" } : { verdict: "ok" };
    const runner = b.via === "finish_turn" || b.via === "finish_merges";
    if (!runner && !b.agent) return { verdict: "deny", status: 403, reason: "only an agent's own close or the runner's moves a graded task" };
    // A cancelled task is never graded or moved by a late close: its row ends, and the close is refused before the hold
    // would reopen it.
    if (issue.status === "cancelled") {
      grades.settle(issue.id, "the task was cancelled before the grader settled it");
      return { verdict: "deny", status: 409, reason: "the task is cancelled" };
    }
    const g = grades.get(issue.id)!;
    // Only the task's own assignee moves a grade.
    if (!runner && issue.assigneeAgentId !== b.agent) {
      if (!(g.state === "satisfied" && issue.status === "done")) return { verdict: "deny", status: 403, reason: "this task is graded: the grader closes it once its rubric is met (only its assignee finishes it)" };
      return { verdict: "ok" };
    }
    const r = completionGate(grades, issue.id, b.via as CompletionPath, { done: issue.status === "done" });
    if (r.pass) return { verdict: "ok" };
    log("completion held for grading", { task: issue.identifier, via: b.via, state: r.state });
    return { verdict: "pending", state: r.state, reason: NOTE, until: new Date(Date.now() + GRADE_CHECK_MS).toISOString() };
  }

  /** The grader reads only the task's own PRs; a ref naming another org's repo is refused. */
  async function refAllowed(d: { kind: string; ref: string }) {
    if (d.kind === "pr" && !prRefAllowed(d.ref, await kernel.repos())) throw new HttpError(400, "deliverable.ref: a repo or PR the instance reaches (the agents org, github_orgs, maintainer_repos or the product repo) or a codehost:local repo or change, or empty for the task's own PRs");
  }

  /** A task's own status says it is done or cancelled: its grade is settled work, never restarted by a later filing. */
  const isClosed = (issue: { status?: string }) => issue.status === "done" || issue.status === "cancelled";

  /** The authenticated caller of a rubric write, once the tool it holds is one of `allowed`. */
  async function rubricCaller(req: http.IncomingMessage, allowed: string[], action: string) {
    const caller = await verifyCaller(req, jwks, "tasks").catch((e: Error) => { throw new HttpError(403, `refused: ${e.message}`); });
    const tool = String(caller.tool ?? "").split(".").pop()!;
    if (!allowed.includes(tool)) throw new HttpError(403, `only an agent granted one of ${allowed.join(", ")} may ${action} a rubric`);
    return caller;
  }

  async function filingCaller(req: http.IncomingMessage, ref: string | (() => string)) {
    const caller = await rubricCaller(req, FILERS, "file");
    const issue = await kernel.issue(typeof ref === "string" ? ref : ref());
    if (issue.createdByAgentId !== caller.agent) throw new HttpError(403, "only the agent that delegated a task files its rubric");
    return { caller, issue };
  }

  /**
   * The caller of the amendment route and the task it names. Any delegating or amending tool may call it: who may change the
   * row is the store's rule (the task's delegator, or the recorded filer), checked there against the row, so a module's own
   * route and a delegator's both land on the same write. A task the kernel doesn't know is a 404; a kernel failure is not,
   * so a broken read never reads as a missing task.
   */
  async function amendCaller(req: http.IncomingMessage, ref: string | (() => string)) {
    const caller = await rubricCaller(req, AMENDERS, "amend");
    // The kernel's own status is kept: a 404 is "no such task", a 5xx is the kernel failing, not a missing task.
    const issue = await kernel.issue(typeof ref === "string" ? ref : ref()).catch((e: Error & { status?: number }) => {
      if (e.status === undefined || e.status === 404) throw new HttpError(404, `no such task: ${e.message}`);
      throw new HttpError(e.status >= 500 ? 502 : e.status, `the task could not be read: ${e.message}`);
    });
    return { caller, issue };
  }

  async function file(req: http.IncomingMessage, body: unknown) {
    // The caller is authenticated before the body is read: an unauthenticated request gets 403, never a validation error.
    let b!: ReturnType<typeof parseFiling>;
    const { caller, issue } = await filingCaller(req, () => (b = parseFiling(body)).issue);
    await refAllowed(b.deliverable);
    // The row records its filer as the agent that delegated the task: a differing re-file is that agent's, and only its. A
    // task already closed is left alone (its row may not have been swept to not_graded yet).
    const r = grades.file(issue.id, b.rubric, b.deliverable, `agent:${caller.agent}`, { closed: isClosed(issue), held: issue.status === "in_review" });
    if (r.created) log("rubric filed", { task: issue.identifier, kind: b.deliverable.kind, criteria: b.rubric.length });
    return { created: r.created, state: r.grade.state };
  }

  /**
   * Replaces a filed task's rubric in place (POST /grades/amend): the delegator's route to a criterion it can no longer meet,
   * honoured by the grader because it lands on the grade row, never the description. The store decides who may do it (the
   * task's creator, or the row's recorded filer) and refuses a settled row; a closed task is left alone as a filing is.
   */
  async function amend(req: http.IncomingMessage, body: unknown) {
    let b!: ReturnType<typeof parseAmendment>;
    const { caller, issue } = await amendCaller(req, () => (b = parseAmendment(body)).issue);
    // Work already finished and held for a grade (in review) is requeued by the amendment: the row still restarts `open`, and
    // its resume flag has the next pass grade it against the new list, so the assignee is not asked to finish again for a
    // change they did not make.
    const g = grades.amend(issue.id, b.rubric, { by: `agent:${caller.agent}`, delegator: issue.createdByAgentId ? `agent:${issue.createdByAgentId}` : undefined, closed: isClosed(issue), held: issue.status === "in_review" });
    log("rubric amended", { task: issue.identifier, by: `agent:${caller.agent}`, criteria: g.rubric.length, state: g.state });
    return { amended: true, state: g.state, rubric: g.rubric };
  }

  /** The Fleet Steward's rebind (POST /grades/rebind): its signed role, never an argument, says it may. */
  async function rebind(req: http.IncomingMessage, body: unknown) {
    const caller = await rubricCaller(req, ["task_rebind"], "rebind");
    if (!caller.roles.includes("fleet-settle")) throw new HttpError(403, "only the Fleet Steward (role fleet-settle) rebinds a task's deliverable");
    const b = (body ?? {}) as { issue?: unknown; deliverable?: unknown };
    const f = parseFiling({ issue: b.issue, rubric: [], deliverable: b.deliverable });
    // The grader reads a named PR on GitHub directly; a change on this server's own code host it reads only from the task's own
    // records (grader/evidence.ts prEvidence), so a rebind there would grade nothing.
    if (f.deliverable.ref.startsWith("codehost:")) throw new HttpError(400, "deliverable.ref: a rebind names a GitHub PR (owner/name#number or its URL); a change on this server's code host is graded only on the task that opened it");
    const issue = await kernel.issue(f.issue);
    await refAllowed(f.deliverable);
    const g = grades.rebind(issue.id, f.deliverable, { closed: isClosed(issue), held: issue.status === "in_review" });
    log("deliverable rebound", { task: issue.identifier, by: `agent:${caller.agent}`, kind: g.deliverable.kind, state: g.state });
    return { rebound: true, state: g.state, deliverable: g.deliverable, rubric: g.rubric };
  }

  /**
   * A task's filed grade, read by the delegating agent before it re-files (GET /grades/<task>): the row, or null when none.
   * A filing tool reads only a task it delegated (as filing does); an amending tool reads any task, because the amendment
   * itself decides who may change the row (the delegator, or the recorded filer) and the tool needs the row's deliverable to
   * validate against. Reading is not changing: the write's own rule still refuses everyone else.
   */
  async function readGrade(req: http.IncomingMessage, ref: string) {
    const caller = await rubricCaller(req, [...FILERS, ...AMENDERS], "read");
    const issue = await kernel.issue(ref);
    const tool = String(caller.tool ?? "").split(".").pop()!;
    const grade = grades.get(issue.id) ?? null;
    // A filing tool reads only a task it delegated (as filing does). An amending tool reads only a row it could amend: the
    // delegator's, or the recorded filer's. The read is never a way to see another agent's rubric; the write repeats the same
    // rule, so a caller that passes here still cannot change what it may not.
    const mine = FILERS.includes(tool) ? issue.createdByAgentId === caller.agent : issue.createdByAgentId === caller.agent || grades.filer(issue.id) === `agent:${caller.agent}`;
    if (!mine) throw new HttpError(403, `only ${FILERS.includes(tool) ? "the agent that delegated a task" : "the task's delegator or the rubric's recorded filer"} reads its rubric`);
    return { grade };
  }

  /** A module-filed task's rubric: the kernel's own call (its key), after it checked the filing module holds kernel.tasks. */
  async function fileForModule(b: { task?: { id?: string }; module?: string; rubric?: unknown; deliverable?: unknown }) {
    if (!b?.task?.id || typeof b.module !== "string") throw new HttpError(400, "send {task, module, rubric, deliverable}");
    const f = parseFiling({ issue: b.task.id, rubric: b.rubric, deliverable: b.deliverable });
    await refAllowed(f.deliverable);
    // The row records its filer as the module the kernel vouched for: the same filing again is a retry, a differing one is
    // that module's to replace while the grade is unsettled, and any other module's is refused (grades.file). The kernel's
    // body carries only the task's id and identifier, so its status is read here: a closed task is left alone, as on the
    // agent route (its row may not have been swept to not_graded yet).
    const issue = await kernel.issue(b.task.id);
    const r = grades.file(b.task.id, f.rubric, f.deliverable, `module:${b.module}`, { closed: isClosed(issue), held: issue.status === "in_review" });
    if (r.created) log("rubric filed for a module's task", { task: b.task.id, module: b.module, kind: f.deliverable.kind, criteria: f.rubric.length });
    return { verdict: "ok", created: r.created };
  }

  async function runner(method: string, path: string, body: unknown) {
    if (method === "GET" && path === "/internal/grades") return { grades: grades.due() };
    // One task's grade state (null: ungraded): a sub-task whose grade will speak keeps its progress to itself. The id is
    // decoded as the verdict route does: the grade loop encodes whatever id it was given, and task ids are not all UUIDs.
    const one = /^\/internal\/grades\/([^/]+)$/.exec(path);
    if (method === "GET" && one) {
      // The state, and the filing the row holds now: a queued move saved before filings were named reads it to tell whether it
      // still describes the row (a rubric amended since is a different filing, and its close must not land).
      const g = grades.get(decodeURIComponent(one[1]!));
      return g ? { state: g.state, filing: rubricHash(g.rubric, g.deliverable, g.revision), revision: g.revision, round: g.round, rubric: g.rubric, deliverable: g.deliverable } : { state: null };
    }
    const m = /^\/internal\/grades\/([^/]+)\/verdict$/.exec(path);
    if (method !== "POST" || !m) throw new HttpError(404, "no such route");
    const issue = await kernel.issue(decodeURIComponent(m[1]!));
    const v = parseVerdict(body);
    if (!grades.get(issue.id)) throw new HttpError(404, "no grade for this task");
    // Cancelled while the pass was running: no verdict, the cancel settles the row (a reopened task is graded again).
    if (issue.status === "cancelled") return grades.settle(issue.id, "the task was cancelled before the grader settled it");
    // The hold stays while the grade loop still needs it: its grader token, and the resolve that closes, reopens or blocks the task.
    const { grade: g, applied } = grades.recordPass(issue.id, v);
    if (!applied) {
      // The row moved while the pass ran (an amendment, a re-file, a new submission): the verdict graded what it no longer holds,
      // so it is dropped whole — not recorded as a failure, not cleared. The loop reads `applied` and publishes nothing for it.
      log("grade verdict dropped: the row moved while the pass ran", { task: issue.identifier, outcome: v.outcome, version: v.version.slice(0, 60), state: g.state });
      return { ...g, applied: false };
    }
    if (v.outcome === "grading_failed" && v.reason) grades.noteFailure(issue.id, v.reason);
    else if (v.outcome !== "awaiting_evidence") grades.clearFailure(issue.id);
    log("grade recorded", { task: issue.identifier, outcome: v.outcome, version: v.version.slice(0, 60), state: g.state, attempts: g.attempts, failures: g.failures });
    return { ...g, applied: true };
  }

  async function board(method: string, path: string, body: unknown) {
    if (method === "POST" && path === "/board/grades") {
      const ids = (body as { ids?: unknown })?.ids;
      if (!Array.isArray(ids) || ids.length > 500) throw new HttpError(400, "send {ids} (at most 500)");
      // Every id asked about: its row, or null for none (the board reads an id it wasn't answered as unknown).
      const rows = Object.fromEntries(ids.map((id) => [String(id), grades.get(String(id)) ?? null]));
      // The standard criteria for a row filed without its own, so the board shows what the grader judges against.
      const bare = Object.values(rows).filter((g) => g && !g.rubric.length);
      return { grades: rows, templates: Object.fromEntries(bare.map((g) => [g!.deliverable.kind, template(g!.deliverable.kind)])) };
    }
    const m = /^\/board\/grades\/([^/]+)\/settle$/.exec(path);
    if (method === "POST" && m) return { grade: grades.settle(decodeURIComponent(m[1]!), String((body as { reason?: unknown })?.reason ?? "the task closed").slice(0, 300)) ?? null };
    throw new HttpError(404, "no such route");
  }

  /** Every five minutes: rows whose task closed before the grader settled them. */
  async function tick() {
    try {
      const settled = await settleClosedGrades(grades, (id) => kernel.issue(id));
      if (settled.length) log("graded rows settled on a closed task", { tasks: settled.map((g) => g.issueId) });
    } catch (err) {
      log("settling closed grades failed", { err: String((err as Error).message ?? err) });
    }
  }

  const server = http.createServer(async (req, res) => {
    const path = String(req.url ?? "").split("?")[0]!;
    const send = (status: number, body: unknown) => void res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body ?? null));
    try {
      if (path === "/healthz") return void res.writeHead(200, { "content-type": "text/plain" }).end("ok");
      const chunks: Buffer[] = [];
      let n = 0;
      for await (const c of req) { n += c.length; if (n > 1_000_000) throw new HttpError(413, "too large"); chunks.push(c); }
      let body: unknown;
      try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined; } catch { throw new HttpError(400, "the body must be JSON"); }
      const method = String(req.method);
      if (method === "POST" && path === "/check/finish") return (keyed(req, keys.check), send(200, await finish((body ?? {}) as never)));
      if (method === "POST" && path === "/check/rubric") return (keyed(req, keys.check), send(200, await fileForModule((body ?? {}) as never)));
      // The AI reviewer's read of what the grader last sent back (the kernel's own call, its check key): structured, from this store.
      if (method === "POST" && path === "/check/grade") {
        keyed(req, keys.check);
        const id = (body as { task?: { id?: unknown } })?.task?.id;
        if (typeof id !== "string" || !id) throw new HttpError(400, "send {task: {id}}");
        return send(200, { verdict: "ok", grade: graderNote(grades.get(id), template) });
      }
      if (method === "POST" && path === "/grades") return send(200, await file(req, body));
      if (method === "POST" && path === "/grades/amend") return send(200, await amend(req, body));
      if (method === "POST" && path === "/grades/rebind") return send(200, await rebind(req, body));
      // The delegating agent reads a task's filed grade before re-filing it on the same task (a corrected deliverable).
      {
        const g = /^\/grades\/([^/]+)$/.exec(path);
        if (method === "GET" && g) return send(200, await readGrade(req, decodeURIComponent(g[1]!)));
      }
      // The Fleet Steward's read (its own module token, vouched for by the kernel): which grader passes failed lately, and why.
      if (method === "GET" && path === "/steward/grade-failures") {
        const who = await fetch(`${kernelUrl}/v1/whoami`, { headers: { authorization: String(req.headers.authorization ?? "") }, signal: AbortSignal.timeout(5_000) }).then((r) => (r.ok ? r.json() : {}), () => ({})) as { kind?: string; module?: string };
        if (who.kind !== "module" || who.module !== "fleet-steward") throw new HttpError(403, "forbidden");
        return send(200, { failures: grades.failuresSince(new Date(Date.now() - 2 * 3_600_000).toISOString()) });
      }
      if (path.startsWith("/board/")) return (keyed(req, keys.board), send(200, await board(method, path, body)));
      send(404, { error: "no such route" });
    } catch (err) {
      const e = err as Error & { status?: number };
      const status = e instanceof Invalid ? 400 : e instanceof Conflict ? 409 : e instanceof HttpError ? e.status : 500;
      if (status >= 500) log("grading error", { path, err: String(e.message).slice(0, 300) });
      if (!res.headersSent) send(status, { error: e.message });
    }
  });
  return { server, grades, tick, runner };
}
