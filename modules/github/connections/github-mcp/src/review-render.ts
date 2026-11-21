// Code review's findings as GitHub text (docs/design/code-review.md "Posting"): pure functions, no I/O. The reviewer's output
// (a Review, whose text came from a model that read untrusted pull request text) is data: every string of it goes through
// `plain` or a fence, and only this code writes the markers (the severity line, the finding ids, the run id) other code reads
// back. The card the AI reviewer reads is exactly this rendering, so what it approves is what is posted.
import { z } from "zod";
import { SECRETS } from "./scrub.js";

const SHA = /^[0-9a-f]{40}$/;
const NAME = "[A-Za-z0-9_.-]{1,100}";
const oneLine = z.string().max(500).regex(/^[^\r\n]*$/);
/** Which reviewer a run was: its engine, model and effort (code-review's combo). */
const ENGINE = z.enum(["codex", "claude-code", "codegenie"]);
const MODEL = z.string().regex(/^~?[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.:~-]{1,100}$/);
const EFFORT = z.enum(["minimal", "low", "medium", "high", "xhigh", "max"]);
/** A combo as the posts name it: `codex · ~deepseek/deepseek-flash-latest · medium effort`. */
export const comboText = (c: { engine: string; model: string; effort: string }) => `${c.engine} · ${c.model} · ${c.effort} effort`;

export const FindingSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{6,64}$/),
  severity: z.enum(["important", "nit", "pre_existing"]),
  path: oneLine.min(1),
  line: z.number().int().min(1).max(10_000_000),
  end_line: z.number().int().min(1).max(10_000_000).optional(),
  title: z.string().min(1).max(200),
  why: z.string().max(3000),
  evidence: z.string().max(4000),
  fix_brief: z.string().max(2000),
});
export const ReviewSchema = z.object({
  version: z.literal(1),
  repo: z.string().regex(new RegExp(`^${NAME}/${NAME}$`)),
  pr: z.number().int().min(1),
  base: z.string().regex(SHA),
  head: z.string().regex(SHA),
  engine: ENGINE, model: MODEL, effort: EFFORT,
  incremental_from: z.string().regex(SHA).nullable(),
  full: z.boolean(),
  coverage: z.object({ reviewed: z.array(oneLine).max(5000), excluded: z.array(oneLine).max(5000), incomplete: z.string().max(500).nullable() }),
  findings: z.array(FindingSchema).max(200),
  withheld: z.object({ important: z.number().int().min(0), nit: z.number().int().min(0), pre_existing: z.number().int().min(0) }),
  cost_usd: z.number().min(0).max(100_000),
  stale_guidance: z.array(z.string().max(300)).max(10),
});
export type Review = z.infer<typeof ReviewSchema>;
export type Finding = z.infer<typeof FindingSchema>;

const RUN = z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/);
export const PostArgsSchema = z.object({
  /** The target, from the caller's run row, never from the review's own text: a review naming another repo, PR or head is refused. */
  repo: z.string().regex(new RegExp(`^${NAME}/${NAME}$`)),
  pr: z.number().int().min(1),
  head: z.string().regex(SHA),
  review: ReviewSchema,
  /** Finding ids of an earlier run the state service wants resolved (its own threads only: review-post.ts checks). */
  resolve: z.array(z.string().regex(/^[A-Za-z0-9_-]{6,64}$/)).max(200).default([]),
  /** The run: the idempotency key, and the id the summary carries. */
  run: RUN,
});
export type PostArgs = z.infer<typeof PostArgsSchema>;

/** Why a review didn't run: a fixed vocabulary, so a notice carries no text a model or an author wrote. */
export const SKIP_REASONS = {
  draft: "this is a draft pull request",
  fork: "this pull request comes from a fork; a maintainer asks for a review with `@aiden review`",
  budget_repo: "this repository's monthly review budget is used up",
  budget_instance: "the monthly review budget for all repositories is used up",
  superseded: "a newer commit arrived",
  stopped: "reviews are stopped on this pull request (`@aiden review always` starts them again)",
  unchanged: "nothing changed since the last review",
  ignored: "every changed file is ignored by this repository's review settings",
  no_access: "the pull request can't be read",
  daily_limit: "the daily limit of automatic reviews is reached; ask with `@aiden review`",
} as const;
/** A command's answer, in fixed words (`@aiden review help|always|focus: …|status` with no review yet). */
export const ANSWERS = {
  help: "commands: `@aiden review` (once, with the repo's review-on-open combos), `@aiden review full` (the whole PR), `@aiden review always` (every push), `@aiden review stop`, `@aiden review focus: <text>`, `@aiden review status`",
  always: "every push to this pull request will be reviewed",
  focus: "the next reviews on this pull request look hardest at the focus given",
  focus_cleared: "the focus on this pull request is cleared",
  no_review: "no review yet",
} as const;
export const NoticeArgsSchema = z.object({
  repo: z.string().regex(new RegExp(`^${NAME}/${NAME}$`)),
  pr: z.number().int().min(1),
  head: z.string().regex(SHA),
  phase: z.enum(["queued", "running", "done", "skipped", "failed", "answered"]),
  engine: ENGINE.optional(), model: MODEL.optional(), effort: EFFORT.optional(),
  reason: z.enum(Object.keys(SKIP_REASONS) as [keyof typeof SKIP_REASONS, ...(keyof typeof SKIP_REASONS)[]]).optional(),
  answer: z.enum(Object.keys(ANSWERS) as [keyof typeof ANSWERS, ...(keyof typeof ANSWERS)[]]).optional(),
  important: z.number().int().min(0).max(9999).optional(),
  nit: z.number().int().min(0).max(9999).optional(),
  pre_existing: z.number().int().min(0).max(9999).optional(),
  cost_usd: z.number().min(0).max(100_000).optional(),
  run: RUN.optional(),
});
export type NoticeArgs = z.infer<typeof NoticeArgsSchema>;

export const MARK = { review: "aidenhq-review", finding: "aidenhq-finding", run: "aidenhq-review-run", ack: "aidenhq-review-ack" } as const;
export const FINDING_MARK = /<!-- aidenhq-finding: ([A-Za-z0-9_-]{6,64}) -->/;
export const RUN_MARK = (run: string) => `<!-- ${MARK.run}: ${run} -->`;
export const ACK_MARK = `<!-- ${MARK.ack} -->`;
export const STATUS_CONTEXT = "aidenhq/review";

const ICON = { important: "\u{1F534}", nit: "\u{1F7E1}", pre_existing: "\u{1F7E3}" } as const;
const LABEL = { important: "Important", nit: "Nit", pre_existing: "Pre-existing" } as const;
const ORDER = ["important", "nit", "pre_existing"] as const;
// Sized so a whole review fits the card the AI reviewer reads (80,000 characters): 15 inline comments of at most ~3,200 plus a
// summary of about 30,000.
export const INLINE_MAX = 15;
const EVIDENCE_MAX = 500;
const LISTED_DETAILS = 4;
const LIST_MAX = 40;

const ASSIGNMENT = /\b((?:pass(?:word|wd)?|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|authorization|credential)s?)(["']?\s*[:=]\s*["']?)[^\s"',;]{4,}/gi;
/** Credentials and secret-looking values replaced by a marker (scrub.ts's token patterns, assignments, bearer values, URL logins). */
export function redact(text: string): string {
  let t = text;
  for (const [what, re] of SECRETS) t = t.replace(re, `[redacted ${what}]`);
  return t
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g, "Bearer [redacted]")
    .replace(/(\w+:\/\/)[^\s/:@]+:[^\s/@]+@/g, "$1[redacted]@")
    .replace(ASSIGNMENT, (_m, k: string, sep: string) => `${k}${sep}[redacted]`);
}

const ZWSP = "​";
/**
 * Text a model wrote, made inert in a GitHub comment: secrets redacted, control characters dropped, `<` escaped (no HTML
 * comment can forge a marker, no tag or image loads, `</details>` can't close ours), images and links shown as code, and every
 * `@name` broken so nobody is pinged and no `@aiden` command can fire from our own text.
 */
export function plain(text: string, max: number): string {
  const t = redact(text)
    .replace(/[\p{Cc}\p{Cf}]/gu, (c) => (c === "\n" || c === "\t" ? c : ""))
    .replace(/</g, "&lt;")
    .replace(/!\[[^\]]{0,200}\]\([^)]{0,500}\)/g, "[image removed]")
    .replace(/\[([^\]]{0,200})\]\(([^)\s]{1,500})[^)]*\)/g, (_m, label: string, url: string) => `${label} (\`${url.replace(/`/g, "")}\`)`)
    .replace(/@(?=[A-Za-z0-9_-])/g, `@${ZWSP}`)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** A fenced block its content can't close. */
export const fence = (text: string, lang = "") => {
  const f = "`".repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1)));
  return `${f}${lang}\n${text}\n${f}`;
};
const code = (s: string) => `\`${s.replace(/[`\r\n]/g, "")}\``;
const short = (sha: string) => sha.slice(0, 7);

export const counts = (findings: readonly { severity: Finding["severity"] }[]) => ({
  important: findings.filter((f) => f.severity === "important").length,
  nit: findings.filter((f) => f.severity === "nit").length,
  pre_existing: findings.filter((f) => f.severity === "pre_existing").length,
});
type Counts = { important: number; nit: number; pre_existing: number };
const countLine = (c: Counts) => `${ICON.important} ${c.important} important · ${ICON.nit} ${c.nit} ${c.nit === 1 ? "nit" : "nits"} · ${ICON.pre_existing} ${c.pre_existing} pre-existing`;

export const COMMANDS = [
  "`@aiden review`: review the new changes again (once, with the repo's review-on-open combos)",
  "`@aiden review full`: review the whole pull request, not only what changed since the last review",
  "`@aiden review always`: review every push; `@aiden review stop`: stop reviewing this pull request",
  "`@aiden review focus: <text>`: look at one thing",
  "`@aiden review status` and `@aiden review help`",
];
/** The fixed help block every review summary ends with: how people on the PR ask Aiden for more (never the review's own words). */
export const commandsBlock = () => `<details><summary>Commands</summary>\n\n${COMMANDS.map((c) => `- ${c}`).join("\n")}\n\n</details>`;

/** One finding as an inline comment: marker, severity and title; the reasoning and a fix brief collapsed. */
export function renderFinding(f: Finding, r: Pick<Review, "repo" | "pr" | "head">): string {
  const where = `${f.path}:${f.line}${f.end_line && f.end_line > f.line ? `-${f.end_line}` : ""}`;
  const evidence = redact(f.evidence).slice(0, EVIDENCE_MAX);
  const brief = [`Fix ${where} (${r.repo} PR #${r.pr} at ${short(r.head)})`, `Problem: ${plain(f.title, 200)}`, ...(evidence ? [`Evidence: ${evidence}`] : []), `Wanted: ${plain(f.fix_brief, 500)}`].join("\n");
  return [
    `<!-- ${MARK.finding}: ${f.id} -->`,
    `${ICON[f.severity]} **${LABEL[f.severity]}:** ${plain(f.title, 200)}`,
    "",
    `<details><summary>Why flagged</summary>\n\n${plain(f.why, 800)}${evidence ? `\n\n${fence(evidence)}` : ""}\n\n</details>`,
    "",
    `<details><summary>Copy as fix brief</summary>\n\n${fence(brief)}\n\n</details>`,
  ].join("\n");
}

export type Placed = { id: string; path: string; line: number; start_line?: number; body: string };
/**
 * The review, ready to post. `inline` names the findings that go on diff lines (ids; default: the first INLINE_MAX by
 * severity, as a preview shows); `earlier` names findings an earlier review already commented on (not posted again). Every other
 * finding is listed in the summary, so nothing the reviewer found is dropped.
 */
export function renderReview(r: Review, run: string, opts: { inline?: ReadonlySet<string>; earlier?: ReadonlySet<string> } = {}): { summary: string; comments: Placed[]; listed: Finding[] } {
  const { inline, earlier = new Set<string>() } = opts;
  const ranked = [...r.findings].sort((a, b) => ORDER.indexOf(a.severity) - ORDER.indexOf(b.severity));
  const chosen = ranked.filter((f) => !earlier.has(f.id) && (inline ? inline.has(f.id) : true)).slice(0, INLINE_MAX);
  const ids = new Set(chosen.map((f) => f.id));
  const comments = chosen.map((f): Placed => ({ id: f.id, path: f.path, line: f.end_line && f.end_line > f.line ? f.end_line : f.line, ...(f.end_line && f.end_line > f.line ? { start_line: f.line } : {}), body: renderFinding(f, r) }));
  const listed = ranked.filter((f) => !ids.has(f.id) && !earlier.has(f.id));
  const c = counts(r.findings);
  const incomplete = r.coverage.incomplete;
  const lines = [
    `<!-- ${MARK.review}: ${JSON.stringify(c)} -->`,
    RUN_MARK(run),
    `### Aiden review · ${code(comboText(r))}`,
    "",
    `**${countLine(c)}**`,
    "",
    `Reviewed ${r.coverage.reviewed.length} file${r.coverage.reviewed.length === 1 ? "" : "s"} at ${code(short(r.head))} (${r.full || !r.incremental_from ? "the whole pull request" : `new changes since ${code(short(r.incremental_from))}`})${r.coverage.excluded.length ? `, ${r.coverage.excluded.length} excluded` : ""}. Reviewer ${code(comboText(r))}, $${r.cost_usd.toFixed(2)}.`,
    ...(incomplete ? ["", `> **Incomplete:** ${plain(incomplete, 300)}. This is not a clean review.`] : []),
    ...(r.withheld.important + r.withheld.nit + r.withheld.pre_existing ? ["", `Withheld to keep this short: ${countLine(r.withheld)}. \`@aiden review full\` shows more.`] : []),
  ];
  if (r.findings.length) {
    lines.push("", "**Findings**");
    for (const f of ranked.slice(0, LIST_MAX)) lines.push(`- ${ICON[f.severity]} ${code(`${f.path}:${f.line}`)} ${plain(f.title, 160)}${earlier.has(f.id) ? " (commented earlier)" : ids.has(f.id) ? "" : " (no inline comment)"}`);
    if (ranked.length > LIST_MAX) lines.push(`- \u2026and ${ranked.length - LIST_MAX} more`);
  } else if (!incomplete) lines.push("", "No findings.");
  for (const f of listed.slice(0, LISTED_DETAILS)) lines.push("", `<details><summary>${ICON[f.severity]} ${code(`${f.path}:${f.line}`)} ${plain(f.title, 160)}</summary>\n\n${plain(f.why, 800)}${f.evidence ? `\n\n${fence(redact(f.evidence).slice(0, EVIDENCE_MAX))}` : ""}\n\n**Fix brief:** ${plain(f.fix_brief, 500)}\n\n</details>`);
  if (r.stale_guidance.length) lines.push("", `<details><summary>Guidance this change may make stale</summary>\n\n${r.stale_guidance.map((s) => `- ${plain(s, 300)}`).join("\n")}\n\n</details>`);
  lines.push("", commandsBlock());
  return { summary: lines.join("\n"), comments, listed };
}

const usd = (n: number | undefined) => (n === undefined ? "" : ` ($${n.toFixed(2)})`);
/** The acknowledgement comment's text and the commit status a notice sets (no status for `queued`), from fixed words only. */
export function renderNotice(n: NoticeArgs): { text: string; status?: { state: "pending" | "success" | "error"; description: string } } {
  const who = n.engine && n.model && n.effort ? ` with ${code(comboText({ engine: n.engine, model: n.model, effort: n.effort }))}` : "";
  const sha = code(short(n.head));
  const c: Counts = { important: n.important ?? 0, nit: n.nit ?? 0, pre_existing: n.pre_existing ?? 0 };
  const head = `${ACK_MARK}\n**Aiden review**`;
  const help = "`@aiden review help` lists the commands.";
  switch (n.phase) {
    case "queued": return { text: `${head}: queued${who} for ${sha}. ${help}` };
    case "running": return { text: `${head}: reviewing ${sha}${who}…`, status: { state: "pending", description: "Reviewing" } };
    case "done": return { text: `${head}: reviewed ${sha}${who}: ${countLine(c)}${usd(n.cost_usd)}. ${help}`, status: { state: "success", description: `${c.important} important, ${c.nit} nit, ${c.pre_existing} pre-existing` } };
    case "skipped": { const why = SKIP_REASONS[n.reason ?? "unchanged"]; return { text: `${head}: skipped ${sha}: ${why}. ${help}`, status: { state: "success", description: `Skipped: ${why}`.replace(/`/g, "").slice(0, 140) } }; }
    case "answered": return { text: `${head}: ${ANSWERS[n.answer ?? "help"]}.${n.answer === "help" ? "" : ` ${help}`}` };
    case "failed": return { text: `${head}: the review of ${sha}${who} failed${n.run ? ` (run ${n.run})` : ""}. Say \`@aiden review\` to try again. ${help}`, status: { state: "error", description: "Review failed" } };
  }
}

/** The status a posted review sets: always success (advisory, never a block), with what it found and whether it was complete. */
export function reviewStatus(r: Review): { state: "success"; description: string } {
  const c = counts(r.findings);
  return { state: "success", description: `${c.important} important, ${c.nit} nit, ${c.pre_existing} pre-existing${r.coverage.incomplete ? " (incomplete)" : ""}`.slice(0, 140) };
}

/** The right-side line numbers of a unified diff patch: where GitHub accepts an inline comment. */
export function rightLines(patch: string): Set<number> {
  const out = new Set<number>();
  let n = 0;
  for (const line of patch.split("\n")) {
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (h) { n = Number(h[1]); continue; }
    if (!n || line.startsWith("-") || line.startsWith("\\")) continue;
    out.add(n++);
  }
  return out;
}
