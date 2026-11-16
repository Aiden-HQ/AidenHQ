// Approval records: the exact request (action, target, digest, the args its executor replays),
// approved or rejected once by the owner, consumed once atomically by whoever applies it. Nothing here knows who the owner
// is: the routes check that (app.ts); this file only keeps the state machine honest.
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { Events } from "./events.js";
import { TIER_RULE, type ReviewCode } from "./reason-codes.js";

export const ACTIONS = ["apply", "push", "pr", "merge", "create_repo", "deploy_app", "app_run", "raise_cap"] as const;
export type Action = (typeof ACTIONS)[number];
/** Applied by the board on the tap; the rest by the runner, which claims approved records on its poll. */
export const BOARD_ACTIONS: readonly Action[] = ["deploy_app", "app_run", "raise_cap"];

// "auto": a Tier 0 audit row: the runner already ran it; never decided, never claimable.
export type State = "pending" | "approved" | "rejected" | "stale" | "expired" | "used" | "auto";
/**
 * Tiers (the tiered-approvals design): 0 ran at once (an audit row), 1 the AI reviewer decides, 2 the owner decides.
 * A record filed without a tier is 2.
 */
export type Tier = 0 | 1 | 2;
/** The reviewer models a verdict may name (decided_by `reviewer:<model>`, or `reviewer:<model>+<second>` for the panel). */
export const REVIEWER_MODELS = ["~openai/gpt-luna-latest", "~deepseek/deepseek-flash-latest", "~z-ai/glm-flash-latest"] as const;
const TTL_MS = 7 * 86_400_000;
/** A record used this long ago with no outcome: the applier died mid-way. Shown as unknown, never retried. */
const UNKNOWN_AFTER_MS = 2 * 3_600_000;

export interface Request {
  issueId: string;
  identifier: string;
  action: Action;
  target: string;
  digest: string;
  args: unknown;
  /** The card, written by host code from the request (never only the agent's prose). */
  sentence: string;
  reads: string;
  changes: string;
  cost: string;
  details: string;
  requestedBy: string;
  /** 1 or 2, from the runner's classifier (or the board's own rule for its actions); 2 when absent. */
  tier?: 1 | 2;
  /** Why this tier (the classifier's reason). */
  reason?: string;
  /** The filer's Paperclip agent id, from the authenticated caller (never request text); none for system filers. */
  requesterId?: string | null;
  /** The tier computed on the request's merits (tiers.mjs classify, or the board's own rule) before the autonomy override. */
  baseTier?: Tier | null;
  /** The tier's reason code: the classifier's rule (tiers.mjs `rule`, or the board's own), kebab-case; dropped unless it has that shape. */
  reasonCode?: string | null;
  /** Authority-expanding (tiers.mjs `panel`): a reviewer approval must name a second reviewer too. */
  panel?: boolean;
  /**
   * The owner decides after the reviewer (tiers.mjs reviewFirstOf): "final", the reviewer may escalate or reject (its reject is
   * final); "owner", Tier 2 on its merits, the reviewer may only escalate (its reject reaches the owner too). Never an approve.
   */
  reviewFirst?: ReviewFirst | null;
}
export type ReviewFirst = "final" | "owner";

/** Actions whose content the runner keys by patch (args `patch` per branch or PR). */
const CONTENT_KEYED = ["push", "pr", "merge"];
/** A request's patch keys, sorted and joined, or undefined when any is missing. */
export function patchesOf(action: string, args: unknown): string | undefined {
  const a = args as { only?: { patch?: string }[]; prs?: { patch?: string }[] } | null;
  const list = (action === "merge" ? a?.prs : action === "push" || action === "pr" ? a?.only : undefined) ?? [];
  return list.length && list.every((x) => typeof x.patch === "string") ? list.map((x) => x.patch!).sort().join(",") : undefined;
}

/** A tier rule as a reason code: kebab-case words only (classifier output, never agent text); anything else is dropped. */
const ruleCode = (rule: string | null | undefined) => (rule && TIER_RULE.test(rule) ? rule : null);

/**
 * The target a request acts on, apart from the commit or diff it carries: a merge's PR URLs, a push's or PR's repos and
 * branches, an apply's repo and branch. Two requests replace each other only when the action and this target are both
 * equal, so a card for one PR never expires a card for another. A card naming several targets replaces only a card naming
 * exactly the same set (order aside): there is no partial-overlap rule. Anything without a known target shape falls back
 * to its stored target text.
 */
function targetKey(action: Action, target: string, args: unknown): string {
  const a = (args ?? {}) as any;
  if (action === "merge" && Array.isArray(a.prs) && a.prs.length) {
    return `${action}:${a.prs.map((p: any) => String(p?.url ?? "").toLowerCase()).sort().join(" ")}`;
  }
  if ((action === "push" || action === "pr") && Array.isArray(a.only) && a.only.length) {
    return `${action}:${a.only.map((b: any) => `${String(b?.repo ?? "").toLowerCase()} ${String(b?.branch ?? "")}`).sort().join(" ")}`;
  }
  if (action === "apply" && a.repo && a.branch) return `${action}:${String(a.repo).toLowerCase()} ${a.branch}`;
  return `${action}:${target}`;
}

/** An apply carrying new module authority (its explicit ownerRequired flag, never its line text): the reviewer never approves it alone. */
export const ownerAfterReview = (a: { action: string; args: unknown }) => a.action === "apply" && (a.args as any)?.ownerRequired === true;

/** The stable reason for a request whose change is already satisfied: no card is filed, the task gets the evidence. */
export const ALREADY_APPLIED = "already_applied";

export interface Approval extends Omit<Request, "tier" | "reason" | "requesterId" | "baseTier" | "reasonCode" | "panel" | "reviewFirst"> {
  tier: Tier;
  /** The owner decides after the reviewer (Request.reviewFirst); null on any other card. */
  reviewFirst: ReviewFirst | null;
  /** Authority-expanding: the board takes a reviewer's approval only with a second reviewer's. */
  panel: boolean;
  reason: string;
  /** Null on records filed before it was recorded. */
  requesterId: string | null;
  baseTier: Tier | null;
  /** The AI reviewer's note: its verdict's reason, or why it escalated. */
  review: string | null;
  /** The tier rule's code (null on older records). */
  reasonCode: string | null;
  /** The reviewer's code (services/shared/reason-codes.ts REVIEW_CODES): reviewer_unsure when it couldn't tell; null before review. */
  reviewCode: ReviewCode | null;
  id: string;
  state: State;
  decidedBy: string | null;
  decidedAt: string | null;
  usedAt: string | null;
  outcome: "applied" | "failed" | null;
  outcomeText: string | null;
  createdAt: string;
  expiresAt: string;
  /** It replaced an open request on the same task, action and target: a typed reply can't approve it, only a tap on its card. */
  replaced: boolean;
}

// The runner's requests: args validated per action, and the card built here from them (never the caller's prose). Its one
// free-text part, an apply's diff, is rechecked by the runner against the approved commit before anything lands.
const SHA = z.string().regex(/^[0-9a-f]{40}$/);
const REPO = z.string().regex(/^[\w.-]+\/[\w.-]+$/);
// base: the trusted base the runner read in its own clone before tiering (a product branch only), kept so the approval
// hands it back and the runner rechecks and records the reviewed range. The runner's card args are the source of truth for
// this shape: test/card-contract.test.ts fails when a field it builds is missing here.
// patch: the runner's content key of the branch's change (git.mjs patchKey), the same however the branch is named or rebased:
// the owner's veto binds to it.
const PATCH = z.string().regex(/^[0-9a-f]{64}$/);
const BRANCH = z.object({ repo: REPO, branch: z.string().min(1).max(200).regex(/^[^\s`]+$/), sha: SHA, base: SHA.optional(), patch: PATCH.optional() }).strict();
export const ARGS = {
  push: z.object({ only: z.array(BRANCH).min(1).max(30) }).strict(),
  // merge: the product repo's one-card path (push, PR, then merge at exactly these commits once green), shown on the card.
  pr: z.object({ only: z.array(BRANCH).min(1).max(30), text: z.object({ title: z.string().max(300), body: z.string().max(60_000) }).strict().optional(), merge: z.literal(true).optional() }).strict(),
  merge: z.object({ prs: z.array(z.object({ repo: REPO, number: z.number().int().positive(), url: z.string().regex(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/), head: z.string().regex(/^[0-9a-f]{40}$/).optional(), noReview: z.literal(true).optional(), patch: PATCH.optional() }).strict()).min(1).max(30), gap: z.number().int().min(0).max(720).optional() }).strict(),
  // authority: the module changes the apply brings, one line each (the runner's kernel/src/loader/authority.ts), shown on the card;
// ownerRequired: one of them adds module authority, so the reviewer may only send it on to the owner (in the digest, as args).
  apply: z.object({ repo: REPO, branch: z.string().min(1).max(200).regex(/^[^\s`]+$/), sha: SHA, files: z.array(z.string().max(300)).min(1).max(200), authority: z.array(z.string().max(300).regex(/^[^\p{Cc}\p{Cf}]+$/u)).min(1).max(200).optional(), ownerRequired: z.boolean().optional() }).strict(),
  // A new app's repository in the agents org (the runner's tiers.mjs refuses any other org or name before filing).
  create_repo: z.object({ repo: z.string().regex(/^[\w.-]+\/[a-z][a-z0-9-]{0,62}$/) }).strict(),
};
export type RunnerAction = keyof typeof ARGS;

/** The card for a runner request, and its digest (of exactly what runs: action, args and the shown diff). */
export function card(action: RunnerAction, args: any, diff = ""): Pick<Request, "target" | "digest" | "sentence" | "reads" | "changes" | "cost" | "details"> {
  const digest = createHash("sha256").update(JSON.stringify({ action, args, diff })).digest("hex").slice(0, 40);
  const branches = (only: { repo: string; branch: string; sha: string }[]) => only.map((b) => `${b.repo} ${b.branch} at ${b.sha.slice(0, 12)}`);
  const base = { digest, reads: "Nothing new.", cost: "No model cost." };
  if (action === "push" || action === "pr") {
    const list = branches(args.only);
    const text = action === "pr" && args.text ? `\n\nPR title: ${args.text.title}\n\n${args.text.body}` : "";
    const n = `${list.length} branch${list.length === 1 ? "" : "es"}`;
    const merge = action === "pr" && args.merge === true;
    const sentence = action === "push" ? `Push ${n} to GitHub.` : merge ? `Push and open (or update) a PR for ${n}, then merge each PR once its checks are green.` : `Push and open (or update) a draft PR for ${n}.`;
    const then = merge ? "\nThen merges each PR at exactly this commit, once every named check is green on it and its base branch is green." : "";
    return { ...base, target: list.join(", ").slice(0, 500), sentence, changes: `${list.join("\n")}${then}`, details: `${list.join("\n")}${then}${text}` };
  }
  if (action === "merge") {
    const prs = args.prs as { url: string; head?: string; noReview?: true }[];
    const urls = prs.map((p) => p.url);
    const lines = prs.map((p) => `${p.url}${p.head ? ` at ${p.head.slice(0, 12)}` : ""}${p.noReview ? " (your tap is its only review)" : " (also needs GitHub approval)"}`);
    return { ...base, target: urls.join(", ").slice(0, 500), sentence: `Merge ${urls.length} pull request${urls.length === 1 ? "" : "s"}, one at a time${args.gap ? `, ${args.gap} minutes apart` : ""}.`, changes: `Merges, in this order, only at these commits and with green checks:\n${lines.join("\n")}`, details: lines.join("\n") };
  }
  if (action === "create_repo") {
    const what = `Creates the private repository ${args.repo} (with a README) through the instance's GitHub App. It adds a repository to the agents org; nothing else changes.`;
    return { ...base, target: args.repo, sentence: `Create the repository ${args.repo}.`, changes: what, details: what };
  }
  const authority = Array.isArray(args.authority) && args.authority.length ? `\nModule changes (the owner decides those marked owner, after the AI reviewer):\n${args.authority.join("\n")}` : "";
  return { ...base, target: `${args.repo} ${args.branch}`, sentence: `Apply a change to the fleet's configuration (commit ${args.sha.slice(0, 12)}).`, changes: `Lands ${args.sha.slice(0, 12)} on ${args.repo}'s main and re-applies the live fleet. Files: ${args.files.join(", ")}${authority}`, cost: "No model cost; services restart.", details: diff };
}

/** Printable, one line, capped: for app- or agent-written text, shown only in its own labelled field. */
const oneLine = (s: string, max: number) => s.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim().slice(0, max);

/**
 * A raise_cap: the model gateway refused a call at a spend cap and asks to raise it (filed by the gateway's own key, the
 * numbers from its ledger, never an agent's text). `subject` is what the cap is on: the run key (scope run), the Paperclip
 * task id (task) or the UTC date (day, for `agentId`). Double only: the new cap is derived here, never typed.
 */
export const RaiseCapSchema = z
  .object({
    scope: z.enum(["run", "task", "day"]),
    agentId: z.string().min(1).max(80),
    subject: z.string().regex(/^[\w:.-]{1,128}$/),
    cap: z.number().positive().max(1000),
    spent: z.number().min(0).max(100_000),
  })
  .strict();
export type RaiseCap = z.infer<typeof RaiseCapSchema>;
const usd = (n: number) => `$${n.toFixed(2)}`;

/**
 * The raise_cap request: always the owner's tap (no autonomy setting lowers it), after the AI reviewer has read it (Tier 2 on
 * its merits, review-first: the reviewer may only escalate it, with its verdict on the card). Its args are the
 * checked request plus `to` (twice the cap), which is what the applier sets; the digest covers both. A different cap value
 * is a new request, and like every record it replaces the open raise_cap on the same task.
 */
export function raiseCapRequest(task: { id: string; identifier: string }, r: RaiseCap, agentName: string): Request {
  const args = { ...r, to: Math.round(r.cap * 200) / 100 };
  const who = oneLine(agentName, 80) || r.agentId;
  const on = r.scope === "run" ? "this run" : r.scope === "task" ? `task ${task.identifier}` : `${r.subject} (UTC day)`;
  return {
    issueId: task.id,
    identifier: task.identifier,
    action: "raise_cap",
    target: `${who} ${r.scope} cap`,
    // What the tap applies, not `spent`: a re-file as spend moves keeps the same card (one per scope and cap value).
    digest: createHash("sha256").update(JSON.stringify({ action: "raise_cap", scope: r.scope, agentId: r.agentId, subject: r.subject, cap: r.cap, to: args.to })).digest("hex").slice(0, 40),
    args,
    sentence: `Double ${who}'s ${r.scope} spend cap from ${usd(r.cap)} to ${usd(args.to)}.`,
    reads: "Nothing new.",
    changes: `${who} may spend up to ${usd(args.to)} on ${on} (${usd(r.spent)} spent so far); its calls are refused again at the new cap.`,
    cost: `Up to ${usd(Math.max(0, args.to - r.spent))} more in model calls.`,
    details: `agent: ${r.agentId}\nscope: ${r.scope}\non: ${r.subject}\ncap: ${usd(r.cap)} → ${usd(args.to)}\nspent: ${usd(r.spent)}`,
    requestedBy: "the model gateway",
    tier: 1,
    baseTier: 2,
    reviewFirst: "owner",
    reason: `a ${r.scope} spend cap is the owner's to raise`,
    reasonCode: "raise-cap",
  };
}

/**
 * The instance's `autonomy` setting, as setup writes it into the grants table: off (everything is the owner's, as
 * before), tier0 (Tier 0 runs; the reviewer only comments) or full (the reviewer decides Tier 1). Read on every use: it is
 * the pause switch. Anything unreadable is off.
 */
export type Autonomy = "off" | "tier0" | "full";
export function autonomy(grantsFile = process.env.AIDENHQ_GRANTS_FILE): Autonomy {
  try {
    const v = JSON.parse(readFileSync(grantsFile ?? "", "utf8"))?.autonomy;
    return v === "tier0" || v === "full" ? v : "off";
  } catch {
    return "off";
  }
}

/**
 * The daily digest: only what was the owner's to decide (Tier 2) in the window, with how each stands. Tier 0 runs and the
 * reviewer's own verdicts are not the owner's (owner, 2026-11-15): they stay on the board. null when there were none.
 */
export function digestText(records: Approval[], now = Date.now()): string | null {
  // target (agent-named branches and repos), reason and the reviewer's note (model output over agent text) are untrusted:
  // printable, links removed, markdown escaped, and labelled as reported rather than said by the board.
  const plain = (s: string, max: number) => oneLine(s, max).replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[link removed]").replace(/[\\`*_[\]()~>#|<!]/g, "\\$&");
  const status = (a: Approval) => {
    const st = shown(a, now);
    if (st === "pending") return "still waiting for you";
    if (st === "used") return a.outcome === "applied" ? "approved, applied" : a.outcome === "failed" ? "approved, failed" : "approved, running";
    return st === "unknown" ? "approved, no outcome reported" : st;
  };
  const yours = records.filter((a) => a.tier === 2).map((a) => `• ${a.identifier} ${a.action} · target (as reported): ${plain(a.target, 80)} · ${status(a)}${a.review ? ` · reviewer's note: ${plain(a.review, 200)}` : ""}`);
  if (!yours.length) return null;
  return [`🧾 **Approvals digest** (last 24h): ${yours.length} ${yours.length === 1 ? "card was" : "cards were"} yours to decide`, ...yours.slice(0, 20)].join("\n");
}

/** What a person sees: the stored state, plus expired (past its 7 days) and unknown (used, never reported back). */
export type ShownState = State | "unknown";
export function shown(a: Approval, now = Date.now()): ShownState {
  if ((a.state === "pending" || a.state === "approved") && Date.parse(a.expiresAt) <= now) return "expired";
  if (a.state === "used" && !a.outcome && a.usedAt && now - Date.parse(a.usedAt) > UNKNOWN_AFTER_MS) return "unknown";
  return a.state;
}

/** A typed reply: a decision, optionally followed by the task, a card id, or a target (PR link/number, repo+branch). */
export interface ParsedReply {
  decision: "approve" | "reject";
  /** The task the reply names, when it names one. */
  ref?: string;
  /** The card id or target the reply names, when it names one. */
  target?: string;
}

/** A target a reply may name instead of a task: a card id, a PR link or number, or a repo+branch. */
const replyTarget = (text: string): string | undefined => {
  const t = text.trim();
  if (/^A[0-9a-f]{8}$/i.test(t)) return t;
  if (/^https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/i.test(t)) return t;
  if (/^(?:pr\s*)?#?\d+$/i.test(t)) return t;
  if (/^[\w.-]+\/[\w.-]+#\d+$/i.test(t)) return t;
  if (/^[\w.-]+\/[\w.-]+(?:\s+\S.*)?$/i.test(t)) return t;
  return undefined;
};

/** An exact typed reply: "approve", "approve WOR-184", "approve A1b2c3d4", "approve PR #10" or a PR link (any case, one trailing . or !). */
export function parseReply(text: string): ParsedReply | undefined {
  const m = /^\s*(apply|approve|reject)\b(.*?)[.!]?\s*$/i.exec(text);
  if (!m) return undefined;
  const decision = m[1]!.toLowerCase() === "reject" ? "reject" : "approve";
  const rest = m[2]!.trim();
  if (!rest) return { decision };
  const task = /^([A-Za-z][A-Za-z0-9]*-\d+)\b(.*)$/.exec(rest);
  if (task) {
    const after = task[2]!.trim();
    if (!after) return { decision, ref: task[1]!.toUpperCase() };
    const target = replyTarget(after);
    return target ? { decision, ref: task[1]!.toUpperCase(), target } : undefined;
  }
  const target = replyTarget(rest);
  return target ? { decision, target } : undefined;
}

interface Row {
  id: string;
  issue_id: string;
  identifier: string;
  action: string;
  target: string;
  digest: string;
  args: string;
  sentence: string;
  reads: string;
  changes: string;
  cost: string;
  details: string;
  requested_by: string;
  state: string;
  decided_by: string | null;
  decided_at: string | null;
  used_at: string | null;
  outcome: string | null;
  outcome_text: string | null;
  created_at: string;
  expires_at: string;
  replaced: number;
  tier: number;
  reason: string;
  review: string | null;
  requester_id: string | null;
  base_tier: number | null;
  review_first: string | null;
  reason_code: string | null;
  review_code: string | null;
  panel: number | null;
}

const toApproval = (r: Row): Approval => ({
  id: r.id,
  issueId: r.issue_id,
  identifier: r.identifier,
  action: r.action as Action,
  target: r.target,
  digest: r.digest,
  args: JSON.parse(r.args),
  sentence: r.sentence,
  reads: r.reads,
  changes: r.changes,
  cost: r.cost,
  details: r.details,
  requestedBy: r.requested_by,
  state: r.state as State,
  decidedBy: r.decided_by,
  decidedAt: r.decided_at,
  usedAt: r.used_at,
  outcome: r.outcome as Approval["outcome"],
  outcomeText: r.outcome_text,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  replaced: r.replaced === 1,
  tier: r.tier as Tier,
  reason: r.reason,
  review: r.review,
  requesterId: r.requester_id,
  baseTier: r.base_tier as Tier | null,
  reasonCode: r.reason_code,
  reviewCode: r.review_code as ReviewCode | null,
  panel: r.panel === 1,
  reviewFirst: (r.review_first as ReviewFirst | null) ?? null,
});

/** One card as the owner saw it in a batch: its id and the digest of exactly what it runs. */
export type BatchItem = { id: string; digest: string };
/** The most cards one batch decides (the board's multiselect and a Telegram list). */
export const BATCH_MAX = 10;
export const BatchItemsSchema = z
  .array(z.object({ id: z.string().regex(/^A[0-9a-f]{8}$/), digest: z.string().regex(/^[0-9a-f]{40}$/) }).strict())
  .min(1)
  .max(BATCH_MAX)
  .refine((xs) => new Set(xs.map((x) => x.id)).size === xs.length, "each card once");
export type BatchResult = { ok: true; approvals: Approval[] } | { ok: false; reason: string };

/**
 * The instance's `batch_approvals` setting (grants table, read per use): off is the kill switch; every card is then decided
 * on its own, as before.
 */
export function batchesOn(grantsFile = process.env.AIDENHQ_GRANTS_FILE): boolean {
  try {
    return JSON.parse(readFileSync(grantsFile ?? "", "utf8"))?.batch_approvals !== "off";
  } catch {
    return true;
  }
}

/** How a candidate card is named in a reply: its id, action and distinguishing target. */
const describeCard = (a: Approval) => `${a.id} (${a.action}) ${a.target || "no target"}`;

/**
 * Whether a typed selector names this card: its id, one of a merge's PR URLs or numbers, or its target (repo and branch).
 * A PR selector only matches a merge card, so "#10" can't match an unrelated target.
 */
function selectedBy(a: Approval, selector: string): boolean {
  const s = selector.trim().toLowerCase();
  if (!s) return false;
  if (/^a[0-9a-f]{8}$/i.test(s)) return a.id.toLowerCase() === s;
  const url = /^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)$/i.exec(s);
  const repoPr = /^([\w.-]+\/[\w.-]+)#(\d+)$/i.exec(s);
  const pr = /^(?:pr\s*)?#?\s*(\d+)$/i.exec(s);
  if (url || repoPr || pr) {
    if (a.action !== "merge") return false;
    const prs = (a.args as any)?.prs;
    if (Array.isArray(prs) && prs.length) {
      const repo = url ? `${url[1]}/${url[2]}`.toLowerCase() : repoPr?.[1]?.toLowerCase();
      const number = Number(url?.[3] ?? repoPr?.[2] ?? pr?.[1]);
      return prs.some((p: any) => Number(p?.number) === number && (!repo || String(p?.repo ?? "").toLowerCase() === repo) && (!url || String(p?.url ?? "").toLowerCase() === s));
    }
  }
  const target = a.target.toLowerCase();
  return target === s || target.includes(s);
}

export class Approvals {
  constructor(
    private db: DatabaseSync,
    private events?: Events,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY, issue_id TEXT NOT NULL, identifier TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL,
      digest TEXT NOT NULL, args TEXT NOT NULL, sentence TEXT NOT NULL, reads TEXT NOT NULL, changes TEXT NOT NULL,
      cost TEXT NOT NULL, details TEXT NOT NULL, requested_by TEXT NOT NULL, state TEXT NOT NULL, decided_by TEXT,
      decided_at TEXT, used_at TEXT, outcome TEXT, outcome_text TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
      replaced INTEGER NOT NULL DEFAULT 0, claim_nonce TEXT);
      CREATE INDEX IF NOT EXISTS approvals_issue ON approvals (issue_id, action, state);`);
    const columns = (db.prepare("PRAGMA table_info(approvals)").all() as { name: string }[]).map((c) => c.name);
    if (!columns.includes("tier")) db.exec("ALTER TABLE approvals ADD COLUMN tier INTEGER NOT NULL DEFAULT 2");
    if (!columns.includes("reason")) db.exec("ALTER TABLE approvals ADD COLUMN reason TEXT NOT NULL DEFAULT ''");
    if (!columns.includes("review")) db.exec("ALTER TABLE approvals ADD COLUMN review TEXT");
    if (!columns.includes("requester_id")) db.exec("ALTER TABLE approvals ADD COLUMN requester_id TEXT");
    if (!columns.includes("base_tier")) db.exec("ALTER TABLE approvals ADD COLUMN base_tier INTEGER");
    if (!columns.includes("reason_code")) db.exec("ALTER TABLE approvals ADD COLUMN reason_code TEXT");
    if (!columns.includes("review_code")) db.exec("ALTER TABLE approvals ADD COLUMN review_code TEXT");
    if (!columns.includes("panel")) db.exec("ALTER TABLE approvals ADD COLUMN panel INTEGER NOT NULL DEFAULT 0");
    if (!columns.includes("review_first")) db.exec("ALTER TABLE approvals ADD COLUMN review_first TEXT");
    // A batch the owner channel showed in Telegram: the exact cards (id and digest), decided at most once within 24h.
  }

  private changed(issueId?: string) {
    this.events?.emit("approvals", issueId);
  }

  /**
   * The owner's veto (owner, 2026-11-14): their latest decision of this action on this task was a no, so every later request
   * is theirs (Tier 2) until they say yes; and a no on exactly this content (digest) holds until they approve that same
   * content, whatever else they approved since. The AI reviewer's rejections never make a request the owner's, nor does a
   * watcher's no on a stale or duplicate card (`stale:watcher`).
   * (An approved card a newer request replaced is `expired` but still decided: it counts as their yes.)
   */
  ownerVetoed(ref: string, action: Action, digest?: string, args?: unknown): boolean {
    const owner = "(issue_id = ? OR identifier = ?) AND action = ? AND decided_by IS NOT NULL AND decided_by NOT LIKE 'reviewer:%' AND decided_by NOT LIKE 'auto:%' AND decided_by NOT LIKE 'stale:%'";
    const rows = (this.db.prepare(`SELECT * FROM approvals WHERE ${owner} AND state IN ('approved','used','expired','rejected') ORDER BY decided_at DESC, rowid DESC`).all(ref, ref.toUpperCase(), action) as unknown as Row[]).map(toApproval);
    if (rows[0]?.state === "rejected") return true;
    // The same content: the digest, or the patch keys whatever the commits (a rebased or renamed resubmission).
    const patches = patchesOf(action, args);
    // Fail closed: a branch or PR request without patch keys can't be told apart from a vetoed one.
    if (CONTENT_KEYED.includes(action) && !patches && rows.some((r) => r.state === "rejected")) return true;
    const same = rows.find((r) => (digest && r.digest === digest) || (patches && patchesOf(r.action, r.args) === patches));
    return same?.state === "rejected";
  }

  get(id: string): Approval | undefined {
    const r = this.db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as Row | undefined;
    return r && toApproval(r);
  }

  /**
   * File a request. The same request (task, action, digest) still open returns the existing record; a changed one replaces
   * the open record for that task, action and target (a changed request needs a new approval), so a typed reply is never
   * ambiguous. A request for a different target (another PR or branch) is a separate card and never expires one for that
   * target. A card naming several targets replaces only a card naming exactly the same set.
   */
  request(req: Request, now = new Date()): Approval {
    const iso = now.toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const open = (this.db.prepare("SELECT * FROM approvals WHERE issue_id = ? AND action = ? AND state IN ('pending','approved') AND expires_at > ?").all(req.issueId, req.action, iso) as unknown as Row[]).map(toApproval);
      const same = open.find((a) => a.digest === req.digest);
      if (same) {
        this.db.exec("COMMIT");
        return same;
      }
      const key = targetKey(req.action, req.target, req.args);
      const replacing = open.filter((a) => targetKey(a.action, a.target, a.args) === key);
      const veto = req.tier === 1 && this.ownerVetoed(req.issueId, req.action, req.digest, req.args);
      // The owner's veto makes it theirs on its merits: the reviewer still reads it first, then the owner decides either way.
      const tier = req.tier ?? 2;
      const reviewFirst = tier === 1 ? (veto ? "owner" : (req.reviewFirst ?? null)) : null;
      for (const a of replacing) this.db.prepare("UPDATE approvals SET state = 'expired', outcome_text = 'replaced by a newer request' WHERE id = ?").run(a.id);
      const id = `A${randomBytes(4).toString("hex")}`;
      const reason = veto ? `the owner rejected this action on this task, so they decide (was: ${req.reason ?? ""})` : (req.reason ?? "");
      const code = veto ? "owner-veto" : ruleCode(req.reasonCode);
      this.db
        .prepare("INSERT INTO approvals (id, issue_id, identifier, action, target, digest, args, sentence, reads, changes, cost, details, requested_by, state, created_at, expires_at, replaced, tier, reason, requester_id, base_tier, reason_code, panel, review_first) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(id, req.issueId, req.identifier, req.action, req.target, req.digest, JSON.stringify(req.args ?? null), req.sentence, req.reads, req.changes, req.cost, req.details, req.requestedBy, iso, new Date(now.getTime() + TTL_MS).toISOString(), replacing.length ? 1 : 0, tier, reason.slice(0, 1000), req.requesterId ?? null, req.baseTier ?? null, code, req.panel ? 1 : 0, reviewFirst);
      this.db.exec("COMMIT");
      this.changed(req.issueId);
      return this.get(id)!;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** A Tier 0 audit row: what the runner already ran, by which rule, and how it went. State `auto`: nothing decides or claims it. */
  audit(req: Request & { rule: string; ok: boolean; outcomeText: string }, now = new Date()): Approval {
    const iso = now.toISOString();
    const id = `A${randomBytes(4).toString("hex")}`;
    this.db
      .prepare("INSERT INTO approvals (id, issue_id, identifier, action, target, digest, args, sentence, reads, changes, cost, details, requested_by, state, decided_by, decided_at, used_at, outcome, outcome_text, created_at, expires_at, tier, reason, requester_id, base_tier, reason_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'auto', ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)")
      .run(id, req.issueId, req.identifier, req.action, req.target, req.digest, JSON.stringify(req.args ?? null), req.sentence, req.reads, req.changes, req.cost, req.details, req.requestedBy, `auto:${req.rule}`, iso, iso, req.ok ? "applied" : "failed", req.outcomeText.slice(0, 4000), iso, iso, (req.reason ?? "").slice(0, 1000), req.requesterId ?? null, req.baseTier ?? null, ruleCode(req.rule));
    this.changed(req.issueId);
    return this.get(id)!;
  }

  /**
   * The AI reviewer's verdict on a pending Tier 1 record, bound to its digest: approve or reject decides it (decided_by
   * `reviewer:<model>`, or `reviewer:<model>+<second>` when a second reviewer approved too); escalate makes it Tier 2 (the
   * owner's), with the note. Anything else is refused, and so is an approval of a panel record (authority-expanding) that
   * names no second reviewer of another model. `code` is the reviewer's reason code (reviewer_unsure on a reject: two
   * reviewers couldn't tell, so it went back to the agent; panel_split: the two reviewers disagreed).
   */
  review(id: string, v: { digest: string; decision: "approve" | "reject" | "escalate"; reason: string; model: string; second?: string; code?: ReviewCode }, now = new Date()): { ok: true; approval: Approval } | { ok: false; reason: string } {
    const a = this.get(id);
    if (!a) return { ok: false, reason: "no such approval" };
    if (shown(a, now.getTime()) !== "pending") return { ok: false, reason: `this approval is ${shown(a, now.getTime())}` };
    if (a.tier !== 1) return { ok: false, reason: "only a Tier 1 record is the reviewer's" };
    if (a.digest !== v.digest) return { ok: false, reason: "the digest doesn't match this record" };
    if (v.second !== undefined && v.second === v.model) return { ok: false, reason: "the second reviewer must be another model" };
    if (a.panel && v.decision === "approve" && !v.second) return { ok: false, reason: "an authority-expanding record needs a second reviewer's approval too" };
    // New module authority (spec §5.7), and every review-first card: the reviewer goes first, but only the owner approves it.
    if (v.decision === "approve" && ownerAfterReview(a)) return { ok: false, reason: "this apply adds module authority: after the reviewer, the owner decides (escalate it)" };
    if (v.decision === "approve" && a.reviewFirst) return { ok: false, reason: "after the reviewer, the owner decides this card (escalate it)" };
    // Tier 2 on its merits: the owner sees the reviewer's reject too; only code's own refusals (it moved, refused by code) close it.
    if (v.decision === "reject" && a.reviewFirst === "owner" && !["stale_head", "refused_by_code"].includes(v.code ?? "")) return { ok: false, reason: "this card is the owner's on its merits: escalate the reject to them" };
    const by = `reviewer:${v.model}${v.decision === "approve" && v.second ? `+${v.second}` : ""}`;
    const note = v.reason.slice(0, 2000);
    const state = v.decision === "approve" ? "approved" : v.decision === "reject" && v.code === "stale_head" ? "stale" : "rejected";
    const r =
      v.decision === "escalate"
        ? this.db.prepare("UPDATE approvals SET tier = 2, review = ?, review_code = ? WHERE id = ? AND state = 'pending' AND tier = 1").run(note, v.code ?? null, id)
        : this.db.prepare("UPDATE approvals SET state = ?, decided_by = ?, decided_at = ?, review = ?, review_code = ? WHERE id = ? AND state = 'pending' AND tier = 1").run(state, by, now.toISOString(), note, v.code ?? null, id);
    if (r.changes !== 1) return { ok: false, reason: "it changed meanwhile" };
    this.changed(a.issueId);
    return { ok: true, approval: this.get(id)! };
  }

  /**
   * The reviewer found a pending Tier 1 record authority-expanding: from now on it needs a second reviewer's approval too.
   * Only ever set, never cleared; bound to the digest like a verdict.
   */
  markPanel(id: string, digest: string): { ok: true; approval: Approval } | { ok: false; reason: string } {
    const r = this.db.prepare("UPDATE approvals SET panel = 1 WHERE id = ? AND digest = ? AND state = 'pending' AND tier = 1").run(id, digest);
    if (r.changes !== 1) return { ok: false, reason: "no pending Tier 1 record with that digest" };
    return { ok: true, approval: this.get(id)! };
  }

  /** Records filed or decided since then, oldest first (the daily digest). */
  since(iso: string): Approval[] {
    return (this.db.prepare("SELECT * FROM approvals WHERE created_at > ? OR decided_at > ? ORDER BY created_at").all(iso, iso) as unknown as Row[]).map(toApproval);
  }

  /** Open first (pending, then approved and running), then the newest decided ones. */
  list(limit = 50): Approval[] {
    return (this.db.prepare("SELECT * FROM approvals ORDER BY CASE WHEN state = 'pending' THEN 0 WHEN state IN ('approved','used') AND outcome IS NULL THEN 1 ELSE 2 END, created_at DESC LIMIT ?").all(limit) as unknown as Row[]).map(toApproval);
  }

  /** Every record on a task, by its id or identifier, newest first (an agent's heartbeat reads them). */
  on(ref: string): Approval[] {
    return (this.db.prepare("SELECT * FROM approvals WHERE issue_id = ? OR identifier = ? ORDER BY created_at DESC LIMIT 50").all(ref, ref.toUpperCase()) as unknown as Row[]).map(toApproval);
  }

  /** Pending (and not expired) records on a task, by its id or identifier. */
  pendingOn(ref: string, now = Date.now()): Approval[] {
    return (this.db.prepare("SELECT * FROM approvals WHERE (issue_id = ? OR identifier = ?) AND state = 'pending' AND expires_at > ? ORDER BY created_at").all(ref, ref.toUpperCase(), new Date(now).toISOString()) as unknown as Row[]).map(toApproval);
  }

  /** Ids of the tasks with a pending record (chat state "waiting for approval"). */
  awaiting(now = Date.now()): Set<string> {
    return new Set((this.db.prepare("SELECT DISTINCT issue_id FROM approvals WHERE state = 'pending' AND tier = 2 AND expires_at > ?").all(new Date(now).toISOString()) as { issue_id: string }[]).map((r) => r.issue_id));
  }

  /** Counts for the metrics endpoint (monitoring.ts): cards created and decided since `since` by tier and state, and pending by tier. */
  stats(since: string, now = Date.now()): { created: { tier: number; n: number }[]; decided: { tier: number; state: string; n: number }[]; pending: { tier: number; n: number }[] } {
    const q = (sql: string, ...a: string[]) => this.db.prepare(sql).all(...a) as never;
    return {
      created: q("SELECT tier, COUNT(*) AS n FROM approvals WHERE created_at >= ? GROUP BY tier", since),
      decided: q("SELECT tier, state, COUNT(*) AS n FROM approvals WHERE decided_at >= ? GROUP BY tier, state", since),
      pending: q("SELECT tier, COUNT(*) AS n FROM approvals WHERE state = 'pending' AND expires_at > ? GROUP BY tier", new Date(now).toISOString()),
    };
  }

  /** Pending records (not expired) of one tier, oldest first: Tier 2 is what the owner-channel sends as cards; Tier 1, the reviewer's queue. */
  pending(now = Date.now(), tier: 1 | 2 = 2): Approval[] {
    return (this.db.prepare("SELECT * FROM approvals WHERE state = 'pending' AND tier = ? AND expires_at > ? ORDER BY created_at").all(tier, new Date(now).toISOString()) as unknown as Row[]).map(toApproval);
  }

  /** Approved records an applier may claim (not expired). */
  approved(actions: readonly Action[], now = Date.now()): Approval[] {
    return (this.db.prepare("SELECT * FROM approvals WHERE state = 'approved' AND expires_at > ? ORDER BY decided_at").all(new Date(now).toISOString()) as unknown as Row[]).map(toApproval).filter((a) => actions.includes(a.action));
  }

  /** The owner's decision, once, on a pending record that hasn't expired. `by` is set by the caller's server code. */
  decide(id: string, decision: "approve" | "reject", by: string, now = new Date()): { ok: true; approval: Approval } | { ok: false; reason: string } {
    const r = this.db
      .prepare("UPDATE approvals SET state = ?, decided_by = ?, decided_at = ? WHERE id = ? AND state = 'pending' AND expires_at > ?")
      .run(decision === "approve" ? "approved" : "rejected", by, now.toISOString(), id, now.toISOString());
    const a = this.get(id);
    if (!a) return { ok: false, reason: "no such approval" };
    if (r.changes !== 1) return { ok: false, reason: `this approval is ${shown(a, now.getTime())}${a.outcomeText && a.state === "expired" ? ` (${a.outcomeText})` : ""}` };
    this.changed(a.issueId);
    return { ok: true, approval: a };
  }

  /** Why a card can't be decided in a batch as shown: gone, no longer pending, the reviewer's, or changed since. */
  private unbatchable(x: BatchItem, now: number): string | undefined {
    const a = this.get(x.id);
    if (!a) return `${x.id} doesn't exist`;
    const s = shown(a, now);
    if (s !== "pending") return `${a.identifier} (${a.id}) is ${s}`;
    if (a.tier !== 2) return `${a.identifier} (${a.id}) is with the AI reviewer`;
    if (a.digest !== x.digest) return `${a.identifier} (${a.id}) changed since it was shown`;
    return undefined;
  }

  /**
   * The owner's decision on several cards at once, exactly as they were shown (id and digest each). All or nothing: if any
   * card is no longer pending, not the owner's (Tier 2), or changed since, nothing is decided and the reason names each such
   * card. Each card stays its own record: claimed, applied and reported on its own. `by` is set by the caller's server code.
   */
  decideMany(items: BatchItem[], decision: "approve" | "reject", by: string, now = new Date()): BatchResult {
    const iso = now.toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const bad = items.map((x) => this.unbatchable(x, now.getTime())).filter((r): r is string => Boolean(r));
      if (bad.length) {
        this.db.exec("ROLLBACK");
        return { ok: false, reason: `nothing was decided: ${bad.join("; ")}` };
      }
      const update = this.db.prepare("UPDATE approvals SET state = ?, decided_by = ?, decided_at = ? WHERE id = ? AND state = 'pending' AND tier = 2 AND digest = ? AND expires_at > ?");
      for (const x of items) if (update.run(decision === "approve" ? "approved" : "rejected", by, iso, x.id, x.digest, iso).changes !== 1) throw new Error(`${x.id} changed while deciding`);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    const approvals = items.map((x) => this.get(x.id)!);
    for (const issue of new Set(approvals.map((a) => a.issueId))) this.changed(issue);
    return { ok: true, approvals };
  }

  /**
   * A typed reply decides an open record on a task. Without a target it acts only when exactly one is open; with a card id
   * or target (PR link/number, repo+branch) it acts on the one that matches, even when several are open. Several without a
   * target, or a selector that matches none or several, decides nothing and says which cards are open. It approves only a
   * request the owner could have seen as it is: one that replaced an earlier request on the task (the agent changed it
   * after a card went out) needs a tap on its own card, which carries its id. Rejecting is always allowed.
   */
  decideByReply(ref: string, decision: "approve" | "reject", by: string, nowOrTarget: Date | string = new Date(), target?: string): { ok: true; approval: Approval } | { ok: false; reason: string } {
    const now = nowOrTarget instanceof Date ? nowOrTarget : new Date();
    const pick = (typeof nowOrTarget === "string" ? nowOrTarget : target)?.trim();
    const asCard = /^A[0-9a-f]{8}$/i.test(ref);
    const only = asCard ? this.get(ref) : undefined;
    const open = asCard
      ? only && only.state === "pending" && Date.parse(only.expiresAt) > now.getTime()
        ? [only]
        : []
      : this.pendingOn(ref, now.getTime());
    const label = asCard ? only?.identifier ?? ref : ref.toUpperCase();
    if (!open.length) return { ok: false, reason: asCard ? `no open approval ${ref}` : `nothing on ${label} is waiting for approval` };
    const candidates = pick ? open.filter((a) => selectedBy(a, pick)) : open;
    if (!candidates.length) return { ok: false, reason: `no open approval on ${label} matches "${pick}"; open: ${open.map(describeCard).join("; ")}` };
    if (candidates.length > 1) return { ok: false, reason: `several approvals wait on ${label}; name one by card id or target: ${candidates.map(describeCard).join("; ")}` };
    const a = candidates[0]!;
    if (decision === "approve" && a.replaced) return { ok: false, reason: `the request on ${a.identifier} changed after it was first shown; look at the new card and tap Approve there` };
    return this.decide(a.id, decision, by, now);
  }

  /**
   * approved → used, atomically: a record for exactly one caller, with a nonce only that caller gets. It runs it once and
   * reports the outcome with the nonce (finish), so nobody else can write the outcome on the card.
   */
  claim(id: string, now = new Date()): (Approval & { nonce: string }) | undefined {
    const nonce = randomBytes(16).toString("hex");
    const r = this.db.prepare("UPDATE approvals SET state = 'used', used_at = ?, claim_nonce = ? WHERE id = ? AND state = 'approved' AND expires_at > ?").run(now.toISOString(), nonce, id, now.toISOString());
    if (r.changes !== 1) return undefined;
    const a = this.get(id)!;
    this.changed(a.issueId);
    return { ...a, nonce };
  }

  /** The claimer's outcome, once. A repeat of the report is a no-op (the applier retries until the board takes it). */
  finish(id: string, nonce: string, ok: boolean, text: string): boolean {
    const r = this.db.prepare("UPDATE approvals SET outcome = ?, outcome_text = ? WHERE id = ? AND state = 'used' AND outcome IS NULL AND claim_nonce = ?").run(ok ? "applied" : "failed", text.slice(0, 4000), id, nonce);
    if (r.changes === 1) {
      this.changed(this.get(id)?.issueId);
      return true;
    }
    const a = this.db.prepare("SELECT outcome, claim_nonce FROM approvals WHERE id = ?").get(id) as { outcome: string | null; claim_nonce: string | null } | undefined;
    return a?.outcome != null && a.claim_nonce === nonce;
  }
}

/**
 * A module write kind's record (the kernel's kernel.db, lean-core 2d): until 2f and 3a the board shows it with its own cards
 * and forwards the owner's decisions and the reviewer's verdicts on it to the kernel, which keeps it and runs it.
 */
export type KernelRecord = {
  id: string; kind: string; args: unknown; digest: string; tier: Tier; merit?: Tier | null; panel: boolean; task: string; state: string; review: string | null;
  decided_by: string | null; outcome: { ok: boolean; text: string } | null; created_at: string; updated_at: string;
  card: { sentence: string; changes: string; reads: string; cost: string; details: string; reason?: string }; requester: { agent: string; key: string; name: string };
};
export const KERNEL_ID = /^k-[0-9a-f]{16}$/;
/** The two ported kinds keep their card names, so the reviewer reads them as it always has. */
const LEGACY: Record<string, string> = { "apps-platform.deploy": "deploy_app", "apps-platform.run": "app_run" };
const KERNEL_STATE: Record<string, State> = { review: "pending", owner: "pending", approved: "approved", claimed: "used", done: "used", failed: "used", unknown: "used", rejected: "rejected", stale: "stale", cancelled: "expired" };

export function recordApproval(r: KernelRecord): Approval {
  const decided = r.decided_by ? r.updated_at : null;
  return {
    id: r.id, issueId: r.task, identifier: r.task, action: (LEGACY[r.kind] ?? r.kind) as Action, target: String((r.args as { name?: unknown })?.name ?? r.kind), digest: r.digest, args: r.args,
    sentence: r.card.sentence, changes: r.card.changes, reads: r.card.reads, cost: r.card.cost, details: r.card.details, requestedBy: r.requester.name || r.requester.key,
    tier: r.state === "review" ? 1 : r.state === "owner" ? 2 : r.tier, panel: r.panel, reason: r.card.reason ?? "", requesterId: r.requester.agent || null,
    baseTier: r.merit ?? r.tier, reviewFirst: r.merit === 2 ? "owner" : null, review: r.review, reasonCode: null, reviewCode: null, state: KERNEL_STATE[r.state] ?? "expired", decidedBy: r.decided_by, decidedAt: decided,
    usedAt: ["claimed", "done", "failed", "unknown"].includes(r.state) ? r.updated_at : null, outcome: r.state === "done" ? "applied" : r.state === "failed" || r.state === "unknown" ? "failed" : null,
    outcomeText: r.outcome?.text ?? null, createdAt: r.created_at, expiresAt: "9999-12-31T00:00:00.000Z", replaced: false,
  };
}

export type Advisory = { id: string; module: string; severity: string; fixed: string; summary: string; url: string };

/** The kernel's record routes, with the board's key (gateway_board_key). Throws with the kernel's reason. */
export function kernelRecords(k: { url: string; token: string } | undefined) {
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    if (!k) throw new Error("the board has no kernel configured (AIDENHQ_KERNEL_URL, gateway_board_key)");
    const res = await fetch(`${k.url}${path}`, { method, headers: { authorization: `Bearer ${k.token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15_000) });
    const j = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) throw Object.assign(new Error(String(j?.error?.message ?? `the kernel answered ${res.status}`)), { status: res.status });
    return j as T;
  };
  return {
    enabled: Boolean(k),
    list: async (state: "review" | "owner" | "recent", task?: string) => (await call<{ records: KernelRecord[] }>("GET", `/v1/writes?state=${state}${task ? `&task=${encodeURIComponent(task)}` : ""}`)).records.map(recordApproval),
    get: async (id: string) => recordApproval(await call<KernelRecord>("GET", `/v1/writes/${id}`)),
    review: async (id: string, v: unknown) => recordApproval(await call<KernelRecord>("POST", `/v1/writes/${id}/review`, v)),
    panel: async (id: string, digest: string) => recordApproval(await call<KernelRecord>("POST", `/v1/writes/${id}/panel`, { digest })),
    /** Marketplace advisories open against installed modules (lean-core 4e): Settings > Modules shows them as a banner. */
    advisories: async () => (await call<{ advisories: Advisory[] }>("GET", "/v1/advisories")).advisories,
  };
}
