// How GitHub check results are read: the one copy the merge gate, the PR watcher and the grader share. A rollup's contexts
// (check runs and commit statuses) become named checks; a skipped image scan on a PR that could change an image is not green.
type Json = any;

/** The UI Reviewer's design review: advisory in the named checks (the merge gate reads it on its own). */
export const DESIGN_REVIEW_CHECK = "design-review";
/** Code review's commit status: a mirror of its merge verdict for people and `gh pr checks`. The merge queue asks code review's
 * verdict itself, so the status never becomes a second gate here. */
export const CODE_REVIEW_STATUS = "aidenhq/review";
/** The aggregate check a repository's CI may end with (the product's ci.yml `ci-required`). */
export const GATE_CHECK = "ci-required";

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

/** Every context in a rollup as a named check, advisory ones (the design review, code review's status) included: { name, status, kind, rank?, ok, success, pending, skipped? } (`ok` counts neutral and skipped as passed, `success` only success). A name's newest run is picked where it is judged (latestChecks). */
export function contextChecks(rollup: Json): Check[] {
  const pass = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
  return (rollup?.contexts?.nodes ?? [])
    .map((n: Json) => ({ name: n.name ?? n.context, status: contextStatus(n), kind: contextKind(n), ...(contextRank(n) !== undefined ? { rank: contextRank(n) } : {}) }))
    .filter((c: Json) => c.name)
    .map((c: Json) => ({ ...c, ok: pass.has(c.status), success: c.status === "SUCCESS", pending: ["PENDING", "EXPECTED", "QUEUED", null, undefined].includes(c.status), ...(c.status === "SKIPPED" ? { skipped: true } : {}) }));
}

/** The named checks in a rollup, the design review and code review left out (contextChecks): every context is returned, and a name's newest run is picked where it is judged (latestChecks). */
export function namedChecks(rollup: Json): Check[] {
  return contextChecks(rollup).filter((c) => c.name !== DESIGN_REVIEW_CHECK && c.name !== CODE_REVIEW_STATUS);
}

const IMAGE_FILE = /(^|\/)(Dockerfile|Containerfile)[^/]*$|\.dockerfile$/i;
/**
 * `image-scan` skipped on a PR that changes an image definition (or whose files can't all be read): nothing was scanned.
 * The scan's newest run at the head is the judgement (latestChecks), like every other name: a run that scanned the head after
 * an edit superseded a skip cleared the question, so the obsolete skip is not one, and a skip that is the newest run is.
 */
export function skippedImageScan(pr: Json): boolean {
  const nodes = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];
  const scans = latestChecks(contextChecks({ contexts: { nodes } }).filter((c) => c.name === "image-scan"));
  if (!scans.some((c) => c.status === "SKIPPED")) return false;
  return !pr.files || pr.files.pageInfo?.hasNextPage || (pr.files.nodes ?? []).some((f: Json) => IMAGE_FILE.test(f.path ?? ""));
}
