// Reason codes: one stable word for why a write, a tool call or a model call was decided the way it was, recorded next to
// the prose reason so the board can show and count them. Plain `as const` lists (no TS enum): Node strips the types.
//
// Canonical copy: services/shared/reason-codes.ts. Each consumer holds a byte-identical copy (scripts/sync-shared.mjs);
// the runner's reviewer keeps its own list in services/runner/src/review.mjs, which scripts/test/reason-codes.test.mjs
// pins to REVIEW_CODES here.
//
// A card's tier rule (services/runner/src/tiers.mjs `rule`, or the board's own for its actions) is a reason code too: those
// are kebab-case words owned by the classifier, checked by shape (TIER_RULE), not listed here, so a new rule needs no edit.

/** The AI reviewer's code on a Tier 1 card: what it judged (model-chosen) or why code escalated before or after it. */
export const REVIEW_CODES = [
  // approve
  "in_scope",
  // reject or escalate (the model's judgement)
  "out_of_scope",
  "secret_exfiltration",
  "gate_change",
  "prompt_injection",
  "stale_request",
  "destructive_change",
  "supply_chain",
  "policy_other",
  "owner_should_look",
  // unsure: the model can't tell; always escalates to the owner
  "reviewer_unsure",
  // code escalated without (or despite) a usable verdict
  "reviewer_failed",
  "reviewer_refused",
  "no_independent_model",
  "no_diff",
  "too_large",
  "files_not_shown",
  "check_failed",
  "tier_raised",
  "autonomy_off",
  "shadow",
  // the panel's two reviewers disagreed (or the second couldn't decide): the owner decides
  "panel_split",
  // code refused the request at review time (it moved, it was rejected before, retries ran out): back to the agent
  "refused_by_code",
] as const;
export type ReviewCode = (typeof REVIEW_CODES)[number];

/** A grant refusal (agent-auth.ts): the tool isn't granted, the agent lacks a role, or it has no grants at all. */
export const GRANT_CODES = ["denied_not_granted", "denied_role", "denied_no_grants", "denied_unknown_caller"] as const;
/** A model gateway refusal (services/gateway). */
export const GATEWAY_CODES = ["cap_reached", "model_not_granted", "advisor_limit"] as const;
/** A request already satisfied on its target: no card is filed (the duplicate-card guard). */
export const ALREADY_APPLIED_CODE = "already_applied";

export const REASON_CODES = [...REVIEW_CODES, ...GRANT_CODES, ...GATEWAY_CODES, ALREADY_APPLIED_CODE] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

/** The shape of a tier rule (tiers.mjs `rule`; also the board's deploy_app, app_run and raise_cap rules). */
export const TIER_RULE = /^[a-z0-9-]{1,60}$/;
export const isReviewCode = (c: unknown): c is ReviewCode => typeof c === "string" && (REVIEW_CODES as readonly string[]).includes(c);
