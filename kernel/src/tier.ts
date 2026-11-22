// K5, the tier formula (spec §5.1): Tier 0 runs at once (still a record), Tier 1 is the AI reviewer's, Tier 2 the owner's. A
// tier is the kind's floor, code's hard refusals, the owner's veto or save, and autonomy off; nothing else. The AI reviewer
// blocks only malice and fails open (owner, 2026-11-22: "AI agents we use are trusted, not threat actors"): no write reaches
// the owner on its merits. Pure.
export type Tier = 0 | 1 | 2;
export type Autonomy = "off" | "tier0" | "full";
/** A requester's raise: any raise means the AI reviewer reads it. */
export type Raise = { tier: 1 | 2; reason?: string; rule?: string };
/** The cap a write was tiered under, kept on its record: the instance's autonomy below full. */
export type Cap = { by: "autonomy"; value: Autonomy };
/** One part of a request's tier, as the requesters' rules build it. */
export type Part = { tier: number; rule?: string; reason?: string; reject?: boolean; [k: string]: unknown };
/** A model's verdict, or code's in its place. */
export type Verdict = { decision: "approve" | "reject" | "escalate"; reason: string; model: string; code?: string };

/** What a cap says, for a card's reason and the reviewer's label. */
export const capText = (c: Cap) => `autonomy is ${c.value}`;

/**
 * The one tier function every write goes through (writes.ts: module kinds, conn.tool, the kernel's kinds). `refusal`: code's
 * hard refusal (rejected, never reviewed). The owner's (Tier 2) only: his veto on the task (`priorVeto`), his own settings save
 * (`ownerSave`: his Save is his approval, decided as his account at filing), and autonomy off. Otherwise the floor or any
 * raise above 0 is the AI reviewer's (Tier 1), and 0 runs. The release updater's filing passes `autonomy: "full"` (it acts on
 * the owner's standing auto-update authority).
 */
export function computeTier({ floor, raise, refusal, priorVeto = false, ownerSave = false, autonomy }: {
  floor: Tier; raise?: Raise; refusal?: string; priorVeto?: boolean; ownerSave?: boolean; autonomy: Autonomy;
}): { tier: Tier; merit: Tier; cap?: Cap; rule?: string; state: "claimed" | "review" | "owner" | "rejected" } {
  const merit = Math.max(floor, raise?.tier ?? 0) as Tier;
  if (refusal) return { tier: merit, merit, rule: refusal, state: "rejected" };
  if (ownerSave || priorVeto) return { tier: 2, merit, state: "owner" };
  if (autonomy === "off") return { tier: 2, merit, cap: { by: "autonomy", value: "off" }, rule: "autonomy-off", state: "owner" };
  if (merit === 0) return { tier: 0, merit, state: "claimed" };
  return { tier: 1, merit, ...(autonomy === "tier0" ? { cap: { by: "autonomy" as const, value: autonomy } } : {}), state: "review" };
}

export const T = (tier: number, rule: string, reason: string): Part => ({ tier, rule, reason });
export const REJECT = (rule: string, reason: string): Part => ({ tier: 2, rule, reason, reject: true });

/** The highest part (a reject beats everything); no parts is Tier 2 (the reviewer reads it). */
export function highest(parts: Part[]): Part {
  if (!parts.length) return T(2, "unrecognised", "nothing recognised in the request");
  return parts.find((p) => p.reject) ?? parts.reduce((a, b) => (b.tier > a.tier ? b : a));
}

/** The instance setting's `autonomy` values, strictest first. */
export const AUTONOMY: Autonomy[] = ["off", "tier0", "full"];

// ------------------------------------------------------------------ earlier decisions on a task

/** A task's approval record as tiering reads it. */
export type Prior = { id?: string; action: string; args?: any; state: string; decidedBy?: string | null; decidedAt?: string | null; reviewCode?: string | null; review?: string | null; digest?: string };
/** The reviewer's reason codes that name malice: the only rejections that refuse the same content again. */
export const MALICE = ["malicious", "secret_exfiltration", "prompt_injection"];
/** The actions a record carries: a product PR card with `args.merge` is also a merge, so neither dodges the other's no. */
const carried = (r: Prior) => [r.action, ...(r.action === "pr" && r.args?.merge ? ["merge"] : [])];
const keyOf = (list: unknown[]) => (list.length && list.every((x) => typeof x === "string" && /^[0-9a-f]{7,64}$/i.test(x)) ? (list as string[]).map((x) => x.toLowerCase()).sort().join(",") : undefined);
/**
 * What a request changes, as a key two requests share only when their content is identical: the commits (push, PR), the
 * PR heads (merge), the fleet commit (apply), a module kind's or tool call's digest. Never a branch name or PR number.
 */
export function requestKey(action: string, s: any): string | undefined {
  if (action === "push" || action === "pr") return keyOf((s.branches ?? s.only ?? []).map((b: any) => b.sha));
  if (action === "merge") return keyOf((s.prs ?? []).map((p: any) => p.head));
  if (action === "apply") return s.sha ? `apply:${s.sha}` : undefined;
  if (action === "create_repo") return s.repo ? `create_repo:${String(s.repo).toLowerCase()}` : undefined;
  return s.digest ? `digest:${s.digest}` : undefined;
}
/** The same key for an approval record (its args; a module kind's digest is its content). */
export const recordKey = (r: Prior) => requestKey(r.action, { ...(r.args ?? {}), only: r.args?.only ?? [], prs: r.args?.prs ?? [], digest: r.digest });
/** The owner's own decision (not the reviewer's, code's or a stale close). */
const byOwner = (r: Prior) => Boolean(r.decidedBy) && !/^(reviewer|auto|stale):/.test(r.decidedBy!);

/**
 * Earlier decisions on a task for a request, from its decided records of the action:
 * - ownerVeto: the owner's latest decision on it was a no (their later yes withdraws that), or the owner rejected exactly
 *   this content and hasn't approved that same content since.
 * - same: the AI reviewer rejected exactly this content as malice (MALICE) and nobody approved it since: it stays rejected,
 *   refused by code before any review. Any other rejection (code's, or one made before the reviewer judged malice only)
 *   never refuses a resubmission.
 */
export function priorDecisions(records: Prior[], action: string, key?: string) {
  const mine = (records ?? []).filter((r) => ["approved", "used", "expired", "rejected"].includes(r.state) && Boolean(r.decidedBy) && carried(r).includes(action)).sort((a, b) => String(a.decidedAt ?? "").localeCompare(String(b.decidedAt ?? "")));
  const sameContent = (r: Prior) => key !== undefined && recordKey(r) === key;
  const approvedLater = (r: Prior, who: (y: Prior) => boolean = () => true) => mine.some((y) => who(y) && y.state !== "rejected" && sameContent(y) && String(y.decidedAt) > String(r.decidedAt));
  const ownerNo = mine.some((r) => byOwner(r) && r.state === "rejected" && sameContent(r) && !approvedLater(r, byOwner));
  const same = mine.find((r) => r.state === "rejected" && /^reviewer:/.test(r.decidedBy ?? "") && MALICE.includes(r.reviewCode ?? "") && sameContent(r) && !approvedLater(r));
  return { ownerVeto: mine.filter(byOwner).at(-1)?.state === "rejected" || ownerNo, same: same ? same.review || "no note" : undefined };
}

/** What earlier decisions do to a request: the owner's veto (his card), or malice resent unchanged (refused). */
export function priorPart(p: ReturnType<typeof priorDecisions> | undefined): Part | undefined {
  if (!p) return undefined;
  if (p.ownerVeto) return T(2, "owner-veto", "the owner rejected this action on this task, and only their own yes lifts it");
  if (p.same !== undefined) return REJECT("rejected-content", `the AI reviewer already rejected exactly this request on this task as malicious, so it isn't reviewed again unchanged (its note: ${String(p.same).slice(0, 400)})`);
  return undefined;
}

// ------------------------------------------------------------------ the reviewer's verdict on a record

/** A failed review (the reviewer unreachable, failing or slow) is tried once more after this wait, then approved (fail open). */
export const RETRY_MS = 60_000;
/** The wait before try `n` (1-based) of an approved record's pre-run reads, never more than 15 minutes. */
export const RETRY_CAP_MS = 15 * 60_000;
export const retryWait = (n: number) => Math.min(60_000 * 2 ** (n - 1), RETRY_CAP_MS);
/**
 * The owner's own autonomy below full (the instance's tier0): the reviewer only comments, so
 * its verdict goes to the owner as a note.
 */
export const shadowed = (v: Verdict, mode: Autonomy): Verdict =>
  mode === "full" || v.decision === "escalate" ? v : { ...v, decision: "escalate", code: "shadow", reason: `Shadow (autonomy: ${mode}): the reviewer would ${v.decision} this. ${v.reason}` };
