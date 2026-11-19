// The code host's git rules: which tier a push, PR, merge, close or create_repo is on its merits, from verified state only
// (the requester the runner looked up, the repos, branches, files, heads and checks git and GitHub report). Pure: no I/O.
// Code refuses (`reject`) what nobody may do and the agent can fix (the instance repo, a default branch outside the agents
// org, a head that moved, red checks); Tier 0 runs at once, Tier 1 goes to the AI reviewer, `panel` adds a second reviewer.
// What a change to the product repo's own files needs (its gate's core, role handbooks, compose files, Dependabot pin bumps,
// the owner-approval records) is the platform check's (modules/platform/src/check.mjs), never decided here.
//
// The runner combines these parts with that check and the shared rules (tiers.mjs classify). `plan` is the same rules in
// executor@1's shape (kernel/sdk/src/executor.ts) for the codehost-github kinds, with the targets the kernel revalidates.
// codehost-local (the org `local`, repos on this server) tiers through these same rules: it only adds `local-merge`.

const T = (tier, rule, reason) => ({ tier, rule, reason });
/** Authority-expanding: the reviewer and a second reviewer on another model family must both approve. */
const PANEL = (rule, reason) => ({ tier: 1, rule, reason, panel: true });
const REJECT = (rule, reason) => ({ tier: 2, rule, reason, reject: true });
const same = (a, b) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();
const orgOf = (repo) => String(repo).split("/")[0];
const GITHUB = /(^|\/)\.github\//;
/** The org codehost-local owns (docs/design/codehost-local.md §2): its repos are bare repos on this server. */
export const LOCAL_ORG = "local";
const isLocal = (repo) => same(orgOf(repo), LOCAL_ORG);
/** The agents orgs, one per enabled code host (`agentsOrgs`; `agentsOrg` alone is the GitHub-only state). */
const agentsOrgs = (s) => [s.agentsOrgs ?? s.agentsOrg].flat().filter(Boolean);
const inAgentsOrg = (repo, s) => agentsOrgs(s).some((o) => same(orgOf(repo), o));

/**
 * Each item's parts (a branch of a push or PR, a PR of a merge or close; create_repo is one item), in the request's order.
 * `s` as tiers.mjs classify documents it. An item code refuses carries only that refusal.
 */
export function planParts(action, s) {
  if (action === "push" || action === "pr") return (s.branches ?? []).map((b) => publishParts(action, b, s));
  if (action === "merge") return (s.prs ?? []).map((p) => mergeParts(p, s));
  if (action === "close") return (s.prs ?? []).map((p) => [closePart(p, s)]);
  if (action === "create_repo") return [[createRepoPart(s)]];
  return [];
}

function publishParts(action, b, s) {
  const inAgents = inAgentsOrg(b.repo, s);
  if (same(b.repo, s.instanceRepo)) return [REJECT("instance-repo", "the instance repo changes only through apply")];
  if (!Array.isArray(b.files)) return [REJECT("unknown-files", `couldn't tell which files ${b.repo} \`${b.branch}\` changes; try again`)];
  // A job without the platform role pushes only its own task's branches (agent/<task>/…): never a branch another
  // requester's PR stands on, a protected or deploy branch, or the default branch.
  const foreign = !s.requester?.platform && !b.branch.startsWith(`agent/${s.workspace}/`);
  const namespace = () => REJECT("branch-namespace", `\`${b.branch}\` isn't this task's branch: name it \`agent/${s.workspace}/<topic>\` and publish again`);
  if (same(b.repo, s.productRepo)) {
    if (b.empty || b.branch === b.defaultBranch) return [REJECT("product-default-branch", `\`${b.branch}\` is the product repo's default branch: publish a branch and open a PR`)];
    // A PR is a proposal: any job that may file one (an Engineer's) opens it, on any task, and may ask to merge it
    // (productMergePart). A bare branch push, or a PR that changes `.github/`, stays the platform line's.
    const workflow = b.files.find((f) => GITHUB.test(f));
    if (!s.requester?.platform && (action !== "pr" || workflow)) return [REJECT(action === "pr" ? "product-pr-workflow" : "product-push", `only a job holding the platform-engineer role (a task the owner, the Agent Architect or the Fleet Steward filed) ${action === "pr" ? `opens a product PR that changes ${workflow}` : "pushes a branch to the product repo without a PR"}`)];
    if (foreign) return [namespace()];
    return [T(1, action === "pr" ? "product-pr" : "product-push-branch", `${action === "pr" ? "a PR" : "a branch push"} to the product repo${s.requester?.platform ? " from the Platform Engineer's line" : ", not from the Platform Engineer's line"}`)];
  }
  const workflow = b.files.find((f) => GITHUB.test(f));
  const parts = [];
  // A byte-identical copy of the product's CI template (checked in the runner's own clone) is Tier 0; any other `.github/`
  // change is the reviewer's (who flags one that weakens a check for the second reviewer).
  if (workflow && !(inAgents && b.ciTemplate === true)) parts.push(T(1, "github-dir", `it changes ${workflow}`));
  if (inAgents) {
    if (b.empty) parts.push(T(1, "empty-repo", `${b.repo} is empty: the first push lands on its default branch`));
    // Straight onto the branch apps deploy from or merge into, past the PR and its checks: weakens the merge gate.
    else if (b.branch === b.defaultBranch || (b.deployBranch && b.branch === b.deployBranch)) parts.push(PANEL("default-branch", `\`${b.branch}\` is ${b.repo}'s default or deploy branch, past its PR checks`));
    else parts.push(T(0, workflow ? "ci-template-copy" : "agents-org-branch", workflow ? `${b.repo}'s \`.github/\` is exactly the product's CI template` : `an ordinary branch of ${b.repo} in the agents org`));
    return parts;
  }
  if (b.empty || b.branch === b.defaultBranch) return [REJECT("outside-default-branch", `\`${b.branch}\` is ${b.repo}'s default branch, outside the agents org: publish a branch and open a PR`)];
  if (foreign) return [namespace()];
  parts.push(action === "pr" ? T(1, "outside-pr", `a draft PR to ${b.repo}, outside the agents org`) : T(1, "outside-push", `a branch push to ${b.repo}, outside the agents org`));
  return parts;
}

/**
 * close: prs [{ repo, dependabot? }]. Tier 0 in the agents org (reversible, no code changes); the instance repo's PRs are the
 * owner's. On the product repo only a Dependabot PR (its author verified as dependabot[bot] from the GitHub API by the runner,
 * never from text) may be closed, by the Platform Engineer's line, at Tier 0 (owner, 2026-11-13): closing changes no code,
 * the reason is posted on the PR, and reopening it undoes it.
 */
function closePart(p, s) {
  if (same(p.repo, s.productRepo)) {
    if (p.dependabot !== true) return REJECT("core-repo-close", `${p.repo} is the product repo: only its Dependabot PRs may be closed`);
    if (!s.requester?.platform) return REJECT("product-close-requester", "only the Platform Engineer's line may close the product repo's Dependabot PRs");
    return T(0, "product-dependabot-close", "closing a Dependabot PR of the product repo is reversible (reopen) and changes no code");
  }
  if (!inAgentsOrg(p.repo, s)) return REJECT("outside-close", `${p.repo} is outside the agents org`);
  if (same(p.repo, s.instanceRepo)) return REJECT("core-repo-close", `${p.repo} is the instance repo: its PRs are the owner's`);
  return T(0, "agents-org-close", `closing a PR of ${p.repo} is reversible and changes no code`);
}

/** A new repository's name: lowercase words joined by hyphens, as an app's name (never `.github` or a path). */
const NEW_REPO_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
/**
 * create_repo: { repo }. A new private repository, asked for only by `aidenhq create-repo` (naming, adding or detecting a
 * missing repo never creates one). Tier 0 in any org the App is installed on (owner, 2026-11-18): where repos live is not
 * decided here (the runner's allowed_orgs, passed in, and the App's installation bound it). Code still refuses the product or instance
 * repo's own name and a name that isn't a plain lowercase one.
 */
function createRepoPart(s) {
  const repo = String(s.repo ?? "");
  const name = repo.split("/")[1] ?? "";
  // The orgs the owner lists (the runner's allowed_orgs, passed in as `allowedOrgs`; the App is public, so an installation alone
  // proves nothing). Without it, only the agents orgs: a plan never says Tier 0 for an org nobody allowed.
  const allowed = [s.allowedOrgs ?? agentsOrgs(s)].flat().filter(Boolean);
  if (!allowed.some((o) => same(orgOf(repo), o))) return REJECT("outside-create-repo", `${repo} is outside the orgs this instance works in (${allowed.join(", ")}): list its org in allowed_orgs`);
  if (same(repo, s.productRepo) || same(repo, s.instanceRepo)) return REJECT("core-repo-create", `${repo} is the product or instance repo`);
  if (name.length > 63 || !NEW_REPO_NAME.test(name)) return REJECT("new-repo-name", `\`${name}\` isn't a new repository's name: lowercase letters, digits and single hyphens, starting with a letter, 63 at most`);
  return T(0, "create-repo", `creating ${repo} is a new private repository: it changes no code, settings or access elsewhere`);
}

/**
 * Friction is the agent's, never the owner's (owner, 2026-11-14): a head that moved, no named checks, or a red one is
 * refused by code with the reason, so the agent fixes it and asks again. Still running is not red: those merges wait.
 */
function mergeFriction(p, ref) {
  if (!p.headMatches) return REJECT("head-moved", `${ref} moved since it was asked for: ask again for its new head`);
  if (!(p.checks ?? []).length) return REJECT("no-checks", `${ref} has no named checks on its head: its repo needs CI (a copy of the product's CI template runs at once), or CI didn't start; fix that and ask again`);
  const red = p.checks.filter((c) => !c.ok && !c.pending);
  // A count, never the names: check names are repo-controlled text, and this reason reaches the agent as the runner's.
  if (red.length) return REJECT("checks-not-green", `${ref}: ${red.length} named check(s) failed on the head (\`${isLocal(p.repo) ? "aidenhq status" : `gh pr checks ${p.number ?? ""}`}\` names them). Fix it and publish again`);
  return undefined;
}

/** A merge's checks as counts the reviewer can match to any readout: "22 named checks, 21 passed, 1 skipped" (never names). */
function checkCounts(checks) {
  const n = (k) => checks.filter(k).length;
  const parts = [[n((c) => c.ok && !c.skipped), "passed"], [n((c) => c.skipped), "skipped"], [n((c) => c.pending), "running"]].filter(([k]) => k).map(([k, w]) => `${k} ${w}`);
  return [`${checks.length} named check${checks.length === 1 ? "" : "s"}`, ...parts].join(", ");
}

function mergeParts(p, s) {
  const ref = `${p.repo}#${p.number ?? "?"}`;
  // The instance repo is refused before anything reads its files: it changes only through apply, whatever it touches.
  if (same(p.repo, s.instanceRepo)) return [REJECT("core-repo-merge", `${ref} is the instance repo: it changes only through apply`)];
  if (same(p.repo, s.productRepo)) return [productMergePart(p, ref, s)];
  if (!Array.isArray(p.files)) return [REJECT("unknown-files", `couldn't list every file ${ref} changes; try again`)];
  // Outside the agents org and the product repo the code host only opens PRs: the merge queue refuses it too (merges.ts).
  if (!inAgentsOrg(p.repo, s)) return [REJECT("outside-merge", `${ref} is outside the agents org: the code host only opens PRs there`)];
  const friction = mergeFriction(p, ref);
  if (friction) return [friction];
  const parts = [];
  const workflow = p.files.find((f) => GITHUB.test(f));
  if (workflow && p.ciTemplate !== true) parts.push(T(1, "github-dir", `${ref} changes ${workflow}`));
  // Existing sensitivity alone doesn't make every merge the owner's: the reviewer reads it (and flags new reach).
  if (p.sensitive) parts.push(T(1, "sensitive-app", `${ref} is a sensitive app's repo (access, caps or connects to paperclip)`));
  // A head the runner didn't push (a fork, someone else's push): the reviewer reads the diff first.
  if (!p.ownHead) parts.push(T(1, "agents-org-merge-foreign-head", `${ref}: its head isn't a commit the runner pushed to a branch of ${p.repo}`));
  // Merged at once when CI is green (owner, 2026-11-12): the PR merges on its own (an independent queue), strict and bound to
  // this head, only once every named check passed on it; red leaves it unmerged. Still running is not red.
  const n = `${p.checks.length} named check${p.checks.length === 1 ? "" : "s"}`;
  // A change request on this server: no CI code-review job read it (that needs GitHub's OIDC), so the AI reviewer reads the
  // card's diff and the request chain (owner, 2026-11-17). Merged only once every named check is green on this head.
  if (isLocal(p.repo)) parts.push(T(1, "local-merge", `${ref}: a change request on this server; ${n}, ${p.checks.some((c) => c.pending) ? "still running on the exact head (merged only once green)" : "all green on the exact head"}`));
  else parts.push(p.checks.some((c) => c.pending) ? T(0, "agents-org-merge-checks-running", `${ref}: ${n}, still running on the exact head (merged only once green)`) : T(0, "agents-org-merge", `${ref}: ${n}, all green on the exact head`));
  return parts;
}

/**
 * A product PR's merge (owner, 2026-11-13): the reviewer's when its head is one the runner pushed (no fork, no one else's
 * push), it is the card's head and its named checks aren't red. The Platform Engineer's line asks for any such PR; any other
 * Engineer job only for a PR whose head its own task pushed (the task the code host recorded with that head, `pushedBy`)
 * and that changes nothing under `.github/`. Still running is not red: a reviewer-approved merge runs the strict queue, which
 * merges only once every named check is green on that exact head. Never Tier 0: the product reaches every instance through
 * the pin. Its files are the platform check's.
 */
function productMergePart(p, ref, s) {
  if (!Array.isArray(p.files)) return REJECT("unknown-files", `couldn't list every file ${ref} changes; try again`);
  if (!s.requester?.platform) {
    const workflow = p.files.find((f) => GITHUB.test(f));
    if (workflow) return REJECT("product-merge-workflow", `${ref} changes ${workflow}: only the Platform Engineer's line merges a product PR that changes \`.github/\``);
    if (!p.ownHead || !s.task || p.pushedBy !== s.task) return REJECT("product-merge-requester", `${ref}: its head wasn't pushed by this task; only the Platform Engineer's line merges another requester's product PR`);
  }
  const friction = mergeFriction(p, ref);
  if (friction) return friction;
  const gates = `On its head: ${checkCounts(p.checks)}. Code merges it only at that head, once every named check has passed (skipped counts as passed) and main is green`;
  // Who pushed the head (recorded at the push): only a head the platform line pushed is its own.
  if (p.ownHead && p.platformHead) return T(1, "product-merge", `${ref}: a product PR from the Platform Engineer's line. ${gates}`);
  if (p.ownHead) return T(1, "product-merge-engineer-head", `${ref}: its head was pushed by an Engineer job that is NOT the Platform Engineer's line (a PR, a proposal). ${gates}`);
  return T(1, "product-merge-foreign-head", `${ref}: its head isn't a commit the runner pushed to a branch of the product repo (the reviewer reads that exact head)`);
}

const rank = (p) => p.tier * 2 + (p.panel ? 1 : 0);
/**
 * executor@1's plan for codehost-github.{push,pr,merge,close,create_repo}: `state` is the verified state the code host read
 * for this request (as `s` above). A refusal throws (the kernel answers it as refused); otherwise the tier above 0 comes back
 * as `raise`, and `targets` bind the record to what it acts on: each branch's commit and base, each PR's head. When any of
 * them moves after approval, the revalidating plan's targets differ and the kernel closes the record as stale.
 */
export function plan({ kind, args }, state) {
  const action = String(kind).replace(/^codehost(-github)?\./, "");
  const parts = planParts(action, state).flat();
  if (!parts.length) throw Object.assign(new Error("nothing recognised in the request"), { rule: "unrecognised" });
  const refused = parts.find((p) => p.reject);
  if (refused) throw Object.assign(new Error(refused.reason), { rule: refused.rule });
  const top = parts.reduce((a, b) => (rank(b) > rank(a) ? b : a));
  const targets = action === "merge" || action === "close"
    ? Object.fromEntries((state.prs ?? []).map((p) => [`${p.repo}#${p.number}`, { repo: p.repo, ref: isLocal(p.repo) ? `change/${p.number}` : `pull/${p.number}`, commit: p.head ?? null, base_sha: p.base ?? null }]))
    : action === "create_repo" ? { [String(state.repo)]: { repo: state.repo } }
    : Object.fromEntries((state.branches ?? []).map((b) => [`${b.repo} ${b.branch}`, { repo: b.repo, ref: b.branch, commit: b.sha ?? null, base_sha: b.base ?? null }]));
  return { args, targets, ...(top.tier > 0 ? { raise: { tier: top.tier, ...(top.panel ? { panel: true } : {}), reason: top.reason, rule: top.rule } } : {}) };
}
