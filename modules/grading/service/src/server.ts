// The grading module's service (lean-core 3h): the grade rows (grades.ts, its own SQLite file) and every route that reads or
// moves them, each behind its own caller's key:
//   POST /check/finish                     the kernel (grading_check_key): the task.finish check (kernel/src/checks.ts)
//   POST /grades                           the tasks module, as the delegating agent (its caller assertion, aud tasks): file a rubric
//   POST /board/grades, POST /board/grades/<task>/settle   the board (grading_board_key): its reads
// It reads tasks and settings from the kernel with its own token (kernel.cp-read) and releases its label there
// (POST /v1/checks/:task); it never writes to the control plane itself. Every five minutes it settles rows whose task closed.
import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { kernelJwks, verifyCaller, type JWKS } from "./aidenhq-sdk/caller.ts";
import { ESCALATION_WAIT_MS, GRADE_CHECK_MS, Grades, Invalid, backfillEscalatedDelegators, completionGate, parseFiling, parseVerdict, prRefAllowed, settleClosedGrades, type CompletionPath } from "./grades.ts";

type Issue = { id: string; identifier?: string; status: string; assigneeAgentId?: string | null; createdByAgentId?: string | null; parentId?: string | null };
/** The kernel as this module: its control-plane reads, its directory's settings, and its label released on a task. */
export type Kernel = {
  issue: (ref: string) => Promise<Issue>;
  settings: () => Promise<{ agents_org?: string; product_repo?: string }>;
  release: (task: string) => Promise<void>;
};
class HttpError extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } }
/** Tools that hand a task to an agent and file its rubric: task_delegate, task_create with an assignee. */
const FILERS = ["task_delegate", "task_propose_rule", "task_create"];
const NOTE = "The grader checks this task against its rubric.";

export function createGrading({ db, kernel, keys, jwks = kernelJwks(), log = () => {} }: {
  db: DatabaseSync; kernel: Kernel; keys: { check: string; board: string }; jwks?: JWKS | (() => Promise<JWKS>);
  log?: (msg: string, f?: Record<string, unknown>) => void;
}) {
  const grades = new Grades(db);
  const keyed = (req: http.IncomingMessage, key: string) => {
    const a = Buffer.from(String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "")), b = Buffer.from(key);
    if (!(b.length > 0 && a.length === b.length && timingSafeEqual(a, b))) throw new HttpError(403, "forbidden");
  };

  /** The finish check (spec §3.5): the board's completion gate as it was, answered as a verdict the kernel acts on. */
  async function finish(b: { task?: Issue; agent?: string | null; via?: string }) {
    const issue = b.task!;
    if (!issue?.id || typeof b.via !== "string") throw new HttpError(400, "send {task, agent, via}");
    // Ungraded (no row): pass before anything else, so the gate never blocks other closes.
    if (!grades.get(issue.id)) return { verdict: "ok" };
    const runner = b.via === "finish_turn" || b.via === "finish_merges";
    if (!runner && !b.agent) return { verdict: "deny", status: 403, reason: "only an agent's own close or the runner's moves a graded task" };
    // A cancelled task is never graded or moved by a late close: its row ends, and the close is refused before the hold
    // would reopen it. This comes before the delegator's acceptance: closing a cancelled task does not accept the work.
    if (issue.status === "cancelled") {
      grades.settle(issue.id, "the task was cancelled before the grader settled it");
      return { verdict: "deny", status: 409, reason: "the task is cancelled" };
    }
    const g = grades.get(issue.id)!;
    // An escalated grade is its delegator's call whatever else that agent is: the delegators saved when it escalated (else
    // the task's creator) accept the work in place of a verdict, and the row is settled rather than left escalated. Read
    // before the assignee rule, because a delegator is often also the task's assignee (a task an agent delegated to
    // itself, or re-delegated): its close would otherwise reach completionGate, which only marks a resubmitted row, and
    // each new deliverable version (an app's redeploy, say) would send the row back to the grader and escalate again.
    const delegators = g.state === "escalated" ? (g.delegators?.length ? g.delegators : [issue.createdByAgentId].filter((id): id is string => Boolean(id))) : [];
    if (!runner && g.state === "escalated" && delegators.includes(b.agent!)) {
      grades.accept(issue.id, b.agent!);
      log("escalated grade accepted by its delegator", { task: issue.identifier, by: b.agent });
      return { verdict: "ok", unlabel: true };
    }
    // A delegator that stayed silent for a day: the assignee finishing again sends the row back to the grader for a fresh
    // verdict on today's facts. Never an acceptance: only a delegator accepts, and a timeout never records `satisfied`.
    if (!runner && g.state === "escalated" && issue.assigneeAgentId === b.agent && Date.now() - Date.parse(g.updatedAt) >= ESCALATION_WAIT_MS) {
      grades.regrade(issue.id);
      log("escalated grade sent back to the grader after a day without the delegator", { task: issue.identifier, by: b.agent });
      return { verdict: "pending", state: "pending", reason: NOTE, until: new Date(Date.now() + GRADE_CHECK_MS).toISOString() };
    }
    // Only the task's own assignee moves any other grade.
    if (!runner && issue.assigneeAgentId !== b.agent) {
      if (!(g.state === "satisfied" && issue.status === "done")) return { verdict: "deny", status: 403, reason: "this task is graded: the grader closes it once its rubric is met (only its assignee finishes it)" };
      return { verdict: "ok" };
    }
    const r = completionGate(grades, issue.id, b.via as CompletionPath, { done: issue.status === "done" });
    if (r.pass) return { verdict: "ok" };
    log("completion held for grading", { task: issue.identifier, via: b.via, state: r.state });
    return { verdict: "pending", state: r.state, reason: NOTE, until: new Date(Date.now() + GRADE_CHECK_MS).toISOString() };
  }

  async function file(req: http.IncomingMessage, body: unknown) {
    const caller = await verifyCaller(req, jwks, "tasks").catch((e: Error) => { throw new HttpError(403, `refused: ${e.message}`); });
    const tool = String(caller.tool ?? "").split(".").pop()!;
    if (!FILERS.includes(tool)) throw new HttpError(403, `only an agent granted one of ${FILERS.join(", ")} may file a rubric`);
    const b = parseFiling(body);
    // The grader reads only the task's own PRs; a ref naming another org's repo is refused here too.
    if (b.deliverable.kind === "pr" && !prRefAllowed(b.deliverable.ref, await kernel.settings())) throw new HttpError(400, "deliverable.ref: a repo or PR in the agents org, a codehost:local repo or change, or the product repo, or empty for the task's own PRs");
    const issue = await kernel.issue(b.issue);
    if (issue.createdByAgentId !== caller.agent) throw new HttpError(403, "only the agent that delegated a task files its rubric");
    const r = grades.file(issue.id, b.rubric, b.deliverable);
    if (r.created) log("rubric filed", { task: issue.identifier, kind: b.deliverable.kind, criteria: b.rubric.length });
    return { created: r.created, state: r.grade.state };
  }

  async function runner(method: string, path: string, body: unknown) {
    if (method === "GET" && path === "/internal/grades") return { grades: grades.due(), resubmitted: grades.resubmitted() };
    const one = /^\/internal\/grades\/([0-9a-f-]{36})$/i.exec(path);
    // One task's grade state (null: ungraded): a sub-task whose grade will speak keeps its progress to itself.
    if (method === "GET" && one) return { state: grades.get(one[1]!)?.state || null };
    const m = /^\/internal\/grades\/([^/]+)\/(verdict|resubmit)$/.exec(path);
    if (method !== "POST" || !m) throw new HttpError(404, "no such route");
    const issue = await kernel.issue(decodeURIComponent(m[1]!));
    if (m[2] === "resubmit") {
      const g = grades.resubmit(issue.id, String((body as { version?: unknown })?.version ?? ""));
      if (!g) throw new HttpError(404, "no grade for this task");
      log("escalated grade resubmitted", { task: issue.identifier, state: g.state });
      return g;
    }
    const v = parseVerdict(body);
    if (!grades.get(issue.id)) throw new HttpError(404, "no grade for this task");
    // An escalation is addressed to the agent that filed the task and the agent on its parent task, as of now.
    const parent = issue.parentId ? await kernel.issue(issue.parentId).catch(() => undefined) : undefined;
    // Cancelled while the pass was running: no verdict, the cancel settles the row (a reopened task is graded again).
    if (issue.status === "cancelled") return grades.settle(issue.id, "the task was cancelled before the grader settled it");
    const g = grades.record(issue.id, v, Date.now(), [issue.createdByAgentId, parent?.assigneeAgentId].filter((x): x is string => Boolean(x)));
    // The hold stays while the grade loop still needs it: its grader token, and the resolve that closes, reopens or blocks the
    // task (satisfied, needs_revision, grading_failed and its escalation). Only another escalation, the delegator's to decide,
    // takes the label off here. The verdict stands if the kernel can't (it restarts on applies).
    if (g.state === "escalated" && v.outcome !== "grading_failed") await kernel.release(issue.id).catch((err: Error) => log("grading label not released", { task: issue.identifier, err: String(err.message).slice(0, 200) }));
    log("grade recorded", { task: issue.identifier, outcome: v.outcome, version: v.version.slice(0, 60), state: g.state, attempts: g.attempts, failures: g.failures });
    return g;
  }

  async function board(method: string, path: string, body: unknown) {
    if (method === "POST" && path === "/board/grades") {
      const ids = (body as { ids?: unknown })?.ids;
      if (!Array.isArray(ids) || ids.length > 500) throw new HttpError(400, "send {ids} (at most 500)");
      // Every id asked about: its row, or null for none (the board reads an id it wasn't answered as unknown).
      return { grades: Object.fromEntries(ids.map((id) => [String(id), grades.get(String(id)) ?? null])) };
    }
    const m = /^\/board\/grades\/([^/]+)\/settle$/.exec(path);
    if (method === "POST" && m) return { grade: grades.settle(decodeURIComponent(m[1]!), String((body as { reason?: unknown })?.reason ?? "the task closed").slice(0, 300)) ?? null };
    throw new HttpError(404, "no such route");
  }

  /** Every five minutes: rows whose task closed before the grader settled them, and escalated rows with no saved delegators. */
  async function tick() {
    try {
      const settled = await settleClosedGrades(grades, (id) => kernel.issue(id));
      if (settled.length) log("graded rows settled on a closed task", { tasks: settled.map((g) => g.issueId) });
      const filled = await backfillEscalatedDelegators(grades, (id) => kernel.issue(id));
      if (filled.length) log("escalated grades given their creator as delegator", { tasks: filled.map((g) => g.issueId) });
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
      if (method === "POST" && path === "/grades") return send(200, await file(req, body));
      if (path.startsWith("/board/")) return (keyed(req, keys.board), send(200, await board(method, path, body)));
      send(404, { error: "no such route" });
    } catch (err) {
      const e = err as Error & { status?: number };
      const status = e instanceof Invalid ? 400 : e instanceof HttpError ? e.status : 500;
      if (status >= 500) log("grading error", { path, err: String(e.message).slice(0, 300) });
      if (!res.headersSent) send(status, { error: e.message });
    }
  });
  return { server, grades, tick, runner };
}
