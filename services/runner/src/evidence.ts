// Evidence, read by code (wave 3, item 5): one function per deliverable kind, shared by the grader (grade.ts gather) and
// the duplicate-card guard (item 4). Facts here were checked by code and are trusted; anything an agent wrote is returned
// as data for the caller to fence. Nothing here closes a task or decides a card: it only reports what is true.
import { createHash } from "node:crypto";
import { RUNNER_MARKER } from "./agents.mjs";
import { patchKey } from "./git.mjs";
import { GATE_CHECK, findPrs, namedChecks, skippedImageScan } from "./merges.mjs";
import { MAX_DIFF } from "./review.mjs";
import { downscalePng, imageInfo, pngStamp, type ImageInfo } from "./images.ts";

/** Marks the grader's own notes on a task, so they never count as the deliverable's evidence. */
export const GRADER_MARKER = "<!-- aidenhq:grader -->";

/** The board's reason code for a change already satisfied on the target (services/board/src/approvals.ts ALREADY_APPLIED). */
export const ALREADY_APPLIED = "already_applied";

const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

/**
 * The repository's own aggregate required check on the head (`ci-required` in the product's ci.yml): "green" when it
 * completed and passed, "red" when it ended otherwise ("not accepted"), "running" while it is queued or in progress —
 * and also, on an open PR, when CI on the head has started but the aggregate is not there yet, because the jobs that need
 * another appear only as it finishes and a head with a few checks can look complete while its tests have not started.
 * "missing" when the repository's CI has no such aggregate at all (an app's template CI), which a merged head's final
 * rollup settles too: no aggregate there means the repository's CI had none for that commit.
 */
function gateOn(pr: any, checks: any[]): string {
  const gate = checks.find((c) => c.name === GATE_CHECK);
  if (gate) return gate.pending ? "running" : gate.status === "SUCCESS" ? "green" : "red";
  if (pr.state !== "OPEN" || !checks.length) return "missing";
  return namedChecks(pr.baseRef?.target?.statusCheckRollup).some((c: any) => c.name === GATE_CHECK) ? "running" : "missing";
}

/**
 * A check's state as the trusted facts state it: green, still running, or not green. Three cases are green. A passed
 * check. An `image-scan` skipped because the change cannot alter an image (`.github/workflows/ci.yml`), which
 * `skippedImageScan` decides: the merge gate merges on that skip. And a skip the repository's own aggregate required
 * check accepted on the same head: ci.yml's `ci-required` is what decides which jobs may skip (it lists them and requires
 * every other job to succeed), so its passing is the proof that a skip beside it was by design. A skip it did not accept
 * — a cancelled job, a missing dependency, a condition that came out false, a head whose aggregate is red or absent —
 * reads not green, so nothing is accepted on the strength of being skipped alone.
 */
function checkState(pr: any, c: any, gate: string): string {
  if (c.pending) return "still running";
  if (!c.skipped) return c.status === "SUCCESS" ? "green" : c.status === "NEUTRAL" ? "not green (neutral)" : "not green (failed)";
  // The aggregate cannot accept its own skip: only its passing is the proof that the skips beside it are by design.
  if (c.name === GATE_CHECK) return "not green (the required check itself was skipped)";
  if (c.name === "image-scan") return skippedImageScan(pr) ? "not green (skipped, and an image could change)" : "green (no image could change)";
  if (gate === "green") return `green (skipped, and ${GATE_CHECK} accepted it)`;
  return gate === "red" ? `not green (skipped, and ${GATE_CHECK} did not pass)` : `not green (skipped, with no ${GATE_CHECK} to accept it)`;
}

/**
 * The PRs the task's own runner records tie to it, for a merge its branch rows no longer name: the queue it ran for this task,
 * the merges it was asked to run, and the merge cards it filed on it (deps.taskMerged). dedupe: one row per PR.
 */
export function taskMergePrs(rows: any[] | undefined) {
  const out: { repo: string; number: number; url: string }[] = [];
  for (const r of rows ?? []) {
    const p = r?.url ? findPrs(String(r.url))[0] : r?.repo && r?.number ? { repo: String(r.repo), number: Number(r.number), url: `https://github.com/${r.repo}/pull/${r.number}` } : undefined;
    if (p && !out.some((x) => x.repo.toLowerCase() === p.repo.toLowerCase() && x.number === p.number)) out.push(p);
  }
  return out;
}

/**
 * What the task's own record says about its deliverable *now*, read fresh when an evidence wait is about to escalate: a PR
 * merged (the task's branch rows, or the runner's own merge records for it when those rows are gone) with its mergedAt, and for
 * a PR in an app's repo a healthy deploy of that merge commit; for an app, a healthy deploy record of its deployed sha; for an apply, a
 * used card with an outcome. { present, facts }: present means the work is there and the wait must hold, not escalate; facts are
 * what this read found and are the only source of a written escalation's premise. A file or report deliverable's evidence is
 * the task's own words, gathered again on the same pass, so there is nothing here to confirm outside it (no facts).
 */
export async function presentNow(deliverable: any, deps: any) {
  const kind = deliverable?.kind;
  const facts: string[] = [];
  if (kind === "pr") {
    let prs = byRef((await deps.taskPrs?.()) ?? [], deliverable.ref);
    if (!prs.length && deps.taskMerged) prs = byRef(taskMergePrs(await deps.taskMerged().catch(() => [])), deliverable.ref);
    let merged: { repo: string; sha: string } | undefined;
    for (const p of prs.slice(0, 5)) {
      const pr = (await deps.pr(p.repo, p.number).catch(() => null))?.repository?.pullRequest;
      if (!pr) {
        facts.push(`${p.url} could not be read just now`);
        continue;
      }
      if (pr.state !== "MERGED") {
        const running = namedChecks(pr.commits?.nodes?.[0]?.commit?.statusCheckRollup).filter((c: any) => c.pending).map((c: any) => c.name);
        facts.push(`${p.url} is ${pr.state === "OPEN" ? "open, not merged yet" : String(pr.state).toLowerCase()}${running.length ? ` (checks still running: ${running.join(", ")})` : ""}`);
        continue;
      }
      merged ??= { repo: p.repo, sha: pr.mergeCommit?.oid ?? pr.headRefOid ?? "" };
      facts.push(`${p.url} is merged${pr.mergedAt ? ` at ${pr.mergedAt}` : ""}${pr.mergeCommit?.oid ? ` (merge commit ${pr.mergeCommit.oid.slice(0, 12)})` : ""}`);
    }
    // A merged PR is delivered by itself; an app on its repo only adds the "deployed at that commit" fact.
    if (merged && deps.appOfRepo) {
      const app = await deps.appOfRepo(merged.repo).catch(() => null);
      const rows = app ? (await deploysOf(app, merged.sha, deps)).rows : [];
      const d = rows.find((r: any) => r.status === "healthy");
      if (app) facts.push(d ? `app ${app.name}: ${merged.sha.slice(0, 12)} deployed ${stamp(d.at)} (healthy)` : `app ${app.name}: no healthy deploy of ${merged.sha ? merged.sha.slice(0, 12) : "the merge commit"}`);
    }
    return { present: Boolean(merged), facts };
  }
  if (kind === "app") {
    const app = await deps.app?.(deliverable.ref).catch(() => null);
    if (!app) return { present: false, facts: [`no app named ${deliverable.ref || "(none)"} is deployed yet`] };
    const d = (await deploysOf(app, app.sha, deps)).rows.find((r: any) => r.status === "healthy");
    return { present: Boolean(d), facts: [d ? `app ${app.name}: ${String(app.sha).slice(0, 12)} deployed ${stamp(d.at)} (healthy)` : `app ${app.name}: deployed commit ${String(app.sha ?? "(none)").slice(0, 12)} has no healthy deploy`] };
  }
  if (kind === "apply") {
    const applied = ((await deps.approvals?.()) ?? []).filter((a: any) => a.action === "apply" && a.state === "used" && a.outcome).at(-1);
    return applied ? { present: true, facts: [`apply ${applied.id}: used, ${applied.outcome}`] } : { present: false, facts: ["no apply filed yet"] };
  }
  return { present: false, facts: [] };
}

/**
 * The task's PRs as evidence: { awaiting } or { version, facts, data }. `prs` are the runner's own PRs for the task, narrowed
 * by the ref (a PR named only in the ref is never read). deps: pr(repo, n) (merges.PR_QUERY's data), diff(repo, n), ownRepo(slug).
 */
export async function prEvidence(prs: any[], ref: string, deps: any): Promise<any> {
  prs = byRef(prs, ref);
  // No branch row names one: the runner's own records for the task (its merge queue and the merge cards it filed) still say
  // which PR delivered it, so they are read rather than reporting "no pull request yet" for a merge whose row a cleanup, a
  // prune or a state reset took away. Never a comment: its runner marker is text any writer can copy, so it proves nothing.
  const byRecord = !prs.length && Boolean(deps.taskMerged);
  if (byRecord) prs = byRef(taskMergePrs(await deps.taskMerged().catch(() => [])), ref);
  if (!prs.length) return { awaiting: "no pull request yet", missing: true };
  const facts: string[] = [];
  const versions: string[] = [];
  const prs_: any[] = []; // each graded PR with its merge commit ("" while unmerged)
  let diff = "";
  for (const p of prs.slice(0, 5)) {
    const pr = (await deps.pr(p.repo, p.number))?.repository?.pullRequest;
    if (!pr) return { awaiting: `${p.url} can't be read yet` };
    const checks = namedChecks(pr.commits?.nodes?.[0]?.commit?.statusCheckRollup);
    const gate = gateOn(pr, checks);
    // A read caught mid-run is never a verdict. A check still queued or running is one (GitHub also reports the rollup as
    // a whole as PENDING until they all finish, so the individual states are the finer read), and so is a head whose
    // aggregate required check is not written yet: its jobs appear only as it finishes.
    if (checks.some((c: any) => c.pending) || gate === "running") return { awaiting: `checks still running on ${p.url}` };
    // Outside the agents org and the product repo the runner can't merge and the owner doesn't: someone else merges it.
    if (pr.state === "OPEN" && deps.ownRepo && !deps.ownRepo(p.repo)) return { awaiting: `${p.url} is not merged yet` };
    // The runner's record names the PR; GitHub says what became of it. Closed without merging is not a merge, not "still running".
    if (byRecord && pr.state !== "MERGED") return { awaiting: `${p.url} ${pr.state === "OPEN" ? "is not merged yet" : "was closed without merging"}` };
    const merged = pr.state === "MERGED";
    const sha = merged ? (pr.mergeCommit?.oid ?? pr.headRefOid) : pr.headRefOid;
    versions.push(`${p.repo}#${p.number}@${sha}`);
    // The code a screenshot may show: the head, the merge commit, and the newest commit that isn't a merge of the base (the
    // agent's own, which the runner re-signs with the same tree before a base update merges on top). By commit or by tree.
    const history = (pr.history?.nodes ?? []).map((n: any) => n.commit).filter(Boolean);
    const own = history.findLast((c: any) => c.parents?.totalCount === 1);
    const shows = { commits: [pr.headRefOid, merged ? pr.mergeCommit?.oid : "", own?.oid].filter(Boolean), trees: [history.find((c: any) => c.oid === pr.headRefOid)?.tree?.oid, own?.tree?.oid].filter(Boolean) };
    prs_.push({ repo: p.repo, number: p.number, merge: merged ? (pr.mergeCommit?.oid ?? "") : "", mergedAt: pr.mergedAt ?? "", shows });
    facts.push(`${p.url}: ${pr.state.toLowerCase()}${merged ? ` into ${pr.baseRefName}` : ` (base ${pr.baseRefName})`}, head ${pr.headRefOid}${merged && pr.mergeCommit?.oid ? `, merge commit ${pr.mergeCommit.oid}` : ""}; checks: ${checks.length ? checks.map((c: any) => `${c.name} ${checkState(pr, c, gate)}`).join(", ") : "none"}${byRecord ? "; named by the runner's own record for this task" : ""}`);
    diff += `### ${p.url}\n${(await deps.diff(p.repo, p.number).catch(() => "(the diff could not be read)")).slice(0, MAX_DIFF)}\n`;
  }
  // The board keeps a version in 200 characters: several PRs are bound by their hash.
  const version = versions.join(" ").length <= 200 ? versions.join(" ") : `prs:${hash(versions.join(" "))}`;
  return { version, facts, prs: prs_, data: { DIFF: diff.slice(0, MAX_DIFF) } };
}

/** An epoch-millis deploy time as ISO, or the value as given (an apps-mcp row may already carry a string). */
export const stamp = (at: unknown): string => (typeof at === "number" ? new Date(at).toISOString() : String(at ?? ""));

/**
 * Every deploy of one exact commit, newest first. `deps.deployHistory(app, sha)` reads apps-mcp's whole deploy table, which is
 * never pruned, so a commit the bounded status row (`app.deploys`) has moved past is still found. Without that read (a
 * failure) only the row is available: `complete: false` says a missing deploy there may simply predate the window it keeps.
 */
export async function deploysOf(app: any, sha: string | undefined, deps: any): Promise<{ rows: any[]; complete: boolean }> {
  if (!sha) return { rows: [], complete: true };
  const rows = await deps.deployHistory?.(app.name, sha).catch(() => undefined);
  if (Array.isArray(rows)) return { rows, complete: true };
  return { rows: (Array.isArray(app.deploys) ? app.deploys : []).filter((d: any) => d.sha === sha), complete: false };
}

/** Whether a merge predates the oldest deploy the status row still lists: then a miss there proves nothing either way. */
export const predatesDeploys = (app: any, mergedAt: unknown): boolean => {
  const at = (Array.isArray(app?.deploys) ? app.deploys : []).map((d: any) => Date.parse(stamp(d.at))).filter((t: number) => Number.isFinite(t));
  const merged = Date.parse((mergedAt as string) || "");
  return at.length > 0 && Number.isFinite(merged) && merged < Math.min(...at);
};

/** A deployed app (apps-mcp status row, or null) as evidence: its commit, state, health, incident and recent deploys. */
export function appEvidence(app: any, name: string | undefined): any {
  if (!app) return { awaiting: `no app named ${name || "(none)"} is deployed yet` };
  if (!app.sha) return { awaiting: `${app.name} is not deployed yet` };
  const facts = [`app ${app.name}: deployed commit ${app.sha}${app.deployed_at ? ` at ${stamp(app.deployed_at)}` : ""}${app.deployed_by ? ` by ${app.deployed_by}` : ""}; state ${app.state}; ${app.healthy ? "healthy" : "not healthy"}; ${app.incident ? `open incident (${app.incident.kind})` : "no open incident"}`];
  // The history, newest first: which commits were deployed, by whom, and how each ended. `by: auto-deploy` is the
  // platform's own deploy of a moved origin branch (loops.ts), never an agent or the owner.
  const seen = (Array.isArray(app.deploys) ? app.deploys : []).slice(0, 5);
  if (seen.length) facts.push(`app ${app.name}: recent deploys (newest first): ${seen.map((d: any) => `${d.sha.slice(0, 12)} deployed ${stamp(d.at)} by ${d.by} (${d.status})`).join("; ")}`);
  return { version: `${app.name}@${app.sha}`, facts, data: {} };
}

/** The task's latest fleet apply (its approval records) as evidence: its state and outcome. */
export function applyEvidence(cards: any[]): any {
  const applied = cards.filter((a: any) => a.action === "apply").at(-1);
  if (!applied) return { awaiting: "no apply filed yet", missing: true };
  const facts = [`apply ${applied.id}: ${applied.state}${applied.outcome ? `, ${applied.outcome}` : ""}`];
  return { version: applied.id, facts, data: { APPLY_OUTCOME: applied.outcomeText ?? "", APPLY_CHANGE: applied.details ?? "" } };
}

const NEWEST = 4; // the newest comments, anyone's, always go first (an owner's reopening word among them)
const COMMENT_MAX = 8_000; // one comment's characters
export const COMMENTS_TOTAL = 18_000; // all comments' characters (the prompt fences a block at 20,000)
const COMMON = new Set("about above after again agent along also another because before being below between could does doing done during each every final first found from have having here into itself just latest least made make more most much must never only other over posted result same should shows since some still such than that their them then there these they this those through under until very were what when where which while will with within would your".split(" "));
/** A text's distinctive words (4+ characters, file names and paths whole), for matching a comment to what names it. */
const termsOf = (text: unknown) => new Set((String(text).toLowerCase().match(/[a-z0-9][a-z0-9._/-]{3,}/g) ?? []).map((w: string) => w.replace(/[._/-]+$/, "")).filter((w: string) => w.length >= 4 && !COMMON.has(w)));

/**
 * The comments the grader reads, within COMMENTS_TOTAL: the NEWEST newest (anyone's but the grader's), then the task agent's
 * own earlier ones (`own(c)`), ranked: those whose id the rubric or the agent's latest result names, then by how many of
 * their distinctive words those name, then the newest. A report posted in parts, or evidence posted before a short closing
 * note, is read this way, not lost behind the last few comments. Each is cut to COMMENT_MAX; they go in the task's order.
 * { text, fact }: the fact says what was sent, cut or left out.
 */
export function pickComments(all: any[], own: (c: any) => boolean, rubric = "") {
  const newest = all.slice(-NEWEST);
  const earlier = all.slice(0, -NEWEST).filter(own);
  const latest = [...all].reverse().find(own);
  const named = `${rubric}\n${latest?.body ?? ""}`;
  const want = termsOf(named);
  const score = (c: any): number => (c.id && named.includes(c.id) ? 1e6 : [...termsOf(c.body)].filter((w) => want.has(w)).length);
  const ranked = earlier.map((c, i) => ({ c, i, s: score(c) })).sort((a, b) => b.s - a.s || b.i - a.i).map((x) => x.c);
  let left = COMMENTS_TOTAL;
  const shown = new Map<any, string>();
  let cut = 0;
  let out = 0;
  const head = (c: any) => `--- comment ${String(c.createdAt ?? "").slice(0, 25)} ---\n`;
  for (const c of [...newest].reverse().concat(ranked)) {
    const body = String(c.body ?? "");
    left -= head(c).length + 2; // the header and separator count too, so the fence never cuts the block
    if (left <= 0) {
      out++;
      continue;
    }
    const s = body.slice(0, Math.min(COMMENT_MAX, left));
    if (s.length < body.length) cut++;
    left -= s.length;
    shown.set(c, s);
  }
  const text = all.filter((c) => shown.has(c)).map((c) => `${head(c)}${shown.get(c)}`).join("\n\n");
  const extra = [...shown.keys()].filter((c) => !newest.includes(c)).length;
  const fact = `TASK_COMMENTS holds ${shown.size} of the task's ${all.length} comments (the grader's own not counted): the newest${extra ? `, and ${extra} earlier one${extra > 1 ? "s" : ""} by the task's agent picked by what the rubric and its latest result name` : ""}${cut ? `; ${cut} cut to fit (each at most ${COMMENT_MAX} characters, all at most ${COMMENTS_TOTAL})` : ""}${out ? `; ${out} more left out over that budget` : ""}`;
  return { text, fact };
}

/**
 * The task's own words (the newest comments other than the grader's, and the agent's earlier ones that bear on the rubric:
 * pickComments) and its files: the evidence for file and report, context for the rest. The task's agent is deps.assignee
 * (its own comments) or the runner posting an Engineer's (its marker). File names and types are the agents' own strings: the
 * trusted facts call each file by a code-made label (file_1, file_2, ... in the attachments' order) and its name and type go
 * in the fenced FILE_NAMES block, as data. The version stays the newest comments' and the files' ids.
 */
export async function wordsEvidence(deps: any, rubric: string[] = []): Promise<any> {
  const all = (await deps.comments()).filter((c: any) => !String(c.body ?? "").includes(GRADER_MARKER));
  const comments = all.slice(-NEWEST);
  const own = (c: any) => String(c.body ?? "").includes(RUNNER_MARKER) || (deps.assignee ? c.authorAgentId === deps.assignee : c.authorType === "agent");
  const picked = pickComments(all, own, rubric.join("\n"));
  const files = (await deps.attachments().catch(() => [])).map((f: any, i: number) => ({ ...f, label: `file_${i + 1}` }));
  const facts = files.length ? [`${files.length} file${files.length > 1 ? "s" : ""} attached: ${files.map((f: any) => f.label).join(", ")} (their names and types, as the agent gave them, are in FILE_NAMES)`] : ["no files attached"];
  if (all.length) facts.push(picked.fact);
  const version = comments.length || files.length ? hash([...comments.map((c: any) => c.id), ...files.map((f: any) => f.id)].join(" ")) : "";
  const names = files.map((f: any) => `${f.label}: ${String(f.originalFilename ?? f.name ?? "").slice(0, 200)} (${String(f.contentType ?? "").slice(0, 100)})`).join("\n");
  return { version, facts, files, data: { TASK_COMMENTS: picked.text, ...(files.length ? { FILE_NAMES: names } : {}) } };
}

const MAX_OTHER_TASKS = 3;
const MAX_OTHER_FILES = 20; // per task, the newest

/**
 * The other tasks a rubric or a deliverable's ref names by identifier ("put the mockups onto ACME-12"): the graded task's own
 * prefix (its company's), never itself, at most MAX_OTHER_TASKS. Only these trusted texts, never the request or comments.
 */
export function namedTasks(texts: unknown[], own: string | undefined) {
  const prefix = /^([A-Z][A-Z0-9]*)-\d+$/.exec(String(own ?? ""))?.[1];
  const out: string[] = [];
  if (!prefix) return out;
  for (const t of texts) {
    for (const m of String(t ?? "").matchAll(/\b([A-Z][A-Z0-9]*)-(\d{1,7})\b/g)) {
      if (m[1] !== prefix || m[0] === own || out.includes(m[0])) continue;
      if (out.push(m[0]) >= MAX_OTHER_TASKS) return out;
    }
  }
  return out;
}

/**
 * Other tasks' attached files as evidence, read-only and never their contents: for each identifier, deps.otherTask(ident)
 * resolves { identifier, files, agents } (Paperclip's attachment rows; agents: id → name, Paperclip's own) or null when no such task is in this company. Code states as
 * trusted facts each file's label (<ident>/file_<n>), size, upload time and uploader, and whether it matches one of this
 * task's own files (`own`, labelled by wordsEvidence) by name and size; the names and types, the agents' strings, go in the
 * fenced OTHER_TASK_FILES block. A read that fails waits for the next look (missing evidence is never a pass).
 * { awaiting } or { facts, data, version } (version: the files' ids, "" with none).
 */
export async function otherTaskEvidence(idents: string[], deps: any, own: any[] = []): Promise<any> {
  const facts: string[] = [];
  const names: string[] = [];
  const ids: string[] = [];
  const nameOf = (f: any) => String(f.originalFilename ?? f.name ?? "");
  const when = (t: unknown) => (/^\d{4}-\d\d-\d\dT[\d:.]+Z?$/.test(String(t ?? "")) ? String(t) : "an unknown time");
  for (const ident of idents) {
    let t: any;
    try {
      t = await deps.otherTask(ident);
    } catch (err: any) {
      return { awaiting: `the files on ${ident} could not be read yet (${String(err.message ?? err).replace(/[^\w .:/()-]/g, "").slice(0, 160)})` };
    }
    if (!t) {
      facts.push(`${ident}: no such task in this company (nothing read from it)`);
      continue;
    }
    const files = [...(t.files ?? [])].sort((a: any, b: any) => String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? ""))).slice(-MAX_OTHER_FILES);
    if (!files.length) {
      facts.push(`${ident} (another task the rubric names; its file list read now): no files attached`);
      continue;
    }
    const lines = files.map((f: any, i: number) => {
      const label = `${ident}/file_${i + 1}`;
      ids.push(f.id);
      names.push(`${label}: ${nameOf(f).slice(0, 200)} (${String(f.contentType ?? "").slice(0, 100)})`);
      const agent = String(t.agents?.[f.createdByAgentId] ?? "").replace(/[^\w .()-]/g, "").slice(0, 60);
      const by = f.createdByAgentId ? (f.createdByAgentId === deps.assignee ? "this task's agent" : agent ? `agent ${agent}` : "another agent") : f.createdByUserId ? "the board key (the owner, or the runner for an Engineer)" : "an unknown uploader";
      const same = own.find((o: any) => nameOf(o) && nameOf(o) === nameOf(f) && Number(o.byteSize) === Number(f.byteSize));
      return `${label}: ${Number(f.byteSize) || 0} bytes, uploaded at ${when(f.createdAt)} by ${by}${same ? `, the same name and size as this task's ${same.label}` : ""}`;
    });
    facts.push(`${ident} (another task the rubric names; its file list read now, not the files' contents): ${files.length} file${files.length > 1 ? "s" : ""} attached${(t.files ?? []).length > files.length ? ` (the newest ${files.length} of ${t.files.length})` : ""}: ${lines.join("; ")} (their names and types are in OTHER_TASK_FILES)`);
  }
  return { facts, data: names.length ? { OTHER_TASK_FILES: names.join("\n") } : {}, version: ids.length ? hash(ids.join(" ")) : "" };
}

/** A content type as code may state it among the trusted facts: a plain type/subtype, or "unknown type". */
const safeType = (t: unknown) => (/^[\w.+-]+\/[\w.+-]+$/.test(String(t ?? "")) ? String(t) : "unknown type");

export const MAX_IMAGES = 20; // a mockup task attaches ~18 screenshots; the byte budget below is the real bound
const IMAGE_SIDE = 2048; // a PNG with a longer side is downscaled (the vision models scale to about this anyway)
const IMAGE_BYTES = 3 * 1024 * 1024; // one image as sent; a bigger one is downscaled if a PNG, else left out
const IMAGES_BYTES = 12 * 1024 * 1024; // all images as sent (base64 adds a third; the gateway takes 32 MB)
const TEXT_FILE = 6_000; // one text file's characters
export const TEXT_TOTAL = 16_000; // all text files' characters (the prompt fences a block at 20,000)
const DOCUMENT_FILE = 6_000; // one task document's characters
export const DOCUMENTS_TOTAL = 16_000; // all task documents' characters (its own fenced block, under 20,000)
const TEXT_EXT = /\.(txt|md|markdown|json|csv|tsv|ya?ml|log|html?|tsx|ts|jsx|js|css)$/i;

/**
 * A text cut to `max` characters for the prompt: the start and the end, with the middle replaced by a marker that names how
 * many characters were cut. A test log's verdict is at its end, so cutting only the head would hide the proof a criterion
 * asks for. A cut is always marked: when not even the marker fits, this returns undefined and the caller says the file was
 * not sent, so the trusted facts never claim a marker that is absent.
 */
function excerpt(text: string, max: number): { shown: string; cut: number } | undefined {
  if (text.length <= max) return { shown: text, cut: 0 };
  const marker = (head: number, tail: number) => `\n[... characters ${head + 1}-${text.length - tail} cut ...]\n`;
  let head = Math.floor(max * 0.6);
  let tail = max - head;
  for (let i = 0; i < 8; i++) {
    const m = marker(head, tail);
    const room = max - m.length;
    if (room < 0) break;
    if (head + tail <= room) return { shown: text.slice(0, head) + m + text.slice(text.length - tail), cut: text.length - head - tail };
    const nextHead = Math.floor(room * 0.6);
    const nextTail = room - nextHead;
    if (nextHead === head && nextTail === tail) break;
    head = nextHead;
    tail = nextTail;
  }
  // No room for text beside the marker: the marker alone still says the whole file was cut, when it fits.
  const only = marker(0, 0);
  return only.length <= max ? { shown: only, cut: text.length } : undefined;
}

/** A PNG made to fit: downscaled until its longest side is at most IMAGE_SIDE and its bytes IMAGE_BYTES, or null. */
function fitPng(buf: Buffer, info: ImageInfo): Buffer | null {
  for (let side = Math.min(IMAGE_SIDE, Math.max(info.width, info.height)); side >= 256; side = Math.floor(side * 0.7)) {
    const small = downscalePng(buf, side);
    if (!small) return null;
    if (small.length <= IMAGE_BYTES) return small;
  }
  return null;
}

/**
 * The task's attached files' contents, for the grader (`files` as wordsEvidence labels them): images (sniffed from the
 * bytes, at most 20, a large PNG downscaled) as image parts, text files (.txt, .md, .json, .csv, ...) as one fenced FILES
 * block, each cut and all within a budget. Order: files the rubric names by file name, then files the task's recent
 * comments name, then the newest. { awaiting } when a file can't be read yet (missing evidence is never a pass), else
 * { facts, data, images }: the facts say per file label (never its name, the agent's string) what was sent (its size, its
 * pixel size, what was cut or left out), so a file left out reads as not sent, not as missing work. `content(id)` resolves
 * with the file's bytes. `heads` (a pr's): the code under review, each PR's { commits, trees } (prEvidence's `shows`); a
 * screenshot stamped (aidenhq-browse, ui-review) with a commit and tree that are none of them shows other code, so it is
 * not sent, and the facts say so. An unstamped image (a mockup, a reference) is sent as before.
 */
export async function fileEvidence(files: any[], content: (id: string) => Promise<Buffer>, { rubric = "", comments = "", heads = [] }: { rubric?: string; comments?: string; heads?: { commits: string[]; trees: string[] }[] } = {}): Promise<any> {
  const facts: string[] = [];
  const images: { url: string; label: string }[] = [];
  const texts: string[] = [];
  let imageBytes = 0;
  let textLeft = TEXT_TOTAL;
  const nameOf = (f: any) => String(f.originalFilename ?? f.name ?? "");
  const baseOf = (f: any) => nameOf(f).split("/").pop()!.toLowerCase();
  const exact = (f: any, text: string) => {
    const base = baseOf(f);
    return base.length >= 3 && text.toLowerCase().includes(base);
  };
  // A rubric often names the file by what it is ("the write matrix", "the test log") rather than its exact name.
  const words = (f: any) => baseOf(f).replace(/\.[^.]+$/, "").split(/[^a-z0-9]+/).filter((w: string) => w.length >= 4);
  const named = (f: any, text: string) => {
    const w = words(f);
    // One shared word ("shot" in shot-1.png and shot-2.png) names nothing: a described file has two or more of its own words.
    return w.length >= 2 && w.filter((x: string) => text.toLowerCase().includes(x)).length >= 2;
  };
  const rank = (f: any) => (exact(f, rubric) ? 3 : named(f, rubric) ? 2 : exact(f, comments) || named(f, comments) ? 1 : 0);
  const order = [...files].sort((a: any, b: any) => rank(b) - rank(a) || String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
  for (const f of order) {
    const name = nameOf(f);
    const isImage = /^image\//.test(f.contentType ?? "") || /\.(png|jpe?g|gif|webp)$/i.test(name);
    const isText = !isImage && (TEXT_EXT.test(name) || /^text\/|^application\/json/.test(f.contentType ?? ""));
    if (!isImage && !isText) {
      facts.push(`${f.label}: not sent to the grader (${safeType(f.contentType)})`);
      continue;
    }
    if (isImage && images.length >= MAX_IMAGES) {
      facts.push(`${f.label}: attached, not sent to the grader (only ${MAX_IMAGES} images are sent: those the rubric names, then those the comments name, then the newest)`);
      continue;
    }
    if (isText && textLeft <= 0) {
      facts.push(`${f.label}: text, ${Number(f.byteSize) || 0} bytes, not sent to the grader (the text budget of ${TEXT_TOTAL} characters was spent on files the rubric names first)`);
      continue;
    }
    let buf: Buffer;
    try {
      buf = await content(f.id);
    } catch (err: any) {
      return { awaiting: `the attached ${f.label} could not be read yet (${String(err.message ?? err).replace(/[^\w .:/()-]/g, "").slice(0, 160)})` };
    }
    if (isImage) {
      const info = imageInfo(buf);
      if (!info) {
        facts.push(`${f.label}: not sent to the grader (not a PNG, JPEG, GIF or WebP image)`);
        continue;
      }
      const real = `${info.width}x${info.height}`;
      const st = heads.length ? pngStamp(buf) : null;
      const at = (v: unknown) => (typeof v === "string" && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(v) ? v : "");
      if (st && (at(st.commit) || at(st.tree)) && !heads.some((h) => h.commits.includes(at(st.commit)) || h.trees.includes(at(st.tree)))) {
        facts.push(`${f.label}: a screenshot stamped as taken at commit ${at(st.commit).slice(0, 12) || "?"} (tree ${at(st.tree).slice(0, 12) || "?"}), which is not the code under review (${heads.map((h) => h.commits[0]!.slice(0, 12)).join(", ")}): not sent to the grader, as it shows other code`);
        continue;
      }
      let sent = buf;
      if (info.type === "image/png" && (Math.max(info.width, info.height) > IMAGE_SIDE || buf.length > IMAGE_BYTES)) sent = fitPng(buf, info) ?? buf;
      if (sent.length > IMAGE_BYTES || imageBytes + sent.length > IMAGES_BYTES) {
        facts.push(`${f.label}: image ${real} px, attached, not sent to the grader (${Math.round(sent.length / 1024)} KB is over the image budget)`);
        continue;
      }
      const s = (sent === buf ? info : imageInfo(sent))!;
      imageBytes += sent.length;
      images.push({ url: `data:${info.type};base64,${sent.toString("base64")}`, label: f.label });
      facts.push(`${f.label}: image ${real} px (its real size), shown as IMAGE_${images.length}${sent !== buf ? ` downscaled to ${s.width}x${s.height} px` : ""}`);
      continue;
    }
    const text = buf.toString("utf8");
    const ex = excerpt(text, Math.min(TEXT_FILE, textLeft));
    if (!ex) {
      facts.push(`${f.label}: text, ${text.length} characters, not sent to the grader (the remaining text budget of ${textLeft} characters has no room for a cut marker)`);
      continue;
    }
    textLeft -= ex.shown.length;
    texts.push(`=== ${f.label}: ${name.slice(0, 200)} ===\n${ex.shown}`);
    facts.push(`${f.label}: text, ${text.length} characters, in FILES${ex.cut ? ` (too large: ${ex.cut} characters cut from the middle, marked in FILES; ${ex.shown.length} characters shown)` : ""}`);
  }
  return { facts, images, data: texts.length ? { FILES: texts.join("\n\n") } : {} };
}

/**
 * The task's revisioned documents (Paperclip's documents, not attachments) as evidence: each document's current body as one
 * fenced TASK_DOCUMENTS block, with its key, title, format, size and revision in DOCUMENT_NAMES. Order: documents the rubric
 * names (by key or title, then by distinctive words), then the newest. A document past the budget is marked as cut or not
 * sent, never silently dropped. { facts, data, version }: version is the revisions' ids, so a new revision is a new version.
 */
export async function documentEvidence(documents: any[], { rubric = "", comments = "" }: { rubric?: string; comments?: string } = {}): Promise<any> {
  const facts: string[] = [];
  const texts: string[] = [];
  let left = DOCUMENTS_TOTAL;
  const keyOf = (d: any) => String(d.key ?? "");
  const titleOf = (d: any) => String(d.title ?? "");
  const bodyOf = (d: any) => String(d.body ?? "");
  const exact = (d: any, text: string) => {
    const t = text.toLowerCase();
    return [keyOf(d), titleOf(d)].some((v: string) => v.length >= 3 && t.includes(v.toLowerCase()));
  };
  const words = (d: any) => `${keyOf(d)} ${titleOf(d)}`.toLowerCase().split(/[^a-z0-9]+/).filter((w: string) => w.length >= 4);
  const named = (d: any, text: string) => {
    const w = words(d);
    return w.length >= 2 && w.filter((x: string) => text.toLowerCase().includes(x)).length >= 2;
  };
  const rank = (d: any) => (exact(d, rubric) ? 3 : named(d, rubric) ? 2 : exact(d, comments) || named(d, comments) ? 1 : 0);
  const labelled = documents.map((d: any, i: number) => ({ ...d, label: `document_${i + 1}` }));
  const order = [...labelled].sort((a: any, b: any) => rank(b) - rank(a) || String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
  const names = labelled.map((d: any) => `${d.label}: key=${keyOf(d).slice(0, 64)}; title=${titleOf(d).slice(0, 200)}; ${String(d.format ?? "text").slice(0, 40)}; ${bodyOf(d).length} characters; revision ${Number(d.latestRevisionNumber) || 0}`);
  for (const d of order) {
    const body = bodyOf(d);
    if (left <= 0) {
      facts.push(`${d.label}: text, ${body.length} characters, not sent to the grader (the document budget of ${DOCUMENTS_TOTAL} characters was spent on documents the rubric names first)`);
      continue;
    }
    const ex = excerpt(body, Math.min(DOCUMENT_FILE, left));
    if (!ex) {
      facts.push(`${d.label}: text, ${body.length} characters, not sent to the grader (the remaining document budget of ${left} characters has no room for a cut marker)`);
      continue;
    }
    left -= ex.shown.length;
    texts.push(`=== ${d.label}: ${keyOf(d).slice(0, 64)} — ${titleOf(d).slice(0, 200)} ===\n${ex.shown}`);
    facts.push(`${d.label}: text, ${body.length} characters, in TASK_DOCUMENTS${ex.cut ? ` (too large: ${ex.cut} characters cut from the middle, marked in TASK_DOCUMENTS; ${ex.shown.length} characters shown)` : ""}`);
  }
  if (!documents.length) facts.push("no task documents");
  const ids = labelled.map((d: any) => String(d.latestRevisionId ?? d.id ?? `${keyOf(d)}:${bodyOf(d).length}`));
  return {
    facts,
    data: documents.length ? { DOCUMENT_NAMES: names.join("\n"), TASK_DOCUMENTS: texts.join("\n\n") } : {},
    version: ids.length ? hash(ids.join(" ")) : "",
  };
}

/**
 * Whether one branch commit is already satisfied on the target's current default branch (the duplicate-card guard): its
 * commit is an ancestor of `origin/<base>`, or every file it changes against their merge base is identical there. Reads only
 * the caller's own fetch. { satisfied, evidence }; any git error is "not satisfied", so a card is filed (the safe direction).
 * `git(path, ...args)` resolves with trimmed stdout and rejects on a non-zero exit.
 */
export async function onMain(git: (path: string, ...args: string[]) => Promise<string>, path: string, base: string, sha: string): Promise<{ satisfied: boolean; evidence?: string }> {
  const main = `refs/remotes/origin/${base}`;
  try {
    const tip = await git(path, "rev-parse", "--verify", `${main}^{commit}`);
    if (await git(path, "merge-base", "--is-ancestor", sha, main).then(() => true, () => false)) return { satisfied: true, evidence: `commit \`${sha.slice(0, 12)}\` is already on \`${base}\` (at \`${tip.slice(0, 12)}\`)` };
    const mb = await git(path, "merge-base", main, sha);
    // NUL-separated (unusual names are not C-quoted), each a literal pathspec (no globbing on names like app/[id]).
    const files = (await git(path, "diff", "-z", "--no-renames", "--name-only", mb, sha)).split("\0").filter(Boolean);
    // No files: nothing to compare (an empty pathspec would diff the whole tree).
    if (!files.length) return { satisfied: false };
    const same = await git(path, "diff", "--quiet", "--no-renames", main, sha, "--", ...files.map((f: string) => `:(literal)${f}`)).then(() => true, () => false);
    if (same) return { satisfied: true, evidence: `every file \`${sha.slice(0, 12)}\` changes (${files.length}: ${files.slice(0, 5).join(", ")}${files.length > 5 ? ", …" : ""}) is already identical on \`${base}\` (at \`${tip.slice(0, 12)}\`)` };
    // The same change already merged (a squash of it, by patch: the same file headers and changed lines), though main moved
    // on in those files since: one of the recent commits that touch them.
    const want = await patchKey(path, mb, sha);
    const recent = (await git(path, "log", "--format=%H", "-n", String(RECENT_COMMITS), main, "--", ...files.map((f: string) => `:(literal)${f}`))).split("\n").filter(Boolean);
    for (const c of recent) {
      const key = await patchKey(path, `${c}^`, c).catch(() => undefined);
      if (key === want) return { satisfied: true, evidence: `the same change is already merged on \`${base}\` as \`${c.slice(0, 12)}\`` };
    }
    return { satisfied: false };
  } catch {
    return { satisfied: false };
  }
}

/**
 * The guard for one branch row of `aidenhq push`/`pr` (main.mjs branchRows: `unpublished` commits and the diffstat against its
 * base, read before the guard's fetch): a branch with no commits of its own has nothing to be satisfied, so it is never
 * "already applied" (its tip is trivially an ancestor of main); otherwise onMain.
 */
/** How far back on the default branch the guard looks for the same change merged (commits touching the same files). */
const RECENT_COMMITS = 200;

export async function guardBranch(git: (path: string, ...args: string[]) => Promise<string>, row: any, sha: string) {
  if (!row.unpublished?.length && !row.stat) return { satisfied: false };
  return onMain(git, row.path, row.defaultBase, sha);
}

/** The task's PRs the ref narrows to: a PR ref (link or owner/name#n) by repo and number, a repo ref by repo, else all. */
function byRef(prs: any[], ref: unknown): any[] {
  const same = (a: unknown, b: unknown) => String(a).toLowerCase() === String(b).toLowerCase();
  const named = findPrs(ref);
  if (named.length) return prs.filter((p: any) => named.some((n: any) => same(n.repo, p.repo) && n.number === p.number));
  const repo = /^(?:https:\/\/github\.com\/)?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(String(ref ?? "").trim())?.[1];
  return repo ? prs.filter((p: any) => same(p.repo, repo)) : prs;
}
