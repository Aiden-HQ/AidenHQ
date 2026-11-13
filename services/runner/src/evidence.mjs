// Evidence, read by code (wave 3, item 5): one function per deliverable kind, shared by the grader (grade.mjs gather) and
// the duplicate-card guard (item 4). Facts here were checked by code and are trusted; anything an agent wrote is returned
// as data for the caller to fence. Nothing here closes a task or decides a card: it only reports what is true.
import { createHash } from "node:crypto";
import { findPrs, namedChecks } from "./merges.mjs";
import { MAX_DIFF } from "./review.mjs";
import { downscalePng, imageInfo } from "./images.mjs";

/** Marks the grader's own notes on a task, so they never count as the deliverable's evidence. */
export const GRADER_MARKER = "<!-- aidenhq:grader -->";

/** The board's reason code for a change already satisfied on the target (services/board/src/approvals.ts ALREADY_APPLIED). */
export const ALREADY_APPLIED = "already_applied";

const hash = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);

/**
 * The task's PRs as evidence: { awaiting } or { version, facts, data }. `prs` are the runner's own PRs for the task, narrowed
 * by the ref (a PR named only in the ref is never read). deps: pr(repo, n) (merges.PR_QUERY's data), diff(repo, n), ownRepo(slug).
 */
export async function prEvidence(prs, ref, deps) {
  prs = byRef(prs, ref);
  if (!prs.length) return { awaiting: "no pull request yet" };
  const facts = [];
  const versions = [];
  const prs_ = []; // each graded PR with its merge commit ("" while unmerged)
  let diff = "";
  for (const p of prs.slice(0, 5)) {
    const pr = (await deps.pr(p.repo, p.number))?.repository?.pullRequest;
    if (!pr) return { awaiting: `${p.url} can't be read yet` };
    const checks = namedChecks(pr.commits?.nodes?.[0]?.commit?.statusCheckRollup);
    if (checks.some((c) => c.pending)) return { awaiting: `checks still running on ${p.url}` };
    // Outside the agents org and the product repo the runner can't merge and the owner doesn't: someone else merges it.
    if (pr.state === "OPEN" && deps.ownRepo && !deps.ownRepo(p.repo)) return { awaiting: `${p.url} is not merged yet` };
    const merged = pr.state === "MERGED";
    const sha = merged ? (pr.mergeCommit?.oid ?? pr.headRefOid) : pr.headRefOid;
    versions.push(`${p.repo}#${p.number}@${sha}`);
    prs_.push({ repo: p.repo, number: p.number, merge: merged ? (pr.mergeCommit?.oid ?? "") : "" });
    facts.push(`${p.url}: ${pr.state.toLowerCase()}${merged ? ` into ${pr.baseRefName}` : ` (base ${pr.baseRefName})`}, head ${pr.headRefOid}${merged && pr.mergeCommit?.oid ? `, merge commit ${pr.mergeCommit.oid}` : ""}; checks: ${checks.length ? checks.map((c) => `${c.name} ${c.skipped ? "skipped" : c.ok ? "green" : "red"}`).join(", ") : "none"}`);
    diff += `### ${p.url}\n${(await deps.diff(p.repo, p.number).catch(() => "(the diff could not be read)")).slice(0, MAX_DIFF)}\n`;
  }
  // The board keeps a version in 200 characters: several PRs are bound by their hash.
  const version = versions.join(" ").length <= 200 ? versions.join(" ") : `prs:${hash(versions.join(" "))}`;
  return { version, facts, prs: prs_, data: { DIFF: diff.slice(0, MAX_DIFF) } };
}

/** A deployed app (apps-mcp status row, or null) as evidence: its commit, state, health and incident. */
export function appEvidence(app, name) {
  if (!app) return { awaiting: `no app named ${name || "(none)"} is deployed yet` };
  if (!app.sha) return { awaiting: `${app.name} is not deployed yet` };
  const facts = [`app ${app.name}: deployed commit ${app.sha}${app.deployed_at ? ` at ${app.deployed_at}` : ""}; state ${app.state}; ${app.healthy ? "healthy" : "not healthy"}; ${app.incident ? `open incident (${app.incident.kind})` : "no open incident"}`];
  return { version: `${app.name}@${app.sha}`, facts, data: {} };
}

/** The task's latest fleet apply (its approval records) as evidence: its state and outcome. */
export function applyEvidence(cards) {
  const applied = cards.filter((a) => a.action === "apply").at(-1);
  if (!applied) return { awaiting: "no apply filed yet" };
  const facts = [`apply ${applied.id}: ${applied.state}${applied.outcome ? `, ${applied.outcome}` : ""}`];
  return { version: applied.id, facts, data: { APPLY_OUTCOME: applied.outcomeText ?? "", APPLY_CHANGE: applied.details ?? "" } };
}

/**
 * The task's own words (the latest comments other than the grader's) and its files: the evidence for file and report, context
 * for the rest. File names and types are the agents' own strings: the trusted facts call each file by a code-made label
 * (file_1, file_2, ... in the attachments' order) and its name and type go in the fenced FILE_NAMES block, as data.
 */
export async function wordsEvidence(deps) {
  const comments = (await deps.comments()).filter((c) => !String(c.body ?? "").includes(GRADER_MARKER)).slice(-4);
  const files = (await deps.attachments().catch(() => [])).map((f, i) => ({ ...f, label: `file_${i + 1}` }));
  const facts = files.length ? [`${files.length} file${files.length > 1 ? "s" : ""} attached: ${files.map((f) => f.label).join(", ")} (their names and types, as the agent gave them, are in FILE_NAMES)`] : ["no files attached"];
  const version = comments.length || files.length ? hash([...comments.map((c) => c.id), ...files.map((f) => f.id)].join(" ")) : "";
  const names = files.map((f) => `${f.label}: ${String(f.originalFilename ?? f.name ?? "").slice(0, 200)} (${String(f.contentType ?? "").slice(0, 100)})`).join("\n");
  return { version, facts, files, data: { TASK_COMMENTS: comments.map((c) => String(c.body ?? "")).join("\n\n---\n\n"), ...(files.length ? { FILE_NAMES: names } : {}) } };
}

/** A content type as code may state it among the trusted facts: a plain type/subtype, or "unknown type". */
const safeType = (t) => (/^[\w.+-]+\/[\w.+-]+$/.test(String(t ?? "")) ? String(t) : "unknown type");

export const MAX_IMAGES = 6;
const IMAGE_SIDE = 2048; // a PNG with a longer side is downscaled (the vision models scale to about this anyway)
const IMAGE_BYTES = 3 * 1024 * 1024; // one image as sent; a bigger one is downscaled if a PNG, else left out
const IMAGES_BYTES = 12 * 1024 * 1024; // all images as sent (base64 adds a third; the gateway takes 32 MB)
const TEXT_FILE = 6_000; // one text file's characters
export const TEXT_TOTAL = 16_000; // all text files' characters (the prompt fences a block at 20,000)
const TEXT_EXT = /\.(txt|md|markdown|json|csv|tsv|ya?ml|log|html?|tsx|ts|jsx|js|css)$/i;

/** A PNG made to fit: downscaled until its longest side is at most IMAGE_SIDE and its bytes IMAGE_BYTES, or null. */
function fitPng(buf, info) {
  for (let side = Math.min(IMAGE_SIDE, Math.max(info.width, info.height)); side >= 256; side = Math.floor(side * 0.7)) {
    const small = downscalePng(buf, side);
    if (!small) return null;
    if (small.length <= IMAGE_BYTES) return small;
  }
  return null;
}

/**
 * The task's attached files' contents, for the grader (`files` as wordsEvidence labels them): images (sniffed from the
 * bytes, at most 6, a large PNG downscaled) as image parts, text files (.txt, .md, .json, .csv, ...) as one fenced FILES
 * block, each cut and all within a budget. Order: files the rubric names by file name, then files the task's recent
 * comments name, then the newest. { awaiting } when a file can't be read yet (missing evidence is never a pass), else
 * { facts, data, images }: the facts say per file label (never its name, the agent's string) what was sent (its size, its
 * pixel size, what was cut or left out), so a file left out reads as not sent, not as missing work. `content(id)` resolves
 * with the file's bytes.
 */
export async function fileEvidence(files, content, { rubric = "", comments = "" } = {}) {
  const facts = [];
  const images = [];
  const texts = [];
  let imageBytes = 0;
  let textLeft = TEXT_TOTAL;
  const nameOf = (f) => String(f.originalFilename ?? f.name ?? "");
  const names = (f, text) => {
    const base = nameOf(f).split("/").pop().toLowerCase();
    return base.length >= 3 && text.toLowerCase().includes(base);
  };
  const rank = (f) => (names(f, rubric) ? 2 : names(f, comments) ? 1 : 0);
  const order = [...files].sort((a, b) => rank(b) - rank(a) || String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
  for (const f of order) {
    const name = nameOf(f);
    const isImage = /^image\//.test(f.contentType ?? "") || /\.(png|jpe?g|gif|webp)$/i.test(name);
    const isText = !isImage && (TEXT_EXT.test(name) || /^text\/|^application\/json/.test(f.contentType ?? ""));
    if (!isImage && !isText) {
      facts.push(`${f.label}: not sent to the grader (${safeType(f.contentType)})`);
      continue;
    }
    if (isImage && images.length >= MAX_IMAGES) {
      facts.push(`${f.label}: attached, not sent to the grader (only ${MAX_IMAGES} images are sent: those the rubric names, then those the comments name, then the newest)`);
      continue;
    }
    if (isText && textLeft <= 0) {
      facts.push(`${f.label}: not sent to the grader (the text budget of ${TEXT_TOTAL} characters was spent on other files)`);
      continue;
    }
    let buf;
    try {
      buf = await content(f.id);
    } catch (err) {
      return { awaiting: `the attached ${f.label} could not be read yet (${String(err.message ?? err).replace(/[^\w .:/()-]/g, "").slice(0, 160)})` };
    }
    if (isImage) {
      const info = imageInfo(buf);
      if (!info) {
        facts.push(`${f.label}: not sent to the grader (not a PNG, JPEG, GIF or WebP image)`);
        continue;
      }
      const real = `${info.width}x${info.height}`;
      let sent = buf;
      if (info.type === "image/png" && (Math.max(info.width, info.height) > IMAGE_SIDE || buf.length > IMAGE_BYTES)) sent = fitPng(buf, info) ?? buf;
      if (sent.length > IMAGE_BYTES || imageBytes + sent.length > IMAGES_BYTES) {
        facts.push(`${f.label}: image ${real} px, attached, not sent to the grader (${Math.round(sent.length / 1024)} KB is over the image budget)`);
        continue;
      }
      const s = sent === buf ? info : imageInfo(sent);
      imageBytes += sent.length;
      images.push({ url: `data:${info.type};base64,${sent.toString("base64")}`, label: f.label });
      facts.push(`${f.label}: image ${real} px (its real size), shown as IMAGE_${images.length}${sent !== buf ? ` downscaled to ${s.width}x${s.height} px` : ""}`);
      continue;
    }
    const text = buf.toString("utf8");
    const shown = text.slice(0, Math.min(TEXT_FILE, textLeft));
    textLeft -= shown.length;
    texts.push(`=== ${f.label}: ${name.slice(0, 200)} ===\n${shown}`);
    facts.push(`${f.label}: text, ${text.length} characters, in FILES${shown.length < text.length ? ` (cut to its first ${shown.length})` : ""}`);
  }
  return { facts, images, data: texts.length ? { FILES: texts.join("\n\n") } : {} };
}

/** Whether a rubric is about attached files (a screenshot, an image, an attachment): their contents are evidence then. */
export const rubricNamesFiles = (rubric) => rubric.some((c) => /\b(attach\w*|screenshots?|images?|png|jpe?g|mockups?|files?)\b/i.test(String(c)));

/**
 * Whether one branch commit is already satisfied on the target's current default branch (the duplicate-card guard): its
 * commit is an ancestor of `origin/<base>`, or every file it changes against their merge base is identical there. Reads only
 * the caller's own fetch. { satisfied, evidence }; any git error is "not satisfied", so a card is filed (the safe direction).
 * `git(path, ...args)` resolves with trimmed stdout and rejects on a non-zero exit.
 */
export async function onMain(git, path, base, sha) {
  const main = `refs/remotes/origin/${base}`;
  try {
    const tip = await git(path, "rev-parse", "--verify", `${main}^{commit}`);
    if (await git(path, "merge-base", "--is-ancestor", sha, main).then(() => true, () => false)) return { satisfied: true, evidence: `commit \`${sha.slice(0, 12)}\` is already on \`${base}\` (at \`${tip.slice(0, 12)}\`)` };
    const mb = await git(path, "merge-base", main, sha);
    // NUL-separated (unusual names are not C-quoted), each a literal pathspec (no globbing on names like app/[id]).
    const files = (await git(path, "diff", "-z", "--no-renames", "--name-only", mb, sha)).split("\0").filter(Boolean);
    // No files: nothing to compare (an empty pathspec would diff the whole tree).
    if (!files.length) return { satisfied: false };
    const same = await git(path, "diff", "--quiet", "--no-renames", main, sha, "--", ...files.map((f) => `:(literal)${f}`)).then(() => true, () => false);
    return same ? { satisfied: true, evidence: `every file \`${sha.slice(0, 12)}\` changes (${files.length}: ${files.slice(0, 5).join(", ")}${files.length > 5 ? ", …" : ""}) is already identical on \`${base}\` (at \`${tip.slice(0, 12)}\`)` } : { satisfied: false };
  } catch {
    return { satisfied: false };
  }
}

/**
 * The guard for one branch row of `aidenhq push`/`pr` (main.mjs branchRows: `unpublished` commits and the diffstat against its
 * base, read before the guard's fetch): a branch with no commits of its own has nothing to be satisfied, so it is never
 * "already applied" (its tip is trivially an ancestor of main); otherwise onMain.
 */
export async function guardBranch(git, row, sha) {
  if (!row.unpublished?.length && !row.stat) return { satisfied: false };
  return onMain(git, row.path, row.defaultBase, sha);
}

/** The task's PRs the ref narrows to: a PR ref (link or owner/name#n) by repo and number, a repo ref by repo, else all. */
function byRef(prs, ref) {
  const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
  const named = findPrs(ref);
  if (named.length) return prs.filter((p) => named.some((n) => same(n.repo, p.repo) && n.number === p.number));
  const repo = /^(?:https:\/\/github\.com\/)?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(String(ref ?? "").trim())?.[1];
  return repo ? prs.filter((p) => same(p.repo, repo)) : prs;
}
