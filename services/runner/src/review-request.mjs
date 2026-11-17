// What the AI reviewer reads (reviewer@1, kernel/sdk/src/reviewer.ts), as the runner gathers it until 3e: the diff, the
// changed files shaped by fileContext, the request chain, the base's source records, the instance's decisions digest,
// earlier findings, and a PR's Evidence section. A record's review
// goes to the kernel with its record (POST /v1/writes/:id/review), which asks the bound reviewer module and applies the
// verdict; the Engineer's check before filing goes to POST /v1/reviews with the same request.
import { readExceptions } from "../../../scripts/supply-chain/best-version.mjs";

/** The owner-approved source exceptions: read from the base branch, never from the change under review. */
export const SOURCE_EXCEPTIONS_FILE = ".github/supply-chain-source-exceptions.yaml";

/**
 * The owner-approved source records: the same flow style, one per line, the version exceptions use (best-version.mjs reads
 * the file), kept only when one says `approved_by: owner` and names a package and the source it moves to. Anything else is
 * not an approval, and code never guesses one; an absent file is no records.
 */
export const readSourceExceptions = (text) =>
  readExceptions(text).filter((e) => String(e.approved_by ?? "").trim().toLowerCase() === "owner" && e.package && e.to);

/** The contents-API path of that file at a base commit: built beside the name it reads, so the ref is always the base reviewed. */
export const sourceExceptionsUrl = (repo, base) => `repos/${repo}/contents/${encodeURIComponent(SOURCE_EXCEPTIONS_FILE)}?ref=${encodeURIComponent(base)}`;

/** A whole card's read that failed: the reviewer is told so, and gets no records rather than a guessed one. */
export const unreadSourceExceptions = () => ({ where: `${SOURCE_EXCEPTIONS_FILE} (could not be read)`, records: [] });

/** A card's source records, read from its bases by `read(repo, url)`: each keeps its repo and base, so it covers only that repo's
 * own change off that base. A base code could not name, or a file it could not read, is no records, so no record ever passes a
 * new source unread; `where` names only the bases read, so a card with none reads as no exception, not as a failed read. */
export async function readCardSourceExceptions(bases, read) {
  const known = bases.filter((b) => b.base);
  const rows = await Promise.all(known.map((b) => read(b.repo, sourceExceptionsUrl(b.repo, b.base)).catch(() => "").then((text) => readSourceExceptions(text).map((r) => ({ ...r, repo: b.repo, base: b.base })))));
  return { where: known.map((b) => `${b.repo} ${b.base} ${SOURCE_EXCEPTIONS_FILE}`).join("; "), records: rows.flat() };
}

/** The instance's product decisions (what the owner decided, and decided not to build), at the instance repo's root. */
export const DECISIONS_FILE = "decisions.md";

/**
 * The instance's decisions digest for the reviewer: read from the instance repo's default branch, never from a card's base
 * or branch, so a change (an edit to decisions.md included) is always judged against the digest already on main. No
 * instance repo, no file or a failed read is no block (undefined): the digest only ever adds grounds to reject.
 */
export async function readDecisions(instanceRepo, defaultBranch, read) {
  const branch = instanceRepo && (await defaultBranch(instanceRepo));
  const text = branch && String(await read(instanceRepo, `repos/${instanceRepo}/contents/${DECISIONS_FILE}?ref=${encodeURIComponent(branch)}`)).trim();
  return text ? { where: `${instanceRepo} ${branch} ${DECISIONS_FILE}`, text } : undefined;
}

/**
 * The diff of a kernel record's card (a module write kind's), from the card's details. Only deploy_app's card carries a
 * marker: the author's commit message after it is cut off, so it never reaches the reviewer inside the DIFF fence (the
 * reviewer is reasoning-blind). Every other kind's details are the change itself, whole (a primer.publish card's is the
 * document as it will be published), so no line in them can hide the rest.
 */
export function kernelCardDiff(a) {
  const marker = "\n\nCommit message (written by the app's author): ";
  const i = a.action === "deploy_app" ? a.details.lastIndexOf(marker) : -1;
  return { diff: i < 0 ? a.details : a.details.slice(0, i) };
}

/**
 * The request the reviewer reads: the card's review (main.mjs reviewOne) and the Engineer's check before filing one
 * (agentReview) both build it here, so the check sees exactly what the card will. `a`: { action, target, sentence, panel? };
 * `input`: the runner's tier input with the diff; `previous`: its own checks' findings for the action on the task.
 */
export function reviewRequest(a, input, chain, { component = "AI reviewer", siblings, sources, decisions, requesterModel = "", previous = [], product = [] } = {}) {
  return {
    // `product`: the repositories that are one product for scope (the product repo and the official modules repo), code's own.
    card: { action: a.action, rule: input.rule, target: a.target, sentence: a.sentence, reason: input.reason, ...(product.length ? { product } : {}) },
    diff: input.diff,
    files: input.files,
    chain,
    siblings,
    sources,
    decisions,
    requesterModel,
    // Code's flag now, or one the card already carries (a first reviewer's, recorded on an earlier try).
    panel: Boolean(input.panel || a.panel),
    previous: [...(input.previous ?? []), ...previous],
    relift: input.relift,
    // A pr or merge card's Evidence section (the author's words, fenced by the reviewer); absent for other actions.
    evidence: input.evidence,
    component,
  };
}

/** How long the runner waits on one review: up to four model calls of ten minutes each, and the kernel's own 45-minute limit. */
const REVIEW_WAIT_MS = 46 * 60_000;
const DECISIONS = ["approve", "reject", "escalate"];

/**
 * One review through the kernel (POST /v1/reviews, the runner's reviewer key). The verdict as the module sent it, checked for
 * shape; a review that can't finish (no reviewer, unreachable, its own failure, a malformed verdict) throws, and the caller
 * counts it as reviewer_failed, retried later as a failed model call always was.
 */
export async function requestReview({ kernelUrl, key, fetchFn = fetch }, request) {
  const res = await fetchFn(`${kernelUrl}/v1/reviews`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ request }), signal: AbortSignal.timeout(REVIEW_WAIT_MS) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`the kernel answered ${res.status}: ${String(body?.error?.message ?? "").slice(0, 200)}`);
  if (!DECISIONS.includes(body?.decision) || typeof body.reason !== "string" || typeof body.model !== "string") throw new Error("the reviewer's verdict is malformed");
  return body;
}
