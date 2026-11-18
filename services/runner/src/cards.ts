// The runner's side of its kernel records (until the code host module takes its kinds, 3d): the args each card carries,
// built in one place and checked by the kernel against its own strict schemas (kernel/src/kinds.ts): a field added here
// must be added there, and the card-contract test fails until it is. The types below mirror those schemas action by action.
// Also here: the card text the runner plans for its kinds (the owner and the reviewer read it), the plan it files with
// (its classifier's tier on the merits), and the runner's view of a kernel record as tiering reads it.
import { highest, requestPatches, reviewFirstOf, type Part } from "../../../kernel/src/tier.ts";

/**
 * What one branch entry carries. `base` is the trusted base the runner read in its own clone before tiering (bindBase): the
 * card keeps it, so the approval hands it back, the runner rechecks that the branch still leaves GitHub's default branch
 * there, and records it to replay the approved commits from later. `patch` is the change's content key (git.mjs patchKey):
 * the owner's veto binds to it, whatever the branch is called or rebased onto.
 */
export const BRANCH_CARD_FIELDS = ["repo", "branch", "sha", "base", "patch"] as const;

/** One branch at its exact commit (ARGS' BRANCH): `repo` is owner/name, `sha` and `base` full commit ids, `patch` 64 hex. */
export interface BranchArg {
  repo: string;
  branch: string;
  sha: string;
  base?: string;
  patch?: string;
}
/** A PR's text as the card shows it (title at most 300 characters, body at most 60,000). */
export interface PrText {
  title: string;
  body: string;
}
/** One PR a merge card merges: `head` binds it to the commit reviewed, `noReview` merges without the AI reviewer's call. */
export interface MergePrArg {
  repo: string;
  number: number;
  url: string;
  head?: string;
  noReview?: true;
  patch?: string;
}

/** Each runner action's card args, as the kernel's schemas accept them. */
export interface CardArgs {
  push: { only: BranchArg[] };
  /** `merge`: the product repo's one-card path (push, PR, then merge at exactly these commits once green). */
  pr: { only: BranchArg[]; text?: PrText; merge?: true };
  /** `gap`: minutes between merges (0 to 720). */
  merge: { prs: MergePrArg[]; gap?: number };
  /**
   * `authority`: one line per module change the apply carries (`<module>: <change> (owner|review)`), at most 200, owner lines
   * first. `ownerRequired`: some change adds module authority, so only the owner approves it (the board's gate reads this
   * flag, never the lines).
   */
  apply: { repo: string; branch: string; sha: string; files: string[]; authority?: string[]; ownerRequired?: boolean };
  /** A new app's repository in the agents org (tiers.mjs refuses any other org or name before filing). */
  create_repo: { repo: string };
}
export type CardAction = keyof CardArgs;
/** A card request: its action and the args the kernel validates for it. */
export type CardRequest = { [A in CardAction]: { action: A; args: CardArgs[A] } }[CardAction];

/** A push or PR card's args: the branches at their exact commits, plus the PR text and the product repo's merge request. */
export function branchCardArgs(branches: BranchArg[], { text, merge }: { text?: PrText; merge?: boolean } = {}): CardArgs["pr"] {
  return {
    // Built from BRANCH_CARD_FIELDS, so the list above is what goes out (and what the contract test holds the board to).
    only: branches.map((b) => Object.fromEntries(BRANCH_CARD_FIELDS.filter((k) => b[k] !== undefined).map((k) => [k, b[k]])) as unknown as BranchArg),
    ...(text ? { text: { title: text.title.slice(0, 300), body: text.body.slice(0, 60_000) } } : {}),
    ...(merge ? { merge: true } : {}),
  };
}

/** The most authority lines a card carries (ARGS: 200 lines of at most 300 characters). */
const AUTHORITY_MAX = 200;
/**
 * An apply card's args: the fleet branch at its exact commit, and the module changes it brings (kernel/src/loader/authority.ts
 * lines, code-chosen words and cleaned ids), so the owner's card lists them and its digest covers them.
 */
export function applyCardArgs(b: { r: { repo: string; branch: string }; sha: string; files: string[] }, authority: string[] = [], ownerRequired = false): CardArgs["apply"] {
  const isOwner = (l: string) => l.endsWith("(owner)");
  const sorted = [...authority.filter(isOwner), ...authority.filter((l) => !isOwner(l))];
  const dropped = sorted.slice(AUTHORITY_MAX - 1);
  const lines = sorted.length > AUTHORITY_MAX ? [...sorted.slice(0, AUTHORITY_MAX - 1), `and ${dropped.length} more module changes (${dropped.some(isOwner) ? "owner" : "review"})`] : sorted;
  return { repo: b.r.repo, branch: b.r.branch, sha: b.sha, files: b.files, ...(lines.length ? { authority: lines.map((l) => l.slice(0, 300)) } : {}), ...(ownerRequired || authority.some(isOwner) ? { ownerRequired: true } : {}) };
}

/** A card's text: the target in a line, what happens, what changes where, and the details the owner and the reviewer read. */
export type CardText = { target: string; sentence: string; changes: string; reads: string; cost: string; details: string };
/** A repository of codehost-local's org (local/<name>): a bare repo on this server, its PRs change requests. */
const onServer = (repo: string) => repo.toLowerCase().startsWith("local/");
/**
 * The card for one of the runner's git kinds, from its args alone (never the agent's prose; a PR's text is its own field).
 * Worded per code host: GitHub's PRs, or this server's change requests when every repository on the card is local/*.
 */
export function cardOf(action: "push" | "pr" | "merge" | "create_repo", args: any): CardText {
  const base = { reads: "Nothing new.", cost: "No model cost." };
  if (action === "push" || action === "pr") {
    const list = (args.only as BranchArg[]).map((b) => `${b.repo} ${b.branch} at ${b.sha.slice(0, 12)}`);
    const local = (args.only as BranchArg[]).every((b) => onServer(b.repo));
    const text = action === "pr" && args.text ? `\n\n${local ? "Change" : "PR"} title: ${args.text.title}\n\n${args.text.body}` : "";
    const n = `${list.length} branch${list.length === 1 ? "" : "es"}`;
    const merge = action === "pr" && args.merge === true;
    const sentence = action === "push" ? `Push ${n} to ${local ? "this server" : "GitHub"}.` : merge ? `Push and open (or update) a PR for ${n}, then merge each PR once its checks are green.` : `Push and open (or update) a draft ${local ? "change request" : "PR"} for ${n}.`;
    const then = merge ? "\nThen merges each PR at exactly this commit, once every named check is green on it and its base branch is green." : "";
    return { ...base, target: list.join(", ").slice(0, 500), sentence, changes: `${list.join("\n")}${then}`, details: `${list.join("\n")}${then}${text}` };
  }
  if (action === "merge") {
    const prs = args.prs as MergePrArg[];
    const urls = prs.map((p) => p.url);
    const local = prs.every((p) => onServer(p.repo));
    const lines = prs.map((p) => `${p.url}${p.head ? ` at ${p.head.slice(0, 12)}` : ""}${onServer(p.repo) ? "" : p.noReview ? " (your tap is its only review)" : " (also needs GitHub approval)"}`);
    return { ...base, target: urls.join(", ").slice(0, 500), sentence: `Merge ${urls.length} ${local ? "change" : "pull"} request${urls.length === 1 ? "" : "s"}, one at a time${args.gap ? `, ${args.gap} minutes apart` : ""}.`, changes: `Merges, in this order, only at these commits and with green checks:\n${lines.join("\n")}`, details: lines.join("\n") };
  }
  const what = onServer(args.repo)
    ? `Creates the app repository ${args.repo}, from the app starter, on this server. It adds a repository to the agents org; nothing else changes.`
    : `Creates the private app repository ${args.repo}, from the app starter, through the instance's GitHub App. It adds a repository to the agents org; nothing else changes.`;
  return { ...base, target: args.repo, sentence: `Create the repository ${args.repo}.`, changes: what, details: what };
}

/** A push or PR card's target and sentence (cardOf): the reviewer reads them, so a check before filing shows it the same words. */
export const cardText = (action: "push" | "pr", args: CardArgs["pr"]): { target: string; sentence: string } => {
  const c = cardOf(action, args);
  return { target: c.target, sentence: c.sentence };
};

/**
 * The plan the runner files a record with, from its classifier's tier on the merits (the kernel applies the caps): the
 * tier, how the owner follows the reviewer (tier.ts reviewFirstOf), the panel, and why. Several parts (a merge card's PRs)
 * plan as one card: the owner's at once if any part is (Tier 2 and not reviewed first, or Tier 0 beside higher ones), else the
 * highest tier, review-first if any part is, the panel if any part needs it.
 */
export function planOf(...ts: Part[]): { tier: 0 | 1 | 2; reviewFirst: "final" | "owner" | null; panel: boolean; reason: string; rule?: string } {
  const live = ts.filter((t) => !t.reject);
  const direct = live.some((t) => t.tier === 2 && !t.reviewFirst) || (live.some((t) => t.tier === 0) && live.some((t) => t.tier !== 0));
  const tier = direct ? 2 : (Math.max(...ts.map((t) => (t.reject ? 2 : t.tier))) as 0 | 1 | 2);
  const rule = highest(ts).rule;
  return { tier, reviewFirst: direct ? null : (reviewFirstOf(...ts) ?? null), panel: ts.some((t) => t.panel), reason: ts.map((t) => t.reason).filter(Boolean).join("; "), ...(rule ? { rule } : {}) };
}

/**
 * What a request acts on, apart from the commit it carries: requests on the same task, kind and target replace each other
 * while open (a merge's PR URLs, a push's or PR's repos and branches, an apply's repo and branch). A card naming several
 * targets replaces only a card naming exactly the same set.
 */
export function targetOf(action: string, args: any): string | undefined {
  if (action === "merge" && args?.prs?.length) return args.prs.map((p: any) => String(p?.url ?? "").toLowerCase()).sort().join(" ");
  if ((action === "push" || action === "pr") && args?.only?.length) return args.only.map((b: any) => `${String(b?.repo ?? "").toLowerCase()} ${String(b?.branch ?? "")}`).sort().join(" ");
  if (action === "apply" && args?.repo && args?.branch) return `${String(args.repo).toLowerCase()} ${args.branch}`;
  if (action === "create_repo" && args?.repo) return String(args.repo).toLowerCase();
  return undefined;
}
/** The content key the owner's veto binds to: a branch or PR request's patch keys ("?" when any is missing: fails closed). */
export function contentOf(action: string, args: any): string | null {
  const p = requestPatches(action, { branches: args?.only ?? [], prs: args?.prs ?? [] });
  return p === undefined ? null : p === null ? "?" : p;
}

/** A kernel record as the runner reads it (GET /v1/writes): the fields its tiering and its follow-ups use. */
export type KernelRecord = {
  id: string; kind: string; args: any; targets?: Record<string, unknown>; digest: string; tier: number; merit?: number | null; panel: boolean; task: string; identifier?: string | null; state: string;
  review: string | null; review_code?: string | null; review_first?: "final" | "owner" | null; rule?: string | null; decided_by: string | null; decided_at?: string | null; chain?: string | null; replaced?: boolean;
  outcome: { ok: boolean; text: string } | null; created_at: string; updated_at: string; retry_at?: number;
  card: { sentence: string; changes: string; reads: string; cost: string; details: string; reason?: string; target?: string };
};
/** The module kinds the reviewer has always read by their card names. */
const LEGACY: Record<string, string> = { "apps-platform.deploy": "deploy_app", "apps-platform.run": "app_run" };
const STATE: Record<string, string> = { review: "pending", owner: "pending", approved: "approved", claimed: "used", done: "used", failed: "used", unknown: "used", rejected: "rejected", stale: "stale", cancelled: "expired" };
/** The runner's view of a record (tiers' earlier decisions, the review, the follow-ups): board-era field names. */
export function asApproval(r: KernelRecord) {
  return {
    id: r.id, kind: r.kind, action: LEGACY[r.kind] ?? r.kind.replace(/^(runner|kernel)\./, ""), issueId: r.task, identifier: r.identifier ?? r.task, args: r.args, targets: r.targets ?? {}, digest: r.digest,
    tier: r.state === "review" ? 1 : r.tier, baseTier: r.merit ?? r.tier, reviewFirst: r.review_first ?? null, panel: r.panel, replaced: Boolean(r.replaced), rule: r.rule ?? null,
    state: STATE[r.state] ?? "expired", decidedBy: r.decided_by, decidedAt: r.decided_at ?? null, review: r.review, reviewCode: r.review_code ?? null, requestChain: r.chain ?? undefined,
    target: r.card.target ?? "", sentence: r.card.sentence, changes: r.card.changes, cost: r.card.cost, details: r.card.details, reason: r.card.reason ?? "",
    outcome: r.state === "done" ? "applied" : r.state === "failed" || r.state === "unknown" ? "failed" : null, outcomeText: r.outcome?.text ?? null, createdAt: r.created_at, retryAt: r.retry_at,
  };
}
export type Approval = ReturnType<typeof asApproval>;
