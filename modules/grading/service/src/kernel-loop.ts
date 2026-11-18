// The grade loop on the kernel's jobs (phase 2 W7): loop.mjs wired to this module's own rows and to the kernel as the one source of a
// task's jobs, comments, agents and verdict moves, run once a minute by main.ts. A PR's facts and diff are read from GitHub with a
// token the kernel's broker mints (github.ts); its PRs are named by the codehost-github pr and merge records on the task (/v1/work):
// by what their executor wrote in their outcome, never by the args an agent filed.
// Evidence the module cannot read (an app's status, its deploys, its rendered view: apps-mcp's internal API is not reachable from
// here and its token can deploy) throws "not available", so its row stays and is retried, never passed or judged on a guess.
import type { DatabaseSync } from "node:sqlite";
import { createGradeLoop } from "./loop.mjs";
import { GRADE_SCHEMA, escalationFor, gather, grade, gradeNote, template } from "./grader/grade.ts";
import { findPrs, stripHidden } from "./grader/compat.ts";
import { openRouterAsk } from "./aidenhq-sdk/judge.ts";
import { taskPrRows } from "./grader/evidence.ts";
import { createGithub } from "./github.ts";

type Json = any;
/** The kernel as the grading loop needs it: its calls with this module's token (kernel.cp-read, kernel.work-read, kernel.grader, kernel.wake). */
export type KernelCall = (method: string, path: string, body?: unknown) => Promise<Json>;
type Runner = (method: string, path: string, body: unknown) => Promise<Json>;

const notAvailable = (what: string) => async () => { throw new Error(`${what} is not available to the grading module yet`); };
const q = (o: Record<string, string>) => `?${new URLSearchParams(o)}`;

/**
 * The PRs a codehost-github merge record merged, as its executor wrote them: the outcome's first line, `merged-prs: ` and JSON
 * ({ repo, number, head, sha }), on a record that ended ok. The record's args are only what an agent asked for, never evidence.
 */
export function verifiedMerges(r: Json): { repo: string; number: number; head: string; sha: string }[] {
  if (r?.state !== "done" || r.ok !== true) return [];
  const line = String(r.outcome_text ?? "").split("\n", 1)[0]!;
  if (!line.startsWith("merged-prs: ")) return [];
  let list: unknown;
  try { list = JSON.parse(line.slice("merged-prs: ".length)); } catch { return []; }
  const SHA = /^[0-9a-f]{40}$/, SLUG = /^[\w.-]+\/[\w.-]+$/;
  return (Array.isArray(list) ? list : []).filter((p: Json) => SLUG.test(String(p?.repo)) && Number.isInteger(p?.number) && p.number > 0 && SHA.test(String(p?.head)) && SHA.test(String(p?.sha)))
    .map((p: Json) => ({ repo: p.repo, number: p.number, head: p.head, sha: p.sha }));
}

export function createKernelGradeLoop({ db, runner, due, kernel, kernelBytes, gatewayUrl, github = createGithub({ kernel }), log }: {
  db: DatabaseSync; runner: Runner; due: () => Json; kernel: KernelCall; /** A kernel GET's raw bytes (the attachment read). */ kernelBytes: (path: string) => Promise<Buffer>; gatewayUrl: string;
  /** A PR's facts and diff (github.ts); a fake in tests. */ github?: ReturnType<typeof createGithub>; log: (msg: string, f?: Record<string, unknown>) => void;
}) {
  db.exec("CREATE TABLE IF NOT EXISTS loop_state (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
  const state = {
    get: (k: string) => (db.prepare("SELECT v FROM loop_state WHERE k = ?").get(k) as { v?: string } | undefined)?.v ?? "",
    set: (k: string, v: string) => void db.prepare("INSERT INTO loop_state (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v").run(k, v),
    // The task's newest job: when it ended and with which engine (the author's model family, for the cross-family grader).
    lastJob: (task: string): Json => undefined,
  };
  const read = (path: string) => kernel("GET", `/v1/cp/read${path}`);
  const work = (task: string) => kernel("GET", `/v1/work${q({ task })}`);
  const workCache = new Map<string, Promise<Json>>();
  const tasks = new Map<string, Json>();
  // A task's jobs, read once per pass: lastJob is synchronous in the loop, so the pass's reads are made first (prime).
  const prime = async (task: string) => { const w = await work(task); workCache.set(task, w); return w; };
  state.lastJob = (task: string) => { const j = (workCache.get(task) as unknown as Json)?.jobs?.find((x: Json) => x.state !== "running"); return j && { finished_at: j.ended_at, engine: j.engine }; };

  const pc = {
    company: "",
    issue: async (ref: string) => { const i = await kernel("GET", `/v1/cp/read/api/issues/${encodeURIComponent(ref)}`); tasks.set(i.id, i); await prime(i.id); return i; },
    comments: (id: string) => read(`/api/issues/${encodeURIComponent(id)}/comments`),
    children: async (parentId: string) => (await read(`/api/companies/${(await kernel("GET", `/v1/cp/read/api/issues/${encodeURIComponent(parentId)}`)).companyId}/issues${q({ parentId, limit: "200" })}`)).filter((i: Json) => i.parentId === parentId),
    agents: async () => read(`/api/companies/${[...tasks.values()][0]?.companyId}/agents`),
    // A verdict's move is the finish check's own resolve: done accepts the work, todo reopens it with the note (which wakes the agent).
    setStatus: async (id: string, status: string, note: string) => void (await kernel("POST", `/v1/checks/${encodeURIComponent(id)}`, { verdict: status === "done" ? "ok" : "reopen", comment: note })),
    // A note on a task: a labelled wake notice (the kernel posts it and wakes the assignee).
    comment: async (id: string, text: string) => void (await kernel("POST", "/v1/wakes", { task: id, text })),
    attachments: (id: string) => read(`/api/issues/${encodeURIComponent(id)}/attachments`),
    // One attachment's bytes, only one listed on the task (the kernel refuses another, and anything over 25 MB).
    attachmentContent: (task: string, id: string) => kernelBytes(`/v1/cp/read/attachments/${encodeURIComponent(id)}/content${q({ task })}`),
  };
  const tellParent = async (issue: Json, _kind: string, text: string) => {
    if (!issue.parentId) return false;
    return (await kernel("POST", "/v1/wakes", { task: issue.parentId, text })).posted === true;
  };
  const recordsOn = async (issue: Json) => ((await work(issue.id)).records ?? []).map((r: Json) => ({
    id: r.id, action: r.kind, state: r.state === "review" || r.state === "owner" ? "pending" : r.state === "claimed" || r.state === "done" || r.state === "failed" ? "used" : r.state,
    outcome: r.state === "done" || r.state === "failed" ? { ok: r.ok } : undefined, usedAt: r.updated_at, decidedAt: r.decided_at, createdAt: r.created_at, args: r.args ?? {},
  }));
  // The task's PRs, from the code host's records on it (a task that handed its code to an Engineer has those of the tasks its agent
  // delegated under it): each `pr` write's outcome lists its PR links in the order of its branches, which is how a number is tied
  // to the branch it was opened for (identityOf); a `merge` write's bound heads and numbers are what the merge records add.
  const records = async (issue: Json, kind: string, states: string[]) => {
    const mine = ((await work(issue.id)).records ?? []).filter((r: Json) => r.kind === `codehost-github.${kind}` && states.includes(r.state));
    if (!mine.length && issue.assigneeAgentId)
      for (const c of (await pc.children(issue.id)).filter((c: Json) => c.createdByAgentId === issue.assigneeAgentId && c.status !== "cancelled"))
        mine.push(...((await work(c.id)).records ?? []).filter((r: Json) => r.kind === `codehost-github.${kind}` && states.includes(r.state)));
    return mine;
  };
  const gradeDeps = (issue: Json) => {
    let thread: Promise<Json> | undefined;
    const w = () => workCache.get(issue.id) as unknown as Json;
    return {
      busy: () => (w()?.busy ? "the agent is still working on it" : ""),
      approvals: () => recordsOn(issue),
      taskPrs: async () => taskPrRows((await records(issue, "pr", ["done"])).flatMap((r: Json) => {
        const urls = findPrs(r.outcome_text), only = r.args?.only ?? [];
        return urls.map((u, i) => ({ pr_url: u.url, ...(urls.length === only.length ? { branch: only[i]?.branch } : {}) }));
      })),
      taskMerged: async () => (await records(issue, "merge", ["done"])).flatMap(verifiedMerges),
      // The grant reads only the fleet's own repositories (the agents org and the product): a PR that reads is an own PR.
      ownRepo: () => true,
      pr: github.pr, diff: github.diff, app: notAvailable("an app's status"),
      appOfRepo: notAvailable("an app's repository"), deployHistory: notAvailable("an app's deploys"), view: notAvailable("an app's rendered view"),
      assignee: issue.assigneeAgentId,
      delegator: { agentId: issue.createdByAgentId, userId: issue.createdByUserId },
      comments: () => (thread ??= pc.comments(issue.id)),
      attachments: () => pc.attachments(issue.id), content: (id: string) => pc.attachmentContent(issue.id, id),
      identifier: issue.identifier,
      otherTask: async (ident: string) => (await pc.issue(ident).catch(() => null)) && notAvailable("another task's files")(),
    };
  };
  // The kernel mints a grader-kind token for the task (billed to it, never capped) on each model call.
  const graderAsk = (issue: Json) => async (model: string, prompt: { system: string; user: string }) => {
    const { token } = await kernel("POST", "/v1/work/grader-token", { task: issue.id });
    return openRouterAsk(token, { schema: GRADE_SCHEMA, url: `${gatewayUrl}/chat/completions` })(model, prompt);
  };
  const loop = createGradeLoop({
    api: { get: async (path: string) => (path === "/internal/grades" ? due() : runner("GET", path, undefined)), post: (path: string, body: unknown) => runner("POST", path, body) },
    pc, log, state, gather, grade, escalationFor, gradeNote, template, gradeDeps, tellParent, recordsOn,
    graderAsk,
    stripHidden, graderSpeaks: (s?: string) => ["open", "pending", "awaiting_evidence", "needs_revision", "grading_failed"].includes(String(s)),
    isUserInstruction: (c: Json) => c.authorType === "user" && !String(c.body ?? "").includes("<!-- aidenhq-runner -->"),
  });
  return loop;
}
