#!/usr/bin/env node
// The `code-review` check's verdict: reads codegenie's JSON review (`codegenie review --format json`) and fails the check
// when any finding is critical or high, or the review didn't complete (failed, partial, unreadable): missing evidence
// never passes, except on a diff past the review target whose budget ran out, which passes with the unread part named.
// Keeps one PR comment with every finding, updated in place on each push. No dependencies; Node 22+.
//   node codegenie-gate.mjs <review.json> <codegenie exit code>
// Env: GITHUB_TOKEN (pull-requests: write), GITHUB_REPOSITORY, PR_NUMBER, HEAD_SHA, REVIEW_COUNTED_LINES (the workflow's
// counted changed lines: added plus deleted, package-lock.json excluded), GITHUB_API_URL (optional).
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const MARKER = "<!-- ci:code-review -->";
const BOT = "github-actions[bot]"; // the author of comments posted with the workflow's GITHUB_TOKEN
const BLOCKING = new Set(["critical", "high"]);
// Everything posted goes through clip: the comment is public to the repo and GitHub masks secrets only in job logs, so
// anything secret-shaped (API keys, bearer tokens, key=/token= values) is masked first.
const mask = (s) => s.replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{6,}/g, "$1-***").replace(/\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{6,}/gi, "$1 ***")
  .replace(/\b(key|token|secret|password|api_key|apikey|access_token|auth)=[^\s&"']+/gi, "$1=***").replace(/\bgh[pousr]_[A-Za-z0-9]{10,}/g, "gh*_***");
const clip = (s, n) => { const t = mask(String(s ?? "").trim()); return t.length > n ? `${t.slice(0, n)}…` : t; };

// The gate's review target in counted changed lines. A diff past it cannot be reviewed at any budget, so a budget stop
// there is a decision (what it read passes or blocks, the rest is named) rather than a failed check.
const TARGET_LINES = 2000;
const SPLIT = `Split it into stacked PRs of at most ${TARGET_LINES.toLocaleString("en-US")} counted changed lines each (package-lock.json doesn't count) and push those.`;
// What to do when no review came out, by the workflow's CODEGENIE_FAILURE (it retries budget and transient once, time
// permitting: a retry shows as "2 attempts"; too-large ends at once). The split is in counted lines: package-lock.json
// is out of the count (#135), so a diff whose lockfile alone is past the target is still splittable.
const NEXT = {
  budget: `It ran out of its review budget: the PR is too big to review in one go. ${SPLIT}`,
  transient: "The model provider failed or timed out. Re-run the check; if it fails the same way again, read the job log.",
  "too-large": `Diff too large for one review: ${SPLIT.charAt(0).toLowerCase()}${SPLIT.slice(1)}`,
};
const FALLBACK = "See the job log, fix the cause and re-run the check.";

/**
 * { block, body, quiet, short } from codegenie's exit code and its stdout. quiet: nothing worth a new comment. short: a
 * diff past the target whose review stopped, so the body names the unread part instead of claiming a whole review. The workflow's
 * reading of a run with no verdict: failure (budget, transient, permanent), cause (the specific reason it found in
 * codegenie's output, stderr or telemetry), attempts (how many runs it made), lines (the PR's counted changed lines).
 * What it reviewed (codegenie-prior.mjs): mode (full, delta: only the changes since `from`, the n-th delta since a full
 * review; reuse: `from`'s verdict stands).
 */
export function verdict(exitCode, stdout, sha = "", opts = {}) {
  const { mode, from, n, depth, critical } = opts;
  const at = sha ? ` on \`${sha.slice(0, 7)}\`` : "";
  const old = `\`${String(from).slice(0, 7)}\``;
  if (mode === "reuse") return { block: false, quiet: true, body: `${MARKER}\n**Code review reused${at}** from ${old}: the PR's patch is the same as at that green review (a rebase), so it isn't reviewed again.` };
  const v = judge(exitCode, stdout, sha, opts);
  const scope = v.short ? "" : mode === "delta" ? `_Reviewed only the changes since ${old}, this PR's last green review (delta ${n} of at most 3 before a full review). codegenie saw that diff alone, not the rest of the PR's._`
    : mode === "full" ? "_Reviewed the whole PR._" : "";
  // The depth the workflow picked: quick (quick-review.mjs) or light by default, normal on a critical path (the first one it
  // matched), deep on request.
  const how = depth === "normal" && critical ? `_Depth normal: touches \`${clip(critical, 200).replace(/`/g, "")}\`._`
    : depth === "quick" ? "_Quick review (one model call): it touches no critical path._" : depth ? `_Depth ${depth}._` : "";
  const notes = [scope, how].filter(Boolean).join(" ");
  return notes ? { ...v, body: `${v.body}\n\n${notes}` } : v;
}

function judge(exitCode, stdout, sha, { failure, cause, attempts, lines }) {
  let review;
  try { review = JSON.parse(stdout); } catch { review = null; }
  const at = sha ? ` on \`${sha.slice(0, 7)}\`` : "";
  const next = NEXT[failure] ?? FALLBACK;
  const tries = Number(attempts) > 1 ? `, ${attempts} attempts` : "";
  const counted = Number(lines) > 0 ? Number(lines) : 0;
  const readable = Boolean(review) && Array.isArray(review.findings) && review.health?.status !== "failed";
  const noVerdict = exitCode !== 0 || !readable;
  // A budget stop on a diff past the target never gets a verdict, however it is retried: decide on the part it read, and
  // name the part it didn't. Findings are read first (below), so a critical or high one still blocks.
  const oversized = counted > TARGET_LINES && (failure === "budget" || failure === "too-large") && (noVerdict || Boolean(review?.coverage?.unavailable));
  // Its own headline: the runner re-runs a check whose comment says the review failed or was incomplete
  // (services/runner/src/merges.mjs codeReviewInfra), and this one is final for the diff.
  if (failure === "too-large" && !oversized) return { block: true, body: `${MARKER}\n**Diff too large for one review${at}** (codegenie exit ${exitCode}${tries}${cause ? `: ${clip(cause, 300)}` : ""}). ${next}` };
  if (noVerdict && !oversized) {
    const why = cause || review?.health?.diagnostics?.map((d) => d.reason).filter(Boolean).slice(0, 3).join("; ");
    return { block: true, body: `${MARKER}\n**Code review failed${at}** (codegenie exit ${exitCode}${tries}${why ? `: ${clip(why, 300)}` : ""}). ${next}` };
  }
  // Whatever findings came out are read before the oversized decision: a critical or high one blocks even when the
  // review stopped early.
  const all = Array.isArray(review?.findings) ? [...review.findings, ...(review.summaryOnlyFindings ?? [])] : [];
  const blocking = all.filter((f) => BLOCKING.has(f.severity));
  const rest = all.filter((f) => !BLOCKING.has(f.severity));
  // "unresolved" is a finished review that left questions it couldn't settle: listed for a human, never blocking.
  // Owner (2026-11-12): a partial review that still ran and found nothing high/critical passes with a note; only a review
  // with no coverage at all blocks.
  const incomplete = Boolean(review?.coverage?.unavailable) && !oversized;
  const partial = !incomplete && !oversized && Boolean(review?.coverage?.partial || review?.health?.status === "incomplete");
  const questions = review?.needsHumanAttention ?? [];
  const line = (f) => {
    const where = f.anchor?.line ? `${f.path}:${f.anchor.line}` : f.path;
    return `- **${f.severity}** \`${where}\`: ${clip(f.title, 200)}\n  ${clip(f.finalBody || f.failureMode, 800).replace(/\n+/g, "\n  ")}`;
  };
  const parts = [MARKER];
  if (oversized) {
    const reason = failure === "too-large" ? "too large for one review" : "review budget exhausted";
    const why = [reason, cause ? clip(cause, 200) : (review?.coverage?.reasons ?? []).filter(Boolean).join("; "), `codegenie exit ${exitCode}${tries}`].filter(Boolean).join(", ");
    const read = blocking.length
      ? `It reported the blocking findings below but did not read the rest of the diff. ${SPLIT}`
      : all.length
        ? `Nothing high or critical in the part it read, so this check passes; it did not read the rest of the diff. ${SPLIT}`
        : `No review came out, so nothing of it was read and no finding could block; the check passes. ${SPLIT}`;
    parts.push(`**Code review stopped short${at}** (${counted.toLocaleString("en-US")} counted changed lines: ${why}). ${read}`);
  }
  if (partial) parts.push(`**Code review partly done${at}** (passes: nothing high or critical in what it covered). ${clip((review.coverage?.reasons ?? []).join("; ") || review.health?.status, 300)}`);
  if (incomplete) parts.push(`**Code review incomplete${at}${NEXT[failure] ? "" : ": re-run the check"}.** ${clip((review.coverage?.reasons ?? []).join("; ") || review.health?.status, 300)}${NEXT[failure] ? ` ${NEXT[failure]}` : ""}`);
  if (blocking.length) parts.push(`**Code review: ${blocking.length} blocking finding${blocking.length === 1 ? "" : "s"}${at}.** Fix these before merging.`, blocking.map(line).join("\n"));
  if (rest.length) parts.push(`**Not blocking${blocking.length || incomplete ? "" : at}** (for a follow-up change, not this PR):`, rest.map(line).join("\n"));
  if (questions.length) parts.push("**Questions the review couldn't settle** (for a human to check; not blocking):", questions.map((q) => `- ${clip(q.question, 300)}${q.files?.length ? ` (${q.files.slice(0, 3).map((f) => `\`${f}\``).join(", ")})` : ""}`).join("\n"));
  if (!all.length && !incomplete && !questions.length && !oversized) parts.push(`**Code review: no findings${at}.**`);
  const quiet = !all.length && !incomplete && !questions.length && !oversized;
  return { block: blocking.length > 0 || incomplete, partial: Boolean(partial), short: oversized, body: parts.join("\n\n"), quiet };
}

async function upsertComment(body, { quiet }) {
  const { GITHUB_TOKEN: token, GITHUB_REPOSITORY: repo, PR_NUMBER: pr } = process.env;
  const api = process.env.GITHUB_API_URL || "https://api.github.com";
  const gh = async (method, path, payload) => {
    const r = await fetch(`${api}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", ...(payload ? { "content-type": "application/json" } : {}) },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    });
    if (!r.ok) throw new Error(`GitHub ${method} ${path}: ${r.status} ${await r.text()}`);
    return r.json();
  };
  let mine;
  for (let page = 1; !mine; page++) {
    const comments = await gh("GET", `/repos/${repo}/issues/${pr}/comments?per_page=100&page=${page}`);
    mine = comments.find((c) => c.user?.login === BOT && c.body?.includes(MARKER));
    if (comments.length < 100) break;
  }
  if (mine) await gh("PATCH", `/repos/${repo}/issues/comments/${mine.id}`, { body });
  else if (!quiet) await gh("POST", `/repos/${repo}/issues/${pr}/comments`, { body });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [file, code] = process.argv.slice(2);
  let stdout = "";
  try { stdout = readFileSync(file, "utf8"); } catch {}
  const v = verdict(Number(code ?? 1), stdout, process.env.HEAD_SHA, {
    failure: process.env.CODEGENIE_FAILURE, cause: process.env.CODEGENIE_CAUSE, attempts: process.env.CODEGENIE_ATTEMPTS,
    lines: process.env.REVIEW_COUNTED_LINES,
    mode: process.env.REVIEW_MODE, from: process.env.REVIEW_FROM, n: process.env.REVIEW_N,
    depth: process.env.REVIEW_DEPTH, critical: process.env.REVIEW_CRITICAL,
  });
  console.log(v.body);
  // A partial pass is no baseline for the next push's delta (the workflow's Record step).
  if (v.partial && process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, "CODE_REVIEW_PARTIAL=1\n");
  // The comment is a courtesy: failing to post it never changes the verdict.
  try { await upsertComment(v.body, v); } catch (err) { console.error(`couldn't update the PR comment: ${err.message}`); }
  process.exit(v.block ? 1 : 0);
}
