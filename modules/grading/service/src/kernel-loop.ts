// The grade loop on the kernel's jobs (phase 2 W7): loop.ts wired to this module's own rows and to the kernel as the one source of a
// task's jobs, comments, agents and verdict moves, run once a minute by main.ts. A PR's facts and diff are read from GitHub with a
// token the kernel's broker mints (github.ts); its PRs are named by the codehost-github pr and merge records on the task (/v1/work):
// by what their executor wrote in their outcome, never by the args an agent filed.
// An app's status, deploys and rendered view are read from apps-mcp with this module's own token (role apps.read, apps-evidence.ts).
import type { DatabaseSync } from "node:sqlite";
import { createGradeLoop } from "./loop.ts";
import { GRADE_SCHEMA, GRADER_MARKER, escalationFor, gather, grade, gradeNote, template } from "./grader/grade.ts";
import { findPrs, stripHidden } from "./grader/text.ts";
import { openRouterAsk } from "./aidenhq-sdk/judge.ts";
import { MAX_OTHER_FILES, presentNow, taskPrRows } from "./grader/evidence.ts";
import { createGithub } from "./github.ts";
import type { FactIn } from "./aidenhq-sdk/kernel-client.ts";
import { appsEvidence, type AppsCall } from "./apps-evidence.ts";
import { rubricHash } from "./grades.ts";

type Json = any;
/** The kernel as the grading loop needs it: its calls with this module's token (kernel.cp-read, kernel.work-read, kernel.grader, kernel.wake). */
export type KernelCall = (method: string, path: string, body?: unknown) => Promise<Json>;
type Runner = (method: string, path: string, body: unknown) => Promise<Json>;

/** The code host modules (the kernel's list, kernel/src/codehost.ts CODEHOSTS; this service is its own build context). */
const CODEHOSTS = ["github", "codehost-local"];
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

export function createKernelGradeLoop({ db, runner, due, kernel, kernelBytes, apps, gatewayUrl, github, log, emit }: {
  db: DatabaseSync; runner: Runner; due: () => Json; kernel: KernelCall; /** apps-mcp's grader reads (apps-evidence.ts); a fake in tests. */ apps: AppsCall; /** A kernel GET's raw bytes (the attachment read). */ kernelBytes: (path: string) => Promise<Buffer>; gatewayUrl: string;
  /** A PR's facts and diff (github.ts); a fake in tests. */ github: ReturnType<typeof createGithub>; log: (msg: string, f?: Record<string, unknown>) => void;
  /** Flow facts (FactEmitter.emit); none in tests that don't read them. */ emit?: (f: FactIn) => void;
}) {
  db.exec("CREATE TABLE IF NOT EXISTS loop_state (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
  const state = {
    get: (k: string) => (db.prepare("SELECT v FROM loop_state WHERE k = ?").get(k) as { v?: string } | undefined)?.v ?? "",
    set: (k: string, v: string) => void db.prepare("INSERT INTO loop_state (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v").run(k, v),
    /** The rows under a prefix that hold something, as [key, value]. */
    list: (prefix: string) => (db.prepare("SELECT k, v FROM loop_state WHERE k >= ? AND k < ? AND v != '' ORDER BY k").all(prefix, `${prefix}\uffff`) as { k: string; v: string }[]).map((r) => [r.k, r.v] as [string, string]),
    // The task's newest job: when it ended and with which engine (the author's model family, for the cross-family grader).
    lastJob: (task: string): Json => undefined,
  };
  const read = (path: string) => kernel("GET", `/v1/cp/read${path}`);
  // The kernel's write records by id (a card a report cites): GET /v1/work?record=<id>, null when there is none.
  const writes = {
    record: async (id: string) => {
      try { return await kernel("GET", `/v1/work${q({ record: id })}`); } catch (err: Json) { if (Number(err?.status) === 404) return null; throw err; }
    },
  };
  const workCache = new Map<string, Promise<Json>>();
  const work = (task: string) => kernel("GET", `/v1/work${q({ task })}`);
  // A task's jobs, read once per pass (cleared at each pass's start): lastJob is synchronous in the loop, so the pass's reads are made first (prime).
  const prime = async (task: string) => { const w = await work(task); workCache.set(task, w); return w; };
  state.lastJob = (task: string) => { const j = (workCache.get(task) as unknown as Json)?.jobs?.find((x: Json) => x.state !== "running"); return j && { finished_at: j.ended_at, engine: j.engine }; };

  const pc = {
    company: "",
    issue: async (ref: string) => { const i = await kernel("GET", `/v1/cp/read/api/issues/${encodeURIComponent(ref)}`); await prime(i.id); return i; },
    // The task as cp-read has it, with no work prime: a rubric-named task is checked against the graded task's company before
    // anything on it (its work, its records, its files) is read.
    taskOnly: (ref: string) => read(`/api/issues/${encodeURIComponent(ref)}`),
    comments: (id: string) => read(`/api/issues/${encodeURIComponent(id)}/comments`),
    children: async (parentId: string) => (await read(`/api/companies/${(await kernel("GET", `/v1/cp/read/api/issues/${encodeURIComponent(parentId)}`)).companyId}/issues${q({ parentId, limit: "200" })}`)).filter((i: Json) => i.parentId === parentId),
    // The task's own agent, whatever its company (work or personal).
    agent: (id: string) => read(`/api/agents/${encodeURIComponent(id)}`).catch((e: { status?: number }) => (e.status === 404 ? undefined : Promise.reject(e))),
    // A verdict's move is the finish check's own resolve: done accepts the work, todo reopens it with the note (which wakes the agent).
    setStatus: async (id: string, status: string, note: string, { expectStatus }: { expectStatus?: string } = {}) => void (await kernel("POST", `/v1/checks/${encodeURIComponent(id)}`, { verdict: status === "done" ? "ok" : "reopen", comment: note, ...(expectStatus ? { expectStatus } : {}) })),
    // A grader that keeps failing: the task ends blocked with the error (no wake), and its delegator is told.
    block: async (id: string, note: string) => void (await kernel("POST", `/v1/checks/${encodeURIComponent(id)}`, { verdict: "block", comment: note })),
    // A note on a task: a labelled wake notice (the kernel posts it and wakes the assignee). `key`: the producer's own id for it,
    // so a retried post (its answer lost) lands once: the kernel reads the thread for that id before it posts again.
    comment: async (id: string, text: string, key?: string) => void (await kernel("POST", "/v1/wakes", { task: id, text, ...(key ? { id: key } : {}) })),
    attachments: (id: string) => read(`/api/issues/${encodeURIComponent(id)}/attachments`),
    // One attachment's bytes, only one listed on the task (the kernel refuses another, and anything over 25 MB).
    attachmentContent: (task: string, id: string) => kernelBytes(`/v1/cp/read/attachments/${encodeURIComponent(id)}/content${q({ task })}`),
  };
  const tellParent = async (issue: Json, _kind: string, text: string) => {
    if (!issue.parentId) return false;
    return (await kernel("POST", "/v1/wakes", { task: issue.parentId, text })).posted === true;
  };
  const recordsOn = async (issue: Json) => ((await work(issue.id)).records ?? []).map((r: Json) => ({
    id: r.id, action: r.kind, state: r.state === "review" || r.state === "owner" ? "pending" : r.state === "done" || r.state === "failed" ? "used" : r.state,
    outcome: r.state === "done" || r.state === "failed" ? { ok: r.ok } : undefined, usedAt: r.updated_at, decidedAt: r.decided_at, createdAt: r.created_at, args: r.args ?? {},
    // What an apply's card carries beyond its args (evidence.ts applyEvidence): the committed diff (APPLY_CHANGE) and the
    // apply's own log tail (APPLY_OUTCOME). The kernel's task read sends the diff for apply records only.
    details: r.details ?? "", outcomeText: r.outcome_text ?? "",
  }));
  // The task's PRs, from the code host's records on it (a task that handed its code to an Engineer has those of the tasks its agent
  // delegated under it): each `pr` write's outcome lists its PR links in the order of its branches, which is how a number is tied
  // to the branch it was opened for (identityOf); a `merge` write's bound heads and numbers are what the merge records add.
  // Any code host's: the same actions under each host's module name.
  const ofKind = (r: Json, kind: string) => CODEHOSTS.some((h) => r.kind === `${h}.${kind}`);
  const records = async (issue: Json, kind: string, states: string[]) => {
    const mine = ((await work(issue.id)).records ?? []).filter((r: Json) => ofKind(r, kind) && states.includes(r.state));
    if (!mine.length && issue.assigneeAgentId)
      for (const c of (await pc.children(issue.id)).filter((c: Json) => c.createdByAgentId === issue.assigneeAgentId && c.status !== "cancelled"))
        mine.push(...((await work(c.id)).records ?? []).filter((r: Json) => ofKind(r, kind) && states.includes(r.state)));
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
      pr: github.pr, issue: github.issue, diff: github.diff, job: github.job, run: github.run, file: github.file, exists: github.exists, commit: github.commit,
      ...appsEvidence(apps),
      assignee: issue.assigneeAgentId,
      delegator: { agentId: issue.createdByAgentId, userId: issue.createdByUserId },
      comments: () => (thread ??= pc.comments(issue.id)),
      attachments: () => pc.attachments(issue.id), content: (id: string) => pc.attachmentContent(issue.id, id),
      identifier: issue.identifier,
      // Another task the rubric or the ref names (evidence.ts otherTaskEvidence): its task and its attachment rows, read as the
      // owner through cp-read and never its files' contents. The task read carries no work prime, so another company's task is
      // refused before its work or its files are touched. A 404 is a fact ("no such task"); so is a task of another company,
      // which is never read. Any other failure throws, so the evidence waits for a real transient read failure instead of
      // becoming "not met".
      otherTask: async (ident: string) => {
        let task: Json;
        try {
          task = await pc.taskOnly(ident);
        } catch (err: Json) {
          if (Number(err?.status) === 404) return null;
          throw err;
        }
        if (!task?.companyId || task.companyId !== issue.companyId) return null;
        const listed = await pc.attachments(task.id);
        const files = Array.isArray(listed) ? listed : [];
        // Only the newest files otherTaskEvidence states get an uploader name: the agents read is one call each. A 404 is
        // "another agent" (pc.agent returns undefined); any other failure throws, so a transient read is never a wrong name.
        const newest = [...files].sort((a: Json, b: Json) => String(a?.createdAt ?? "").localeCompare(String(b?.createdAt ?? ""))).slice(-MAX_OTHER_FILES);
        const agents: Record<string, string> = {};
        for (const id of new Set(newest.map((f: Json) => f?.createdByAgentId).filter(Boolean))) {
          const a = await pc.agent(id as string);
          if (a?.name) agents[id as string] = a.name;
        }
        return { identifier: task.identifier ?? ident, files, agents };
      },
      // The ids a report cites, read one at a time (evidence.ts citedEvidence): a task's identifier, title and state as the
      // control plane has them; a card's state and outcome from the kernel's write record; an Actions job from GitHub.
      citedTask: async (ident: string) => {
        try {
          const i = await pc.issue(ident);
          return { identifier: i.identifier ?? ident, title: i.title ?? "", state: i.status ?? "unknown", exists: true };
        } catch (err: Json) {
          if (Number(err?.status) === 404) return { exists: false };
          throw err;
        }
      },
      citedCard: (id: string) => (writes.record(id) as Promise<Json | null>),
      citedJob: async (repo: string, id: string) => github.job(repo, id),
    };
  };
  // The kernel mints a grader-kind token for the task (billed to it, never capped) on each model call.
  const graderAsk = (issue: Json) => async (model: string, prompt: { system: string; user: string }) => {
    const { token } = await kernel("POST", "/v1/work/grader-token", { task: issue.id });
    return openRouterAsk(token, { schema: GRADE_SCHEMA, url: `${gatewayUrl}/api/v1/chat/completions` })(model, prompt);
  };
  const loop = createGradeLoop({
    api: { get: async (path: string) => (path === "/internal/grades" ? due() : runner("GET", path, undefined)), post: (path: string, body: unknown) => runner("POST", path, body) },
    pc, log, state, gather, grade, escalationFor, presentNow, gradeNote, template, gradeDeps, tellParent, recordsOn,
    graderAsk, emit, rubricHash,
    stripHidden, graderSpeaks: (s?: string) => ["open", "pending", "awaiting_evidence", "needs_revision", "grading_failed"].includes(String(s)), graderMarker: GRADER_MARKER,
  });
  return { ...loop, runGrades: async () => { workCache.clear(); return loop.runGrades(); } };
}
