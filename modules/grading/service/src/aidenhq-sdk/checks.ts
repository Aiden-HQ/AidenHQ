// How GitHub check results are read: the one copy the merge gate, the PR watcher and the grader share. A rollup's contexts
// (check runs and commit statuses) become named checks; a skipped image scan on a PR that could change an image is not green.
type Json = any;

/** Code review's commit status: a mirror of its merge verdict for people and `gh pr checks`. The merge queue asks code review's
 * verdict itself, so the status never becomes a second gate here. */
export const CODE_REVIEW_STATUS = "aidenhq/review";
/** The aggregate check a repository's CI may end with (the product's ci.yml `ci-required`). */
export const GATE_CHECK = "ci-required";
/** The product's PR-metadata job: its title check (and the supply-chain checks), the one job an `edited` run still runs. */
export const POLICY_CHECK = "policy";

/** One context's result: a check run's conclusion once completed, else PENDING; a status's state. */
export const contextStatus = (n: Json): string | null | undefined => (n.__typename === "CheckRun" ? (n.status === "COMPLETED" ? n.conclusion : "PENDING") : n.state);

/** Which judgement a context is: a check run and a status context that share a name are different judgements, both counted. */
export const contextKind = (n: Json): "run" | "status" => (n.__typename === "CheckRun" ? "run" : n.__typename === "StatusContext" || n.state !== undefined ? "status" : "run");

const numOf = (v: unknown): number | undefined => {
  if (v === null || v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};
const timeOf = (v: unknown): number | undefined => {
  const t = Date.parse(String(v ?? ""));
  return Number.isNaN(t) ? undefined : t;
};

/**
 * Where a context sits in its name's history, higher is later: a check run's `databaseId` (GitHub creates every run, a re-run
 * included, with a higher one), else its `id` where that is a number (REST), else its start or completion time; a status's
 * `id` (REST), else its `createdAt`. Undefined when GitHub gave none, so a caller never trusts a rollup's node order as a contract.
 */
export function contextRank(n: Json): number | undefined {
  if (contextKind(n) === "status") return numOf(n.id) ?? timeOf(n.createdAt ?? n.created_at);
  // A run's id is the authority; without one, its start is the point every run of a name shares, so the fallback never compares
  // one run's completion with another's start (a cancelled run finishes after its replacement has started, and would outrank it).
  return numOf(n.databaseId ?? n.id) ?? timeOf(n.startedAt ?? n.started_at) ?? timeOf(n.completedAt ?? n.completed_at);
}

/**
 * One judgement per name and kind: the newest check run of a name, and the newest status of a name (a check run and a status
 * sharing a name judge the same name twice, so both survive and the gate takes the worst). `rank` (contextRank) decides the
 * newest. An entry with no rank proves no order, so it stays its own judgement and the worst of the name still counts: only
 * entries carrying a rank are resolved against each other, and entries of one name whose ranks tie (two statuses in the same
 * second) all stay judgements, so the worst of them counts rather than whichever the rollup listed first. An entry with no
 * `kind` is left as it is for the same reason.
 */
export function latestChecks<T extends { name?: string; kind?: "run" | "status"; rank?: number }>(checks: T[]): T[] {
  const out: T[] = [];
  const groups = new Map<string, { top: number; items: T[] }>();
  for (const c of checks) {
    if (!c.kind || c.rank === undefined) { out.push(c); continue; }
    const key = `${c.kind}\u0000${c.name ?? ""}`;
    const g = groups.get(key);
    if (!g) { groups.set(key, { top: c.rank, items: [c] }); continue; }
    if (c.rank > g.top) { g.top = c.rank; g.items = [c]; }
    else if (c.rank === g.top) g.items.push(c);
  }
  for (const g of groups.values()) out.push(...g.items);
  return out;
}

/** A named check as this module reads it: its status, which judgement it is (`kind`) and where it sits in its name's history (`rank`). */
export type Check = { name: string; status: string | null | undefined; kind: "run" | "status"; rank?: number; ok: boolean; success: boolean; pending: boolean; skipped?: true };

/** Every context in a rollup as a named check, advisory ones (code review's status) included: { name, status, kind, rank?, ok, success, pending, skipped? } (`ok` counts neutral and skipped as passed, `success` only success). A name's newest run is picked where it is judged (latestChecks). */
export function contextChecks(rollup: Json): Check[] {
  const pass = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
  return (rollup?.contexts?.nodes ?? [])
    .map((n: Json) => ({ name: n.name ?? n.context, status: contextStatus(n), kind: contextKind(n), ...(contextRank(n) !== undefined ? { rank: contextRank(n) } : {}) }))
    .filter((c: Json) => c.name)
    .map((c: Json) => ({ ...c, ok: pass.has(c.status), success: c.status === "SUCCESS", pending: ["PENDING", "EXPECTED", "QUEUED", null, undefined].includes(c.status), ...(c.status === "SKIPPED" ? { skipped: true } : {}) }));
}

/** The named checks in a rollup, code review's status left out (contextChecks): every context is returned, and a name's newest run is picked where it is judged (latestChecks). */
export function namedChecks(rollup: Json): Check[] {
  return contextChecks(rollup).filter((c) => c.name !== CODE_REVIEW_STATUS);
}

/**
 * Whether a check is the aggregate gate reporting that it judged nothing: `ci-required` `skipped` (a job skipped by an `if`, as
 * an `edited` run's is) or `cancelled` (a run superseded before the job started). GitHub counts a skip as a pass for branch
 * protection; nothing here does. Scoped to the gate name: a suite's own skip is a real result (the change didn't touch it).
 */
export const gateJudgedNothing = (c: { name?: string; status?: string | null }) => c.name === GATE_CHECK && ["SKIPPED", "CANCELLED"].includes(String(c.status ?? "").toUpperCase());

/** Whether a report actually judged something: a job skipped by `if` or a run cancelled before it started judged nothing. */
export const judgedSomething = (c: { status?: string | null }) => !["SKIPPED", "CANCELLED"].includes(String(c.status ?? "").toUpperCase());

/**
 * Whether the head's newest aggregate report judged nothing: the `ci-required` an `edited` run posts, skipped because that run
 * planned no suite. Every check that run posted is a skip too, and those skips are newer than the run that tested the head — so
 * they are no verdict, and reading them as passes is exactly the bug this rule exists to stop.
 */
export function newestGateSkipped<T extends { name?: string; kind?: "run" | "status"; rank?: number; status?: string | null }>(checks: T[]): boolean {
  const runs = checks.filter((c) => c.name === GATE_CHECK && (c.kind ?? "run") === "run" && typeof c.rank === "number");
  const newest = runs.reduce<T | undefined>((a, b) => (a === undefined || (b.rank as number) > (a.rank as number) ? b : a), undefined);
  return newest !== undefined && gateJudgedNothing(newest);
}

/**
 * The reports that judge a head, for a reader that decides on its checks. A run that plans no suite (`edited`) posts a
 * `skipped` check for every job it did not run — and a job `if` skips is still a check GitHub counts as a pass. Those reports
 * are newer than the run that tested the head, so judging them would let a body edit read as green over a real failure and
 * hide it.
 *
 * Per name and kind: when the newest report is `skipped` and an older report of that same name judged something, the skip is
 * dropped and the older result stands — it is the run that tested the code, and an edit's skip says nothing about it. Two runs
 * on one head differ only in the event (an edit against a push or a re-run); within one run a path-filtered suite is skipped
 * the same way both times, so an older judgement of the same name is the same tree's. A name whose only report is a skip keeps
 * it: a suite skipped by the run that judged the head is a real result (the change didn't touch it). An unranked report proves
 * no order, so it is never dropped. `cancelled` is left alone: latestChecks still reads it as a superseded run's red.
 */
export function judgedOnHead<T extends { name?: string; kind?: "run" | "status"; rank?: number; status?: string | null }>(checks: T[]): T[] {
  const groups = new Map<string, T[]>();
  for (const c of checks) {
    if (typeof c.rank !== "number") continue;
    const key = `${c.name ?? ""}\u0000${c.kind ?? "run"}`;
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  const drop = new Set<T>();
  for (const group of groups.values()) {
    const ranked = [...group].sort((a, b) => (b.rank as number) - (a.rank as number));
    if (String(ranked[0]?.status ?? "").toUpperCase() !== "SKIPPED") continue;
    // Drop the newest run of skips only when something older judged the name: then they are a later run's skips, not its result.
    const firstJudged = ranked.findIndex((c) => judgedSomething(c));
    if (firstJudged <= 0) continue;
    for (const c of ranked.slice(0, firstJudged)) drop.add(c);
  }
  return drop.size ? checks.filter((c) => !drop.has(c)) : checks;
}

const IMAGE_FILE = /(^|\/)(Dockerfile|Containerfile)[^/]*$|\.dockerfile$/i;
/**
 * `image-scan` skipped on a PR that changes an image definition (or whose files weren't read at all): nothing was scanned.
 * The scan's newest report that judged the head is the judgement (judgedOnHead): a run that scanned the head after an edit
 * superseded a skip cleared the question, so the obsolete skip is not one, and a skip that is the newest judgement is.
 * The file list answers on its own: a truncated list is answered on the pages that were read; paging happens at the caller.
 * Deleting an image definition is not one: the workflow selects Dockerfiles from the head's tree, so a PR that only removes
 * a service's Dockerfile skips the scan for a real reason, and no commit could unskip it. A file whose `changeType` is
 * missing counts as a change (fail closed).
 */
export function skippedImageScan(pr: Json): boolean {
  const nodes = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];
  const scans = latestChecks(judgedOnHead(contextChecks({ contexts: { nodes } })).filter((c) => c.name === "image-scan"));
  if (!scans.some((c) => c.status === "SKIPPED")) return false;
  // No file list at all (ship's list read carries none) is no evidence: the full PR read answers instead.
  if (!Array.isArray(pr.files?.nodes)) return true;
  return pr.files.nodes.some((f: Json) => IMAGE_FILE.test(f.path ?? "") && f.changeType !== "DELETED");
}
