import { dirname, join } from "node:path";
import { isAgentSubtask, stripHidden } from "../agents.mjs";
import { gatewayApi, modelToken } from "../engines.mjs";
import { READ } from "../../../../modules/codehost-github/src/github-app.ts";
import { Paperclip } from "../paperclip.ts";
import * as prQueue from "../../../../modules/engineering/src/merge-queue.mjs";
import { openRouterAsk, openRouterKey } from "../models.mjs";
import { GRADE_SCHEMA, escalationFor, gather, grade, gradeNote, template } from "../grade.ts";
import { createGradeLoop } from "../../../../modules/grading/src/loop.mjs";
import { createResolver } from "../../../../kernel/src/net.ts";
import { graderSpeaks, wakesParent } from "../notices.ts";
import { boardApi, cfg, execFileP, gho, log, ownRepo, pc, queue, running, state } from "./context.ts";
import { dispatch } from "./dispatch.ts";
import { mergeGithub, mergeQueue } from "./merge.ts";
import { kernel, keyIn, recordsOn } from "./tier-state.ts";
import { findRealGh } from "./github.ts";

// ------------------------------------------------------------------ graded done

/**
 * The kernel's finish gate (graded done and any other task.finish check) for one of the runner's close paths: true when the
 * task may close as before. Held: the kernel has put it in review with the check's label. Anything else (a refusal, a check
 * that failed, the kernel unreachable) is false: the task stays in review, never closed past a check (fail closed; with the
 * kernel down no job or model call runs either).
 */
async function mayClose(issueId: any, via: any) {
  try {
    return (await kernel("POST", "/v1/finish", { task: issueId, via }, { ms: 30_000 })).pass === true;
  } catch (err: any) {
    log("completion gate failed", { issue: issueId, via, err: String(err.message ?? err).slice(0, 200) });
    return false;
  }
}
/** The grading module's service, at its container address (the kernel's resolver), with the runner's own key. */
const gradingApi = (() => {
  const base = process.env.AIDENHQ_GRADING_URL ?? "http://grading:8096";
  const keyFile = join(dirname(cfg.runnerWritesKeyFile), "grading_runner_key");
  const resolver = createResolver({ project: process.env.COMPOSE_PROJECT_NAME ?? "aidenhq" });
  const call = async (method: any, path: any, body?: any) => {
    const to = await resolver.resolve(`${base}${path}`);
    const res = await fetch(`http://${to.host}:${to.port}${to.path}`, { method, headers: { authorization: `Bearer ${keyIn(keyFile)}`, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60_000) }).catch((e) => { resolver.forget(base); throw e; });
    const text = await res.text();
    if (!res.ok) throw new Error(`grading ${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : {};
  };
  return { get: (path: any) => call("GET", path), post: (path: any, body = {}) => call("POST", path, body) };
})();
// The grade loop (modules/grading/src/loop.mjs): this runner holds what the grader reads, so it runs it.
const { runGrades, graded } = createGradeLoop({
  api: gradingApi, pc, log, state, gather, grade, escalationFor, gradeNote, template, gradeDeps, tellParent, stripHidden, graderSpeaks,
  recordsOn: (issue: any) => recordsOn(issue), dispatch: (job: any) => dispatch(job), isUserInstruction: (c: any) => Paperclip.isUserInstruction(c), selfName: cfg.selfName,
  // Through the model gateway with the runner's grader token (kind grader: billed to the task, never capped). AIDENHQ_GRADER_URL: tests' fake.
  graderAsk: (issue: any) => process.env.AIDENHQ_GRADER_URL
    ? openRouterAsk(openRouterKey(cfg), { schema: GRADE_SCHEMA, url: process.env.AIDENHQ_GRADER_URL })
    : openRouterAsk(modelToken(cfg, { kind: "grader", issueId: issue.id, component: "Grader", ttlMs: 3600_000 }), { schema: GRADE_SCHEMA, url: `${gatewayApi(cfg)}/chat/completions` }),
});
/** What the grader reads, for one task: GitHub through the App, the board's cards and app status, Paperclip's comments and files. */
function gradeDeps(issue: any) {
  // Read once per pass: the wait's words and the guard read the same thread.
  let thread;
  const comments = () => (thread ??= pc.comments(issue.id));
  return {
    busy: () =>
      running.has(issue.id) || queue.some((j: any) => j.issue.id === issue.id)
        ? "the Engineer is still working on it"
        : mergeQueue(issue.id)?.state === "running" || JSON.parse(state.get("auto_merges") || "{}")[issue.id]?.prs?.length
          ? "its merges are still running"
          : "",
    approvals: () => recordsOn(issue),
    taskPrs: async () => prQueue.findPrs(state.branches(issue.id).map((b) => b.pr_url).filter(Boolean).join("\n")),
    // The PRs this task's own runner records tie to it when no branch row does: its merge queue for the task, the merges it was
    // asked to run, and the merge cards it filed on it. The runner's own state and the board's cards, never a comment: a
    // comment's runner marker is text any writer can copy, so it proves nothing about which task a PR belongs to.
    taskMerged: async () => {
      const cards = (await recordsOn(issue)).filter((a: any) => a.action === "merge");
      const asked = JSON.parse(state.get("auto_merges") || "{}")[issue.id]?.prs ?? [];
      return [...(mergeQueue(issue.id)?.prs ?? []).filter((p: any) => p.status === "merged"), ...asked, ...cards.flatMap((a: any) => a.args?.prs ?? [])];
    },
    ownRepo,
    pr: (repo: any, number: any) => mergeGithub.pr(repo, number),
    diff: async (repo: any, number: any) => (await execFileP(await findRealGh(), ["api", "-H", "Accept: application/vnd.github.diff", `repos/${repo}/pulls/${number}`], await gho(repo, READ, { maxBuffer: 16 * 1024 * 1024 }))).stdout,
    app: async (name: any) => (/^[a-z0-9-]{1,63}$/.test(name) ? (await boardApi.get(`/internal/grades/app/${name}`)).app : null),
    appOfRepo: async (repo: any) => (await boardApi.get(`/internal/grades/app-of/${repo}`)).app,
    // Every deploy of one exact commit, over apps-mcp's whole deploy table (the status row's list is bounded).
    deployHistory: async (name: any, sha: any) => (await boardApi.get(`/internal/grades/deploys/${name}/${sha}`)).deploys,
    view: (name: any, path: any) => boardApi.post("/internal/grades/view", { name, path }),
    assignee: issue.assigneeAgentId, // whose comments are the task agent's own (wordsEvidence)
    comments,
    attachments: () => pc.attachments(issue.id),
    content: (id: any) => pc.attachmentContent(id),
    identifier: issue.identifier,
    // Another task the rubric names: its file list only (never contents), and only in this company; null when there is none.
    otherTask: async (ident: any) => {
      const t = await pc.issue(ident).catch((err) => {
        if (/→ 404\b/.test(String(err.message))) return null;
        throw err;
      });
      // The identifier's prefix is the company's (namedTasks asks only for the graded task's own); a row naming another
      // company, or a different task, is not this one.
      if (!t || t.identifier !== ident || (t.companyId && t.companyId !== pc.company)) return null;
      return { identifier: t.identifier, files: await pc.attachments(t.id), agents: Object.fromEntries((await pc.agents()).map((a) => [a.id, a.metadata?.persona?.name ?? a.name])) };
    },
  };
}

/**
 * A notice about a sub-task for its parent (notices.ts): an outcome is posted there, which wakes the delegator; progress is
 * not (it is on the sub-task already). Only an open parent hears it: Paperclip reopens a done or cancelled task on any
 * user-authored comment (the runner's included), which would wake its agent and send finished work round again (WOR-3582).
 * The asking agent's own chat, handed to the owner while it waited for a tap, is given back first so the outcome wakes it.
 * True when it was posted.
 */
async function tellParent(issue: any, kind: any, text: any) {
  if (!wakesParent(kind) || !issue.parentId) return false;
  const p = await pc.issue(issue.parentId).catch(() => undefined);
  if (!p || ["done", "cancelled"].includes(p.status)) return false;
  // Only the asking agent's own chat (its id in the chat's end-anchored marker), and only while it sits with the owner.
  const chatAgent = /<!-- aidenhq-chat-agent:([A-Za-z0-9_-]+) -->\s*$/.exec(p.description ?? "")?.[1];
  if (!p.assigneeAgentId && p.assigneeUserId && issue.createdByAgentId && chatAgent === issue.createdByAgentId && isAgentSubtask(issue))
    await pc.api("PATCH", `/api/issues/${encodeURIComponent(p.id)}`, { assigneeAgentId: issue.createdByAgentId, assigneeUserId: null, status: "todo" }).catch(() => {});
  await pc.comment(p.id, text);
  return true;
}

export { graded, mayClose, runGrades, tellParent };
