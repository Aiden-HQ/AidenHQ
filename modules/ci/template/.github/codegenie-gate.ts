#!/usr/bin/env node
// The `code-review` check's verdict: reads the review's JSON (code-review.ts: codex's review, its P0 and P1 as critical
// and high; codegenie's `--format json` from repos on the older template has the same shape) and fails the check when any
// finding is critical or high, or the PR changes codex config (a policy refusal). A run without a verdict (failed, no
// coverage, unreadable) passes with a note (owner, 2026-11-21: fail open); findings it published still decide.
// Keeps one PR comment with every finding, updated in place on each push. No dependencies; Node 22+.
//   node codegenie-gate.ts <review.json> <reviewer exit code>
// Env: GITHUB_TOKEN (pull-requests: write), GITHUB_REPOSITORY, PR_NUMBER, HEAD_SHA, REVIEW_COUNTED_LINES (the PR's counted changed
// lines: added plus deleted, lockfiles and generated files excluded), REVIEW_TIER, REVIEW_WHY and REVIEW_EFFORT (codegenie-tier.ts),
// GITHUB_API_URL (optional).
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const MARKER = "<!-- ci:code-review -->";
const BOT = "github-actions[bot]"; // the author of comments posted with the workflow's GITHUB_TOKEN
const BLOCKING = new Set(["critical", "high"]);
interface Finding { severity: string; path: string; anchor?: { line?: number }; title: string; finalBody?: string; failureMode?: string }
interface Review {
  findings?: Finding[]; summaryOnlyFindings?: Finding[];
  health?: { status?: string; diagnostics?: { reason?: string }[] };
  cause?: string;
  coverage?: { unavailable?: unknown; partial?: unknown; reasons?: string[] };
  needsHumanAttention?: { question?: string; files?: string[] }[];
}
interface Opts { mode?: string; from?: string; n?: string | number; tier?: string; why?: string; effort?: string; failure?: string; cause?: string; attempts?: string | number; lines?: string | number }
interface Verdict { block: boolean; body: string; short?: boolean; partial?: boolean; quiet?: boolean }
interface Comment { id: number; user?: { login?: string }; body?: string }

// Everything posted goes through clip: the comment is public to the repo and GitHub masks secrets only in job logs, so
// anything secret-shaped (API keys, bearer tokens, key=/token= values) is masked first.
const mask = (s: string) => s.replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{6,}/g, "$1-***").replace(/\b(ahq[a-z]{1,3})_[A-Za-z0-9._-]{6,}/g, "$1_***").replace(/\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{6,}/gi, "$1 ***")
  .replace(/\b(key|token|secret|password|api_key|apikey|access_token|auth)=[^\s&"']+/gi, "$1=***").replace(/\bgh[pousr]_[A-Za-z0-9]{10,}/g, "gh*_***");
const clip = (s: unknown, n: number) => { const t = mask(String(s ?? "").trim()); return t.length > n ? `${t.slice(0, n)}…` : t; };

// Why no review came out, by the workflow's CODEGENIE_FAILURE. transient: a confirmed provider error (HTTP 429 or 5xx, a
// provider quota 402, a dropped connection); no-verdict: anything else (a timeout, an answer that isn't a review). The
// workflow retries both once when time is left; a retry shows as "2 attempts". permanent: the gateway refused, never retried.
const NEXT: Record<string, string> = {
  transient: "The model provider failed (rate limit, server error or a dropped connection).",
  "no-verdict": "The reviewer gave no verdict (it timed out, or its answer wasn't a review).",
  permanent: "The model gateway refused the review.",
};
const FALLBACK = "See the job log for why.";
// A run without a verdict never blocks (owner, 2026-11-21: fail open rather than stall; this replaces the fail-closed ruling
// of 2026-11-17). The review target is advisory: past it, in counted changed lines (lockfiles and generated files don't count), the
// comment says the PR is large and suggests stacked PRs. On the 2026-11-16 eval a 1,936-line PR took 17 minutes and a
// 5,230-line one ended without a verdict after 25.
const TARGET_LINES = 2000;

/**
 * { block, body, quiet } from the reviewer's exit code and its stdout. quiet: nothing worth a new comment. The workflow's
 * reading of a run with no verdict: failure (transient, permanent), cause (a fixed class), attempts (how many runs it made).
 * What it reviewed (codegenie-prior.ts): mode (full, delta: only the changes since `from`, the n-th delta since a full
 * review; reuse: `from`'s verdict stands).
 */
export function verdict(exitCode: number, stdout: string, sha = "", opts: Opts = {}): Verdict {
  const { mode, from, n, tier, why, effort } = opts;
  const at = sha ? ` on \`${sha.slice(0, 7)}\`` : "";
  const old = `\`${String(from).slice(0, 7)}\``;
  if (mode === "reuse") return { block: false, quiet: true, body: `${MARKER}\n**Code review reused${at}** from ${old}: the PR's patch is the same as at that green review (a rebase), so it isn't reviewed again.` };
  const v = judge(exitCode, stdout, sha, opts);
  const scope = v.short ? "" : mode === "delta" ? `_Reviewed only the changes since ${old}, this PR's last green review (delta ${n} of at most 3 before a full review)._`
    : mode === "full" ? "_Reviewed the whole PR._" : "";
  // The PR's risk tier (codegenie-tier.ts), why, and the effort it was reviewed at.
  const how = tier ? `_Risk tier: ${tier}${why ? ` (${clip(why, 200).replace(/`/g, "")})` : ""}${effort ? `, reviewed at ${effort} effort` : ""}._` : "";
  const notes = [scope, how].filter(Boolean).join(" ");
  return notes ? { ...v, body: `${v.body}\n\n${notes}` } : v;
}

function judge(exitCode: number, stdout: string, sha: string, { failure, cause, attempts, lines }: Opts): Verdict {
  let review: Review | null;
  try { review = JSON.parse(stdout); } catch { review = null; }
  const at = sha ? ` on \`${sha.slice(0, 7)}\`` : "";
  const tries = Number(attempts) > 1 ? `, ${attempts} attempts` : "";
  const readable = Boolean(review) && Array.isArray(review!.findings) && review!.health?.status !== "failed";
  const counted = Number(lines) > 0 ? Number(lines) : 0;
  // No verdict passes with its own headline, never "failed"/"incomplete" (the runner re-runs a check whose comment says that:
  // modules/github/service/src/merge-gate.ts codeReviewInfra). partial: it is no baseline for the next push's delta.
  const noVerdict = (why: unknown) => {
    const size = counted > TARGET_LINES ? `The change is large (${counted.toLocaleString("en-US")} counted changed lines; lockfiles and generated files don't count): split it into stacked PRs under ~${TARGET_LINES.toLocaleString("en-US")} each to get a review. ` : "";
    return { block: false, partial: true, short: true, body: `${MARKER}\n**Code review: no verdict${at}** (not blocking: review exit ${exitCode}${tries}${why ? `: ${clip(why, 300)}` : ""}). ${NEXT[failure!] ?? FALLBACK} ${size}A re-run or the next push reviews it.` };
  };
  // A policy refusal (the PR changes codex config: a prompt-injection guard, not a review verdict) always blocks.
  // An older workflow (a PR on an older base) still reports the codex-config refusal as permanent: recognised by its cause.
  if (failure === "policy" || (failure === "permanent" && /changes codex config/i.test(String(cause ?? "")))) return { block: true, short: true, body: `${MARKER}\n**Code review: refused${at}**: ${clip(cause, 400)}` };
  // Findings a run published still decide, even when it then failed or exited non-zero; only a run with none is no verdict.
  const listed = (l: Finding[] | null | undefined) => (Array.isArray(l) ? l.filter((f) => f && typeof f.severity === "string") : []);
  const malformed = [review?.findings, review?.summaryOnlyFindings].some((l) => Array.isArray(l) && listed(l).length < l.length);
  const published = listed(review?.findings).length + listed(review?.summaryOnlyFindings).length > 0;
  const unfinished = exitCode !== 0 || !readable || malformed;
  if (unfinished && !published) {
    // The review's own cause is the specific one (a provider quota, our spend cap): the workflow's CODEGENIE_CAUSE is only a
    // fixed fallback for a run that never produced a review.
    return noVerdict(review?.cause || cause || review?.health?.diagnostics?.map((d) => d.reason).filter(Boolean).slice(0, 3).join("; "));
  }
  const all = [...listed(review!.findings), ...listed(review!.summaryOnlyFindings)];
  const blocking = all.filter((f) => BLOCKING.has(f.severity));
  const rest = all.filter((f) => !BLOCKING.has(f.severity));
  // "unresolved" is a finished review that left questions it couldn't settle: listed for a human, never blocking.
  // Owner (2026-11-12): a partial review that still ran and found nothing high/critical passes with a note. A review with no
  // coverage at all is no verdict: it passes unless a finding came out.
  const incomplete = Boolean(review!.coverage?.unavailable);
  const partial = unfinished || incomplete || Boolean(review!.coverage?.partial || review!.health?.status === "incomplete");
  const questions = review!.needsHumanAttention ?? [];
  const line = (f: Finding) => {
    const where = f.anchor?.line ? `${f.path}:${f.anchor.line}` : f.path;
    return `- **${f.severity}** \`${where}\`: ${clip(f.title, 200)}\n  ${clip(f.finalBody || f.failureMode, 800).replace(/\n+/g, "\n  ")}`;
  };
  const parts = [MARKER];
  if (unfinished) parts.push(`**Code review: no verdict${at}** (review exit ${exitCode}${tries}): it stopped before it finished; the findings it published are below and still decide.`);
  else if (partial && !incomplete) parts.push(`**Code review partly done${at}** (passes: nothing high or critical in what it covered). ${clip((review!.coverage?.reasons ?? []).join("; ") || review!.health?.status, 300)}`);
  if (incomplete) parts.push(`**Code review: no verdict${at}** (not blocking: it covered none of the change${(review!.coverage?.reasons ?? []).length ? `: ${clip(review!.coverage!.reasons!.join("; "), 300)}` : ""}). A re-run or the next push reviews it.`);
  if (blocking.length) parts.push(`**Code review: ${blocking.length} blocking finding${blocking.length === 1 ? "" : "s"}${at}.** Fix these before merging.`, blocking.map(line).join("\n"));
  if (rest.length) parts.push(`**Not blocking${blocking.length || incomplete ? "" : at}** (for a follow-up change, not this PR):`, rest.map(line).join("\n"));
  if (questions.length) parts.push("**Questions the review couldn't settle** (for a human to check; not blocking):", questions.map((q) => `- ${clip(q.question, 300)}${q.files?.length ? ` (${q.files.slice(0, 3).map((f) => `\`${f}\``).join(", ")})` : ""}`).join("\n"));
  const quiet = !all.length && !incomplete && !questions.length;
  if (quiet) parts.push(`**Code review: no findings${at}.**`);
  return { block: blocking.length > 0, partial, body: parts.join("\n\n"), quiet };
}

async function upsertComment(body: string, { quiet }: { quiet?: boolean }) {
  const { GITHUB_TOKEN: token, GITHUB_REPOSITORY: repo, PR_NUMBER: pr } = process.env;
  const api = process.env.GITHUB_API_URL || "https://api.github.com";
  const gh = async (method: string, path: string, payload?: unknown) => {
    const r = await fetch(`${api}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", ...(payload ? { "content-type": "application/json" } : {}) },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    });
    if (!r.ok) throw new Error(`GitHub ${method} ${path}: ${r.status} ${await r.text()}`);
    return r.json();
  };
  let mine: Comment | undefined;
  for (let page = 1; !mine; page++) {
    const comments: Comment[] = await gh("GET", `/repos/${repo}/issues/${pr}/comments?per_page=100&page=${page}`);
    mine = comments.find((c) => c.user?.login === BOT && c.body?.includes(MARKER));
    if (comments.length < 100) break;
  }
  if (mine) await gh("PATCH", `/repos/${repo}/issues/comments/${mine.id}`, { body });
  else if (!quiet) await gh("POST", `/repos/${repo}/issues/${pr}/comments`, { body });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [file, code] = process.argv.slice(2);
  let stdout = "";
  try { stdout = readFileSync(file!, "utf8"); } catch {}
  const v = verdict(Number(code ?? 1), stdout, process.env.HEAD_SHA, {
    failure: process.env.CODEGENIE_FAILURE, cause: process.env.CODEGENIE_CAUSE, attempts: process.env.CODEGENIE_ATTEMPTS,
    lines: process.env.REVIEW_COUNTED_LINES,
    mode: process.env.REVIEW_MODE, from: process.env.REVIEW_FROM, n: process.env.REVIEW_N,
    tier: process.env.REVIEW_TIER, why: process.env.REVIEW_WHY, effort: process.env.REVIEW_EFFORT,
  });
  console.log(v.body);
  // A partial or no-verdict pass is no baseline for the next push's delta (the workflow's Record step).
  if (v.partial && process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, "CODE_REVIEW_PARTIAL=1\n");
  // The comment is a courtesy: failing to post it never changes the verdict.
  try { await upsertComment(v.body, v); } catch (err) { console.error(`couldn't update the PR comment: ${(err as Error).message}`); }
  process.exit(v.block ? 1 : 0);
}
