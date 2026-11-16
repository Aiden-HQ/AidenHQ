// The runner as the AI reviewer's requester (reviewer@1, kernel/sdk/src/reviewer.ts): it gathers what the reviewer reads (the
// diff, the changed files shaped by fileContext, the request chain, the base's source records, earlier findings) and asks
// the kernel, which sends it to the bound reviewer module and hands back its verdict. Until 3b it stays the requester for
// every review, git cards and kernel records alike.
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
