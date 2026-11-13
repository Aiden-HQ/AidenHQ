// Approval records: the exact request (action, target, digest, the args its executor replays),
// approved or rejected once by the owner, consumed once atomically by whoever applies it. Nothing here knows who the owner
// is: the routes check that (app.ts); this file only keeps the state machine honest.
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { Events } from "./events.js";
import { TIER_RULE, type ReviewCode } from "./reason-codes.js";

export const ACTIONS = ["apply", "push", "pr", "merge", "deploy_app", "app_run", "raise_cap"] as const;
export type Action = (typeof ACTIONS)[number];
/** Applied by the board on the tap; the rest by the runner, which claims approved records on its poll. */
export const BOARD_ACTIONS: readonly Action[] = ["deploy_app", "app_run", "raise_cap"];

// "auto": a Tier 0 audit row: the runner already ran it; never decided, never claimable.
export type State = "pending" | "approved" | "rejected" | "expired" | "used" | "auto";
/**
 * Tiers (the tiered-approvals design): 0 ran at once (an audit row), 1 the AI reviewer decides, 2 the owner decides.
 * A record filed without a tier is 2.
 */
export type Tier = 0 | 1 | 2;
/** The reviewer models a verdict may name (decided_by `reviewer:<model>`). */
export const REVIEWER_MODELS = ["moonshotai/kimi-k3.1-pro", "~z-ai/glm-latest"] as const;
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
}

/** A tier rule as a reason code: kebab-case words only (classifier output, never agent text); anything else is dropped. */
const ruleCode = (rule: string | null | undefined) => (rule && TIER_RULE.test(rule) ? rule : null);

/** The stable reason for a request whose change is already satisfied: no card is filed, the task gets the evidence. */
export const ALREADY_APPLIED = "already_applied";

export interface Approval extends Omit<Request, "tier" | "reason" | "requesterId" | "baseTier" | "reasonCode"> {
  tier: Tier;
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
  /** It replaced an open request on the same task and action: a typed reply can't approve it, only a tap on its card. */
  replaced: boolean;
}

// The runner's requests: args validated per action, and the card built here from them (never the caller's prose). Its one
// free-text part, an apply's diff, is rechecked by the runner against the approved commit before anything lands.
const SHA = z.string().regex(/^[0-9a-f]{40}$/);
const REPO = z.string().regex(/^[\w.-]+\/[\w.-]+$/);
const BRANCH = z.object({ repo: REPO, branch: z.string().min(1).max(200).regex(/^[^\s`]+$/), sha: SHA }).strict();
export const ARGS = {
  push: z.object({ only: z.array(BRANCH).min(1).max(30) }).strict(),
  pr: z.object({ only: z.array(BRANCH).min(1).max(30), text: z.object({ title: z.string().max(300), body: z.string().max(60_000) }).strict().optional() }).strict(),
  merge: z.object({ prs: z.array(z.object({ repo: REPO, number: z.number().int().positive(), url: z.string().regex(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/), head: z.string().regex(/^[0-9a-f]{40}$/).optional(), noReview: z.literal(true).optional() }).strict()).min(1).max(30), gap: z.number().int().min(0).max(720).optional() }).strict(),
  apply: z.object({ repo: REPO, branch: z.string().min(1).max(200).regex(/^[^\s`]+$/), sha: SHA, files: z.array(z.string().max(300)).min(1).max(200) }).strict(),
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
    return { ...base, target: list.join(", ").slice(0, 500), sentence: action === "push" ? `Push ${list.length} branch${list.length === 1 ? "" : "es"} to GitHub.` : `Push and open (or update) a draft PR for ${list.length} branch${list.length === 1 ? "" : "es"}.`, changes: list.join("\n"), details: `${list.join("\n")}${text}` };
  }
  if (action === "merge") {
    const prs = args.prs as { url: string; head?: string; noReview?: true }[];
    const urls = prs.map((p) => p.url);
    const lines = prs.map((p) => `${p.url}${p.head ? ` at ${p.head.slice(0, 12)}` : ""}${p.noReview ? " (your tap is its only review)" : " (also needs GitHub approval)"}`);
    return { ...base, target: urls.join(", ").slice(0, 500), sentence: `Merge ${urls.length} pull request${urls.length === 1 ? "" : "s"}, one at a time${args.gap ? `, ${args.gap} minutes apart` : ""}.`, changes: `Merges, in this order, only at these commits and with green checks:\n${lines.join("\n")}`, details: lines.join("\n") };
  }
  return { ...base, target: `${args.repo} ${args.branch}`, sentence: `Apply a change to the fleet's configuration (commit ${args.sha.slice(0, 12)}).`, changes: `Lands ${args.sha.slice(0, 12)} on ${args.repo}'s main and re-applies the live fleet. Files: ${args.files.join(", ")}`, cost: "No model cost; services restart.", details: diff };
}

/** An app_run: apps-mcp's checked request (owner, script in package.json at the running commit), filed with the apps token. */
export const RunRequestSchema = z
  .object({
    agent_id: z.string().min(1).max(64),
    task: z.string().min(1).max(64),
    name: z.string().regex(/^[a-z][a-z0-9-]{1,30}$/),
    script: z.string().regex(/^[a-z0-9][a-z0-9:_-]{0,63}$/),
    service: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/),
    sha: SHA,
    // Shown in full on the card, never shortened or cleaned: what the owner reads is exactly what runs.
    command: z.string().min(1).max(500).refine((c) => !/[\p{Cc}\p{Cf}]/u.test(c), "the script's command has control or format characters"),
    reason: z.string().max(2000),
  })
  .strict();
export type RunRequest = z.infer<typeof RunRequestSchema>;

/** Printable, one line, capped: for app- or agent-written text, shown only in its own labelled field. */
const oneLine = (s: string, max: number) => s.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim().slice(0, max);

/** The card for an app_run (the args the board replays: name, script, service, sha), and its digest (args plus the command). */
export function runCard(r: RunRequest): Pick<Request, "target" | "digest" | "args" | "sentence" | "reads" | "changes" | "cost" | "details"> {
  const args = { name: r.name, script: r.script, service: r.service, sha: r.sha };
  const command = r.command;
  return {
    target: r.name,
    args,
    digest: createHash("sha256").update(JSON.stringify({ action: "app_run", args, command })).digest("hex").slice(0, 40),
    sentence: `Run \`npm run ${r.script}\` once in app ${r.name}.`,
    reads: "Whatever the script reads (the app's own data and secrets).",
    changes: `Runs once inside ${r.name}'s running ${r.service} container at commit ${r.sha.slice(0, 12)}; it can change the app's data. 10-minute limit. Refused if the app is redeployed before it runs.`,
    cost: "No model cost.",
    details: `app: ${r.name}\nservice: ${r.service}\ncommit: ${r.sha}\nruns: npm run ${r.script}\nScript (from the app's package.json): ${command}\nReason (written by the requesting agent): ${oneLine(r.reason, 300)}`,
  };
}

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
 * The raise_cap request: always Tier 2 (the owner's tap; no reviewer, no autonomy setting lowers it). Its args are the
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
    tier: 2,
    baseTier: 2,
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
 * Whether a deploy's diff touches a migration, .sql or schema file (such a deploy is Tier 2, the owner's). Fails closed:
 * no SQL is parsed, so a destructive statement can't hide from it. File names come only from `diff --git` headers, which a
 * hunk line (always prefixed with +, - or a space) can't forge.
 */
export function touchesMigrations(diff: string): boolean {
  return diff.split("\n").some((line) => line.startsWith("diff --git ") && /migrat|\.sql\b|schema/i.test(line));
}

/** The daily digest: Tier 0 runs, the reviewer's verdicts and escalations in the window; null when there were none. */
export function digestText(records: Approval[]): string | null {
  // target (agent-named branches and repos), reason and the reviewer's note (model output over agent text) are untrusted:
  // printable, links removed, markdown escaped, and labelled as reported rather than said by the board.
  const plain = (s: string, max: number) => oneLine(s, max).replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[link removed]").replace(/[\\`*_[\]()~>#|<!]/g, "\\$&");
  const line = (a: Approval, what: string, note: string) => `• ${a.identifier} ${a.action} · target (as reported): ${plain(a.target, 80)} · ${what}: ${plain(note, 200)}`;
  const auto = records.filter((a) => a.state === "auto").map((a) => line(a, `ran by rule ${a.decidedBy?.replace(/^auto:/, "")}, ${a.outcome ?? "?"}; runner's reason`, a.reason));
  const reviewed = records.filter((a) => a.decidedBy?.startsWith("reviewer:")).map((a) => line(a, `${a.state === "rejected" ? "rejected" : "approved"} by ${a.decidedBy}; reviewer's note`, a.review ?? ""));
  const escalated = records.filter((a) => a.tier === 2 && a.review).map((a) => line(a, "sent to you; reviewer's note", a.review!));
  if (!auto.length && !reviewed.length && !escalated.length) return null;
  const part = (title: string, xs: string[]) => (xs.length ? [`${title} (${xs.length})`, ...xs.slice(0, 20)].join("\n") : "");
  return ["🧾 **Approvals digest** (last 24h, decided without you)", part("Ran at once (Tier 0)", auto), part("The reviewer decided (Tier 1)", reviewed), part("Escalated to you", escalated)].filter(Boolean).join("\n\n");
}

/** What a person sees: the stored state, plus expired (past its 7 days) and unknown (used, never reported back). */
export type ShownState = State | "unknown";
export function shown(a: Approval, now = Date.now()): ShownState {
  if ((a.state === "pending" || a.state === "approved") && Date.parse(a.expiresAt) <= now) return "expired";
  if (a.state === "used" && !a.outcome && a.usedAt && now - Date.parse(a.usedAt) > UNKNOWN_AFTER_MS) return "unknown";
  return a.state;
}

/** An exact typed reply: "apply WOR-184", "approve WOR-184" or "reject WOR-184" (any case, one trailing . or !). */
export function parseReply(text: string): { decision: "approve" | "reject"; ref: string } | undefined {
  const m = /^\s*(apply|approve|reject)\s+([A-Za-z][A-Za-z0-9]*-\d+)\s*[.!]?\s*$/i.exec(text);
  return m ? { decision: m[1]!.toLowerCase() === "reject" ? "reject" : "approve", ref: m[2]!.toUpperCase() } : undefined;
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
  reason_code: string | null;
  review_code: string | null;
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
const BATCH_TTL_MS = 86_400_000;

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
    // A batch the owner channel showed in Telegram: the exact cards (id and digest), decided at most once within 24h.
    db.exec("CREATE TABLE IF NOT EXISTS approval_batches (id TEXT PRIMARY KEY, items TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT)");
  }

  private changed(issueId?: string) {
    this.events?.emit("approvals", issueId);
  }

  /** Sticky escalation: once the owner or the reviewer rejected this action on this task, every later request is Tier 2. */
  rejectedBefore(ref: string, action: Action): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM approvals WHERE (issue_id = ? OR identifier = ?) AND action = ? AND state = 'rejected' LIMIT 1").get(ref, ref.toUpperCase(), action));
  }

  get(id: string): Approval | undefined {
    const r = this.db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as Row | undefined;
    return r && toApproval(r);
  }

  /**
   * File a request. The same request (task, action, digest) still open returns the existing record; a changed one replaces
   * the open record for that task and action (a changed request needs a new approval), so a typed reply is never ambiguous.
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
      for (const a of open) this.db.prepare("UPDATE approvals SET state = 'expired', outcome_text = 'replaced by a newer request' WHERE id = ?").run(a.id);
      const id = `A${randomBytes(4).toString("hex")}`;
      const sticky = req.tier === 1 && this.rejectedBefore(req.issueId, req.action);
      const tier = sticky ? 2 : (req.tier ?? 2);
      const reason = sticky ? `rejected before on this task, so the owner decides (was: ${req.reason ?? ""})` : (req.reason ?? "");
      const code = sticky ? "sticky" : ruleCode(req.reasonCode);
      this.db
        .prepare("INSERT INTO approvals (id, issue_id, identifier, action, target, digest, args, sentence, reads, changes, cost, details, requested_by, state, created_at, expires_at, replaced, tier, reason, requester_id, base_tier, reason_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(id, req.issueId, req.identifier, req.action, req.target, req.digest, JSON.stringify(req.args ?? null), req.sentence, req.reads, req.changes, req.cost, req.details, req.requestedBy, iso, new Date(now.getTime() + TTL_MS).toISOString(), open.length ? 1 : 0, tier, reason.slice(0, 1000), req.requesterId ?? null, req.baseTier ?? null, code);
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
   * `reviewer:<model>`); escalate makes it Tier 2 (the owner's), with the note. Anything else is refused. `code` is the
   * reviewer's reason code (reviewer_unsure: it couldn't tell, so the owner decides).
   */
  review(id: string, v: { digest: string; decision: "approve" | "reject" | "escalate"; reason: string; model: string; code?: ReviewCode }, now = new Date()): { ok: true; approval: Approval } | { ok: false; reason: string } {
    const a = this.get(id);
    if (!a) return { ok: false, reason: "no such approval" };
    if (shown(a, now.getTime()) !== "pending") return { ok: false, reason: `this approval is ${shown(a, now.getTime())}` };
    if (a.tier !== 1) return { ok: false, reason: "only a Tier 1 record is the reviewer's" };
    if (a.digest !== v.digest) return { ok: false, reason: "the digest doesn't match this record" };
    const note = v.reason.slice(0, 2000);
    const r =
      v.decision === "escalate"
        ? this.db.prepare("UPDATE approvals SET tier = 2, review = ?, review_code = ? WHERE id = ? AND state = 'pending' AND tier = 1").run(note, v.code ?? null, id)
        : this.db.prepare("UPDATE approvals SET state = ?, decided_by = ?, decided_at = ?, review = ?, review_code = ? WHERE id = ? AND state = 'pending' AND tier = 1").run(v.decision === "approve" ? "approved" : "rejected", `reviewer:${v.model}`, now.toISOString(), note, v.code ?? null, id);
    if (r.changes !== 1) return { ok: false, reason: "it changed meanwhile" };
    this.changed(a.issueId);
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
   * A batch the owner channel is about to show in Telegram: the cards as they are now (each pending, Tier 2, digest as
   * given), stored under one id its buttons carry (a button holds 64 bytes, not the list). Refused if any card isn't.
   */
  snapshot(items: BatchItem[], now = new Date()): { ok: true; id: string; approvals: Approval[] } | { ok: false; reason: string } {
    const bad = items.map((x) => this.unbatchable(x, now.getTime())).filter((r): r is string => Boolean(r));
    if (bad.length) return { ok: false, reason: bad.join("; ") };
    const id = `B${randomBytes(4).toString("hex")}`;
    this.db.prepare("INSERT INTO approval_batches (id, items, created_at, expires_at) VALUES (?, ?, ?, ?)").run(id, JSON.stringify(items), now.toISOString(), new Date(now.getTime() + BATCH_TTL_MS).toISOString());
    return { ok: true, id, approvals: items.map((x) => this.get(x.id)!) };
  }

  /** A stored batch, used up: its cards as shown, or undefined when unknown, already used or past its 24 hours. */
  takeBatch(id: string, now = new Date()): BatchItem[] | undefined {
    const iso = now.toISOString();
    if (this.db.prepare("UPDATE approval_batches SET used_at = ? WHERE id = ? AND used_at IS NULL AND expires_at > ?").run(iso, id, iso).changes !== 1) return undefined;
    return JSON.parse((this.db.prepare("SELECT items FROM approval_batches WHERE id = ?").get(id) as { items: string }).items);
  }

  /**
   * An exact typed reply ("apply WOR-184") decides the one pending record on that task. It approves only a request the owner
   * could have seen as it is: one that replaced an earlier request on the task (the agent changed it after a card went out)
   * needs a tap on its own card, which carries its id. Rejecting is always allowed.
   */
  decideByReply(ref: string, decision: "approve" | "reject", by: string, now = new Date()): { ok: true; approval: Approval } | { ok: false; reason: string } {
    const open = this.pendingOn(ref, now.getTime());
    if (!open.length) return { ok: false, reason: `nothing on ${ref.toUpperCase()} is waiting for approval` };
    if (open.length > 1) return { ok: false, reason: `several approvals wait on ${ref.toUpperCase()}; tap the one you mean on the board` };
    const a = open[0]!;
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
