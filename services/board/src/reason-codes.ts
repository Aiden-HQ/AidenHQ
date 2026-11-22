// Reason codes: one stable word for why a write, a tool call or a model call was decided the way it was, recorded next to
// the prose reason so the board can show and count them. Plain `as const` lists (no TS enum): Node strips the types.
//
// Canonical copy: services/shared/reason-codes.ts. Each consumer holds a byte-identical copy (scripts/sync-shared.ts);
// the reviewer module keeps its own list in modules/ai-reviewer/service/src/review.ts, which
// modules/ai-reviewer/test/review.test.ts pins to REVIEW_CODES here.
//
// A card's tier rule (kernel/src/tier.ts `rule`, or the board's own for its actions) is a reason code too: those
// are kebab-case words owned by the classifier, checked by shape (TIER_RULE), not listed here, so a new rule needs no edit.

/** The AI reviewer's code on a card: what it judged (model-chosen, malice only) or what code decided in its place. */
export const REVIEW_CODES = [
  // the model's verdict: approve, or reject naming the malice
  "clean",
  "malicious",
  "secret_exfiltration",
  "prompt_injection",
  // the review didn't finish (a call failed, timed out, refused or hit a limit): tried once more, then approved
  "reviewer_failed",
  "fail_open",
  // code's own refusals before any review: the diff differs from the code host's own count of the change, a GitHub
  // write carries the instance's hosts, addresses or paths, or a conn.tool call's arguments can't be read or shown whole
  "files_not_shown",
  "instance_details",
  "tool_call_unreadable",
  // ai_review_code skips the AI review of this push or PR (code review owns it): code approved it
  "code_review_owns",
  // the owner's own veto on this task: he decides
  "owner_veto",
  // the owner's autonomy below full: the reviewer's verdict is a note for him
  "shadow",
  // code refused the request at review time (the same content was already rejected as malicious): back to the agent
  "refused_by_code",
  // code closed the card because its head moved before review: not a verdict, and not a rejection
  "stale_head",
] as const;
export type ReviewCode = (typeof REVIEW_CODES)[number];

/** A grant refusal (kernel/src/identity.ts): the tool isn't granted, the agent lacks a role, or it has no grants at all. */
export const GRANT_CODES = ["denied_not_granted", "denied_role", "denied_no_grants", "denied_unknown_caller"] as const;
/** A model gateway refusal (kernel/src/gateway). */
export const GATEWAY_CODES = ["cap_reached", "model_not_granted", "advisor_limit"] as const;
/** A request already satisfied on its target: no card is filed (the duplicate-card guard). */
export const ALREADY_APPLIED_CODE = "already_applied";

export const REASON_CODES = [...REVIEW_CODES, ...GRANT_CODES, ...GATEWAY_CODES, ALREADY_APPLIED_CODE] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

/** The shape of a tier rule (tiers.mjs `rule`; also the board's deploy_app, app_run and raise_cap rules). */
export const TIER_RULE = /^[a-z0-9-]{1,60}$/;
export const isReviewCode = (c: unknown): c is ReviewCode => typeof c === "string" && (REVIEW_CODES as readonly string[]).includes(c);
