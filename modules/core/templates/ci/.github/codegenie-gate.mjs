#!/usr/bin/env node
// The `code-review` check's verdict: reads codegenie's JSON review (`codegenie review --format json`) and fails the check
// when any finding is critical or high, or the review didn't complete (failed, partial, unreadable): missing evidence
// never passes. Keeps one PR comment with every finding, updated in place on each push. No dependencies; Node 22+.
//   node codegenie-gate.mjs <review.json> <codegenie exit code>
// Env: GITHUB_TOKEN (pull-requests: write), GITHUB_REPOSITORY, PR_NUMBER, HEAD_SHA, GITHUB_API_URL (optional).
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const MARKER = "<!-- ci:code-review -->";
const BOT = "github-actions[bot]"; // the author of comments posted with the workflow's GITHUB_TOKEN
const BLOCKING = new Set(["critical", "high"]);
const clip = (s, n) => { const t = String(s ?? "").trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };

/** { block, body, quiet } from codegenie's exit code and its stdout. quiet: nothing worth a new comment. */
export function verdict(exitCode, stdout, sha = "") {
  let review;
  try { review = JSON.parse(stdout); } catch { review = null; }
  const at = sha ? ` on \`${sha.slice(0, 7)}\`` : "";
  if (exitCode !== 0 || !review || !Array.isArray(review.findings) || review.health?.status === "failed") {
    const why = review?.health?.diagnostics?.map((d) => d.reason).filter(Boolean).slice(0, 3).join("; ");
    return { block: true, body: `${MARKER}\n**Code review failed${at}** (codegenie exit ${exitCode}${why ? `: ${clip(why, 300)}` : ""}). See the job log, fix the cause and re-run the check.` };
  }
  const all = [...review.findings, ...(review.summaryOnlyFindings ?? [])];
  const blocking = all.filter((f) => BLOCKING.has(f.severity));
  const rest = all.filter((f) => !BLOCKING.has(f.severity));
  // "unresolved" is a finished review that left questions it couldn't settle: listed for a human, never blocking.
  // Owner (2026-11-12): a partial review that still ran and found nothing high/critical passes with a note; only a review
  // with no coverage at all blocks.
  const incomplete = Boolean(review.coverage?.unavailable);
  const partial = !incomplete && (review.coverage?.partial || review.health?.status === "incomplete");
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
  if (!all.length && !incomplete && !questions.length) parts.push(`**Code review: no findings${at}.**`);
  return { block: blocking.length > 0 || incomplete, body: parts.join("\n\n"), quiet: !all.length && !incomplete && !questions.length };
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
  const v = verdict(Number(code ?? 1), stdout, process.env.HEAD_SHA);
  console.log(v.body);
  // The comment is a courtesy: failing to post it never changes the verdict.
  try { await upsertComment(v.body, v); } catch (err) { console.error(`couldn't update the PR comment: ${err.message}`); }
  process.exit(v.block ? 1 : 0);
}
