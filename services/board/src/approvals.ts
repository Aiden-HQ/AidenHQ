// Approval records: the exact request (action, target, digest, the args its executor replays),
// approved or rejected once by the owner, consumed once atomically by whoever applies it. Nothing here knows who the owner
// is: the routes check that (app.ts); this file only keeps the state machine honest.
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

export const ACTIONS = ["apply", "push", "pr", "merge", "deploy_app", "app_run"] as const;
export type Action = (typeof ACTIONS)[number];
/** Applied by the board on the tap; the rest by the runner, which claims approved records on its poll. */
export const BOARD_ACTIONS: readonly Action[] = ["deploy_app", "app_run"];

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
}

export interface Approval extends Omit<Request, "tier" | "reason"> {
  tier: Tier;
  reason: string;
  /** The AI reviewer's note: its verdict's reason, or why it escalated. */
  review: string | null;
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
});

export class Approvals {
  constructor(private db: DatabaseSync) {
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
      this.db
        .prepare("INSERT INTO approvals (id, issue_id, identifier, action, target, digest, args, sentence, reads, changes, cost, details, requested_by, state, created_at, expires_at, replaced, tier, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)")
        .run(id, req.issueId, req.identifier, req.action, req.target, req.digest, JSON.stringify(req.args ?? null), req.sentence, req.reads, req.changes, req.cost, req.details, req.requestedBy, iso, new Date(now.getTime() + TTL_MS).toISOString(), open.length ? 1 : 0, tier, reason.slice(0, 1000));
      this.db.exec("COMMIT");
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
      .prepare("INSERT INTO approvals (id, issue_id, identifier, action, target, digest, args, sentence, reads, changes, cost, details, requested_by, state, decided_by, decided_at, used_at, outcome, outcome_text, created_at, expires_at, tier, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'auto', ?, ?, ?, ?, ?, ?, ?, 0, ?)")
      .run(id, req.issueId, req.identifier, req.action, req.target, req.digest, JSON.stringify(req.args ?? null), req.sentence, req.reads, req.changes, req.cost, req.details, req.requestedBy, `auto:${req.rule}`, iso, iso, req.ok ? "applied" : "failed", req.outcomeText.slice(0, 4000), iso, iso, (req.reason ?? "").slice(0, 1000));
    return this.get(id)!;
  }

  /**
   * The AI reviewer's verdict on a pending Tier 1 record, bound to its digest: approve or reject decides it (decided_by
   * `reviewer:<model>`); escalate makes it Tier 2 (the owner's), with the note. Anything else is refused.
   */
  review(id: string, v: { digest: string; decision: "approve" | "reject" | "escalate"; reason: string; model: string }, now = new Date()): { ok: true; approval: Approval } | { ok: false; reason: string } {
    const a = this.get(id);
    if (!a) return { ok: false, reason: "no such approval" };
    if (shown(a, now.getTime()) !== "pending") return { ok: false, reason: `this approval is ${shown(a, now.getTime())}` };
    if (a.tier !== 1) return { ok: false, reason: "only a Tier 1 record is the reviewer's" };
    if (a.digest !== v.digest) return { ok: false, reason: "the digest doesn't match this record" };
    const note = v.reason.slice(0, 2000);
    const r =
      v.decision === "escalate"
        ? this.db.prepare("UPDATE approvals SET tier = 2, review = ? WHERE id = ? AND state = 'pending' AND tier = 1").run(note, id)
        : this.db.prepare("UPDATE approvals SET state = ?, decided_by = ?, decided_at = ?, review = ? WHERE id = ? AND state = 'pending' AND tier = 1").run(v.decision === "approve" ? "approved" : "rejected", `reviewer:${v.model}`, now.toISOString(), note, id);
    return r.changes === 1 ? { ok: true, approval: this.get(id)! } : { ok: false, reason: "it changed meanwhile" };
  }

  /** Records filed or decided since then, oldest first (the daily digest). */
  since(iso: string): Approval[] {
    return (this.db.prepare("SELECT * FROM approvals WHERE created_at > ? OR decided_at > ? ORDER BY created_at").all(iso, iso) as unknown as Row[]).map(toApproval);
  }

  /** Open first (pending, then approved and running), then the newest decided ones. */
  list(limit = 50): Approval[] {
    return (this.db.prepare("SELECT * FROM approvals ORDER BY CASE WHEN state = 'pending' THEN 0 WHEN state IN ('approved','used') AND outcome IS NULL THEN 1 ELSE 2 END, created_at DESC LIMIT ?").all(limit) as unknown as Row[]).map(toApproval);
  }

  /** Every record on a task, by its id or identifier, newest first (an agent's catch-up reads them). */
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
    return { ok: true, approval: a };
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
    return r.changes === 1 ? { ...this.get(id)!, nonce } : undefined;
  }

  /** The claimer's outcome, once. A repeat of the report is a no-op (the applier retries until the board takes it). */
  finish(id: string, nonce: string, ok: boolean, text: string): boolean {
    const r = this.db.prepare("UPDATE approvals SET outcome = ?, outcome_text = ? WHERE id = ? AND state = 'used' AND outcome IS NULL AND claim_nonce = ?").run(ok ? "applied" : "failed", text.slice(0, 4000), id, nonce);
    if (r.changes === 1) return true;
    const a = this.db.prepare("SELECT outcome, claim_nonce FROM approvals WHERE id = ?").get(id) as { outcome: string | null; claim_nonce: string | null } | undefined;
    return a?.outcome != null && a.claim_nonce === nonce;
  }
}
