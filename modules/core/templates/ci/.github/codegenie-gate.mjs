#!/usr/bin/env node
// The `code-review` check's verdict: reads the review's JSON (code-review.mjs: codex's review, its P0 and P1 as critical
// and high; codegenie's `--format json` from repos on the older template has the same shape) and fails the check when any
// finding is critical or high, or the review didn't complete (failed, no coverage, unreadable): missing evidence never
// passes.
// Keeps one PR comment with every finding, updated in place on each push. No dependencies; Node 22+.
//   node codegenie-gate.mjs <review.json> <reviewer exit code>
// Env: GITHUB_TOKEN (pull-requests: write), GITHUB_REPOSITORY, PR_NUMBER, HEAD_SHA, REVIEW_COUNTED_LINES (the workflow's
// counted changed lines: added plus deleted, package-lock.json excluded), GITHUB_API_URL (optional).
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const MARKER = "<!-- ci:code-review -->";
const BOT = "github-actions[bot]"; // the author of comments posted with the workflow's GITHUB_TOKEN
const BLOCKING = new Set(["critical", "high"]);
// Everything posted goes through clip: the comment is public to the repo and GitHub masks secrets only in job logs, so
// anything secret-shaped (API keys, bearer tokens, key=/token= values) is masked first.
const mask = (s) => s.replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{6,}/g, "$1-***").replace(/\b(ahq[a-z]{1,3})_[A-Za-z0-9._-]{6,}/g, "$1_***").replace(/\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{6,}/gi, "$1 ***")
  .replace(/\b(key|token|secret|password|api_key|apikey|access_token|auth)=[^\s&"']+/gi, "$1=***").replace(/\bgh[pousr]_[A-Za-z0-9]{10,}/g, "gh*_***");
const clip = (s, n) => { const t = mask(String(s ?? "").trim()); return t.length > n ? `${t.slice(0, n)}…` : t; };

// What to do when no review came out, by the workflow's CODEGENIE_FAILURE (it retries a transient failure once, time
// permitting: a retry shows as "2 attempts").
const NEXT = {
  transient: "The model provider failed or timed out. Re-run the check; if it fails the same way again, read the job log.",
  unparsable: "The reviewer answered, but not with a review. Something in the change may have steered it: read the job log.",
};
// The review target in counted changed lines (package-lock.json doesn't count). Past it a review that never came out
// because the provider failed or timed out (transient) is a decision, not a failed check (owner, #144): nothing was read,
// so nothing could block; the comment says to split. Only on a PR with no critical path: one that touches one fails closed,
// and so does an answer that isn't a review (unparsable: the PR's content can cause it) at any size. On the 2026-11-16
// eval a 1,936-line PR took 17 minutes and a 5,230-line one ended without a verdict after 25.
const TARGET_LINES = 2000;
const FALLBACK = "See the job log, fix the cause and re-run the check.";

/**
 * { block, body, quiet } from the reviewer's exit code and its stdout. quiet: nothing worth a new comment. The workflow's
 * reading of a run with no verdict: failure (transient, permanent), cause (a fixed class), attempts (how many runs it made).
 * What it reviewed (codegenie-prior.mjs): mode (full, delta: only the changes since `from`, the n-th delta since a full
 * review; reuse: `from`'s verdict stands).
 */
export function verdict(exitCode, stdout, sha = "", opts = {}) {
  const { mode, from, n, depth, critical } = opts;
  const at = sha ? ` on \`${sha.slice(0, 7)}\`` : "";
  const old = `\`${String(from).slice(0, 7)}\``;
  if (mode === "reuse") return { block: false, quiet: true, body: `${MARKER}\n**Code review reused${at}** from ${old}: the PR's patch is the same as at that green review (a rebase), so it isn't reviewed again.` };
  const v = judge(exitCode, stdout, sha, opts);
  const scope = v.short ? "" : mode === "delta" ? `_Reviewed only the changes since ${old}, this PR's last green review (delta ${n} of at most 3 before a full review)._`
    : mode === "full" ? "_Reviewed the whole PR._" : "";
  // The depth the workflow picked: light by default, normal on a critical path (the first one it matched), deep on request
  // (the higher effort). quick: the older template's one-call reviewer.
  const how = depth === "normal" && critical ? `_Touches a critical path: \`${clip(critical, 200).replace(/`/g, "")}\`._`
    : depth === "deep" ? "_Reviewed at the higher effort (deep-review)._" : depth === "quick" ? "_Quick review (one model call): it touches no critical path._" : "";
  const notes = [scope, how].filter(Boolean).join(" ");
  return notes ? { ...v, body: `${v.body}\n\n${notes}` } : v;
}

function judge(exitCode, stdout, sha, { failure, cause, attempts, lines, critical }) {
  let review;
  try { review = JSON.parse(stdout); } catch { review = null; }
  const at = sha ? ` on \`${sha.slice(0, 7)}\`` : "";
  const next = NEXT[failure] ?? FALLBACK;
  const tries = Number(attempts) > 1 ? `, ${attempts} attempts` : "";
  const readable = Boolean(review) && Array.isArray(review.findings) && review.health?.status !== "failed";
  // Its own headline: the runner re-runs a check whose comment says the review failed or was incomplete
  // (services/runner/src/merges.mjs codeReviewInfra).
  const counted = Number(lines) > 0 ? Number(lines) : 0;
  if (exitCode === 1 && failure === "transient" && !critical && counted > TARGET_LINES) {
    // Its own headline (never "failed"/"incomplete": the runner would re-run it) and no baseline for a delta.
    return { block: false, short: true, body: `${MARKER}\n**Code review stopped short${at}** (${counted.toLocaleString("en-US")} counted changed lines: no review came out, review exit ${exitCode}${tries}). Nothing of it was read, so no finding could block and the check passes. Split it into stacked PRs of at most ${TARGET_LINES.toLocaleString("en-US")} counted changed lines each (package-lock.json doesn't count) and push those.` };
  }
  if (exitCode !== 0 || !readable) {
    const why = cause || review?.health?.diagnostics?.map((d) => d.reason).filter(Boolean).slice(0, 3).join("; ");
    return { block: true, body: `${MARKER}\n**Code review failed${at}** (review exit ${exitCode}${tries}${why ? `: ${clip(why, 300)}` : ""}). ${next}` };
  }
  const all = [...review.findings, ...(review.summaryOnlyFindings ?? [])];
  const blocking = all.filter((f) => BLOCKING.has(f.severity));
  const rest = all.filter((f) => !BLOCKING.has(f.severity));
  // "unresolved" is a finished review that left questions it couldn't settle: listed for a human, never blocking.
  // Owner (2026-11-12): a partial review that still ran and found nothing high/critical passes with a note; only a review
  // with no coverage at all blocks.
  const incomplete = Boolean(review.coverage?.unavailable);
  const partial = !incomplete && Boolean(review.coverage?.partial || review.health?.status === "incomplete");
  const questions = review.needsHumanAttention ?? [];
  const line = (f) => {
    const where = f.anchor?.line ? `${f.path}:${f.anchor.line}` : f.path;
    return `- **${f.severity}** \`${where}\`: ${clip(f.title, 200)}\n  ${clip(f.finalBody || f.failureMode, 800).replace(/\n+/g, "\n  ")}`;
  };
  const parts = [MARKER];
  if (partial) parts.push(`**Code review partly done${at}** (passes: nothing high or critical in what it covered). ${clip((review.coverage?.reasons ?? []).join("; ") || review.health?.status, 300)}`);
  if (incomplete) parts.push(`**Code review incomplete${at}: re-run the check.** ${clip((review.coverage?.reasons ?? []).join("; ") || review.health?.status, 300)}`);
  if (blocking.length) parts.push(`**Code review: ${blocking.length} blocking finding${blocking.length === 1 ? "" : "s"}${at}.** Fix these before merging.`, blocking.map(line).join("\n"));
  if (rest.length) parts.push(`**Not blocking${blocking.length || incomplete ? "" : at}** (for a follow-up change, not this PR):`, rest.map(line).join("\n"));
  if (questions.length) parts.push("**Questions the review couldn't settle** (for a human to check; not blocking):", questions.map((q) => `- ${clip(q.question, 300)}${q.files?.length ? ` (${q.files.slice(0, 3).map((f) => `\`${f}\``).join(", ")})` : ""}`).join("\n"));
  const quiet = !all.length && !incomplete && !questions.length;
  if (quiet) parts.push(`**Code review: no findings${at}.**`);
  return { block: blocking.length > 0 || incomplete, partial, body: parts.join("\n\n"), quiet };
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
