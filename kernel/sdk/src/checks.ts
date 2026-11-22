// How GitHub check results are read: the one copy the merge gate, the PR watcher and the grader share. A rollup's contexts
// (check runs and commit statuses) become named checks; a skipped image scan on a PR that could change an image is not green.
type Json = any;

/** The UI Reviewer's design review: advisory in the named checks (the merge gate reads it on its own). */
export const DESIGN_REVIEW_CHECK = "design-review";
/** Code review's commit status: a mirror of its merge verdict for people and `gh pr checks`. The merge queue asks code review's
 * verdict itself, so the status never becomes a second gate here. */
export const CODE_REVIEW_STATUS = "aidenhq/review";
/** The image CVE scan: advisory (owner, 2026-11-22). A finished scan counts as ok whatever it found, so it never holds a merge or
 * turns the base red; its real conclusion stays on the head (`status`) as evidence for image work. */
export const IMAGE_SCAN_CHECK = "image-scan";
/** The aggregate check a repository's CI may end with (the product's ci.yml `ci-required`). */
export const GATE_CHECK = "ci-required";

/** One context's result: a check run's conclusion once completed, else PENDING; a status's state. */
export const contextStatus = (n: Json): string | null | undefined => (n.__typename === "CheckRun" ? (n.status === "COMPLETED" ? n.conclusion : "PENDING") : n.state);

/** The named checks in a rollup, the design review and code review left out: { name, status, ok, pending, skipped? }. */
export function namedChecks(rollup: Json): { name: string; status: string | null | undefined; ok: boolean; pending: boolean; skipped?: true }[] {
  const pass = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
  return (rollup?.contexts?.nodes ?? [])
    .map((n: Json) => ({ name: n.name ?? n.context, status: contextStatus(n) }))
    .filter((c: Json) => c.name && c.name !== DESIGN_REVIEW_CHECK && c.name !== CODE_REVIEW_STATUS)
    .map((c: Json) => ({ ...c, ok: pass.has(c.status) || (c.name === IMAGE_SCAN_CHECK && c.status !== "PENDING"), pending: ["PENDING", "EXPECTED", "QUEUED", null, undefined].includes(c.status), ...(c.status === "SKIPPED" ? { skipped: true } : {}) }));
}

const IMAGE_FILE = /(^|\/)(Dockerfile|Containerfile)[^/]*$|\.dockerfile$/i;
/** `image-scan` skipped on a PR that changes an image definition (or whose files can't all be read): nothing was scanned. */
export function skippedImageScan(pr: Json): boolean {
  const nodes = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];
  if (!nodes.some((n: Json) => n.name === "image-scan" && n.status === "COMPLETED" && n.conclusion === "SKIPPED")) return false;
  return !pr.files || pr.files.pageInfo?.hasNextPage || (pr.files.nodes ?? []).some((f: Json) => IMAGE_FILE.test(f.path ?? ""));
}
