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
 * The reports that judge a head, for a reader that decides on its checks. A run that planned no suite (`edited`, which only runs
 * `policy`) posts a `skipped` check for every job it did not run — and a job `if` skips is still a check GitHub counts as a pass.
 * Those reports are newer than the run that tested the head, so judging them would let a body edit read as green over a real
 * failure and hide it. Here a skip newer than the newest aggregate that judged the head is dropped; every other report stands,
 * the `policy` run an edit did make included. A run that judged the head keeps its own skips: a suite skipped there is a real
 * result (the change didn't touch it). An unranked report proves no order, so it is never dropped.
 */
export function judgedOnHead<T extends { name?: string; kind?: "run" | "status"; rank?: number; status?: string | null }>(checks: T[]): T[] {
  if (!newestGateSkipped(checks)) return checks;
  const gates = checks.filter((c) => c.name === GATE_CHECK && !gateJudgedNothing(c) && typeof c.rank === "number");
  const cut = gates.reduce<number | undefined>((a, c) => (a === undefined || (c.rank as number) > a ? (c.rank as number) : a), undefined);
  // No aggregate ever judged the head: nothing here is a pass, so only the reports that judged something stand.
  if (cut === undefined) return checks.filter(judgedSomething);
  return checks.filter((c) => judgedSomething(c) || typeof c.rank !== "number" || c.rank <= cut);
}

const IMAGE_FILE = /(^|\/)(Dockerfile|Containerfile)[^/]*$|\.dockerfile$/i;
/**
 * `image-scan` skipped on a PR that changes an image definition (or whose files can't all be read): nothing was scanned.
 * The scan's newest report that judged the head is the judgement (judgedOnHead): a run that scanned the head after an edit
 * superseded a skip cleared the question, so the obsolete skip is not one, and a skip that is the newest judgement is.
 */
export function skippedImageScan(pr: Json): boolean {
  const nodes = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];
  const scans = judgedOnHead(contextChecks({ contexts: { nodes } })).filter((c) => c.name === "image-scan");
  if (!scans.some((c) => c.status === "SKIPPED")) return false;
  return !pr.files || pr.files.pageInfo?.hasNextPage || (pr.files.nodes ?? []).some((f: Json) => IMAGE_FILE.test(f.path ?? ""));
}
