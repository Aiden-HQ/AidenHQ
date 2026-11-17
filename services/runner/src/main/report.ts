import { join, relative } from "node:path";
import { isAgentSubtask, isUserPart, parseCommand } from "../agents.mjs";
import { ALL_STATUSES } from "../paperclip.ts";
import { prSummary, subtaskSummary, summaryGist, coversHead } from "../prompt.ts";
import { PRIMER_FILES, publishedRef, readDocument } from "../primer.ts";
import { summaryKind } from "../notices.ts";
import { log, pc, queue, running, sameRepo, state } from "./context.ts";
import { CLOSED } from "./poll.ts";
import { mergeQueue } from "./merge.ts";
import { graded, tellParent } from "./grading.ts";
import { recordsOn } from "./tier-state.ts";
import { runCommand } from "./commands.ts";
import { kernelWrites, ownerAskedToUpdate, primerRecord, savePrimer } from "./jobs.ts";
import { reportError, taskHasCommits } from "./github.ts";

/**
 * After a finished run on a task that asked for Primer: file the agent's document as a primer.publish record if it changed
 * (the AI reviewer checks it against the request; the kernel publishes it once approved and posts the outcome on the task).
 * The last record filed is settled first: done gives the document's link for later versions, a rejection keeps that version
 * from being filed again unchanged, and one still waiting holds this version back to the next run. Resolves with a line for
 * the task comment ("" when there was nothing to do).
 */
async function publishToPrimer(issue: any, full: any, workspace: any, agentId: any) {
  let record = primerRecord(issue.id);
  if (!record) return "";
  if (!agentId) return "_Couldn't file the Primer document: no Engineer is known for this run. The next run tries again._";
  const who = { issue, agentId };
  try {
    if (record.pending) {
      // A record the kernel no longer has (or not as this Engineer's) counts as never filed: this version is filed afresh.
      const r: any = await kernelWrites("GET", `/v1/writes/${record.pending.id}`, who).catch((e) => { if (e.status === 404) return { state: "gone" }; throw e; });
      if (["review", "owner", "approved", "claimed"].includes(r.state)) return `_Primer: the last version (approval ${record.pending.id}) is still waiting; this run's changes are filed after it is decided._`;
      const { pending, ...rest } = record;
      const ref = r.state === "done" ? publishedRef(r.outcome?.text) : {};
      record = { ...rest, ...(rest.documentId || !ref.documentId ? {} : { documentId: ref.documentId, url: ref.url }), ...(["done", "rejected"].includes(r.state) ? { hash: pending.hash } : {}) };
      savePrimer(issue.id, record);
    }
    const doc = readDocument(workspace, full.title);
    if (!doc) return `_No Primer document: the run didn't write ${PRIMER_FILES}._`;
    if (doc.hash === record.hash) return record.url ? `**Primer:** ${record.url} (unchanged)` : "";
    // A version of a document the task didn't publish itself goes to the owner unless their own comment asks for that link
    // to be updated (the executor raises it to Tier 2 without `own`): a link given to read is never one to overwrite.
    const own = record.documentId && (!record.linked || (await ownerAskedToUpdate(issue, record.url)));
    const args = { title: doc.title, content: doc.content, format: doc.format, path: relative(workspace, doc.path), ...(record.documentId ? { documentId: record.documentId } : {}), ...(own ? { own: true } : {}) };
    const r: any = await kernelWrites("POST", "/v1/writes", who, { kind: "primer.publish", args });
    savePrimer(issue.id, { ...record, pending: { id: r.id, hash: doc.hash } });
    log("filed for Primer", { issue: issue.identifier, approval: r.id, tier: r.tier, document: record.documentId });
    return `**Filed for Primer** (approval ${r.id}): ${record.documentId ? `a new version of ${record.url ?? record.documentId}` : "a new document"}. The AI reviewer checks it against the request; the outcome, with the link, is posted here.`;
  } catch (err: any) {
    log("Primer publish failed", { issue: issue.identifier, err: String(err.message ?? err).slice(0, 300) });
    return `_Couldn't file the Primer document: ${String(err.message ?? err).slice(0, 200)}. The document is in ${join(workspace, ".aidenhq")}; the next run tries again._`;
  }
}

/** The branch heads a task's last run ended on, for the run-end receipt: [{ repo, branch, sha }]. */
function headsOf(issueId: any) {
  try {
    return JSON.parse(state.get(`heads:${issueId}`) || "[]").filter((h: any) => h?.repo && h?.branch && h?.sha);
  } catch {
    return [];
  }
}

/**
 * Whether the board already shows a task's work published, so the receipt leaves it out of its `pr` invitation: every branch
 * row's PR merged or closed at the head its run ended on (a merge after that run counts; a commit made on the branch since
 * does not). A row with no PR, no recorded head, or a head its merge or close doesn't account for keeps the invitation: the
 * row alone is no evidence a committed head went out. Only the runner's own records are read, never a guess.
 */
function publishedAt(issue: any) {
  if (CLOSED.includes(issue.status)) return true;
  // No row or head is no evidence (`every` on nothing is true), so both are asked for first.
  const heads = headsOf(issue.id);
  const rows = state.branches(issue.id);
  const merged = (mergeQueue(issue.id)?.prs ?? []).filter((p: any) => p.status === "merged");
  return heads.length > 0 && rows.length > 0 && rows.every((row) => {
    const head = heads.find((h: any) => sameRepo(h.repo, row.repo) && h.branch === row.branch);
    if (!head || !((row.pr_url && row.merged) || row.closed)) return false;
    return row.closed ? row.closed_head === head.sha : merged.some((p: any) => sameRepo(p.repo, row.repo) && (p.head === head.sha || p.headOid === head.sha));
  });
}

/**
 * The pending pr/merge cards that cover every one of a task's heads: [{ id, action, sha }]. Only a task whose every
 * head is covered counts, so the receipt never hides a branch that still needs a request. A failed board read is no
 * cards: the receipt then offers `pr`, as it did before this existed.
 */
async function cardsAt(issue: any, heads: any) {
  // The board returns a card's args (the branch and commit) only to the runner's own key. Without it, no card can be
  // matched: the receipt keeps its `pr` invitation rather than guessing.
  if (!heads.length) return [];
  let approvals;
  try {
    approvals = await recordsOn(issue);
  } catch (err: any) {
    log("receipt card lookup failed", { issue: issue.identifier, err: String(err.message ?? err).slice(0, 200) });
    return [];
  }
  const pending = (approvals ?? []).filter((a: any) => a.state === "pending" && a.args && (a.action === "pr" || a.action === "merge"));
  const each = heads.map((h: any) => ({ h, card: pending.find((a: any) => coversHead(a, h)) }));
  if (each.some((x: any) => !x.card)) return [];
  return [...new Map(each.map((x: any) => [x.card.id, { id: x.card.id, action: x.card.action, sha: x.h.sha }])).values()];
}

/**
 * "pr" on a parent: open (or update) the PR of every approved Engineer sub-task that has commits,
 * one after another in the background, then post the links on the parent. Each task's own "pr" path
 * does the work, so its guards (merged PRs, empty repos, nothing new) all apply. True when a "pr"
 * comment was taken here.
 */
async function handleParentPr(parent: any, fresh: any) {
  const asks = fresh.filter((c: any) => parseCommand(c.body) === "pr");
  if (!asks.length) return false;
  const engineers = await pc.engineerAgents();
  // Approved sub-tasks the Researcher made, and the parts the user gave Engineers themselves.
  const kids = (await pc.children(parent.id)).filter((c: any) => (isAgentSubtask(c) && state.get(`approved:${c.id}`)) || isUserPart(c, engineers));
  if (!kids.length) return false;
  for (const c of asks) state.markHandled(c.id, parent.id);
  kids.sort((a: any, b: any) => a.identifier.localeCompare(b.identifier, undefined, { numeric: true }));
  await pc.comment(parent.id, `Opening PRs for the Engineer tasks with commits (${kids.length} task${kids.length === 1 ? "" : "s"} to check). I'll post the links here when done.`);
  log("parent pr requested", { issue: parent.identifier, tasks: kids.length });
  void (async () => {
    const rows = [];
    for (const kid of kids) {
      const task = state.task(kid.id);
      let note = "";
      try {
        const cards = await cardsAt(kid, headsOf(kid.id));
        if (running.has(kid.id) || queue.some((j: any) => j.issue.id === kid.id)) note = "Still running: reply **pr** on it when it's done";
        else if (cards.length) note = `Already requested: ${cards.map((c: any) => `${c.id} (${c.action})`).join(", ")}`;
        else if (publishedAt(kid)) note = "Already published";
        else if (!(await taskHasCommits(task))) note = "Nothing to publish";
        else await runCommand(kid, task, "pr");
      } catch (err: any) {
        await reportError(kid, err);
        note = `Failed: ${String(err.message ?? err).split("\n")[0]!.slice(0, 160)}`;
      }
      rows.push({ identifier: kid.identifier, title: kid.title, prUrl: note ? "" : state.branches(kid.id).filter((b) => b.pr_url && !b.merged).map((b) => b.pr_url).join(", "), note });
    }
    await pc.comment(parent.id, prSummary(rows));
    log("parent pr done", { issue: parent.identifier, opened: rows.filter((r) => r.prUrl).length });
  })().catch((err) => log("parent pr failed", { issue: parent.identifier, err: String(err.message ?? err).slice(0, 300) }));
  return true;
}

// Parents with a summary being posted: the sent markers are written only after the post succeeds (a failed post is
// retried on the next finish), so this keeps two siblings finishing together from posting it twice.
const summarizing = new Set();
/**
 * When the last of a parent's approved Engineer sub-tasks finishes, post one summary on the parent
 *: otherwise the parent stays silent after "Starting N tasks" while the results are spread over
 * N tasks. Once per batch: keyed on the newest job among the siblings.
 */
async function reportToParent(issue: any) {
  const full = await pc.issue(issue.id);
  if (!isAgentSubtask(full) || !state.get(`approved:${issue.id}`)) return;
  const siblings = (await pc.children(full.parentId, ALL_STATUSES)).filter((c: any) => isAgentSubtask(c) && state.get(`approved:${c.id}`));
  const busy = (c: any) => running.has(c.id) || queue.some((j: any) => j.issue.id === c.id) || (!state.lastJob(c.id) && ["todo", "in_progress"].includes(c.status));
  if (!siblings.length || siblings.some(busy)) return;
  const newest = Math.max(...siblings.map((c: any) => state.lastJob(c.id)?.id ?? 0));
  const key = `parent-summary:${full.parentId}`;
  if (Number(state.get(key) ?? 0) >= newest || summarizing.has(full.parentId)) return;
  const sorted = siblings
    .map((c: any) => ({ c, job: state.lastJob(c.id) }))
    .sort((a: any, b: any) => a.c.identifier.localeCompare(b.c.identifier, undefined, { numeric: true }));
  const rows = await Promise.all(
    sorted.map(async ({ c, job }: any) => {
      const committed = job?.detail === "committed";
      return { identifier: c.identifier, title: c.title, status: c.status, job: job?.status, committed, cards: committed ? await cardsAt(c, headsOf(c.id)) : [], published: committed && publishedAt(c), graded: await graded(c.id) };
    }),
  );
  // The same outcomes again (a resumed run that changed nothing, or only a newer card on a re-filed head) would only wake the
  // parent's agent for nothing.
  const text = subtaskSummary(rows);
  if (state.get(`parent-summary-gist:${full.parentId}`) === summaryGist(rows)) return void state.set(key, String(newest));
  summarizing.add(full.parentId);
  try {
    // Only when it is the last word (notices.ts summaryKind): with every task graded and nothing asked, the grades say it.
    await tellParent(full, summaryKind(rows), text);
  } finally {
    summarizing.delete(full.parentId);
  }
  state.set(key, String(newest));
  state.set(`parent-summary-gist:${full.parentId}`, summaryGist(rows));
  log("parent summary posted", { issue: issue.identifier, parent: full.parentId, tasks: rows.length });
}

export { handleParentPr, publishToPrimer, reportToParent };
