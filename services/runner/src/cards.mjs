// The args a push or PR card carries, built in one place. The board checks them against its own strict schema
// (services/board/src/approvals.ts, ARGS): a field added here must be added there, and its card-contract test fails until it is.

/**
 * What one branch entry carries. `base` is the trusted base the runner read in its own clone before tiering (bindBase): the
 * card keeps it, so the approval hands it back, the runner rechecks that the branch still leaves GitHub's default branch
 * there, and records it to replay the approved commits from later. `patch` is the change's content key (git.mjs patchKey):
 * the owner's veto binds to it, whatever the branch is called or rebased onto.
 */
export const BRANCH_CARD_FIELDS = ["repo", "branch", "sha", "base", "patch"];

/** A push or PR card's args: the branches at their exact commits, plus the PR text and the product repo's merge request. */
export function branchCardArgs(branches, { text, merge } = {}) {
  return {
    // Built from BRANCH_CARD_FIELDS, so the list above is what goes out (and what the contract test holds the board to).
    only: branches.map((b) => Object.fromEntries(BRANCH_CARD_FIELDS.filter((k) => b[k] !== undefined).map((k) => [k, b[k]]))),
    ...(text ? { text: { title: text.title.slice(0, 300), body: text.body.slice(0, 60_000) } } : {}),
    ...(merge ? { merge: true } : {}),
  };
}
