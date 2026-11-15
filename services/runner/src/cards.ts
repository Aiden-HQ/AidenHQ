// The args a push or PR card carries, built in one place. The board checks them against its own strict schema
// (services/board/src/approvals.ts, ARGS): a field added here must be added there, and its card-contract test fails until it is.
// The types below mirror ARGS action by action, so the runner's side of the contract is checked when it compiles.

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

/** Each runner action's card args, as the board's ARGS accepts them. */
export interface CardArgs {
  push: { only: BranchArg[] };
  /** `merge`: the product repo's one-card path (push, PR, then merge at exactly these commits once green). */
  pr: { only: BranchArg[]; text?: PrText; merge?: true };
  /** `gap`: minutes between merges (0 to 720). */
  merge: { prs: MergePrArg[]; gap?: number };
  apply: { repo: string; branch: string; sha: string; files: string[] };
  /** A new app's repository in the agents org (tiers.mjs refuses any other org or name before filing). */
  create_repo: { repo: string };
}
export type CardAction = keyof CardArgs;
/** A card request: its action and the args the board validates for it. */
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

/**
 * A push or PR card's target and sentence, as the board writes them on the card (services/board/src/approvals.ts card()):
 * the reviewer reads them, so a check before filing (`aidenhq review`) shows it the same words.
 */
export function cardText(action: "push" | "pr", args: CardArgs["pr"]): { target: string; sentence: string } {
  const list = args.only.map((b) => `${b.repo} ${b.branch} at ${b.sha.slice(0, 12)}`);
  const n = `${list.length} branch${list.length === 1 ? "" : "es"}`;
  const merge = action === "pr" && args.merge === true;
  const sentence = action === "push" ? `Push ${n} to GitHub.` : merge ? `Push and open (or update) a PR for ${n}, then merge each PR once its checks are green.` : `Push and open (or update) a draft PR for ${n}.`;
  return { target: list.join(", ").slice(0, 500), sentence };
}
