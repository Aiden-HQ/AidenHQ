// Evidence, read by code (wave 3, item 5): one function per deliverable kind, shared by the grader (grade.ts gather) and
// the duplicate-card guard (item 4). Facts here were checked by code and are trusted; anything an agent wrote is returned
// as data for the caller to fence. Nothing here closes a task or decides a card: it only reports what is true.
import { createHash } from "node:crypto";
import { findPrs, staleHead } from "./text.ts";
import { GATE_CHECK, namedChecks, skippedImageScan } from "../aidenhq-sdk/checks.ts";
import { closedBy } from "../aidenhq-sdk/closed-event.ts";
import { forOthers } from "../aidenhq-sdk/for-others.ts";
import { downscalePng, imageInfo, pngStamp, type ImageInfo } from "./images.ts";

/** Marks the grader's own notes on a task, so they never count as the deliverable's evidence. */
export const GRADER_MARKER = "<!-- aidenhq:grader -->";

/** The board's reason code for a change already satisfied on the target (services/board/src/approvals.ts ALREADY_APPLIED). */
export const ALREADY_APPLIED = "already_applied";

/**
 * A card's action as the kernel names it: a kernel or runner write arrives as `kernel.apply`/`runner.push` (kernel/src/work.ts
 * returns the record's kind), and the kernel's own short name drops that prefix (kernel/src/records.ts actionOf). Cards are
 * read here, never by the kind (`github.pr` stays whole: the code host's rows go through taskPrs).
 */
export const cardAction = (a: any) => String(a?.action ?? "").replace(/^(runner|kernel)\./, "");

/** A card's outcome, as text: the kernel's records carry `outcome_text`; a board card carries its own `outcomeText`. */
const cardOutcome = (a: any) => String(a?.outcomeText || a?.outcome_text || "");

/**
 * The newest of a task's cards by when it was filed, whatever order the caller's list is in (/v1/work sends newest first, the
 * board's cards oldest first): a task that re-filed its apply is graded on the card it filed last, not the first it ever filed.
 */
const latestCard = (cards: any[]) => cards.reduce((last: any, a: any) => {
  const at = (c: any) => Date.parse(c?.createdAt ?? c?.created_at ?? "") || 0;
  return !last || at(a) >= at(last) ? a : last;
}, undefined);

const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

const COMMAND_TIMEOUT_MS = 60_000;
const CI_WORKFLOW = ".github/workflows/ci.yml";
const CI_AREAS = ".github/ci/areas.json";
const SHA40 = /^[0-9a-f]{40}$/;

type CiMap = { everything: string[]; markdown: string[]; suites: any[] };

/** `.github/ci/areas.json` as CI reads it: the suites and the command and directory each one runs. */
function ciMap(text: string): CiMap | undefined {
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!Array.isArray(json?.suites) || !Array.isArray(json?.everything) || !Array.isArray(json?.markdown)) return;
  return {
    everything: json.everything.map(String),
    markdown: json.markdown.map(String),
    suites: json.suites.filter((s: any) => typeof s?.name === "string" && typeof s?.run === "string" && s.run)
      .map((s: any) => ({ name: s.name, run: String(s.run), dir: s.name.split("#")[0]! })),
  };
}

/** `p`, or undefined after `ms`; a failure — thrown or rejected — is the same as no answer at all. */
const withTimeout = <T>(p: () => Promise<T>, ms: number): Promise<T | null | undefined> =>
  Promise.race([Promise.resolve().then(p).catch(() => null), new Promise<undefined>((r) => setTimeout(() => r(undefined), ms).unref())]);

/**
 * A suite's pass, as CI itself records it: CI's `post-checks` job (`.github/workflows/ci.yml`, `f61fa8e0`) posts one completed
 * `success` check per suite a shard ran, named exactly the suite, with `external_id: <run_id>/<job id>/<shard>`. A check alone
 * proves nothing: GitHub's check API answers any App token, so PR code holding the workflow token could post one. So the fact
 * also needs the shard's own Actions job record behind that `job id` — its `run_id` is the check's `<run_id>`, its name is
 * the shard the check names, and it concluded `success` — plus, in that same run, a completed `success` `post-checks` job at
 * or after the shard's own `run_attempt`, never before it: the poster CI itself ran. A failed-job re-run keeps the earlier
 * attempt's passing shard (CI's own `filter=latest` list) and posts its checks in the newer attempt, so the poster's attempt
 * may be the higher one. Then the run must be the repository's own CI on the graded head: `.github/workflows/ci.yml`,
 * active, `pull_request`, `head_sha` the graded head.
 *
 * What this proves, exactly: a green shard job existed in that `ci.yml` run at that head, and CI's own `post-checks` job ran
 * at or after the shard's attempt. It does not prove, from the check record alone, that that shard ran that suite: GitHub gives an
 * API-posted check no link back to the job that posted it. The suite-to-shard assignment is carried by `post-checks`, which
 * reads the trusted base-map plan and runs no PR code, and the practical forgery path — a PR adding a `checks: write` step to
 * its own run — needs a `ci.yml` edit, which the `.github/` guard below refuses. This is deliberately not called unforgeable:
 * a same-repo PR that otherwise reaches a workflow token with `checks: write` can post a check at any head, and no field on a
 * check record separates that from CI's own.
 *
 * Two bindings that would look stronger are not usable, and their absence is deliberate, not an oversight. A check posted
 * through the API is filed by GitHub under the head's existing check suite for the posting App — on this repo, `community.yml`'s
 * `pull_request_target` suite, which exists from the moment the PR opens — not under the run that posted it; its `checkSuite`
 * therefore never names the `<run_id>` in its own `external_id`. And it has no job, so its `detailsUrl` is its own
 * `/runs/<check id>` page, never the runner form `…/actions/runs/<run>/job/<job>` that only the job's own check run carries.
 * Measured on PR #1243 at `d275911` (posted check `136946586698` in suite `121621144682` = run `44937127396`, `community.yml`)
 * and again at `5c9381c` (suite `121603408900`). Requiring either would refuse every real per-suite check, so the job record
 * and the `post-checks` job are what this fact binds to.
 *
 * The command and directory come from `areas.json` at the run's own recorded base (`base_sha`), byte-identical to the head's.
 * CI's `select.ts` reads the map from the tree it tests (the PR's merge commit), and that tree's map is the base's exactly when
 * the PR did not edit the map — which the `.github/ci/` guard below already refuses — so the base's map is the one CI used, and
 * the byte-identity requirement means it can never name a command the graded head does not carry either. That base is the only immutable one; the PR's `baseRef` is where its base
 * branch points now, which moves as main advances, so it is never a stand-in. A merged run records no base, and there the merge
 * commit's first parent (the tree the merge was made on) is used instead; a run with neither mints nothing. CI's own two preconditions are checked as well: `ci.yml` at the run's base is byte-identical
 * to the head's (a PR that rewrote the workflow ran its own CI), and the suite's directory is a directory at the graded head
 * (`post-checks` posts nothing for a `gone:` one, so a deleted directory is a green job with nothing run). Which suites a shard
 * ran is known only inside the run (CI writes the plan to the `checks` job's outputs, which GitHub does not expose on the job),
 * so the fact does not re-derive it. Only a suite that map names mints a fact. The workflows, the map and the suite runner are
 * the inputs that decide what a shard ran, so a PR that edits anything under `.github/workflows/` or `.github/ci/` mints nothing
 * at all. `.ci-base/` is refused too: no tree carries it today (CI runs `.github/ci/run-suites.sh`), but it stays gitignored and a
 * PR can force-add a file there past `.gitignore`, so the guard refuses the prefix rather than assume nothing owns it again.
 * Every read that fails, or any field that doesn't match, mints nothing.
 */
async function commandFacts(pr: any, repo: string, deps: any): Promise<string[]> {
  if (!deps.file || !deps.job || !deps.run || !deps.exists) return [];
  const head = String(pr.headRefOid ?? "");
  if (!SHA40.test(head)) return [];
  const files = (pr.files?.nodes ?? []).map((f: any) => String(f?.path ?? "")).filter(Boolean);
  if (!files.length || pr.files?.pageInfo?.hasNextPage) return [];
  // CI's own execution inputs (the workflows, the suite map and the selector and runner that read it): a PR that edits any of
  // them may have run something else, so nothing it shows counts. `.ci-base/` is not a tracked path in normal use, but a PR can
  // force-add one (`git add -f` beats .gitignore) and GitHub then lists it; refusing the prefix keeps the guard independent of
  // where CI's own base checkout happens to write.
  if (files.some((f) => f.startsWith(".github/workflows/") || f.startsWith(".github/ci/") || f.startsWith(".ci-base/"))) return [];
  const rollup = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts;
  if (rollup?.pageInfo?.hasNextPage) return [];
  const checks = (rollup?.nodes ?? []).filter((n: any) => n.__typename === "CheckRun" && n.status === "COMPLETED" && n.conclusion === "SUCCESS" && n.name && n.externalId);
  if (!checks.length) return [];
  // One read per job and per run however many suites a shard carried: the same Actions record, not a second opinion.
  const cache = new Map<string, Promise<unknown>>();
  const read = (key: string, p: () => Promise<any>) => {
    if (!cache.has(key)) cache.set(key, withTimeout(p, COMMAND_TIMEOUT_MS));
    return cache.get(key)!;
  };
  const found = await Promise.all(checks.map(async (c: any) => {
    // `<run_id>/<job id>/<shard>`: CI's own format, with nothing else in it.
    const m = /^(\d{1,20})\/(\d{1,20})\/(\d{1,6})$/.exec(String(c.externalId ?? ""));
    if (!m) return undefined;
    const [, run, jobId, shard] = m as unknown as [string, string, string, string];
    // GitHub Actions' own App. The check suite and runner-form URL that would look stronger are unusable here (see this
    // function's comment): GitHub files an API-posted check in the head's older App suite and gives it no job link. A check
    // from another App is refused outright.
    if (String(c.checkSuite?.app?.slug ?? "") !== "github-actions") return undefined;
    const j: any = await read(`job/${jobId}`, () => deps.job(repo, jobId));
    // A made-up or posted check has no such job, or one from another run or another shard: never a fact.
    if (!j || String(j.run_id ?? "") !== run || j.name !== `packages (${shard})` && j.name !== `modules (${shard})`) return undefined;
    if (j.state !== "completed" || j.conclusion !== "success") return undefined;
    const u: any = await read(`run/${run}`, () => deps.run(repo, run));
    if (!u || u.workflow_path !== CI_WORKFLOW || u.workflow_state !== "active" || u.event !== "pull_request" || u.head_sha !== head) return undefined;
    // A shard that passed and then failed a re-run keeps its old passing check on the head (`post-checks` never deletes one),
    // so a check naming an instance the run has since replaced would grade on a result the shard no longer reports. The job
    // the check names must be that shard's latest instance in the run: the same id the newest attempt left behind, and that
    // attempt itself completed and green. A run read that answers no latest map is no evidence, never a pass.
    const latest: any = u.latest_shard_jobs?.[String(j.name)];
    if (!latest || String(latest.id ?? "") !== jobId) return undefined;
    if (latest.state !== "completed" || latest.conclusion !== "success") return undefined;
    // CI's own poster: a run with no completed `success` `post-checks` job mints nothing, whatever checks name it. The poster
    // is what turns a green shard into a per-suite record. It must not predate the shard, but it may come later: a failed-job
    // re-run keeps an earlier attempt's passing shard and posts its checks in the new attempt, so the shard's own attempt can
    // be the lower one. Both numbers are that run's attempts, so "at or after the shard" is the whole rule.
    const attempt = Number(j.run_attempt ?? u.run_attempt ?? NaN);
    const post = (u.post_checks ?? []).find((p: any) => Number.isSafeInteger(attempt) && Number(p?.run_attempt) >= attempt
      && p?.state === "completed" && p?.conclusion === "success");
    if (!post) return undefined;
    // The run's own recorded base is where CI read `areas.json` and the workflow (main as it was when the run started). It is
    // the only immutable source of that tree: the PR's `baseRef` is the current tip of its base branch, which moves as main
    // advances, so it cannot stand in. GitHub drops the run's `pull_requests` entry once the PR merges, which is exactly the
    // head a merged task is graded on, so there the base is the merge commit's first parent: the tree the merge was made on.
    // An unreadable commit, or one with no parent, is still no base, and mints nothing.
    let base = String(u.base_sha ?? "");
    if (!SHA40.test(base)) {
      const merge = String(pr.mergeCommit?.oid ?? "");
      if (!deps.commit || !SHA40.test(merge)) return undefined;
      const m: any = await read(`commit/${merge}`, () => deps.commit(repo, merge));
      base = String(m?.parents?.[0] ?? "");
      if (!SHA40.test(base)) return undefined;
    }
    return { name: String(c.name), base };
  }));
  const green = found.filter(Boolean) as { name: string; base: string }[];
  if (!green.length) return [];
  const bases = [...new Set(green.map((g) => g.base))];
  const reads = await withTimeout(() => Promise.all([head, ...bases].map((ref) => deps.file(repo, CI_AREAS, ref).catch(() => null))), COMMAND_TIMEOUT_MS) ?? [];
  // The head's own map, so a base map that differs (main moved, or the PR edited it — which the `.github/` guard already
  // refuses) can never name a command the graded head doesn't carry. Byte for byte, never a merge of the two.
  const headMap = String(reads[0] ?? "");
  const maps = new Map<string, CiMap>();
  for (const [i, b] of bases.entries()) {
    const at = String(reads[i + 1] ?? "");
    const map = at === headMap ? ciMap(at) : undefined;
    // The run's own `areas.json`, the same one the head carries; a base whose map can't be read is no evidence for its suites.
    if (map) maps.set(b, map);
  }
  if (!maps.size) return [];
  // CI's own preconditions, read against the same trees the run used. `ci.yml` at the run's base must be the graded head's
  // own, byte for byte: a PR that rewrote the workflow ran its own CI, so a job named for a suite proves nothing there (the
  // `.github/` guard above already refuses the PR's own edit; this covers the workflow at the head it actually checked out).
  // And the suite's directory must be a directory at the graded head: `post-checks` posts nothing for one `run-suites.sh`
  // reported `gone:`, so a deleted directory is a green job with nothing run.
  const headWorkflow = await withTimeout(() => deps.file(repo, CI_WORKFLOW, head), COMMAND_TIMEOUT_MS);
  if (typeof headWorkflow !== "string" || !headWorkflow) return [];
  const sameWorkflow = new Map<string, boolean>();
  for (const b of bases) {
    const at = await withTimeout(() => deps.file(repo, CI_WORKFLOW, b), COMMAND_TIMEOUT_MS);
    sameWorkflow.set(b, typeof at === "string" && at === headWorkflow);
  }
  const present = new Map<string, boolean>();
  const facts: string[] = [];
  for (const { name, base } of green) {
    const suite = maps.get(base)?.suites.find((s: any) => s.name === name);
    if (!suite || sameWorkflow.get(base) !== true) continue;
    if (!present.has(suite.dir)) present.set(suite.dir, (await withTimeout(() => deps.exists(repo, suite.dir, head), COMMAND_TIMEOUT_MS)) === true);
    // Not a directory (or not readable) at the head: the suite did not run there, so nothing is a fact.
    if (present.get(suite.dir) !== true) continue;
    facts.push(`${name} green on head ${head}: ran "${suite.run}" in ${suite.dir}/ — passed`);
  }
  return [...new Set(facts)];
}

const nameOf = (f: any) => String(f.originalFilename ?? f.name ?? "");

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
 * What the task's own rows and records keep about one of its PRs: every distinct value of each identifier. A list holding more
 * than one value is a contradiction among the task's own records, and it is never resolved by picking one.
 */
export interface RecordedIds {
  heads: string[];
  headOids: string[];
  merges: string[];
}

const addId = (list: string[], v: unknown, re?: RegExp) => {
  if (typeof v === "string" && v && (!re || re.test(v)) && !list.includes(v)) list.push(v);
};
const samePr = (a: { repo: string; number: number }, b: { repo: string; number: number }) => a.repo.toLowerCase() === b.repo.toLowerCase() && Number(a.number) === Number(b.number);

/**
 * A PR's base commit: the base ref's commit recorded on the PR (`baseRefOid`), or "" when the read does not carry one.
 *
 * GitHub records it when the PR is opened or its base is last changed, and does not move it as the base branch advances. So it
 * is the base branch's commit the PR was opened against, and it is what a criterion about the PR's base is judged from -- a
 * prerequisite that merged just before the PR was opened is that commit. It is not the base branch's current tip
 * (`baseRef.target`, which moves) and not the git merge base (which advances as the branch is rebased onto it); neither is
 * substituted for it. Nor does it prove the PR's ancestry: a base commit that is an ancestor of another commit says nothing
 * about whether the PR contains that other commit's change.
 *
 * Nothing is established ("") when the read carries no base ref commit, or the value is not a commit id.
 */
export function baseCommitOf(pr: any): string {
  const oid = pr?.baseRefOid;
  return typeof oid === "string" && SHA40.test(oid) ? oid : "";
}

/**
 * Identifiers from anything that names a PR: a merged record (the arrays taskPrRows and taskMergePrs return) or a record as it
 * is stored. `head` is a branch on a branch row and a bound head commit on a merge card (a 40-hex value), so it goes wherever
 * its shape says.
 */
export function idsOf(p: any): RecordedIds {
  const ids: RecordedIds = { heads: [], headOids: [], merges: [] };
  const list = (v: unknown) => (Array.isArray(v) ? v : []);
  for (const v of [p?.head, p?.headRef, ...list(p?.heads), ...list(p?.headRefs)]) addId(SHA40.test(String(v)) ? ids.headOids : ids.heads, v, SHA40.test(String(v)) ? SHA40 : undefined);
  for (const v of [p?.headOid, ...list(p?.headOids)]) addId(ids.headOids, v, SHA40);
  for (const v of [p?.merge, p?.sha, ...list(p?.merges)]) addId(ids.merges, v, SHA40);
  return ids;
}

/**
 * The PRs a task's branch rows name, one per PR, with every branch its rows recorded (`heads`). Rows that name one PR with
 * different branches are a contradiction, which the grading read refuses rather than resolving to one of them.
 */
export function taskPrRows(rows: any[] | undefined) {
  const byPr = new Map<string, { repo: string; number: number; url: string; heads: string[] }>();
  for (const b of rows ?? [])
    for (const p of findPrs(b?.pr_url ?? "")) {
      const key = `${p.repo.toLowerCase()}#${p.number}`;
      const seen = byPr.get(key) ?? { ...p, heads: [] };
      addId(seen.heads, b?.branch);
      byPr.set(key, seen);
    }
  return [...byPr.values()];
}

/**
 * The PRs the task's own runner records tie to it, for a merge its branch rows no longer name: the queue it ran for this task,
 * the merges it was asked to run, and the merge cards it filed on it (deps.taskMerged). dedupe: one row per PR, keeping every
 * identifier any of its records holds (`heads`, `headOids`, `merges`) so that records which disagree contradict rather than one
 * of them winning.
 */
export function taskMergePrs(rows: any[] | undefined) {
  const byPr = new Map<string, { repo: string; number: number; url: string } & RecordedIds>();
  for (const r of rows ?? []) {
    const p = r?.url ? findPrs(String(r.url))[0] : r?.repo && r?.number ? { repo: String(r.repo), number: Number(r.number), url: `https://github.com/${r.repo}/pull/${r.number}` } : undefined;
    if (!p) continue;
    const key = `${p.repo.toLowerCase()}#${p.number}`;
    const seen = byPr.get(key) ?? { ...p, heads: [], headOids: [], merges: [] };
    addId(seen.heads, typeof r.headRef === "string" ? r.headRef : undefined);
    addId(seen.headOids, r.headOid, SHA40);
    addId(seen.headOids, r.head, SHA40);
    addId(seen.merges, r.sha, SHA40);
    byPr.set(key, seen);
  }
  return [...byPr.values()];
}

/**
 * The task's PRs the ref narrows to: a PR ref (link or owner/name#n) by repo and number, a repo ref by repo, else all. A repo
 * ref is the delegator's guess at where the work lands: when the task has PRs but none there (a fix briefed against the
 * product that belongs in the modules repo), they are all its deliverable, and `elsewhere` says so as a fact.
 */
function byRef(prs: any[], ref: unknown): any[] & { elsewhere?: string } {
  const same = (a: unknown, b: unknown) => String(a).toLowerCase() === String(b).toLowerCase();
  const named = findPrs(ref);
  if (named.length) return prs.filter((p: any) => named.some((n: any) => same(n.repo, p.repo) && n.number === p.number));
  const repo = /^(?:https:\/\/github\.com\/)?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(String(ref ?? "").trim())?.[1];
  if (!repo) return prs;
  const there = prs.filter((p: any) => same(p.repo, repo));
  if (there.length || !prs.length) return there;
  const repos = [...new Set(prs.map((p: any) => p.repo))].join(", ");
  return Object.assign([...prs], { elsewhere: `the deliverable names ${repo}, where this task opened no pull request; its pull requests are in ${repos}, and they are graded as its deliverable` });
}

type Identity = { state: "ok" } | { state: "stale"; why: string } | { state: "unknown" };

/**
 * How a stored PR's number reads against GitHub: this task's change, another change now under that number, or neither provably.
 * Every identifier the task's own rows and records keep must agree — with each other and with GitHub's read: the branches
 * (`heads`, each by staleHead), the head commits bound (`headOids`) and the merge commits (`merges`). Two different values of
 * one identifier are a contradiction in the task's own record and are refused, never resolved. A record that keeps none of them
 * proves nothing, and nothing proven is never graded as this task's work: `unknown` fails closed.
 */
function identityOf(ids: RecordedIds, pr: any): Identity {
  const conflicting = (what: string, list: string[]) => `the task's own records name different ${what} (${list.map((v) => `\`${v}\``).join(", ")})`;
  const why: string[] = [];
  if (ids.heads.length > 1) why.push(conflicting("branches", ids.heads));
  if (ids.headOids.length > 1) why.push(conflicting("head commits", ids.headOids));
  if (ids.merges.length > 1) why.push(conflicting("merge commits", ids.merges));
  for (const head of ids.heads) {
    const whyNot = staleHead(head, pr.headRefName);
    if (whyNot) why.push(whyNot);
  }
  for (const headOid of ids.headOids)
    if (String(pr.headRefOid ?? "") !== headOid) why.push(`its head is \`${String(pr.headRefOid ?? "").slice(0, 12) || "(none)"}\`, not the task's commit \`${headOid.slice(0, 12)}\``);
  for (const merge of ids.merges)
    if (String(pr.state) !== "MERGED" || pr.mergeCommit?.oid !== merge) why.push(`it did not merge at the task's merge commit \`${merge.slice(0, 12)}\``);
  if (why.length) return { state: "stale", why: [...new Set(why)].join(", and ") };
  return ids.heads.length || ids.headOids.length || ids.merges.length ? { state: "ok" } : { state: "unknown" };
}

/**
 * The fact a stale number states: what GitHub's read disagrees on, and the merge commit the task's own record holds for it.
 * The commit is cited only when the record names exactly one: with several, which of them is the task's merge is the very
 * contradiction identityOf refused, so citing one would state as a fact what the record does not settle.
 */
const staleFact = (url: string, why: string, merges: string[]) =>
  `${url} now names a different change (${why})${merges.length === 1 ? `; the runner's own record has this task's merge commit ${merges[0]}` : ""}`;

/** What a record that keeps no branch, head commit or merge commit says: the number is not read as this task's change. */
const unverifiable = (url: string) => `${url} is named by the runner's own record for this task, which keeps no branch, head commit or merge commit to tell the change by, so it is not read as this task's change`;

/**
 * Every identifier the task keeps for one of its PRs, its branch rows and the runner's own merge records together: one row's
 * gap is filled by another's fact, and two rows that disagree stay two values for identityOf to refuse.
 *
 * `unread`: the records read failed and this row's own identifiers cannot establish the PR by themselves. That is an answer it
 * could not get, never "this number is not the task's change": a retry may fill the gap, so a caller deciding whether work
 * exists must wait rather than close on the row's silence.
 */
async function idsWithRecord(p: any, deps: any): Promise<RecordedIds & { unread: boolean }> {
  const ids = idsOf(p);
  const establishes = ids.heads.length > 0 || ids.headOids.length > 0 || ids.merges.length > 0;
  if (!deps.taskMerged) return { ...ids, unread: false };
  const records = await deps.taskMerged().then((r: any[]) => ({ rows: r }), () => undefined);
  if (!records) return { ...ids, unread: !establishes };
  const row = taskMergePrs(records.rows).find((x) => samePr(x, p));
  if (!row) return { ...ids, unread: false };
  const other = idsOf(row);
  return { heads: [...new Set([...ids.heads, ...other.heads])], headOids: [...new Set([...ids.headOids, ...other.headOids])], merges: [...new Set([...ids.merges, ...other.merges])], unread: false };
}

/**
 * The registry's answer for an app ref, as the evidence paths word it. null: a successful read with no such row. undefined: a
 * failed read (apps-evidence.ts `appsEvidence().app`). An absent app is not a pending deploy: the ref names no app this
 * instance runs, so the deliverable can never be satisfied as filed. A failed read is unavailable evidence, never "not an app".
 */
const appNotRun = (name: string | undefined) => `${name || "(none)"} is not an app this instance runs (the apps registry has no such app), so this deliverable cannot be satisfied as filed`;
const appUnknown = (name: string | undefined) => `the apps registry could not be read just now (unavailable evidence), so whether ${name || "(none)"} is an app this instance runs is unknown`;

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
  // `unknown` is an answer it could not get (GitHub or the apps registry unreachable), never "absent": a caller deciding
  // whether work exists must wait and ask again, not read a failed lookup as nothing there.
  let unknown = false;
  if (kind === "pr") {
    let prs = byRef((await deps.taskPrs?.()) ?? [], deliverable.ref);
    if (!prs.length && deps.taskMerged) {
      // No branch row names one: the runner's own records may. A records read that failed proves nothing about the PR, so it
      // is "could not be read" (unknown), never "the task has no PR": reading it as absent would let a versionless close land
      // done/ungraded while the merge the record holds is exactly the deliverable.
      const records = await deps.taskMerged().then((r: any[]) => ({ rows: taskMergePrs(r) }), () => undefined);
      if (!records) return { present: false, unknown: true, facts: ["the runner's own merge records for this task could not be read just now"] };
      prs = byRef(records.rows, deliverable.ref);
    }
    const byName = !prs.length && findPrs(deliverable.ref).length > 0;
    if (byName) prs = findPrs(deliverable.ref);
    let merged: { repo: string; sha: string } | undefined;
    for (const p of prs.slice(0, 5)) {
      // A read that throws is no answer (unknown, wait); GitHub answering that the repository or the PR is gone is an answer,
      // and a PR that cannot reappear must not keep the close waiting for it.
      const answer = await deps.pr(p.repo, p.number).then((r: any) => ({ r }), () => undefined);
      if (!answer) {
        unknown = true;
        facts.push(`${p.url} could not be read just now`);
        continue;
      }
      const node = answer.r?.repository;
      const pr = node?.pullRequest;
      if (node === null || (node && "pullRequest" in node && pr === null)) {
        facts.push(`${p.url} no longer exists`);
        continue;
      }
      if (!pr) {
        unknown = true;
        facts.push(`${p.url} could not be read just now`);
        continue;
      }
      // The stored number is this task's change only while the identifiers the task keeps say so (identityOf). When it names
      // another change, or proves nothing, that change's state is not this task's: the fact is the merge commit the task's own
      // record holds, and it is never "present", so the row escalates with what the record does hold instead.
      if (!byName) {
        const ids = await idsWithRecord(p, deps);
        // The record that would tell this PR's own branch, head or merge could not be read and the row alone proves nothing: that
        // is a failed read, not "this number is not the task's change", so the close waits and asks again.
        if (ids.unread) {
          unknown = true;
          facts.push(`${p.url} could not be read just now`);
          continue;
        }
        const who = identityOf(ids, pr);
        if (who.state !== "ok") {
          facts.push(who.state === "unknown" ? unverifiable(p.url) : staleFact(p.url, who.why, ids.merges));
          continue;
        }
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
      const deploys = app ? await deploysOf(app, merged.sha, deps) : { rows: [], complete: true };
      const d = deploys.rows.find((r: any) => r.status === "healthy");
      const at = merged.sha ? merged.sha.slice(0, 12) : "the merge commit";
      // An incomplete history (the deploy read timed out, so only the status row's recent entries were read) is not the same
      // answer as "that commit never had a healthy deploy": say the history could not be read, never claim a miss it can't prove.
      if (app) facts.push(d ? `app ${app.name}: ${at} deployed ${stamp(d.at)} (healthy)` : deploys.complete ? `app ${app.name}: no healthy deploy of ${at}` : `app ${app.name}: its deploy history could not be read just now, so a healthy deploy of ${at} is unknown`);
    }
    return { present: Boolean(merged), unknown, facts };
  }
  if (kind === "app") {
    const app = await deps.app?.(deliverable.ref).catch(() => undefined);
    if (app == null) return { present: false, unknown: app === undefined, facts: [app === undefined ? appUnknown(deliverable.ref) : appNotRun(deliverable.ref)] };
    const deploys = await deploysOf(app, app.sha, deps);
    const d = deploys.rows.find((r: any) => r.status === "healthy");
    const sha = String(app.sha ?? "(none)").slice(0, 12);
    // Same distinction here: a history that could not be read says so, rather than reporting a healthy deploy as absent.
    return { present: Boolean(d), unknown: !d && !deploys.complete, facts: [d ? `app ${app.name}: ${sha} deployed ${stamp(d.at)} (healthy)` : deploys.complete ? `app ${app.name}: deployed commit ${sha} has no healthy deploy` : `app ${app.name}: its deploy history could not be read just now, so a healthy deploy of ${sha} is unknown`] };
  }
  if (kind === "apply") {
    const applied = latestCard(((await deps.approvals?.()) ?? []).filter((a: any) => cardAction(a) === "apply" && a.state === "used" && a.outcome));
    return applied ? { present: true, facts: [`apply ${applied.id}: used${cardOutcome(applied) ? `, ${cardOutcome(applied).split("\n")[0]}` : ""}`] } : { present: false, facts: ["no apply filed yet"] };
  }
  return { present: false, facts: [] };
}

/**
 * A change request on this server (codehost-local's readChange) in the PR read prEvidence and presentNow take (the github
 * module's PR_QUERY data): its state, head, base and words, its merge commit, and its checks receipt on the head as the named
 * checks, a required one with no entry yet still running. `mergedAt`: the merge commit's date.
 *
 * `baseRef` is the change's recorded opening base (codehost-local's refs/changes/<n>/opened: the default branch's tip when the
 * change was opened, which a push never moves), carried as `baseRefOid` so `baseCommitOf` reads both code hosts by one rule. A
 * change written before that ref existed carries none, so it states no base commit rather than naming a later tip. `base` is the
 * git merge base and is never carried as the base commit.
 */
export function localPullRequest(c: any, checks: { name: string; ok: boolean; pending: boolean }[], required: string[], mergedAt = "") {
  const state = (x: { ok: boolean; pending: boolean } | undefined) => (!x || x.pending ? "PENDING" : x.ok ? "SUCCESS" : "FAILURE");
  const names = [...new Set([...required, ...checks.map((x) => x.name)])];
  const nodes = names.map((name) => ({ __typename: "StatusContext", context: name, state: state(checks.find((x) => x.name === name)) }));
  return {
    repository: {
      pullRequest: {
        number: c.number, url: c.url, state: c.state === "open" ? "OPEN" : c.state === "merged" ? "MERGED" : "CLOSED", title: c.title ?? "", body: c.body ?? "",
        headRefOid: c.head, headRefName: c.branch, baseRefName: c.into, baseRefOid: c.baseRef || undefined, mergeCommit: c.merged ? { oid: c.merged } : null, mergedAt: c.merged ? mergedAt : null,
        commits: { nodes: [{ commit: { oid: c.head, statusCheckRollup: { contexts: { nodes } } } }] }, history: { nodes: [] },
      },
    },
  };
}

/** All the graded PRs' titles and descriptions: the grader fences a data block at 20,000 characters. */
const PR_TEXT_TOTAL = 20_000;

/**
 * The task's PRs as evidence: { awaiting } or { version, facts, data }. `prs` are the runner's own PRs for the task, narrowed
 * by the ref (a PR named only in the ref is never read), each with the branch or branches its records name (`heads`).
 * deps: pr(repo, n) (merges.PR_QUERY's data), diff(repo, n), ownRepo(slug).
 * Each PR's title and description are the author's own text, so they go to the grader fenced (PR_DESCRIPTION), never as facts:
 * a rubric may ask what the PR records, which only that text can show.
 */
export async function prEvidence(prs: any[], ref: string, deps: any): Promise<any> {
  prs = byRef(prs, ref);
  // No branch row names one: the runner's own records for the task (its merge queue and the merge cards it filed) still say
  // which PR delivered it, so they are read rather than reporting "no pull request yet" for a merge whose row a cleanup, a
  // prune or a state reset took away. Never a comment: its runner marker is text any writer can copy, so it proves nothing.
  const lookup = !prs.length && Boolean(deps.taskMerged);
  if (lookup) {
    // A records read that failed is evidence that could not be read, not "no pull request yet": the latter is a missing
    // deliverable that closes the task after MISSING_WAIT_MS, so a 502 on the kernel's own records would close a task whose
    // merge is exactly what those records hold.
    const records = await deps.taskMerged().then((r: any[]) => ({ rows: taskMergePrs(r) }), () => undefined);
    if (!records) return { awaiting: "the runner's own merge records for this task could not be read just now" };
    prs = byRef(records.rows, ref);
  }
  const byRecord = lookup && prs.length > 0;
  // Neither a branch row nor a merge record of this task holds the PR the ref names (another task opened or merged it): the
  // ref is that PR's identity, so it is read directly, graded by the same criteria as the task's own, and waits while unmerged.
  const byName = !prs.length && findPrs(ref).length > 0;
  if (byName) prs = findPrs(ref);
  if (!prs.length) return { awaiting: "no pull request yet", missing: true };
  const facts: string[] = (prs as any).elsewhere ? [(prs as any).elsewhere] : [];
  const versions: string[] = [];
  const prs_: any[] = []; // each graded PR with its merge commit ("" while unmerged)
  let left = PR_TEXT_TOTAL;
  let diff = "";
  let described = "";
  const candidates = prs.slice(0, 5);
  const key = (p: any) => `${String(p.repo).toLowerCase()}#${p.number}`;
  // Which of the task's PRs are the deliverable is decided before any is read as one: a PR closed without merging is never a
  // `pr` task's deliverable, and when the task's own records name a merged PR in the same repo beside the superseded branch it
  // replaced, the merged PR is what landed the work and the closed one is not read at all.
  const states = new Map<string, any>();
  for (const p of candidates) {
    const answer = await deps.pr(p.repo, p.number);
    const pr = answer?.repository?.pullRequest;
    // GitHub answering that the named repository or PR does not exist is an answer, not an unread one.
    if (byName && (answer?.repository === null || pr === null)) return { awaiting: `no pull request at ${p.url}`, missing: true };
    if (!pr) return { awaiting: `${p.url} can't be read yet` };
    states.set(key(p), pr);
  }
  const landed = new Set(candidates.filter((p) => states.get(key(p)).state === "MERGED").map((p) => String(p.repo).toLowerCase()));
  const graded = candidates.filter((p) => states.get(key(p)).state !== "CLOSED" || !landed.has(String(p.repo).toLowerCase()));
  for (const p of graded) {
    // Closed without merging is not a merge, not "still running", and not a branch a revision request can still reach: its head
    // is fixed, so its checks and diff are not read as the task's deliverable. The row holds for evidence instead.
    const pr = states.get(key(p));
    // The stored number is this task's change only while the record's own identifier says so (identityOf): a re-created
    // repository restarts numbering, and the number can then name an unrelated change. That change's diff and description are
    // not this task's, so nothing of it is read or graded; the wait says so, and names the merge commit the record holds.
    // A record that proves nothing is not graded either: the wait says the number can't be checked, rather than trusting it.
    if (!byName) {
      const ids = await idsWithRecord(p, deps);
      if (ids.unread) return { awaiting: `${p.url}: the runner's record for this task could not be read just now` };
      const who = identityOf(ids, pr);
      if (who.state !== "ok") {
        if (who.state === "unknown") return { awaiting: unverifiable(p.url) };
        return { awaiting: `${staleFact(p.url, who.why, ids.merges)}, so this task's change cannot be read by its stored number` };
      }
    }
    if (pr.state === "CLOSED") return { awaiting: `${p.url} was closed without merging` };
    const checks = namedChecks(pr.commits?.nodes?.[0]?.commit?.statusCheckRollup);
    const gate = gateOn(pr, checks);
    // A read caught mid-run is never a verdict. A check still queued or running is one (GitHub also reports the rollup as
    // a whole as PENDING until they all finish, so the individual states are the finer read), and so is a head whose
    // aggregate required check is not written yet: its jobs appear only as it finishes.
    if (checks.some((c: any) => c.pending) || gate === "running") return { awaiting: `checks still running on ${p.url}` };
    // Outside the agents org and the product repo the runner can't merge and the owner doesn't: someone else merges it.
    if (pr.state === "OPEN" && deps.ownRepo && !deps.ownRepo(p.repo)) return { awaiting: `${p.url} is not merged yet` };
    // The runner's record names the PR; GitHub says what became of it, and a closed one was held above whatever named it.
    if ((byRecord || byName) && pr.state !== "MERGED") return { awaiting: `${p.url} is not merged yet` };
    const merged = pr.state === "MERGED";
    const sha = merged ? (pr.mergeCommit?.oid ?? pr.headRefOid) : pr.headRefOid;
    const head = `### ${p.url}\n`;
    const text = `title: ${String(pr.title ?? "").trim()}\n\n${String(pr.body ?? "").trim()}`;
    // An edited description is a new version to grade, even at the same head: the rubric may only be met by what it says. So is a
    // changed base commit: a criterion about the PR's base is judged from it, so the same head and text on another base is another
    // version (read before the fact line below, which uses the same value).
    const base = baseCommitOf(pr);
    versions.push(`${p.repo}#${p.number}@${sha}+${hash(text)}${base ? `.${base}` : ""}`);
    // The code a screenshot may show: the head, the merge commit, and the newest commit that isn't a merge of the base (the
    // agent's own, which the runner re-signs with the same tree before a base update merges on top). By commit or by tree.
    const history = (pr.history?.nodes ?? []).map((n: any) => n.commit).filter(Boolean);
    const own = history.findLast((c: any) => c.parents?.totalCount === 1);
    const shows = { commits: [pr.headRefOid, merged ? pr.mergeCommit?.oid : "", own?.oid].filter(Boolean), trees: [history.find((c: any) => c.oid === pr.headRefOid)?.tree?.oid, own?.tree?.oid].filter(Boolean) };
    prs_.push({ repo: p.repo, number: p.number, merge: merged ? (pr.mergeCommit?.oid ?? "") : "", mergedAt: pr.mergedAt ?? "", shows });
    // The base commit (baseCommitOf): the base ref's commit recorded on the PR, never the base branch's moving tip or the git
    // merge base. "not established" is missing evidence rather than a guess.
    facts.push(`${p.url}: ${pr.state.toLowerCase()}${merged ? ` into ${pr.baseRefName}` : ` (base ${pr.baseRefName})`}${base ? `, base commit ${base} (the recorded base ref commit)` : ", base commit not established"}, head ${pr.headRefOid}${merged && pr.mergeCommit?.oid ? `, merge commit ${pr.mergeCommit.oid}` : ""}; checks: ${checks.length ? checks.map((c: any) => `${c.name} ${checkState(pr, c, gate)}`).join(", ") : "none"}${byRecord ? "; named by the runner's own record for this task, which is how its number was told from another change" : ""}${byName ? "; named by the deliverable's own ref" : ""}`);
    // The command facts this change adds: one line per green suite job on this head (see `commandFacts`).
    facts.push(...(await commandFacts(pr, p.repo, deps)));
    // The author's own words: code labels them and says whether they were cut; the text itself goes fenced, as data.
    const kept = text.slice(0, Math.max(0, left - head.length)).trim();
    left -= head.length + kept.length + 2;
    if (kept) described += `${head}${kept}\n\n`;
    const empty = !String(pr.body ?? "").trim();
    const note = empty
      ? "; the description is empty"
      : !kept
        ? "; left out (the block's budget is used up)"
        : kept.length < text.trim().length
          ? `, cut to their first ${kept.length} of ${text.trim().length} characters (what is missing is not shown)`
          : "";
    facts.push(`${p.url}: the PR's title and description are in PR_DESCRIPTION (the author's words, data)${note}`);
    diff += `### ${p.url}\n${(await deps.diff(p.repo, p.number).catch(() => "(the diff could not be read)"))}\n`;
  }
  // The board keeps a version in 200 characters: several PRs are bound by their hash.
  const version = versions.join(" ").length <= 200 ? versions.join(" ") : `prs:${hash(versions.join(" "))}`;
  return { version, facts, prs: prs_, data: { PR_DESCRIPTION: described.trim() ? described.trim() : "(none)", DIFF: diff } };
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

/**
 * A deployed app (apps-mcp status row) as evidence: its commit, state, health, incident and recent deploys. `null` is a
 * successful registry read with no such app: the ref is not an app this instance runs, and the deliverable is missing rather
 * than a deploy still to come. `undefined` is a read that failed: unavailable evidence, and the row waits rather than judging.
 */
export function appEvidence(app: any, name: string | undefined): any {
  if (app === undefined) return { awaiting: appUnknown(name) };
  if (app === null) return { awaiting: appNotRun(name), missing: true };
  if (!app.sha) return { awaiting: `${app.name} is not deployed yet` };
  const facts = [`app ${app.name}: deployed commit ${app.sha}${app.deployed_at ? ` at ${stamp(app.deployed_at)}` : ""}${app.deployed_by ? ` by ${app.deployed_by}` : ""}; state ${app.state}; ${app.healthy ? "healthy" : "not healthy"}; ${app.incident ? `open incident (${app.incident.kind})` : "no open incident"}`];
  // The history, newest first: which commits were deployed, by whom, and how each ended. `by: auto-deploy` is the
  // platform's own deploy of a moved origin branch (loops.ts), never an agent or the owner.
  const seen = (Array.isArray(app.deploys) ? app.deploys : []).slice(0, 5);
  if (seen.length) facts.push(`app ${app.name}: recent deploys (newest first): ${seen.map((d: any) => `${d.sha.slice(0, 12)} deployed ${stamp(d.at)} by ${d.by} (${d.status})`).join("; ")}`);
  return { version: `${app.name}@${app.sha}`, facts, data: {} };
}

/**
 * A GitHub issue ("owner/name#number") as evidence: its state and how it closed (GitHub's own closer, or the Maintainer's one
 * `Fixed by <owner>/<repo>#<n> (merge <sha>)` line), its labels, and whether the PR it names is merged at that sha, each read by
 * code. The newest comments go fenced as ISSUE_COMMENTS (strangers' words, data), each with its author's association so an owner's
 * word shows. An open issue is evidence too: its criteria are unmet, and the task goes back. deps.issue(repo, n), deps.pr(repo, n).
 */
export async function issueEvidence(ref: string, deps: any): Promise<any> {
  const [, repo = "", n = ""] = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(ref) ?? [];
  const read = repo ? await deps.issue(repo, Number(n)).catch(() => null) : null;
  const i = read?.repository?.issue;
  if (!i) return { awaiting: `issue ${ref || "(none)"} can't be read yet` };
  const comments: any[] = i.comments?.nodes ?? [];
  const closer = i.closedEvents?.nodes?.[0]?.actor?.login;
  const owned = (c: any) => ["OWNER", "MEMBER", "COLLABORATOR"].includes(c?.authorAssociation);
  // Path (b): the one machine line the Maintainer leaves, `Fixed by <owner>/<repo>#<n> (merge <40-hex sha>)`, in a comment by an
  // owner, member or collaborator (the fleet acts as the owner), since the latest reopen. Only that line counts, and only for a PR the code
  // host reads as merged at that sha: no other text or link is scanned.
  // Only a line posted at or after the issue's latest reopen belongs to this closure: an earlier close-and-reopen cycle's doesn't.
  const reopened = Date.parse(i.reopenedEvents?.nodes?.[0]?.createdAt ?? "") || 0;
  const FIXED_BY = /^Fixed by ([\w.-]+\/[\w.-]+)#(\d+) \(merge ([0-9a-f]{40})\)\s*$/gm;
  const lines = i.state === "CLOSED" ? comments.filter((c) => owned(c) && Date.parse(c.createdAt) >= reopened).flatMap((c) => [...String(c.body ?? "").matchAll(FIXED_BY)].map((m) => ({ c, repo: m[1]!, number: Number(m[2]), sha: m[3]! }))) : [];
  // Anyone with close rights can close an issue: a close counts only through a merged PR that GitHub records as its closer ("Fixes
  // owner/repo#N", in this repo or another), or that line.
  const by = closedBy(i)?.pull_request;
  const keywordPr = i.state === "CLOSED" && by?.merged ? { ...by, url: `https://github.com/${by.repo}/pull/${by.number}` } : undefined;
  // A close that is not a completion (not planned, a duplicate) carries no PR: it counts when a comment by its closer (the close event's actor), an owner, member or collaborator
  // (the fleet acts as the owner), within two minutes of the close, since the latest reopen, carries the line `Not fixing: <reason>`
  // or `Duplicate of <owner>/<repo>#<n>`. No other comment is a reason.
  const REASON = /^(?:Not fixing: \S.*|Duplicate of [\w.-]+\/[\w.-]+#\d+)\s*$/m;
  const reasoned = i.state === "CLOSED" && i.stateReason !== "COMPLETED" && Boolean(closer) && comments.some((c) => owned(c) && c.author?.login === closer && REASON.test(String(c.body ?? "")) && Date.parse(c.createdAt) >= reopened && Math.abs(Date.parse(c.createdAt) - Date.parse(i.closedAt)) <= 120_000);
  const trusted = Boolean(keywordPr) || lines.length > 0 || reasoned;
  const facts = [`${ref}: ${i.state === "CLOSED" ? `closed${i.stateReason ? ` as ${String(i.stateReason).toLowerCase()}` : ""} at ${i.closedAt}${closer ? ` by ${closer}` : ""}` : "open"}; labels: ${(i.labels?.nodes ?? []).map((l: any) => l.name).join(", ") || "none"}`];
  const merges: string[] = [];
  if (keywordPr) {
    merges.push(keywordPr.merge_commit_sha ?? "");
    facts.push(`closed by GitHub through the closing keyword of ${keywordPr.url}, which cites it as the fix: ${keywordPr.url}: merged${keywordPr.merge_commit_sha ? ` (merge commit ${keywordPr.merge_commit_sha})` : ""}`);
  } else if (i.state === "CLOSED" && !trusted) facts.push(`the close does not count: it was not closed by a merged PR, and no comment by an owner, member or collaborator carries a "Fixed by <owner>/<repo>#<n> (merge <sha>)" line, and a not-planned or duplicate close has no \"Not fixing: <reason>\" or \"Duplicate of <owner>/<repo>#<n>\" line from one of them within two minutes of it, so the issue is treated as not resolved`);
  else {
    const seen = new Set<string>();
    for (const l of lines) {
      const url = `https://github.com/${l.repo}/pull/${l.number}`;
      if (seen.has(`${url}@${l.sha}`)) continue;
      seen.add(`${url}@${l.sha}`);
      if (l.repo.toLowerCase() !== repo.toLowerCase()) { facts.push(`${url}: not in ${repo}, so it does not count as this issue's fix`); continue; }
      const pr = (await deps.pr(l.repo, l.number).catch(() => null))?.repository?.pullRequest;
      const ok = pr?.state === "MERGED" && pr.mergeCommit?.oid === l.sha;
      if (ok) merges.push(l.sha);
      facts.push(`the comment by ${l.c.author?.login} (${l.c.createdAt}) says ${url} merged at ${l.sha}: ${!pr ? "could not be read just now" : ok ? `merged${pr.mergedAt ? ` at ${pr.mergedAt}` : ""}, merge commit ${l.sha}` : pr.state === "MERGED" ? `merged, but at ${pr.mergeCommit?.oid ?? "another commit"}, not that sha` : pr.state === "OPEN" ? "open, not merged" : "closed without merging"}`);
    }
  }
  const text = comments.slice(-5).map((c) => `--- ${c.author?.login ?? "ghost"} (${c.authorAssociation}) ${c.createdAt} ---\n${String(c.body ?? "").slice(0, 2000)}`).join("\n\n");
  const closed = i.state === "CLOSED" ? `${trusted ? "" : "untrusted:"}${keywordPr ? `kw${keywordPr.number}:` : ""}${i.stateReason}:${i.closedAt}:${merges.map((m) => m.slice(0, 12)).join(",")}+${hash(lines.map((l) => `${l.repo}#${l.number}@${l.sha}`).join("\n"))}` : "open";
  return { version: `${ref}@${closed}`.slice(0, 200), facts, data: { ISSUE_COMMENTS: text || "(none)" } };
}

/** The task's latest fleet apply (its approval records) as evidence: its state and outcome. */
export function applyEvidence(cards: any[]): any {
  const applied = latestCard(cards.filter((a: any) => cardAction(a) === "apply"));
  if (!applied) return { awaiting: "no apply filed yet", missing: true };
  const facts = [`apply ${applied.id}: ${applied.state}${cardOutcome(applied) ? `, ${cardOutcome(applied).split("\n")[0]}` : ""}`];
  // What the apply carried, from the card's args (code-built): the instance repo, the commit and the files it changed. The
  // card's details (APPLY_CHANGE) are the committed diff itself; the outcome text (APPLY_OUTCOME) is the apply's own log tail.
  const a = applied.args ?? {};
  if (a.repo && a.sha) facts.push(`apply ${applied.id} landed ${String(a.sha).slice(0, 12)} on ${a.repo}${Array.isArray(a.files) && a.files.length ? `, files: ${a.files.slice(0, 20).join(", ")}` : ""}`);
  facts.push(`apply ${applied.id}: the diff it carried is ${applied.details ? "in APPLY_CHANGE" : "not available"}; its log is ${cardOutcome(applied) ? "in APPLY_OUTCOME" : "not available"}`);
  return { version: applied.id, facts, data: { APPLY_OUTCOME: cardOutcome(applied), APPLY_CHANGE: applied.details ?? "" } };
}

const NEWEST = 4; // the newest comments, anyone's, always go first (an owner's reopening word among them)
const COMMENT_MAX = 8_000; // one comment's characters
export const COMMENTS_TOTAL = 18_000; // all comments' characters (the prompt fences a block at 20,000)
const COMMON = new Set("about above after again agent along also another because before being below between could does doing done during each every final first found from have having here into itself just latest least made make more most much must never only other over posted result same should shows since some still such than that their them then there these they this those through under until very were what when where which while will with within would your".split(" "));
/** A text's distinctive words (4+ characters, file names and paths whole), for matching a comment to what names it. */
const termsOf = (text: unknown) => new Set((String(text).toLowerCase().match(/[a-z0-9][a-z0-9._/-]{3,}/g) ?? []).map((w: string) => w.replace(/[._/-]+$/, "")).filter((w: string) => w.length >= 4 && !COMMON.has(w)));

/**
 * The comments the grader reads, within COMMENTS_TOTAL: the NEWEST newest (anyone's but the grader's), then the task agent's
 * own earlier ones (`own(c)`) and the task's delegator's earlier ones (`delegator(c)`: a comment is the delegator's only way
 * to amend the ask, so an amendment older than the newest comments is never lost), ranked: those whose id the rubric or the
 * agent's latest result names, then by how many of their distinctive words those name, then the delegator's before the
 * agent's, then the newest. A report posted in parts, or evidence posted before a short closing note, is read this way, not
 * lost behind the last few comments. Each is cut to COMMENT_MAX; they go in the task's order. Each header names the writer's
 * role ([who]) so the grader can tell the delegator's ask from the agent's working notes. { text, fact }: the fact says
 * what was sent, cut or left out.
 */
export function pickComments(all: any[], own: (c: any) => boolean, rubric = "", delegator: (c: any) => boolean = () => false, who: (c: any) => string = () => "someone else") {
  const newest = all.slice(-NEWEST);
  const earlier = all.slice(0, -NEWEST).filter((c) => own(c) || delegator(c));
  const latest = [...all].reverse().find(own);
  const named = `${rubric}\n${latest?.body ?? ""}`;
  const want = termsOf(named);
  const score = (c: any): number => (c.id && named.includes(c.id) ? 1e6 : [...termsOf(c.body)].filter((w) => want.has(w)).length);
  const ranked = earlier.map((c, i) => ({ c, i, s: score(c) })).sort((a, b) => b.s - a.s || Number(delegator(b.c)) - Number(delegator(a.c)) || b.i - a.i).map((x) => x.c);
  let left = COMMENTS_TOTAL;
  const shown = new Map<any, string>();
  let cut = 0;
  let out = 0;
  const head = (c: any) => `--- comment ${String(c.createdAt ?? "").slice(0, 25)} by ${who(c)} ---\n`;
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
  const ownText = all.filter((c) => shown.has(c) && own(c)).map((c) => shown.get(c)).join("\n\n");
  const extra = [...shown.keys()].filter((c) => !newest.includes(c)).length;
  const fact = `TASK_COMMENTS holds ${shown.size} of the task's ${all.length} comments (the grader's own not counted): the newest${extra ? `, and ${extra} earlier one${extra > 1 ? "s" : ""} by the task's agent or delegator picked by what the rubric and its latest result name` : ""}${cut ? `; ${cut} cut to fit (each at most ${COMMENT_MAX} characters, all at most ${COMMENTS_TOTAL})` : ""}${out ? `; ${out} more left out over that budget` : ""}`;
  return { text, fact, ownText };
}

/**
 * The task's own words (the newest comments other than the grader's, and the agent's earlier ones that bear on the rubric:
 * pickComments) and its files: the evidence for file and report, context for the rest. The task's agent is deps.assignee
 * (its own comments) or the runner posting an Engineer's (its marker); the delegator is deps.delegator ({ agentId, userId }),
 * whose comments can amend the ask. File names and types are the agents' own strings: the
 * trusted facts call each file by a code-made label (file_1, file_2, ... in the attachments' order) and its name and type go
 * in the fenced FILE_NAMES block, as data. The version stays the newest comments' and the files' ids.
 */
export async function wordsEvidence(deps: any, rubric: string[] = []): Promise<any> {
  const all = (await deps.comments()).filter((c: any) => !String(c.body ?? "").includes(GRADER_MARKER));
  const comments = all.slice(-NEWEST);
  const own = (c: any) => (deps.assignee ? c.authorAgentId === deps.assignee : c.authorType === "agent");
  // The delegator is the task's creator: an agent's id for an agent-authored task, else the user's. A comment posted
  // for someone else is never the delegator's words.
  const delegator = (c: any) =>
    Boolean(deps.delegator?.agentId || deps.delegator?.userId) &&
    !forOthers(c.body) &&
    (c.authorAgentId ? c.authorAgentId === deps.delegator.agentId : c.authorType === "user" && c.authorUserId === deps.delegator.userId);
  const who = (c: any) => (delegator(c) ? "the task's delegator" : own(c) ? "the task's agent" : "someone else");
  const picked = pickComments(all, own, rubric.join("\n"), delegator, who);
  const files = (await deps.attachments().catch(() => [])).map((f: any, i: number) => ({ ...f, label: `file_${i + 1}` }));
  const facts = files.length ? [`${files.length} file${files.length > 1 ? "s" : ""} attached: ${files.map((f: any) => f.label).join(", ")} (their names, types and sizes, as the agent gave them, are in FILE_NAMES)`] : ["no files attached"];
  if (all.length) facts.push(picked.fact);
  const version = comments.length || files.length ? hash([...comments.map((c: any) => c.id), ...files.map((f: any) => f.id)].join(" ")) : "";
  const names = files.map((f: any) => `${f.label}: ${nameOf(f).slice(0, 200)} (${String(f.contentType ?? "").slice(0, 100)}; ${Number(f.byteSize) || 0} bytes)`).join("\n");
  return { version, facts, files, report: picked.ownText, data: { TASK_COMMENTS: picked.text, ...(files.length ? { FILE_NAMES: names } : {}) } };
}

const MAX_OTHER_TASKS = 3;
export const MAX_OTHER_FILES = 20; // per task, the newest

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


/** The most ids one report's citations may add to the evidence: the facts stay small and the prompt bounded. */
export const MAX_CITED = 20;

/** An id a report cites: a task of this company, an approval card, or a GitHub Actions job. */
export type Citation = { kind: "task"; id: string } | { kind: "card"; id: string } | { kind: "job"; id: string; repo?: string };

/**
 * The ids a report cites, in the order it names them, at most MAX_CITED: this task's company prefix (its own identifier's,
 * never the graded task itself), approval cards (`k-` and 16 hex), and Actions jobs (a `.../actions/runs/<n>/job/<id>` URL,
 * or `job <id>` / `job_id: <id>`). Only the report's own words: an id in the rubric is not a citation the report made.
 */
export function citedIds(texts: unknown[], own: string | undefined): Citation[] {
  const prefix = /^([A-Z][A-Z0-9]*)-\d+$/.exec(String(own ?? ""))?.[1];
  const found: { at: number; c: Citation }[] = [];
  const seen = new Set<string>();
  const add = (at: number, c: Citation) => {
    // An Actions job id is GitHub's own and unique across repositories, so the same id from a URL and from "job <id>" is one.
    const key = `${c.kind}:${c.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ at, c });
  };
  let offset = 0;
  for (const t of texts) {
    const text = String(t ?? "");
    const at = (i: number | undefined) => offset + (i ?? 0);
    for (const m of text.matchAll(/https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/actions\/runs\/\d+\/job\/(\d{1,20})/g)) add(at(m.index), { kind: "job", repo: m[1]!, id: m[2]! });
    if (prefix) for (const m of text.matchAll(/\b([A-Z][A-Z0-9]*)-(\d{1,7})\b/g)) if (m[1] === prefix && m[0] !== own) add(at(m.index), { kind: "task", id: m[0]! });
    for (const m of text.matchAll(/\bk-[0-9a-f]{16}\b/g)) add(at(m.index), { kind: "card", id: m[0]! });
    for (const m of text.matchAll(/\bjob(?:_id)?\s*[:#=]?\s*(\d{4,20})\b/gi)) add(at(m.index), { kind: "job", id: m[1]! });
    offset += text.length + 1;
  }
  // The order the report names them, then the cap: the evidence (and so the prompt) stays bounded.
  return found.sort((a, b) => a.at - b.at).slice(0, MAX_CITED).map((x) => x.c);
}

/** What one cited id resolved to; `exists: false` is a real answer ("no such id"), not a read failure. */
export type ResolvedCitation = {
  citation: Citation;
  id: string;
  exists: boolean;
  /** A task's state, a card's state, or an Actions job's state. */
  state?: string;
  /** A task's title (the task's own words: fenced as data by citedEvidence). */
  title?: string;
  /** A card's outcome. */
  outcome?: { ok?: boolean; text?: string };
  /** An Actions job's conclusion and name (the workflow's words: fenced as data). */
  conclusion?: string;
  name?: string;
  repo?: string;
  /** Why the repo could not be read at all (a refusal): a final answer, not a wait. */
  unreadable?: string;
};

/** A GitHub rate limit, primary or secondary: by its message or its headers (a Headers or a plain object, when the error carries them). */
const rateLimited = (err: any) => {
  const h = (k: string) => (typeof err?.headers?.get === "function" ? err.headers.get(k) : err?.headers?.[k]);
  return /rate limit/i.test(String(err?.message ?? "")) || String(h("x-ratelimit-remaining")) === "0" || h("retry-after") != null;
};

/**
 * Resolve one cited id with the reads the grader holds: deps.citedTask(ident) (the control plane's task: identifier, title,
 * state, exists), deps.citedCard(id) (the kernel's write record: state, ok, outcome_text; null for none), and
 * deps.citedJob(repo, id) (GitHub's Actions job: state, conclusion, name; null for none). A job cited without a repo is
 * looked for in `repos` (the graded PRs' and the report's own PR links), at most three. A 404 is `exists: false`; any other
 * read failure is thrown so the caller can wait for the next look rather than report "no such id" for a failed read.
 */
export async function resolveCitation(c: Citation, deps: any, repos: string[] = []): Promise<ResolvedCitation> {
  if (c.kind === "task") {
    const t = await deps.citedTask(c.id);
    if (!t || t.exists === false) return { citation: c, id: c.id, exists: false };
    return { citation: c, id: String(t.identifier ?? c.id), exists: true, state: String(t.state ?? "unknown"), title: String(t.title ?? "") };
  }
  if (c.kind === "card") {
    const r = await deps.citedCard(c.id);
    if (!r) return { citation: c, id: c.id, exists: false };
    const text = r.outcome_text ?? r.outcome?.text ?? "";
    return { citation: c, id: c.id, exists: true, state: String(r.state ?? "unknown"), outcome: { ...(typeof r.ok === "boolean" ? { ok: r.ok } : r.outcome?.ok !== undefined ? { ok: Boolean(r.outcome.ok) } : {}), text: String(text ?? "") } };
  }
  // A cited repo is the report's own spelling ("AidenHQ/AidenHQ" for Aiden-HQ/AidenHQ): an exact (case-insensitive) match among
  // the graded PRs' and report's repos wins; otherwise the one known repo that differs only by dashes and case is tried first, then
  // the cited spelling itself (dashes can make two real repos equal, and a job id exists in one repo only).
  const lower = (r: string) => r.toLowerCase();
  const nodash = (r: string) => lower(r).replace(/-/g, "");
  const exact = repos.find((r) => c.repo && lower(r) === lower(c.repo));
  const variants = [...new Set(repos.filter((r) => c.repo && nodash(r) === nodash(c.repo)).map(lower))];
  const known = exact ?? (variants.length === 1 ? repos.find((r) => lower(r) === variants[0]) : undefined);
  const candidates = c.repo ? [...new Map([known ?? c.repo, c.repo].map((r) => [lower(r), r])).values()] : [...new Set(repos.map((r) => String(r).toLowerCase()))].slice(0, 3);
  let refused: { repo: string; message: string } | undefined;
  for (const repo of candidates) {
    let j: any;
    try {
      j = await deps.citedJob(repo, c.id);
    } catch (err: any) {
      // What the code host answers (modules/github ops.ts "job": GitHub's 404 for a job is a 200 with null, so "no such job" is
      // null, never a status; the kernel's POST /v1/codehost/:op (codehost.ts) answers 403 for a missing grant and 404 for an
      // unknown repo or no code host). So a 403 or 404 here is a refusal, never "no such job". A rate limit (message,
      // x-ratelimit-remaining: 0 or a retry-after header) and any other failure are rethrown: the next look retries them.
      const status = Number(err?.status ?? err?.statusCode ?? err?.response?.status);
      if (rateLimited(err) || ![403, 404].includes(status)) throw err;
      // The first refusal is kept and the next candidate tried.
      refused ??= { repo, message: String(err.message ?? err) };
      continue;
    }
    if (!j) continue;
    return { citation: c, id: c.id, exists: true, state: String(j.state ?? j.status ?? "unknown"), conclusion: String(j.conclusion ?? ""), name: String(j.name ?? ""), repo };
  }
  // Every candidate came back empty or refused: a refusal means the job may be in a repo the grader cannot read, so it is unverified, not "no such job".
  if (refused) return { citation: c, id: c.id, exists: false, unreadable: refused.message, repo: refused.repo };
  return { citation: c, id: c.id, exists: false };
}

/** A task title, a card's outcome or a job name on one line, cut: these are agents' or workflows' words, never a fact. */
const oneLine = (s: unknown, n: number) => String(s ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, n);

/**
 * The ids a report cites, resolved by code: each is a task of this company, an approval card or an Actions job, and the
 * trusted facts say whether it exists and its state — an id the facts call "no such …" does not exist, which is the answer
 * a criterion about citing a real id needs, never an error. The titles, card outcomes and job names are their authors'
 * words: they go in CITED_IDS as data. A read that fails waits for the next look (missing evidence is never a pass).
 * { awaiting } or { facts, data, version } (version: a hash of the resolutions, "" with none).
 */
export async function citedEvidence(citations: Citation[], deps: any, repos: string[] = []): Promise<any> {
  const facts: string[] = [];
  const lines: string[] = [];
  const seen: string[] = [];
  for (const c of citations) {
    let r: ResolvedCitation;
    try {
      r = await resolveCitation(c, deps, repos);
    } catch (err: any) {
      return { awaiting: `the cited ${c.kind === "task" ? "task" : c.kind === "card" ? "card" : "Actions job"} ${c.id} could not be read yet (${String(err.message ?? err).replace(/[^\w .:/()-]/g, "").slice(0, 160)})` };
    }
    const state = r.state ? `, state ${oneLine(r.state, 40)}` : "";
    if (c.kind === "task") {
      facts.push(r.exists ? `cited task ${r.id}: exists${state}; its title is in CITED_IDS` : `cited id ${c.id}: no such task in this company`);
      if (r.exists) lines.push(`${r.id} (task): title ${oneLine(r.title, 200) || "(empty)"} (state ${oneLine(r.state, 40)})`);
    } else if (c.kind === "card") {
      const outcome = r.outcome?.text ? `, outcome ${r.outcome.ok === false ? "failed" : r.outcome.ok ? "ok" : "unknown"}` : "";
      facts.push(r.exists ? `cited card ${c.id}: exists${state}${outcome}; its outcome text is in CITED_IDS` : `cited id ${c.id}: no such approval card`);
      if (r.exists) lines.push(`${c.id} (card): outcome ${oneLine(r.outcome?.text, 300) || "(none)"} (state ${oneLine(r.state, 40)})`);
    } else {
      const repo = r.repo ?? c.repo ?? "an unknown repo";
      const conclusion = r.conclusion ? `, conclusion ${oneLine(r.conclusion, 40)}` : "";
      if (r.unreadable) facts.push(`cited id ${c.id}: its Actions job in ${repo} could not be read (${oneLine(r.unreadable, 160)})`);
      else facts.push(r.exists ? `cited Actions job ${c.id} in ${repo}: exists${state}${conclusion}; its name is in CITED_IDS` : `cited id ${c.id}: no such Actions job${c.repo ? ` in ${c.repo}` : ""}`);
      if (r.exists) lines.push(`${c.id} (Actions job in ${repo}): name ${oneLine(r.name, 120) || "(empty)"} (state ${oneLine(r.state, 40)}${r.conclusion ? `, conclusion ${oneLine(r.conclusion, 40)}` : ""})`);
    }
    seen.push(`${c.kind}:${r.id}:${r.exists}:${r.state ?? ""}:${r.conclusion ?? ""}`);
  }
  return { facts, data: lines.length ? { CITED_IDS: lines.join("\n") } : {}, version: lines.length ? `cited:${hash(seen.join("\n"))}` : "" };
}

/** A content type as code may state it among the trusted facts: a plain type/subtype, or "unknown type". */
const safeType = (t: unknown) => (/^[\w.+-]+\/[\w.+-]+$/.test(String(t ?? "")) ? String(t) : "unknown type");

export const MAX_IMAGES = 20; // a mockup task attaches ~18 screenshots; the byte budget below is the real bound
const IMAGE_SIDE = 2048; // a PNG with a longer side is downscaled (the vision models scale to about this anyway)
const IMAGE_BYTES = 3 * 1024 * 1024; // one image as sent; a bigger one is downscaled if a PNG, else left out
const IMAGES_BYTES = 12 * 1024 * 1024; // all images as sent (base64 adds a third; the gateway takes 32 MB)
const TEXT_FILE = 6_000; // one text file's characters
export const TEXT_TOTAL = 16_000; // all text files' characters (the prompt fences a block at 20,000)
const TEXT_EXT = /\.(txt|md|markdown|json|csv|tsv|ya?ml|log|html?|tsx|ts|jsx|js|css)$/i;

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
  const names = (f: any, text: string) => {
    const base = nameOf(f).split("/").pop()!.toLowerCase();
    return base.length >= 3 && text.toLowerCase().includes(base);
  };
  const rank = (f: any) => (names(f, rubric) ? 2 : names(f, comments) ? 1 : 0);
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
    // Heading and cut marker are paid for out of the budget too, so the block never cuts a file off unmarked.
    const head = `=== ${f.label}: ${name.slice(0, 200)} ===\n`;
    const room = isText ? Math.min(TEXT_FILE, textLeft - head.length) : 0;
    if (isText && room <= 0) {
      facts.push(`${f.label}: text, ${Number(f.byteSize) || 0} bytes, not sent to the grader (the text budget of ${TEXT_TOTAL} characters was spent on other files)`);
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
    const cut = text.length > room ? `\n[cut: ${text.length - room} of ${text.length} characters not shown]` : "";
    textLeft -= head.length + Math.min(room, text.length) + cut.length;
    texts.push(`${head}${text.slice(0, room)}${cut}`);
    facts.push(`${f.label}: text, ${text.length} characters, in FILES${cut ? ` (cut to its first ${room}, the rest marked in FILES)` : ""}`);
  }
  return { facts, images, data: texts.length ? { FILES: texts.join("\n\n") } : {} };
}
