// "Explain this decision" on a write card (web/src/Explain.tsx): who decided, why, what was asked and what it would change,
// in plain words, from the kernel's record whole (GET /v1/writes/:id with the board key) and its task's request chain as
// the AI reviewer reads it (GET /v1/writes/:id/chain). Read on demand; the record's args and review context stay on the
// server. The reviewer's note, the chain and the card's diff are untrusted text: shown as plain text, never rendered.
import { deciderWords } from "./timeline.js";

/** The kernel's record as GET /v1/writes/:id gives the board (kernel/src/records.ts Rec), as far as an explanation reads it. */
export type RecordWhole = {
  id: string; kind: string; tier: 0 | 1 | 2; merit?: 0 | 1 | 2 | null; panel: boolean; state: string; review: string | null; review_code?: string | null; review_first?: "final" | "owner" | null;
  rule?: string | null; cap?: { by: "autonomy" | "routine"; value: string; routine?: string } | null; decided_by: string | null; via?: string | null; decided_at?: string | null; owner_reason?: string | null;
  outcome: { ok: boolean; text: string } | null; created_at: string; identifier?: string | null; task: string;
  card: { sentence: string; changes: string; reads: string; cost: string; details: string; reason?: string; target?: string }; requester: { name?: string; key?: string };
};

export type DeciderKind = "code" | "reviewer" | "panel" | "owner" | "pending-reviewer" | "pending-owner" | "none";

export interface Explanation {
  id: string;
  sentence: string;
  /** Who decided (or decides), as a kind and in words, with the reviewer models named on its stamp. */
  decider: { kind: DeciderKind; words: string; models: string[] };
  /** The record's path from filing to now, one plain sentence a step. */
  path: string[];
  /** Why it was tiered as it was: the tier, the tier on its merits, the rule's code and words, the requester's reason, the cap. */
  tier: { tier: number; merit: number | null; rule: string | null; ruleWords: string | null; reason: string; cap: string | null; panel: boolean };
  /** The AI reviewer's note (its checklist tail taken off), its reason code and the code in words. */
  review: { note: string; code: string | null; codeWords: string | null } | null;
  /** The security checklist items the reviewer was shown, as code cited them at the end of its note. */
  checklist: { id: string; result: "holds" | "fails" | "not reported" }[];
  /** The owner's reason for a no, in their words. */
  ownerReason: string | null;
  /** What was asked: the task and a delegating parent's own words, as the reviewer reads them, from the task as it reads now. */
  asked: string | null;
  changes: string;
  details: string;
  outcome: { ok: boolean; text: string } | null;
}

/** The kernel's own tier rules (kernel/src/tier.ts, paths.ts) in words; a module's own rule shows as its code and reason. */
const RULES: Record<string, string> = {
  "autonomy-off": "Autonomy is off, so every write is yours to approve.",
  "routine-autonomy": "A routine with its own autonomy cap started this task.",
  "gate-core": "It changes the gates' own core, so two AI reviewers must agree.",
  "owner-path": "It changes a path only you approve (paths.yaml sensitivity 2).",
  "reviewed-path": "It changes a path the AI reviewer reads first (paths.yaml).",
  "gate-list-unknown": "The path inventory couldn't be read, so it went to you.",
  "unknown-files": "The files it changes weren't known, so it went to you.",
  "unknown-repos": "Its repository couldn't be told apart from the product's, so it went to you.",
};

/** The AI reviewer's reason codes (services/shared/reason-codes.ts REVIEW_CODES) in words. */
const REVIEW_WORDS: Record<string, string> = {
  in_scope: "In scope: it does what the task asked.",
  out_of_scope: "Out of scope: it does more or other than the task asked.",
  secret_exfiltration: "It could send a secret out.",
  gate_change: "It changes a gate.",
  prompt_injection: "It follows instructions from untrusted text.",
  stale_request: "The request is out of date.",
  destructive_change: "It destroys something hard to get back.",
  supply_chain: "It adds or bumps a dependency against the supply-chain rules.",
  policy_other: "It breaks another rule of the review policy.",
  owner_should_look: "The reviewer thought you should look.",
  reviewer_unsure: "The reviewer couldn't tell.",
  reviewer_failed: "The reviewer failed to answer.",
  reviewer_refused: "The reviewer's answer was refused by code.",
  no_independent_model: "No reviewer model independent of the requester was available.",
  no_diff: "There was no change to read.",
  files_not_shown: "The reviewer couldn't see every file.",
  review_cap: "The review reached its spend cap before it finished: you decide.",
  code_review_owns: "Code approved it without an AI review: your setting leaves pushes and PRs on this repo to code review.",
  check_failed: "A required check failed.",
  tier_raised: "Its tier was raised after filing.",
  new_authority: "It adds authority: the reviewer approved, you decide next.",
  autonomy_off: "Autonomy is off: the reviewer's verdict is a note for you.",
  routine_autonomy: "A routine's autonomy cap: the reviewer approved, you decide next.",
  owner_tier: "It is yours on its merits: the reviewer read it first.",
  shadow: "Autonomy is tier0: the reviewer's verdict is only a note.",
  panel_split: "The two reviewers disagreed.",
  refused_by_code: "Code refused it (it moved, was rejected before, or ran out of retries).",
  stale_head: "Its head moved before review, so nothing ran.",
};

/** The checklist code cites at the end of the reviewer's note (modules/ai-reviewer review.ts): "… Checklist: a holds, b fails." */
const CHECKLIST = /\s*Checklist: ((?:[\w.-]+ (?:holds|fails|not reported)(?:, )?)+)\.$/;

export function splitChecklist(note: string): { note: string; checklist: Explanation["checklist"] } {
  const m = CHECKLIST.exec(note);
  if (!m) return { note, checklist: [] };
  const checklist = m[1]!.split(", ").map((s) => {
    const [, id, result] = /^([\w.-]+) (holds|fails|not reported)$/.exec(s) ?? [];
    return { id: id ?? s, result: (result ?? "not reported") as "holds" | "fails" | "not reported" };
  });
  return { note: note.slice(0, m.index).trim(), checklist };
}

const capWords = (c: NonNullable<RecordWhole["cap"]>) => (c.by === "autonomy" ? `Autonomy is ${c.value}.` : c.routine ? `A routine's run (${c.routine}) started this task and its autonomy is ${c.value}.` : `The task's routine couldn't be traced, so it counts as a routine set to ${c.value}.`);
const models = (by: string) => (by.startsWith("reviewer:") && by !== "reviewer:kernel/code" ? by.slice("reviewer:".length).split(";unsure:")[0]!.split("+") : []);
/** The reviewer that was unsure on an approval (`;unsure:<model>`, writes.ts). */
const unsureOf = (by: string) => /;unsure:(.+)$/.exec(by)?.[1];
const verdict = (state: string) => (["approved", "claimed", "done", "failed", "unknown"].includes(state) ? "approved it" : state === "stale" ? "closed it: its head moved, so nothing ran" : "rejected it");

export function explain(r: RecordWhole, asked: string | null): Explanation {
  const by = r.decided_by ?? "";
  const waiting = r.state === "review" ? "pending-reviewer" : r.state === "owner" ? "pending-owner" : null;
  const kind: DeciderKind = waiting ?? (!by ? (r.tier === 0 ? "code" : "none") : by === "reviewer:kernel/code" || by.startsWith("stale:") || by.startsWith("kernel") ? "code" : by.startsWith("reviewer:") ? (by.includes("+") ? "panel" : "reviewer") : "owner");
  const words =
    kind === "pending-reviewer" ? (r.panel ? "Two AI reviewers decide (a panel): it is with them now." : "The AI reviewer decides: it is with it now.")
    : kind === "pending-owner" ? "You decide: it waits on you."
    : kind === "none" ? "Nobody: it closed before a decision."
    : kind === "code" && !by ? "Code: its tier rule let it run at once (Tier 0)."
    : `${deciderWords(by)![0]!.toUpperCase()}${deciderWords(by)!.slice(1)}.`;
  const { note, checklist } = splitChecklist(r.review ?? "");
  const rule = r.rule ?? null;
  const path: string[] = [`Filed by ${r.requester.name || r.requester.key || "an agent"} at Tier ${r.merit ?? r.tier}${r.merit != null && r.merit < r.tier ? `, raised to Tier ${r.tier}` : ""}.`];
  if (r.tier === 0 && !waiting) path.push("Its tier rule let it run at once.");
  else if (r.review || by.startsWith("reviewer:") || r.state === "review") {
    const who = r.panel ? "The review panel" : "The AI reviewer";
    if (r.state === "review") path.push(`${who} is reading it.`);
    else if (by.startsWith("reviewer:")) path.push(by === "reviewer:kernel/code" ? `Code ${verdict(r.state)} before any model read it.` : unsureOf(by) ? `${who} (${models(by).join(" and ")}) approved it; the second reviewer (${unsureOf(by)}) was unsure.` : `${who} (${models(by).join(" and ")}) ${verdict(r.state)}.`);
    else path.push(`${who} sent it to you${r.review_first ? " (after the reviewer, you decide this one)" : ""}.`);
  }
  if (r.state === "owner") path.push("It waits on your decision.");
  else if (kind === "owner") path.push(`You ${verdict(r.state)}${r.owner_reason ? `: ${r.owner_reason}` : "."}`);
  if (r.outcome) path.push(r.outcome.ok ? "It ran." : r.state === "cancelled" ? "It closed without running." : "It failed when it ran.");
  return {
    id: r.id,
    sentence: r.card.sentence,
    decider: { kind, words, models: models(by) },
    path,
    tier: { tier: r.tier, merit: r.merit ?? null, rule, ruleWords: rule ? (RULES[rule] ?? null) : null, reason: r.card.reason ?? "", cap: r.cap ? capWords(r.cap) : null, panel: r.panel },
    review: r.review ? { note, code: r.review_code ?? null, codeWords: r.review_code ? (REVIEW_WORDS[r.review_code] ?? null) : null } : null,
    checklist,
    ownerReason: r.owner_reason ?? null,
    asked: asked || null,
    changes: r.card.changes,
    details: r.card.details,
    outcome: r.outcome,
  };
}
