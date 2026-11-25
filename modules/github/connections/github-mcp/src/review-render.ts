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
const ENGINE = z.enum(["codex", "claude-code", "codegenie", "codex-native"]);
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
  /** The repo is gated (a mandatory combo): the summary says whether this review blocks the merge. */
  gated: z.boolean().default(false),
  /** The comment ids the code-review service recorded as its own posts on this PR (its database, never a marker read back):
   * only their threads are ever resolved. */
  own: z.array(z.number().int().min(1)).max(1000).default([]),
  /** The head's risk tier and the one-line why of the rule that named it: the review's header says it (a path or count from the PR: no backtick or line break). */
  tier: z.enum(["skip", "trivial", "standard", "sensitive"]).optional(),
  tier_why: z.string().regex(/^[^`\r\n]{1,500}$/).optional(),
  /** The pull request's first review: the only one that carries the Commands block. */
  first: z.boolean().default(false),
});
export type PostArgs = z.infer<typeof PostArgsSchema>;

/** The commands people on the PR may write (a comment whose first word is `aiden`); never with an `@`, which would ping a user. */
export const COMMANDS = "`aiden review` (again) · `aiden review full` · `aiden review always` / `stop` · `aiden review focus: <text>` · `aiden review status` / `help`";
/** Why a review didn't run: a fixed vocabulary, so a notice carries no text a model or an author wrote. */
export const SKIP_REASONS = {
  draft: "this is a draft pull request",
  fork: "this pull request comes from a fork; a maintainer asks for a review with `aiden review`",
  superseded: "a newer commit arrived",
  stopped: "reviews are stopped on this pull request (`aiden review always` starts them again)",
  push_cap: "this repository reviews a set number of pushes per pull request and that number is reached; a maintainer asks for another review with `aiden review`",
  unchanged: "nothing changed since the last review",
  ignored: "every changed file is ignored by this repository's review settings",
  no_access: "the pull request can't be read",
} as const;
/**
 * Why a review that ran was not posted: its approval record was refused (closed as stale, rejected, or failed in the
 * executor). Fixed words, so a notice carries no text a model or an author wrote.
 */
export const REFUSED_REASONS = {
  post_refused: "its post was refused or did not go through",
} as const;
/** Every reason a notice may carry: a skip's, or a refusal's. */
const NOTICE_REASONS = { ...SKIP_REASONS, ...REFUSED_REASONS };
type NoticeReason = keyof typeof NOTICE_REASONS;
/** A command's answer, in fixed words (`@aiden review help|always|focus: …|status` with no review yet). */
export const ANSWERS = {
  help: `commands (a comment that starts with one): ${COMMANDS}`,
  always: "every push to this pull request will be reviewed",
  focus: "the next reviews on this pull request look hardest at the focus given",
  focus_cleared: "the focus on this pull request is cleared",
  no_review: "no review yet",
} as const;
export const NoticeArgsSchema = z.object({
  repo: z.string().regex(new RegExp(`^${NAME}/${NAME}$`)),
  pr: z.number().int().min(1),
  head: z.string().regex(SHA),
  phase: z.enum(["queued", "running", "done", "skipped", "failed", "answered", "classified"]),
  /** The head's risk tier and the one-line why of the rule that named it (a path or count from the PR: no backtick or line break). */
  tier: z.enum(["skip", "trivial", "standard", "sensitive"]).optional(),
  tier_why: z.string().regex(/^[^`\r\n]{1,500}$/).optional(),
  engine: ENGINE.optional(), model: MODEL.optional(), effort: EFFORT.optional(),
  reason: z.enum(Object.keys(NOTICE_REASONS) as [NoticeReason, ...NoticeReason[]]).optional(),
  answer: z.enum(Object.keys(ANSWERS) as [keyof typeof ANSWERS, ...(keyof typeof ANSWERS)[]]).optional(),
  important: z.number().int().min(0).max(9999).optional(),
  nit: z.number().int().min(0).max(9999).optional(),
  pre_existing: z.number().int().min(0).max(9999).optional(),
  cost_usd: z.number().min(0).max(100_000).optional(),
  /** The run covered only part of the head: a done notice says so instead of reading as clean. */
  partial: z.boolean().optional(),
  run: RUN.optional(),
  /** The acknowledgement comment the service recorded (edited in place; absent: a new one). */
  ack: z.number().int().min(1).optional(),
  /** The posted review a done notice links. */
  review: z.string().regex(/^https:\/\/github\.com\/[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}\/pull\/\d{1,9}#pullrequestreview-\d{1,15}$/).optional(),
}).superRefine((n, ctx) => {
  // Each phase's reasons are its own: a skip's words never say a post was refused, and a refusal never reads as a skip.
  const refused = n.reason != null && n.reason in REFUSED_REASONS;
  if (refused && n.phase !== "failed") ctx.addIssue({ code: "custom", path: ["reason"], message: "a refused-post reason goes on the failed phase" });
  if (n.reason != null && !refused && n.phase !== "skipped") ctx.addIssue({ code: "custom", path: ["reason"], message: "a skip reason goes on the skipped phase" });
});
export type NoticeArgs = z.infer<typeof NoticeArgsSchema>;
/** An agent's answer to an important finding, replied on its thread (`comment`: the thread's first comment). */
export const ReplyArgsSchema = z.object({
  repo: z.string().regex(new RegExp(`^${NAME}/${NAME}$`)),
  pr: z.number().int().min(1),
  head: z.string().regex(SHA),
  comment: z.number().int().min(1),
  body: z.string().min(1).max(1600),
});
export type ReplyArgs = z.infer<typeof ReplyArgsSchema>;

/** The commit status code review mirrors its merge verdict to (code-review computes it, per PR head, from its /v1/verdict). */
export const STATUS_CONTEXT = "aidenhq/review";
/** The verdict's reason (code-review engine.ts's verdict codes; "pass" when there is none, "failed" for a pass with a mandatory
 * review that failed past its retries) and the commit state each one is. */
export const STATUS_STATE = { pass: "success", ungated: "success", queued: "pending", running: "pending", not_started: "pending", backlog: "pending", moved: "pending", spend_limit: "pending", findings: "failure", failed: "success", incomplete: "failure", not_reviewed: "failure", config: "failure" } as const;
export const StatusArgsSchema = z.object({
  repo: z.string().regex(new RegExp(`^${NAME}/${NAME}$`)),
  pr: z.number().int().min(1),
  head: z.string().regex(SHA),
  reason: z.enum(Object.keys(STATUS_STATE) as [keyof typeof STATUS_STATE, ...(keyof typeof STATUS_STATE)[]]),
  /** Important findings open on the PR (the gating ones). */
  important: z.number().int().min(0).max(9999),
  /** The mandatory reviewers still queued or running at this head. */
  running: z.array(z.object({ model: MODEL, effort: EFFORT })).max(8).default([]),
  /** A mandatory review at this head covered only part of it: said, never waited on. */
  partial: z.boolean().optional(),
});
export type StatusArgs = z.infer<typeof StatusArgsSchema>;
/** The commit status's state and description (at most 140 characters), in fixed words: what runs, or how to unblock. */
export function renderStatus(a: StatusArgs): { state: "pending" | "failure" | "success"; description: string } {
  const open = a.important ? `${a.important} important finding${a.important === 1 ? "" : "s"} open` : "";
  const who = a.running.map((r) => `${modelName(r.model)} (${r.effort})`).join(", ");
  const text: Record<StatusArgs["reason"], string> = {
    pass: "Reviewed: no important finding open",
    ungated: "Code review no longer gates this repository",
    queued: `Review queued${who ? `: ${who}` : ""}`,
    running: `Reviewing${who ? ` with ${who}` : ""}`,
    not_started: "Review starting",
    backlog: `Not reviewed: comment "aiden review" to start one`,
    moved: "A newer commit is being reviewed",
    spend_limit: "Review waiting: the install's spend limit was reached",
    findings: `${open}: fix and push, or answer on its thread (fixed / disputed …)`,
    failed: `Not reviewed: the review failed past its retries, so it doesn't block. Comment "aiden review" to run it again`,
    incomplete: `Partial review: comment "aiden review full"`,
    not_reviewed: `Not reviewed: comment "aiden review"`,
    config: "The code review setting has errors",
  };
  const t = text[a.reason];
  const d = [open && a.reason !== "findings" ? `${t} · ${open}` : t, ...(a.partial ? ["partial coverage"] : [])].join(" · ");
  return { state: STATUS_STATE[a.reason], description: d.length > 140 ? `${d.slice(0, 139)}…` : d };
}

export const MARK = { review: "aidenhq-review", finding: "aidenhq-finding", run: "aidenhq-review-run", ack: "aidenhq-review-ack" } as const;
export const FINDING_MARK = /<!-- aidenhq-finding: ([A-Za-z0-9_-]{6,64}) -->/;
export const RUN_MARK = (run: string) => `<!-- ${MARK.run}: ${run} -->`;
export const ACK_MARK = `<!-- ${MARK.ack} -->`;
/** The words a notice's bold status line starts with, in every phase: fixed, so only a comment `renderNotice` wrote matches. */
const STATUS_STARTS = ["Review (?:queued|running|not started yet|skipped|failed|finished)", "Partial review", "No review needed", "No important findings", "\\d+ important findings?\\*\\*", "Commands", ...Object.values(ANSWERS).filter((a) => a !== ANSWERS.help).map((a) => (a[0]!.toUpperCase() + a.slice(1)).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))];
/** A notice's generated header, exactly as `renderNotice` writes it at the start of a comment: the marker, then a bold status (one of
 * the fixed starts above) on the next line. A comment that merely quotes a notice carries the marker further down, so it never
 * matches, and an ordinary comment that happens to open with the marker and some bold text doesn't either. */
export const ACK_HEAD = new RegExp(`^\\s*${ACK_MARK.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\r?\\n\\*\\*(?:${STATUS_STARTS.join("|")})`);
const ICON = { important: "\u{1F534}", nit: "\u{1F7E1}", pre_existing: "\u{1F7E3}" } as const;
const LABEL = { important: "Important", nit: "Nit", pre_existing: "Pre-existing" } as const;
const ORDER = ["important", "nit", "pre_existing"] as const;
const LISTED_MAX = 4;
const EVIDENCE_MAX = 500;

const ASSIGNMENT = /\b((?:pass(?:word|wd)?|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|authorization|credential)s?)(["']?\s*[:=]\s*["']?)[^\s"',;]{4,}/gi;
/** Credentials and secret-looking values replaced by a marker (scrub.ts's token patterns, assignments, bearer values, URL logins). */
export function redact(text: string): string {
  const had = redacted.get(text);
  if (had !== undefined) return had;
  const out = redactOnce(text);
  // The whole text, redacted once and remembered: a review rendered at several text scales (its card) trims this, never a cut.
  if (redacted.size > 5000) redacted.clear();
  redacted.set(text, out);
  return out;
}
const redacted = new Map<string, string>();
function redactOnce(text: string): string {
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
 * `@name` broken so nobody is pinged.
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

/** The one-line, collapsed command list every review summary ends with (fixed words, never the review's own). */
export const commandsBlock = () => `<details><summary>Commands</summary>\n\n${COMMANDS}\n\n</details>`;

/** A model as people say it: `anthropic/claude-haiku-5.5` is `Haiku 5.5`, `~openai/gpt-6.2-sol` `GPT 6.2 Sol`. */
export function modelName(model: string): string {
  const words = (model.split("/").pop() ?? model).replace(/^~/, "").split(/[-_]/).filter((w) => w && !/^(claude|latest)$/i.test(w));
  const name = words.map((w) => (/^gpt$/i.test(w) ? "GPT" : /^deepseek$/i.test(w) ? "DeepSeek" : w[0]!.toUpperCase() + w.slice(1))).join(" ");
  return name || model;
}

/** One finding as an inline comment: its run's and its finding's markers (the run's is what names the comment again when GitHub
 * can't list the review's comments), severity and title; the reasoning and a fix brief collapsed. `at`: where the comment sits
 * when that isn't the finding's own line (the nearest diff line, or the file). `run`: the review's run, whose marker it carries. */
export function renderFinding(f: Finding, r: Pick<Review, "repo" | "pr" | "head">, at?: number | "file", scale = 1, run?: string): string {
  const where = `${f.path}:${f.line}${f.end_line && f.end_line > f.line ? `-${f.end_line}` : ""}`;
  const head = [...(run ? [RUN_MARK(run)] : []), `<!-- ${MARK.finding}: ${f.id} -->`, `${ICON[f.severity]} **${LABEL[f.severity]}:** ${plain(f.title, scale ? 200 : 100)}`, ...(at !== undefined && at !== f.line ? ["", `_At ${code(where)}, outside the diff._`] : [])];
  // A review too large for the AI reviewer's card keeps every finding and its thread, with shorter texts (scale), at the least
  // its title alone.
  if (!scale) return head.join("\n");
  const n = (x: number) => Math.max(40, Math.floor(x * scale));
  const evidence = redact(f.evidence).slice(0, n(EVIDENCE_MAX));
  const brief = [`Fix ${where} (${r.repo} PR #${r.pr} at ${short(r.head)})`, `Problem: ${plain(f.title, 200)}`, ...(evidence ? [`Evidence: ${evidence}`] : []), `Wanted: ${plain(f.fix_brief, n(500))}`].join("\n");
  return [
    ...head,
    "",
    `<details><summary>Why flagged</summary>\n\n${plain(f.why, n(800))}${evidence ? `\n\n${fence(evidence)}` : ""}\n\n</details>`,
    "",
    `<details><summary>Copy as fix brief</summary>\n\n${fence(brief)}\n\n</details>`,
  ].join("\n");
}
/** How much of each finding's text a review keeps (renderFinding's scale): the largest that fits `fits`, at the least titles. */
export const SCALES = [1, 0.4, 0.15, 0] as const;

/** Where a finding's thread goes: lines on the diff (`line`, a range's `start_line`), or the file itself. */
export type Anchor = { line: number; start_line?: number } | "file";
export type Placed = { id: string; path: string; line?: number; start_line?: number; file?: true; body: string };
/**
 * Where each finding's thread goes, given the reviewed diff's right-side lines per changed file (a file GitHub shows no patch
 * for has an empty set): its own lines when all are on the diff, else the nearest diff line of its file, else the file. A
 * finding in no changed file gets no anchor (it can take no thread).
 */
export function anchors(findings: readonly Finding[], lines: ReadonlyMap<string, ReadonlySet<number>>): Map<string, Anchor> {
  const out = new Map<string, Anchor>();
  for (const f of findings) {
    const l = lines.get(f.path);
    if (!l) continue;
    if (!l.size) { out.set(f.id, "file"); continue; }
    const to = f.end_line && f.end_line > f.line ? f.end_line : f.line;
    let whole = true;
    for (let i = f.line; i <= to && whole; i++) whole = l.has(i);
    if (whole) { out.set(f.id, to > f.line ? { line: to, start_line: f.line } : { line: f.line }); continue; }
    let best = 0;
    for (const n of l) if (!best || Math.abs(n - f.line) < Math.abs(best - f.line)) best = n;
    out.set(f.id, { line: best });
  }
  return out;
}

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");
const fileLine = (f: Finding) => code(`${f.path.split("/").pop()}:${f.line}`);

/**
 * The review, ready to post. `place`: where each finding's thread goes (default: each on its own lines, as a preview shows);
 * `earlier`: findings an earlier review already opened a thread for (not posted again; the value is that thread's link);
 * `links`: each posted finding's thread link (known once posted: the body is then updated with them); `gated`: the repo's
 * merges wait on code review. Each finding appears once: a table row (its title linking to its thread) or, with no thread, a
 * collapsed block with its reasoning.
 */
export function renderReview(r: Review, run: string, opts: { place?: ReadonlyMap<string, Anchor>; earlier?: ReadonlyMap<string, string>; links?: ReadonlyMap<string, string>; gated?: boolean; card?: boolean; scale?: number; tier?: NoticeArgs["tier"]; tier_why?: string; first?: boolean } = {}): { summary: string; comments: Placed[]; listed: Finding[] } {
  const { earlier = new Map<string, string>(), links = new Map<string, string>() } = opts;
  const ranked = [...r.findings].sort((a, b) => ORDER.indexOf(a.severity) - ORDER.indexOf(b.severity));
  const place = opts.place ?? new Map(ranked.map((f): [string, Anchor] => [f.id, f.end_line && f.end_line > f.line ? { line: f.end_line, start_line: f.line } : { line: f.line }]));
  // Only an important finding is posted, and each gets a thread (answering it there is how it closes). A nit or a pre-existing
  // finding stays on the board's Reviews page and in the run's record: the summary counts them (every inline comment is a GitHub
  // write, and the limit on those is what blocks the fleet).
  const chosen = ranked.filter((f) => f.severity === "important" && !earlier.has(f.id) && place.has(f.id));
  const ids = new Set(chosen.map((f) => f.id));
  const comments = chosen.map((f): Placed => {
    const a = place.get(f.id)!;
    return a === "file" ? { id: f.id, path: f.path, file: true, body: renderFinding(f, r, "file", opts.scale, run) } : { id: f.id, path: f.path, ...a, body: renderFinding(f, r, a.start_line ? undefined : a.line, opts.scale, run) };
  });
  const threaded = (f: Finding) => ids.has(f.id) || earlier.has(f.id);
  const listed = ranked.filter((f) => f.severity === "important" && !threaded(f));
  const c = counts(r.findings);
  // A docs-only PR's qualifying findings (recipe/brief.ts DESIGN_NOTE): shown, never blocking, never counted as important.
  const notes = ranked.filter((f) => f.severity === "pre_existing" && f.why.startsWith("[design note] ")).slice(0, 3);
  const smaller = c.nit + c.pre_existing - notes.length;
  const incomplete = r.coverage.incomplete;
  // Fixed command words, named on the AI reviewer's card instead (they read like instructions to it); model text is never touched.
  const cmd = (words: string) => (opts.card ? "[AidenHQ's fixed command for another review]" : `\`${words}\``);
  const partial = !!incomplete || r.withheld.important > 0;
  const blocks = !opts.gated ? "" : c.important ? " · **blocks the merge** until each important one is fixed or answered" : partial ? " · doesn't block the merge (a partial review: see below)" : " · doesn't block the merge";
  const row = (f: Finding) => { const url = links.get(f.id) || earlier.get(f.id); const t = cell(plain(f.title, 160)); return `| ${ICON[f.severity]} | ${url ? `[${t}](${url})` : t} | ${fileLine(f)} |`; };
  const table = (fs: Finding[]) => ["| | Finding | Where |", "|---|---|---|", ...fs.map(row)].join("\n");
  const important = ranked.filter((f) => f.severity === "important" && threaded(f));
  // A run that did not finish never reads as clean: with nothing important found, the headline says it is incomplete.
  const headline = c.important ? `${ICON.important} ${c.important} important` : incomplete ? "\u26A0\uFE0F Incomplete review" : "\u2705 No important findings";
  const lines = [
    `<!-- ${MARK.review}: ${JSON.stringify(c)} -->`,
    RUN_MARK(run),
    `### Aiden review · ${modelName(r.model)} (${r.effort})`,
    ...(opts.tier ? ["", riskLine(opts.tier, opts.tier_why)] : []),
    "",
    `${headline}${blocks}`,
    ...(smaller ? ["", `${plural(smaller, "smaller note")} on the board's Reviews page, not posted here.`] : []),
    ...(incomplete ? ["", `> **Partial review:** ${plain(incomplete, 300)}. ${cmd("aiden review full")} reviews the whole pull request again.`] : []),
    ...(r.withheld.important ? ["", `${plural(r.withheld.important, "important finding")} withheld to keep this short. ${cmd("aiden review full")} shows more.`] : []),
  ];
  if (important.length) lines.push("", table(important));
  if (notes.length) lines.push("", "**Design notes (not blocking)**", "", ...notes.map((f) => `- ${fileLine(f)} **${plain(f.title, 160)}**: ${plain(f.why.slice("[design note] ".length), 400)}`));
  // Without a thread (in no changed file): the first few with their reasoning, the rest named, so the post stays within GitHub's
  // and the card's size.
  for (const f of listed.slice(0, LISTED_MAX)) lines.push("", `<details><summary>${ICON[f.severity]} ${plain(f.title, 160)} ${code(`${f.path}:${f.line}`)}</summary>\n\n${plain(f.why, 800)}${f.evidence ? `\n\n${fence(redact(f.evidence).slice(0, EVIDENCE_MAX))}` : ""}\n\n**Fix brief:** ${plain(f.fix_brief, 500)}\n\n</details>`);
  if (listed.length > LISTED_MAX) lines.push("", `<details><summary>${listed.length - LISTED_MAX} more without a thread</summary>\n\n${listed.slice(LISTED_MAX, LISTED_MAX + 40).map((f) => `- ${ICON[f.severity]} ${plain(f.title, 160)} ${code(`${f.path}:${f.line}`)}`).join("\n")}${listed.length > LISTED_MAX + 40 ? "\n- \u2026" : ""}\n\n</details>`);
  if (r.stale_guidance.length) lines.push("", `<details><summary>Guidance this change may make stale</summary>\n\n${r.stale_guidance.map((s) => `- ${plain(s, 300)}`).join("\n")}\n\n</details>`);
  // The Commands block is on a pull request's first review only; the engine and cost are on the board, not in the comment.
  if (opts.first) lines.push("", opts.card ? "[AidenHQ's fixed Commands help: the comments people on the pull request may write to ask for another review]" : commandsBlock());
  lines.push("", `<sub>${code(short(r.head))} · ${r.full || !r.incremental_from ? "whole PR" : `changes since ${code(short(r.incremental_from))}`}</sub>`);
  return { summary: lines.join("\n"), comments, listed };
}

const TIER = { skip: ["\u26AA", "Skip"], trivial: ["\u{1F7E2}", "Trivial"], standard: ["\u{1F535}", "Standard"], sensitive: ["\u{1F7E0}", "Sensitive"] } as const;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** The risk tier with its plain-words reason: from the PR's own paths and counts, so inert text: Markdown's marks escaped and no URL left to autolink. */
const riskLine = (tier: keyof typeof TIER, why?: string) => `Risk: ${TIER[tier][0]} **${TIER[tier][1]}**${why ? ` · ${plain(why, 500).replace(/[\\*_~[\]]/g, "\\$&").replace(/:\/\//g, ":\u200B//").replace(/\bwww\./gi, "www\u200B.")}` : ""}`;
/** A model's name and effort as a person reads them: `GPT 6.2 Sol (medium)`. */
const reviewer = (n: NoticeArgs) => (n.model && n.effort ? `${modelName(n.model)} (${n.effort})` : "");
/**
 * The acknowledgement comment's text, from fixed words only, for a person to read at a glance: the status they act on (bold),
 * the risk with its plain-words reason, and a small footer (the head, the run, how to ask for commands). Every phase has the
 * same three parts, so the one comment reads the same whatever the review is doing.
 */
export function renderNotice(n: NoticeArgs): string {
  const link = n.review ? ` · [see the review](${n.review})` : "";
  const who = reviewer(n);
  const minor = [n.nit ? plural(n.nit, "nit") : "", n.pre_existing ? `${n.pre_existing} pre-existing` : ""].filter(Boolean).join(" · ");
  const important = n.important ?? 0;
  let status: string;
  let help = true;
  switch (n.phase) {
    case "classified": status = n.tier === "skip" ? "**No review needed** for this risk" : "**Review not started yet**"; break;
    case "queued": status = `**Review queued**${who ? ` · ${who}` : ""}`; break;
    case "running": status = `**Review running**${who ? ` · ${who}` : ""}`; break;
    case "done": status = `${important ? `**${plural(important, "important finding")}** to fix${n.partial ? " \u00B7 partial coverage" : ""}` : (n.partial ? "**Partial review** \u00B7 not everything was covered or shown, so this is not a clean pass" : "**No important findings**")}${minor ? ` · ${minor}` : ""}${link}`; break;
    case "skipped": status = `**Review skipped** · ${NOTICE_REASONS[(n.reason ?? "unchanged") as NoticeReason]}`; break;
    case "answered": status = n.answer === "help" || !n.answer ? `**Commands** (a comment that starts with one): ${COMMANDS}` : `**${ANSWERS[n.answer][0]!.toUpperCase()}${ANSWERS[n.answer].slice(1)}**`; help = !(n.answer === "help" || !n.answer); break;
    case "failed": status = n.reason && n.reason in REFUSED_REASONS
      ? `**Review finished but was not posted** · ${REFUSED_REASONS[n.reason as keyof typeof REFUSED_REASONS]} · \`aiden review\` runs it again`
      : `**Review failed** · comment \`aiden review\` to try again`; break;
  }
  const risk = n.tier ? `\n${riskLine(n.tier, n.tier_why)}` : "";
  const footer = [short(n.head), ...(help ? ["`aiden review help` for commands"] : [])].join(" · ");
  return `${ACK_MARK}\n${status}${risk}\n\n<sub>${footer}</sub>`;
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
