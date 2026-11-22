// "Explain this decision" on a write card (web/src/Explain.tsx): who decided, why, what was asked and what it would change,
// in plain words, from the kernel's record whole (GET /v1/writes/:id with the board key) and its task's request chain as
// the AI reviewer reads it (GET /v1/writes/:id/chain). Read on demand; the record's args and review context stay on the
// server. The reviewer's note, the chain and the card's diff are untrusted text: shown as plain text, never rendered.
import { deciderWords } from "./timeline.js";

/** The kernel's record as GET /v1/writes/:id gives the board (kernel/src/records.ts Rec), as far as an explanation reads it. */
export type RecordWhole = {
  id: string; kind: string; tier: 0 | 1 | 2; merit?: 0 | 1 | 2 | null; state: string; review: string | null; review_code?: string | null;
  rule?: string | null; cap?: { by: "autonomy"; value: string } | null; decided_by: string | null; via?: string | null; decided_at?: string | null; owner_reason?: string | null;
  outcome: { ok: boolean; text: string } | null; created_at: string; identifier?: string | null; task: string;
  card: { sentence: string; changes: string; reads: string; cost: string; details: string; reason?: string; target?: string }; requester: { name?: string; key?: string };
};

export type DeciderKind = "code" | "reviewer" | "owner" | "pending-reviewer" | "pending-owner" | "none";

export interface Explanation {
  id: string;
  sentence: string;
  /** Who decided (or decides), as a kind and in words, with the reviewer models named on its stamp. */
  decider: { kind: DeciderKind; words: string; models: string[] };
  /** The record's path from filing to now, one plain sentence a step. */
  path: string[];
  /** Why it was tiered as it was: the tier, the tier on its merits, the rule's code and words, the requester's reason, the cap. */
  tier: { tier: number; merit: number | null; rule: string | null; ruleWords: string | null; reason: string; cap: string | null };
  /** The AI reviewer's note, its reason code and the code in words. */
  review: { note: string; code: string | null; codeWords: string | null } | null;
  /** The owner's reason for a no, in their words. */
  ownerReason: string | null;
  /** What was asked: the task and a delegating parent's own words, as the reviewer reads them, from the task as it reads now. */
  asked: string | null;
  changes: string;
  details: string;
  outcome: { ok: boolean; text: string } | null;
}

/** The kernel's own tier rules (kernel/src/tier.ts) in words; a module's own rule shows as its code and reason. */
const RULES: Record<string, string> = {
  "autonomy-off": "Autonomy is off, so every write is yours to approve.",
  "unknown-files": "The files it changes weren't known: the AI reviewer reads it.",
};

/** The AI reviewer's reason codes (services/shared/reason-codes.ts REVIEW_CODES) in words. */
const REVIEW_WORDS: Record<string, string> = {
  clean: "Nothing malicious: approved.",
  malicious: "The reviewer found it malicious.",
  secret_exfiltration: "It would send a secret or private data out.",
  prompt_injection: "It follows instructions from untrusted text.",
  reviewer_failed: "The reviewer failed to answer.",
  fail_open: "The review didn't finish twice, so it was approved (fail open).",
  files_not_shown: "The diff didn't match the code host's own count of the change.",
  instance_details: "It would post this server's hosts, addresses or paths to GitHub.",
  tool_call_unreadable: "The tool call's arguments couldn't be read or shown whole, so it went back to the agent.",
  code_review_owns: "Code approved it without an AI review: your setting leaves pushes and PRs on this repo to code review.",
  owner_veto: "You vetoed this action on this task: it is yours.",
  shadow: "Your autonomy is below full: the reviewer's verdict is only a note.",
  refused_by_code: "Code refused it: the same content was already rejected as malicious.",
  stale_head: "Its head moved before review, so nothing ran.",
};

const capWords = (c: NonNullable<RecordWhole["cap"]>) => `Autonomy is ${c.value}.`;
const models = (by: string) => (by.startsWith("reviewer:") && by !== "reviewer:kernel/code" ? [by.slice("reviewer:".length)] : []);
const verdict = (state: string) => (["approved", "claimed", "done", "failed", "unknown"].includes(state) ? "approved it" : state === "stale" ? "closed it: its head moved, so nothing ran" : "rejected it");

export function explain(r: RecordWhole, asked: string | null): Explanation {
  const by = r.decided_by ?? "";
  const waiting = r.state === "review" ? "pending-reviewer" : r.state === "owner" ? "pending-owner" : null;
  const kind: DeciderKind = waiting ?? (!by ? (r.tier === 0 ? "code" : "none") : by === "reviewer:kernel/code" || by.startsWith("stale:") || by.startsWith("kernel") ? "code" : by.startsWith("reviewer:") ? "reviewer" : "owner");
  const words =
    kind === "pending-reviewer" ? "The AI reviewer decides: it is with it now."
    : kind === "pending-owner" ? "You decide: it waits on you."
    : kind === "none" ? "Nobody: it closed before a decision."
    : kind === "code" && !by ? "Code: its tier rule let it run at once (Tier 0)."
    : `${deciderWords(by)![0]!.toUpperCase()}${deciderWords(by)!.slice(1)}.`;
  const note = r.review ?? "";
  const rule = r.rule ?? null;
  const path: string[] = [`Filed by ${r.requester.name || r.requester.key || "an agent"} at Tier ${r.merit ?? r.tier}${r.merit != null && r.merit < r.tier ? `, raised to Tier ${r.tier}` : ""}.`];
  if (r.tier === 0 && !waiting) path.push("Its tier rule let it run at once.");
  else if (r.review || by.startsWith("reviewer:") || r.state === "review") {
    const who = "The AI reviewer";
    if (r.state === "review") path.push(`${who} is reading it.`);
    else if (by.startsWith("reviewer:")) path.push(by === "reviewer:kernel/code" ? `Code ${verdict(r.state)} before any model read it.` : `${who} (${models(by).join(", ")}) ${verdict(r.state)}.`);
    else path.push(`${who} sent it to you.`);
  }
  if (r.state === "owner") path.push("It waits on your decision.");
  else if (kind === "owner") path.push(`You ${verdict(r.state)}${r.owner_reason ? `: ${r.owner_reason}` : "."}`);
  if (r.outcome) path.push(r.outcome.ok ? "It ran." : r.state === "cancelled" ? "It closed without running." : "It failed when it ran.");
  return {
    id: r.id,
    sentence: r.card.sentence,
    decider: { kind, words, models: models(by) },
    path,
    tier: { tier: r.tier, merit: r.merit ?? null, rule, ruleWords: rule ? (RULES[rule] ?? null) : null, reason: r.card.reason ?? "", cap: r.cap ? capWords(r.cap) : null },
    review: r.review ? { note, code: r.review_code ?? null, codeWords: r.review_code ? (REVIEW_WORDS[r.review_code] ?? null) : null } : null,
    ownerReason: r.owner_reason ?? null,
    asked: asked || null,
    changes: r.card.changes,
    details: r.card.details,
    outcome: r.outcome,
  };
}
