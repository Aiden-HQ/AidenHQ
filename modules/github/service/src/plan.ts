// The code host's git rules: which tier a push, PR, merge, close or create_repo is on its merits, from verified state only
// (the requester the runner looked up, the repos, branches, files, heads and checks git and GitHub report). Pure: no I/O.
// Code refuses (`reject`) what nobody may do and the agent can fix (the instance repo, a default branch outside the agents
// org, a head that moved); Tier 0 runs at once, Tier 1 goes to the AI reviewer.
// `plan` returns the files each push, PR and merge changes (`paths`), and the kernel runs the platform check
// (modules/platform/src/check.ts) on them (writes.ts).
//
// `plan` is these rules in executor@1's shape (kernel/sdk/src/executor.ts) for the github kinds, with the targets the kernel
// revalidates. codehost-local (the org `local`, repos on this server) tiers through these same rules: it only adds `local-merge`.

import { productMergeEligible, type Verdict } from "./merge-gate.ts";

interface Part { tier: 0 | 1 | 2; rule: string; reason: string; reject?: boolean }
interface Check { name?: string; ok?: boolean; pending?: boolean; skipped?: boolean }
interface Branch { repo: string; branch: string; files?: string[]; empty?: boolean; defaultBranch?: string; deployBranch?: string; ciTemplate?: boolean; sha?: string; base?: string; /** A push onto an adopted PR's branch (ship). */ ship?: Ship; /** An explicit handoff: an open PR on this branch whose recorded owner task is no longer open (service.ts reads both facts). */ handoff?: boolean; /** A PR on this branch already recorded to this task (a successor republishing what it adopted): the branch name is the old task's. */ adopted?: boolean; /** The base the change is reviewed against (the PR's own base); `defaultBranch` stays the repo's, so the default-branch guard still holds. */ destination?: string }
interface Pr { repo: string; number?: number; files?: string[]; headMatches?: boolean; checks: Check[]; ciTemplate?: boolean; sensitive?: boolean; ownHead?: boolean; dependabot?: boolean; head?: string; base?: string; /** Code review's verdict for the head (product merges). */ verdict?: Verdict; /** A merge the ship module filed for an adoption. */ ship?: Ship }
/**
 * A write for one adopted PR (the ship module's), as the code host read it now: what the record names (`generation`,
 * `expected` head) beside GitHub's PR and ship's adoption. Every such write is refused on any mismatch (ship-scope,
 * ship-head-moved, ship-generation, ship-fork), so a contributor's push or a newer hand-off always wins over an older write.
 */
export interface Ship {
  number: number; generation: number; expected: string;
  /** The PR's head now: its commit, the repository it lives in (null: a deleted fork), its branch, and whether its author lets
   * maintainers push to a fork's branch (`maintainer_can_modify`). */
  head?: string; headRepo?: string | null; headRef?: string; canModify?: boolean;
  /** A push's branch (args.only): it must be the PR's own head branch. */
  branch?: string;
  /** The base the write was filed against (args `base`) and the PR's base now: a change refuses it (ship-scope). */
  bound?: string; baseRef?: string;
  /** Ship's adoption: its current generation (null: not adopted, undefined: ship isn't installed) and the adoption's task. */
  current?: number | null; task?: string;
  /** The record's task, its id and identifier: an adoption's write is filed on that adoption's task. */
  filedOn?: string[];
  /** Filed by the ship module itself (its module token; github's `filed_by` lets it). */
  byShip?: boolean;
  /**
   * Why the App can't approve this PR (none installed on the repo, or the App opened it), or undefined. An approval is only ever
   * the App's: one under the owner's account would count as a person's (a code owner's included), which stays human.
   */
  noApp?: string;
}
interface State {
  agentsOrgs?: string | string[];
  agentsOrg?: string;
  instanceRepo?: string;
  productRepo?: string;
  /** maintainer_repos ("owner/name"): merged and closed as in the agents org. */
  maintained?: string[];
  requester?: { platform?: boolean };
  workspace?: string;
  branches?: Branch[];
  prs?: Pr[];
  repo?: string;
  allowedOrgs?: string | string[];
  /** A publish's branch and the tip the owner previewed (publish_module). */
  ref?: string;
  base?: string;
}

const T = (tier: 0 | 1 | 2, rule: string, reason: string): Part => ({ tier, rule, reason });
/** Authority-expanding: the reviewer and a second reviewer on another model family must both approve. */
const REJECT = (rule: string, reason: string): Part => ({ tier: 2, rule, reason, reject: true });
const same = (a: unknown, b: unknown) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();
const orgOf = (repo: unknown) => String(repo).split("/")[0];
const GITHUB = /(^|\/)\.github\//;
/** The org codehost-local owns (docs/design/codehost-local.md §2): its repos are bare repos on this server. */
export const LOCAL_ORG = "local";
const isLocal = (repo: unknown) => same(orgOf(repo), LOCAL_ORG);
/** The agents orgs, one per enabled code host (`agentsOrgs`; `agentsOrg` alone is the GitHub-only state). */
const agentsOrgs = (s: State) => [s.agentsOrgs ?? s.agentsOrg].flat().filter(Boolean);
const inAgentsOrg = (repo: unknown, s: State) => agentsOrgs(s).some((o) => same(orgOf(repo), o));
/**
 * A repo the owner listed in `maintainer_repos` outside the agents org (`maintained`, the code host's parsed list): the fleet
 * merges and closes there as in the agents org (owner, 2026-11-20). The owner's account reaching a repo never counts by itself.
 */
const inMaintained = (repo: unknown, s: State) => !inAgentsOrg(repo, s) && (s.maintained ?? []).some((r) => same(r, repo));
const LISTED = "the owner listed it in maintainer_repos";

/**
 * Each item's parts (a branch of a push or PR, a PR of a merge or close; create_repo is one item), in the request's order.
 * `s` as tiers.mjs classify documents it. An item code refuses carries only that refusal.
 */
export function planParts(action: string, s: State) {
  if (action === "push" || action === "pr") return (s.branches ?? []).map((b) => publishParts(action, b, s));
  if (action === "merge") return (s.prs ?? []).map((p) => mergeParts(p, s));
  if (action === "close") return (s.prs ?? []).map((p) => [closePart(p, s)]);
  if (action === "create_repo") return [[createRepoPart(s)]];
  if (action === "publish_module") return [[publishModulePart(s)]];
  if (action === "retitle") return (s.prs ?? []).map((p) => [retitlePart(p, s)]);
  if (action === "approve" || action === "enqueue" || action === "repair" || action === "retarget") return (s.prs ?? []).map((p) => shipEffectParts(action, p, s));
  return [];
}

/**
 * Why a write for an adopted PR is refused, or undefined: ship isn't installed or the adoption is gone or newer
 * (ship-generation), the write isn't for that PR's own branch or task (ship-scope), the PR's head lives in a fork (ship-fork),
 * or its head moved off the one the write names (ship-head-moved). Refusals, never waits: the next round reads the PR again.
 */
export function shipRefusal(x: Ship, ref: string): Part | undefined {
  if (x.current === undefined) return REJECT("ship-generation", `${ref}: the ship module isn't installed, so no adoption can be checked`);
  if (x.current === null) return REJECT("ship-generation", `${ref} isn't adopted by ship (handed back, stopped or never handed over)`);
  if (x.current !== x.generation) return REJECT("ship-generation", `${ref}: generation ${x.generation} is stale, the adoption is at ${x.current}`);
  if (x.task && !(x.filedOn ?? []).includes(x.task)) return REJECT("ship-scope", `${ref}: the write isn't on the adoption's task`);
  // A push onto a fork's branch only where its author allows maintainers to modify it; a merge or an approval is the base repo's.
  if (x.branch !== undefined && (x.headRepo === null || (x.headRepo !== undefined && !same(x.headRepo, ref.split("#")[0]) && !x.canModify))) return REJECT("ship-fork", `${ref}: its head is in a fork whose author doesn't allow maintainers to push: hold it with a note`);
  if (x.bound !== undefined && x.bound !== x.baseRef) return REJECT("ship-scope", `${ref}'s base changed: it now targets \`${String(x.baseRef ?? "")}\`, not \`${x.bound}\`: read it again`);
  if (x.branch !== undefined && x.branch !== x.headRef) return REJECT("ship-scope", `${ref}: \`${x.branch}\` isn't the PR's head branch`);
  if (!x.head || x.head !== x.expected) return REJECT("ship-head-moved", `${ref} moved to \`${String(x.head ?? "").slice(0, 12)}\` since \`${x.expected.slice(0, 12)}\`: read it again`);
  return undefined;
}

/**
 * approve, enqueue and repair: Tier 0 when the adoption, its generation, the target and the head all match, else refused. A
 * repair's commit is the base merged in plus the repo's own generators' output (ship's check job, no model): on a fork too, it
 * carries nothing of the fleet's own.
 * Only the ship module files them (its `approve` setting is what lets a PR be approved: an agent's job can't go around it),
 * only where the fleet may merge, and never an approval GitHub would refuse as the PR author's own. An enqueue is a merge by
 * GitHub's queue, so a head the runner didn't push goes to the AI reviewer first, as a direct merge's does.
 */
function shipEffectParts(action: "approve" | "enqueue" | "repair" | "retarget", p: Pr, s: State): Part[] {
  const part = shipEffectPart(action, p, s);
  // An enqueue is the queue's merge: it takes every merge rule's tier (a foreign head, .github/, the product's eligibility).
  if (part.reject || action !== "enqueue") return [part];
  const merge = mergeParts({ ...p, ship: undefined }, s);
  return merge.some((m) => m.reject) ? merge : [part, ...merge];
}
function shipEffectPart(action: "approve" | "enqueue" | "repair" | "retarget", p: Pr, s: State): Part {
  const ref = `${p.repo}#${p.number ?? "?"}`;
  if (same(p.repo, s.instanceRepo)) return REJECT("core-repo-merge", `${ref} is the instance repo: it changes only through apply`);
  if (!same(p.repo, s.productRepo) && !inAgentsOrg(p.repo, s) && !inMaintained(p.repo, s)) return REJECT("outside-merge", `${ref} is outside the agents org, the product repo and maintainer_repos`);
  if (!p.ship) return REJECT("ship-generation", `${ref}: a ${action} names an adoption`);
  if (!p.ship.byShip) return REJECT("ship-only", `${ref}: only the ship module files a ${action}`);
  const refused = shipRefusal(p.ship, ref);
  if (refused) return refused;
  if (action === "approve" && p.ship.noApp) return REJECT("ship-no-app", `${ref}: approval needs a human (${p.ship.noApp})`);
  return T(0, `ship-${action}`, `${ref}: adopted at generation ${p.ship.generation}, at its head \`${p.ship.expected.slice(0, 12)}\``);
}

/**
 * retitle: an adopted PR's title, replaced so the `policy` job's Conventional Commit check can pass (no commit can fix it). The
 * same adoption, generation and head binding as the other effects, but filed by the Engineer's `aidenhq ship title` (a title is
 * a judgement: ship never invents one), so it is not `byShip`.
 */
function retitlePart(p: Pr, s: State): Part {
  const ref = `${p.repo}#${p.number ?? "?"}`;
  if (same(p.repo, s.instanceRepo)) return REJECT("core-repo-merge", `${ref} is the instance repo: it changes only through apply`);
  if (!same(p.repo, s.productRepo) && !inAgentsOrg(p.repo, s) && !inMaintained(p.repo, s)) return REJECT("outside-merge", `${ref} is outside the agents org, the product repo and maintainer_repos`);
  if (!p.ship) return REJECT("ship-generation", `${ref}: a retitle names an adoption`);
  const refused = shipRefusal(p.ship, ref);
  if (refused) return refused;
  return T(0, "ship-retitle", `${ref}: adopted at generation ${p.ship.generation}, at its head \`${p.ship.expected.slice(0, 12)}\``);
}

/**
 * Where a non-platform task's branch is confined to its own namespace (agent/<task>/…): the product repo and any repo outside the
 * agents org. The publish executor re-asks it to decide whether a push needs the handoff grant, so the two can never disagree.
 */
export function namespaced(repo: string, s: State): boolean {
  return same(repo, s.productRepo) || !inAgentsOrg(repo, s);
}

function publishParts(action: string, b: Branch, s: State): Part[] {
  const inAgents = inAgentsOrg(b.repo, s);
  if (same(b.repo, s.instanceRepo)) return [REJECT("instance-repo", "the instance repo changes only through apply")];
  if (!Array.isArray(b.files)) return [REJECT("unknown-files", `couldn't tell which files ${b.repo} \`${b.branch}\` changes; try again`)];
  // A job without the platform role pushes only its own task's branches (agent/<task>/…): never a branch another
  // requester's PR stands on, a protected or deploy branch, or the default branch.
  // A push onto an adopted PR's branch is checked against the adoption first: when it holds, that one ref is the task's.
  if (b.ship) {
    const refused = shipRefusal(b.ship, `${b.repo}#${b.ship.number}`);
    if (refused) return [refused];
    // A contributor's fork receives the commits: an outside push, whatever its base repo is.
    if (b.ship.headRepo && !same(b.ship.headRepo, b.repo)) return [T(1, "outside-push", `a push to ${b.ship.headRepo}, a contributor's fork of ${b.repo} (outside the agents org)`)];
  }
  const foreign = !b.ship && !b.adopted && !s.requester?.platform && !b.branch.startsWith(`agent/${s.workspace}/`);
  const namespace = () => REJECT("branch-namespace", `\`${b.branch}\` isn't this task's branch: name it \`agent/${s.workspace}/<topic>\` and publish again`);
  // A branch whose recorded owner is a task no longer open (cancelled, done) is an explicit handoff: a successor finishes that PR
  // by publishing to the head branch it already has, the only way to take a PR over (notePrTask then records it as the successor's).
  // It relaxes the namespace refusal only, never a default-branch refusal, and stays the reviewer's.
  const handoff = () => [T(1, action === "pr" ? "handoff-pr" : "handoff-push", `${action === "pr" ? "a PR on" : "a push to"} ${b.repo} \`${b.branch}\`: the branch of an open PR whose task is no longer open, which its successor finishes`)];
  const adopted = () => [T(1, action === "pr" ? "adopted-pr" : "adopted-push", `${action === "pr" ? "a PR on" : "a push to"} ${b.repo} \`${b.branch}\`: the branch of the open PR this task already took over`)];
  const grant = () => (b.handoff ? handoff() : b.adopted ? adopted() : undefined);
  if (same(b.repo, s.productRepo)) {
    if (b.empty || b.branch === b.defaultBranch) return [REJECT("product-default-branch", `\`${b.branch}\` is the product repo's default branch: publish a branch and open a PR`)];
    // A PR or a branch is a proposal: any job that may file one opens it, on any task, and may ask to merge it
    // (productMergePart). The merge waits for ci-required and the mandatory code review on GitHub.
    if (foreign) return grant() ?? [namespace()];
    // Its own branch of the product repo: an adopted PR on another base stays that PR's (the reviewer reads it), any other is the
    // ordinary product publish.
    return grant() ?? [T(1, action === "pr" ? "product-pr" : "product-push-branch", `${action === "pr" ? "a PR" : "a branch push"} to the product repo`)];
  }
  // Outside the agents org: its default branch and, for a non-platform task, another task's branch are refused (a handoff relaxes
  // the second only). An agents-org repo has neither rule: any branch there is an ordinary one (its `inAgents` parts below).
  if (!inAgents) {
    if (b.empty || b.branch === b.defaultBranch) return [REJECT("outside-default-branch", `\`${b.branch}\` is ${b.repo}'s default branch, outside the agents org: publish a branch and open a PR`)];
    if (foreign) return grant() ?? [namespace()];
  }
  const workflow = b.files.find((f) => GITHUB.test(f));
  const parts: Part[] = [];
  // A byte-identical copy of the product's CI template (checked in the runner's own clone) is Tier 0; any other `.github/`
  // change is the reviewer's (who flags one that weakens a check for the second reviewer).
  // A count, never the path: a file name is repo-controlled text, and the reviewer reads this reason as code's own account.
  if (workflow && !(inAgents && b.ciTemplate === true)) parts.push(T(1, "github-dir", `it changes ${b.files.filter((f) => GITHUB.test(f)).length} file(s) under .github/`));
  if (inAgents) {
    if (b.empty) parts.push(T(1, "empty-repo", `${b.repo} is empty: the first push lands on its default branch`));
    // Straight onto the branch apps deploy from or merge into, past the PR and its checks: weakens the merge gate.
    else if (b.branch === b.defaultBranch || (b.deployBranch && b.branch === b.deployBranch)) parts.push(T(1, "default-branch", `\`${b.branch}\` is ${b.repo}'s default or deploy branch, past its PR checks`));
    else parts.push(T(0, workflow ? "ci-template-copy" : "agents-org-branch", workflow ? `${b.repo}'s \`.github/\` is exactly the product's CI template` : `an ordinary branch of ${b.repo} in the agents org`));
    return parts;
  }
  parts.push(action === "pr" ? T(1, "outside-pr", `a draft PR to ${b.repo}, outside the agents org`) : T(1, "outside-push", `a branch push to ${b.repo}, outside the agents org`));
  return parts;
}

/**
 * close: prs [{ repo }]. Tier 0 in the agents org, on the product repo and on a maintained repo: closing changes no code,
 * the reason is posted on the PR, and reopening it undoes it (agents are trusted: a duplicate PR is theirs to close). The
 * instance repo's PRs are the owner's.
 */
function closePart(p: Pr, s: State) {
  if (same(p.repo, s.instanceRepo)) return REJECT("core-repo-close", `${p.repo} is the instance repo: its PRs are the owner's`);
  if (same(p.repo, s.productRepo)) return T(0, "product-close", "closing a PR of the product repo is reversible (reopen) and changes no code");
  if (inMaintained(p.repo, s)) return T(0, "maintained-close", `closing a PR of ${p.repo} (${LISTED}) is reversible and changes no code`);
  if (!inAgentsOrg(p.repo, s)) return REJECT("outside-close", `${p.repo} is outside the agents org and maintainer_repos`);
  return T(0, "agents-org-close", `closing a PR of ${p.repo} is reversible and changes no code`);
}

/** A new repository's name: lowercase words joined by hyphens, as an app's name (never `.github` or a path). */
const NEW_REPO_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
/**
 * create_repo: { repo }. A new private repository, asked for only by `aidenhq create-repo` (naming, adding or detecting a
 * missing repo never creates one). Tier 0 in any allowed org (owner, 2026-11-18): where repos live is not
 * decided here (the runner's allowed_orgs, passed in, and what the owner's account can create in bound it). Code still refuses the product or instance
 * repo's own name and a name that isn't a plain lowercase one.
 */
function createRepoPart(s: State) {
  const repo = String(s.repo ?? "");
  const name = repo.split("/")[1] ?? "";
  // The orgs the owner lists (the runner's allowed_orgs, passed in as `allowedOrgs`; the owner's account reaching an org alone
  // proves nothing). Without it, only the agents orgs: a plan never says Tier 0 for an org nobody allowed.
  const allowed = [s.allowedOrgs ?? agentsOrgs(s)].flat().filter(Boolean);
  if (!allowed.some((o) => same(orgOf(repo), o))) return REJECT("outside-create-repo", `${repo} is outside the orgs this instance works in (${allowed.join(", ")}): list its org in allowed_orgs`);
  if (same(repo, s.productRepo) || same(repo, s.instanceRepo)) return REJECT("core-repo-create", `${repo} is the product or instance repo`);
  if (name.length > 63 || !NEW_REPO_NAME.test(name)) return REJECT("new-repo-name", `\`${name}\` isn't a new repository's name: lowercase letters, digits and single hyphens, starting with a letter, 63 at most`);
  return T(0, "create-repo", `creating ${repo} is a new private repository: it changes no code, settings or access elsewhere`);
}

/**
 * publish_module: { repo, ref, base, … }, the owner's share of a local module (docs/design/sharing.md). Always the owner's
 * (Tier 2, filed only by his save): never the product or instance repo, never a repo on this server, only owner/name.
 */
function publishModulePart(s: State) {
  const repo = String(s.repo ?? "");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return REJECT("publish-repo-name", `${repo.slice(0, 100)} isn't a repository's owner/name`);
  if (same(repo, s.productRepo) || same(repo, s.instanceRepo)) return REJECT("core-repo-publish", `${repo} is the product or instance repo: a module is shared to a repo of its own`);
  if (isLocal(repo)) return REJECT("local-publish", `${repo} is on this server: a shared module goes to a public repo`);
  return T(2, "publish-module", `the owner's share of a local module to ${repo} \`${s.ref}\`, as he previewed it`);
}

/**
 * Friction is the agent's, never the owner's (owner, 2026-11-14): a head that moved is refused by code with the reason, so the
 * agent asks again. On GitHub checks are the queue's: it waits for none yet or still running, and ends the PR on a red one. A
 * change request on this server has no waiting queue (codehost-local decides at the merge): no named checks or a red one is refused here.
 */
function mergeFriction(p: Pr, ref: string) {
  if (!p.headMatches) return REJECT("head-moved", `${ref} moved since it was asked for: ask again for its new head`);
  if (!isLocal(p.repo)) return undefined;
  if (!(p.checks ?? []).length) return REJECT("no-checks", `${ref} has no named checks on its head: its repo needs CI (a copy of the product's CI template runs at once), or CI didn't start; fix that and ask again`);
  const red = p.checks.filter((c) => !c.ok && !c.pending);
  // A count, never the names: check names are repo-controlled text, and this reason reaches the agent as the runner's.
  if (red.length) return REJECT("checks-not-green", `${ref}: ${red.length} named check(s) failed on the head (\`aidenhq status\` names them). Fix it and publish again`);
  return undefined;
}

/** What the plan says of a merge's checks on its head: "2 named checks, still running ..." (never names). */
function checkStatus(checks: Check[]) {
  const failed = checks.filter((c) => !c.ok && !c.pending).length;
  const n = `${checks.length} named check${checks.length === 1 ? "" : "s"}`;
  if (failed) return { green: false, text: `${n}, ${failed} failed on the exact head (the queue reports it not merged)` };
  if (!checks.length || checks.some((c) => c.pending)) return { green: false, text: `${n}, ${checks.length ? "still running" : "none registered yet"} on the exact head (merged only once green)` };
  return { green: true, text: `${n}, all green on the exact head` };
}

/** A merge's checks as counts the reviewer can match to any readout: "22 named checks, 21 passed, 1 skipped" (never names). */
function checkCounts(checks: Check[]) {
  const n = (k: (c: Check) => unknown) => checks.filter(k).length;
  const parts = [[n((c) => c.ok && !c.skipped), "passed"], [n((c) => c.skipped), "skipped"], [n((c) => c.pending), "running"]].filter(([k]) => k).map(([k, w]) => `${k} ${w}`);
  return [`${checks.length} named check${checks.length === 1 ? "" : "s"}`, ...parts].join(", ");
}

function mergeParts(p: Pr, s: State): Part[] {
  const ref = `${p.repo}#${p.number ?? "?"}`;
  // An adoption's merge (its own readiness rules) is ship's alone, as approve and enqueue are.
  if (p.ship && !p.ship.byShip) return [REJECT("ship-only", `${ref}: only the ship module files a merge for an adoption`)];
  const refused = p.ship && shipRefusal(p.ship, ref);
  if (refused) return [refused];
  // The instance repo is refused before anything reads its files: it changes only through apply, whatever it touches.
  if (same(p.repo, s.instanceRepo)) return [REJECT("core-repo-merge", `${ref} is the instance repo: it changes only through apply`)];
  if (same(p.repo, s.productRepo)) return productMergeParts(p, ref, s);
  if (!Array.isArray(p.files)) return [REJECT("unknown-files", `couldn't list every file ${ref} changes; try again`)];
  // A maintained repo outside the agents org merges like an agents-org repo, under its own rule names (the reviewer sees
  // where it is). Anywhere else the code host only opens PRs: the merge queue refuses it too (merges.ts).
  const listed = inMaintained(p.repo, s);
  if (!listed && !inAgentsOrg(p.repo, s)) return [REJECT("outside-merge", `${ref} is outside the agents org and maintainer_repos: the code host only opens PRs there`)];
  const friction = mergeFriction(p, ref);
  if (friction) return [friction];
  const parts: Part[] = [];
  const workflow = p.files.find((f) => GITHUB.test(f));
  // A count, never the path (as above): the card reason is code's account, and a file name is repo-controlled text.
  if (workflow && p.ciTemplate !== true) parts.push(T(1, "github-dir", `${ref} changes ${p.files.filter((f) => GITHUB.test(f)).length} file(s) under .github/${listed ? ` (${LISTED})` : ""}`));
  // Existing sensitivity alone doesn't make every merge the owner's: the reviewer reads it (and flags new reach).
  if (p.sensitive) parts.push(T(1, "sensitive-app", `${ref} is a sensitive app's repo (access, caps or connects to paperclip)`));
  // A head the runner didn't push (a fork, someone else's push, Dependabot's): the reviewer reads the diff first.
  if (!p.ownHead) parts.push(listed
    ? T(1, "maintained-merge-foreign-head", `${ref}: its head isn't a commit the runner pushed to a branch of ${p.repo} (${LISTED})`)
    : T(1, "agents-org-merge-foreign-head", `${ref}: its head isn't a commit the runner pushed to a branch of ${p.repo}`));
  // Merged at once when CI is green (owner, 2026-11-12): the PR merges on its own (an independent queue), strict and bound to
  // this head, only once every named check passed on it; red leaves it unmerged. None yet or still running waits.
  const c = checkStatus(p.checks);
  // A change request on this server: no CI code-review job read it (that needs GitHub's OIDC), so the AI reviewer reads the
  // card's diff and the request chain (owner, 2026-11-17). Merged only once every named check is green on this head.
  if (isLocal(p.repo)) parts.push(T(1, "local-merge", `${ref}: a change request on this server; ${c.text}`));
  else if (listed) parts.push(c.green ? T(0, "maintained-merge", `${ref} (${LISTED}): ${c.text}`) : T(0, "maintained-merge-checks-running", `${ref} (${LISTED}): ${c.text}`));
  else parts.push(c.green ? T(0, "agents-org-merge", `${ref}: ${c.text}`) : T(0, "agents-org-merge-checks-running", `${ref}: ${c.text}`));
  return parts;
}

/**
 * A product PR's merge (owner, 2026-11-13; any requester since 2026-11-22: every product PR gets ci-required and the
 * mandatory code review before GitHub merges it, and agents are trusted). Once `ci-required` is green and code review passed
 * that exact head (productMergeEligible, checked again right before the merge), it skips the AI reviewer (owner,
 * 2026-11-23); otherwise the reviewer reads it, and the strict queue merges only once every named check is green on that
 * head. A foreign head and a `.github/` change stay the reviewer's. Its files are the platform check's.
 */
function productMergeParts(p: Pr, ref: string, s: State): Part[] {
  if (!Array.isArray(p.files)) return [REJECT("unknown-files", `couldn't list every file ${ref} changes; try again`)];
  const friction = mergeFriction(p, ref);
  if (friction) return [friction];
  if (!p.ownHead) return [T(1, "product-merge-foreign-head", `${ref}: its head isn't a commit the runner pushed to a branch of the product repo (the reviewer reads that exact head)`)];
  // Plain wording, and no "skipped counts as passed": the reviewer reads this line as code's description of the gate, and a
  // sentence that reads as a weakened check made every product merge card a false reject (issue #1449).
  const gates = `On its head: ${checkCounts(p.checks)}. Code merges it only at that head and only after every named check has finished without failure`;
  const eligible = productMergeEligible({ repo: p.repo, head: String(p.head ?? ""), checks: p.checks, verdict: p.verdict, productRepo: String(s.productRepo ?? "") });
  const parts = [eligible ? T(0, "product-merge-reviewed", `${ref}: ci-required is green and code review passed its head`) : T(1, "product-merge", `${ref}: a product PR whose head the code host pushed. ${gates}`)];
  if (eligible && p.files.some((f) => GITHUB.test(f))) parts.push(T(1, "github-dir", `${ref} changes ${p.files.filter((f) => GITHUB.test(f)).length} file(s) under .github/`));
  return parts;
}

/**
 * executor@1's plan for github.{push,pr,merge,close,create_repo} (and codehost-local's): `state` is the verified state the code host read
 * for this request (as `s` above). A refusal throws (the kernel answers it as refused); otherwise the tier above 0 comes back
 * as `raise`, and `targets` bind the record to what it acts on: each branch's commit and base, each PR's head. When any of
 * them moves after approval, the revalidating plan's targets differ and the kernel closes the record as stale. `facts` are the
 * card's (target, sentence, diff), read by the code host from git and never cut: the reviewer reads a diff of any size whole
 * (in parts when it is large). Tier 0 runs unread (a lockfile, a new repo's first push).
 * A push, PR or merge also returns `paths`, one { repo, files: [{ path }] } per branch or PR (a rename is listed at both
 * paths): the kernel raises its tier by them and runs the platform check on them; without them it is the owner's.
 */
export function plan({ kind, args }: { kind: unknown; args?: unknown }, state: State, facts: { diff: string; [k: string]: unknown }) {
  const action = String(kind).replace(/^(codehost|github)\./, "");
  const parts = planParts(action, state).flat();
  if (!parts.length) throw Object.assign(new Error("nothing recognised in the request"), { rule: "unrecognised" });
  const refused = parts.find((p) => p.reject);
  if (refused) throw Object.assign(new Error(refused.reason), { rule: refused.rule });
  const top = parts.reduce((a, b) => (b.tier > a.tier ? b : a));
  const targets = action === "merge" || action === "close" || action === "approve" || action === "enqueue" || action === "repair" || action === "retarget" || action === "retitle"
    ? Object.fromEntries((state.prs ?? []).map((p) => [`${p.repo}#${p.number}`, { repo: p.repo, ref: isLocal(p.repo) ? `change/${p.number}` : `pull/${p.number}`, commit: p.head ?? null, base_sha: p.base ?? null }]))
    : action === "create_repo" ? { [String(state.repo)]: { repo: state.repo } }
    : action === "publish_module" ? { [`${state.repo} ${state.ref}`]: { repo: state.repo, ref: state.ref, commit: state.base } }
    // `base_branch` is the destination the plan read: a publish's open-PR lookup and its new PR's base both use it, so a
    // default-branch switch after approval makes the record stale rather than editing the PR into the new base.
    : Object.fromEntries((state.branches ?? []).map((b) => [`${b.repo} ${b.branch}`, { repo: b.repo, ref: b.branch, commit: b.sha ?? null, base_sha: b.base ?? null, base_branch: b.destination ?? b.defaultBranch ?? null }]));
  const items = action === "push" || action === "pr" ? state.branches : action === "merge" || action === "enqueue" ? state.prs : undefined;
  const paths = items?.map((x) => ({ repo: x.repo, ...(Array.isArray(x.files) ? { files: x.files.map((path) => ({ path })) } : {}) }));
  return { args, targets, facts, ...(paths ? { paths } : {}), ...(top.tier > 0 ? { raise: { tier: top.tier as 1 | 2, reason: top.reason, rule: top.rule } } : {}) };
}
