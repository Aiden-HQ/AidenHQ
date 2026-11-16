// Which tier a write is (the tiered-approvals design), from verified state only: the requester the runner looked up,
// the repos, branches and files git and GitHub report, the instance diff it computed. Pure: no I/O. Tier 0 runs at once,
// Tier 1 goes to the AI reviewer, and `panel: true` on Tier 1 (authority-expanding) to it and a second reviewer, who must
// both approve; Tier 2 is the owner's: their own veto, a split panel, or nothing recognised. Friction (checks red, a head
// that moved, an unreadable file) is never the owner's: `reject: true` refuses it by code and tells the agent why. A
// request with several parts takes its highest part (Tier 1 with the panel above plain Tier 1).
import YAML from "yaml";

/**
 * The gate's own core and anything that can bypass or widen it (owner, 2026-11-14): authority-expanding, so the AI reviewer
 * and a second, independent reviewer on another model family must both approve (`panel`); a split goes to the owner. The
 * approval path (tiers, the reviewer, its policy and its eval cases, the owner's-words check, the merge queue's writes,
 * apply), the state classify() trusts and the runner's GitHub writes (main, state, config, github-app, host git on agent
 * clones), the job jail, who an agent is and what it may call (the kernel's identity and tool proxy, the modules' caller check, the compiler's grants, setup), the board's
 * approval records, decision routes, tier rules and sign-in, the sandboxes, the kernel (its model gateway: key and spend caps), host
 * privileges, the security checks, and the product's CI (the checks a merge waits on). A file stays here when it moves from
 * `.mjs` to `.ts` (the TypeScript conversion), so each name matches either extension.
 */
export const GATE_CORE = [
  // One entry per file, so a renamed or moved gate file shows up as a dead entry (gate-coverage.test.mjs).
  ...["tiers", "review", "authorize", "merges", "apply", "netjail", "state", "config", "github-app", "git", "main", "engines", "workspace", "files", "agents"].map((n) => new RegExp(`^services\\/runner\\/src\\/${n}\\.(mjs|ts)$`)),
  // What a job can reach: its sandbox and launch (engines: the bwrap allowlist, writable roots, env), what lands in its
  // workspace and what the runner reads back from it (workspace, files), and the computer box rules (computers).
  /^scripts\/computers\.(mjs|ts)$/,
  // The engines that run inside a job (engine@1: their argv, env and what they pass on) and the contract and kit they share.
  /^modules\/engine-[^/]+\//,
  /^kernel\/sdk\//,
  /^services\/runner\/test\/reviewer-cases\//,
  /^services\/runner\/scripts\/reviewer-eval\.(mjs|ts)$/,
  /^modules\/core\/security\//,
  // The kernel (the tool proxy, caller identity and assertions, the model gateway) and each module server's copy of the
  // SDK's caller check (scripts/sync-shared.mjs).
  /^kernel\//,
  /(^|\/)aidenhq-sdk\/caller\.ts$/,
  /^scripts\/modules\.(mjs|ts)$/,
  /^scripts\/paperclip-setup\.(mjs|ts)$/,
  /^scripts\/no-shell\.(mjs|ts)$/,
  /^services\/board\/src\/approvals\.ts$/,
  /^services\/board\/src\/app\.ts$/,
  /^services\/board\/src\/fleet\.ts$/,
  /^services\/board\/src\/accounts\.ts$/,
  /^services\/board\/src\/session\.ts$/,
  /^services\/computer\//,
  /^ops\//,
  /^scripts\/verify-security\.sh$/,
  /^scripts\/supply-chain\//,
  /^\.gitleaks\.toml$/,
  // The lean ratchet counters and checklists, and the tests that hold this list and the ratchet: loosening either would
  // hide an ungated file or a growing kernel.
  /^scripts\/lean\//,
  /^scripts\/test\/lean\.test\.mjs$/,
  /^services\/runner\/test\/gate-coverage\.test\.mjs$/,
  /(^|\/)\.github\//,
];
/** Where gate files live: every tracked file here must match a GATE_CORE entry or be listed in OUTSIDE_GATE. A trailing
 * `/` is a prefix; anything else is an exact path. */
export const GATE_DIRS = [
  "services/runner/src/",
  "kernel/",
  "services/computer/",
  "ops/",
  "modules/core/security/",
  "services/board/src/approvals.ts",
  "services/board/src/app.ts",
  "services/board/src/fleet.ts",
  "services/board/src/accounts.ts",
  "services/board/src/session.ts",
];
/** Runner files deliberately outside the core (primer is gate code: GATE_CODE). Adding one here is a gate-core change. */
export const OUTSIDE_GATE = [
  "advise.ts", "answered.ts", "branch.ts", "breaker.ts", "busy.ts", "cards.ts", "describe.ts", "evidence.ts", "gcp.ts", "grade.ts",
  "images.ts", "intake.ts", "metrics.ts", "notices.ts", "paperclip.ts", "primer.ts", "product-prs.ts", "prompt.ts",
  "recurring.ts", "repohelper.ts", "repos.ts", "retry.ts", "reviews.ts", "siblings.ts", "thread.ts", "types.ts", "usage.ts",
].map((f) => `services/runner/src/${f}`);
/** `uncovered: <file>` for a file in a gate dir that no entry matches and OUTSIDE_GATE doesn't list; `dead entry: <source>`
 * for an entry that matches no file. */
export function coverageProblems(files, core = GATE_CORE, outside = OUTSIDE_GATE, dirs = GATE_DIRS) {
  const inDir = (f) => dirs.some((d) => (d.endsWith("/") ? f.startsWith(d) : f === d));
  return [
    ...files.filter((f) => inDir(f) && !outside.includes(f) && !core.some((g) => g.test(f))).map((f) => `uncovered: ${f}`),
    ...core.filter((g) => !files.some((f) => g.test(f))).map((g) => `dead entry: ${g.source}`),
  ];
}
/**
 * Gate code that is not the core: the runner's Primer publishing. The AI reviewer decides (Tier 1) and may flag it for the
 * second reviewer when it weakens a control. (agents.mjs is core: repo access, the owner's words, private reads.)
 */
const GATE_CODE = [/^services\/runner\/src\/primer\.(mjs|ts)$/];
const GITHUB = /(^|\/)\.github\//;
/** Module agents that hold roles (besides any agent whose grants list roles). */
const ROLE_AGENTS = new Set(["chief-of-staff", "architect", "fleet-engineer"]);

const T = (tier, rule, reason) => ({ tier, rule, reason });
/** Authority-expanding: the reviewer and a second reviewer on another model family must both approve. */
const PANEL = (rule, reason) => ({ tier: 1, rule, reason, panel: true });
const REJECT = (rule, reason) => ({ tier: 2, rule, reason, reject: true });
const same = (a, b) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();
const orgOf = (repo) => String(repo).split("/")[0];

const rank = (p) => p.tier * 2 + (p.panel ? 1 : 0);
/** The highest part (a reject beats everything; Tier 1 with the panel beats plain Tier 1); no parts is Tier 2. */
export function highest(parts) {
  if (!parts.length) return T(2, "unrecognised", "nothing recognised in the request");
  return parts.find((p) => p.reject) ?? parts.reduce((a, b) => (rank(b) > rank(a) ? b : a));
}

/**
 * The tier of one request. `s` is the verified state:
 * - every action: { agentsOrg, productRepo, instanceRepo, requester: { platform }, records (the task's approval records,
 *   from the board: earlier decisions, see priorDecisions), also (the actions the request also carries), routineAutonomy }
 * - routineAutonomy: the cap of the routine whose run the task chain started from (routineCap); absent when none
 * - connections: each connection's tool tags from the compiled config ({ name: { tools: { read, write, destructive } } })
 * - every action's requester.platform: the Platform Engineer's line (the Platform Engineer itself, a task the Agent
 *   Architect made, or the owner's own task), the only one that writes to the product repo below Tier 2
 * - push/pr: branches [{ repo, branch, sha, defaultBranch, deployBranch?, empty, files, texts?, ciTemplate? }]
 * - merge: prs [{ repo, number, head, files, texts?, checks: [{ name, ok, pending }] (advisory checks such as design-review left out), headMatches, ownHead (a commit the runner pushed to a same-repo branch), sensitive, dependabot?, ciTemplate? }]
 *   (ciTemplate: the runner checked in its own clone that the commit's `.github/` tree is exactly the product's CI template's
 *   at the deployed product commit: same paths, modes and bytes, no symlink, nothing extra)
 *   (texts, product repo only: { path: { base, head } } for each changed module.yaml and compose file, and for every changed
 *   file of a PR the runner verified as Dependabot's from the API: its author and every commit; then `dependabot: true`)
 * - close: prs [{ repo, dependabot? }] (`dependabot`: a product PR whose author the runner read from the API as dependabot[bot])
 * - apply: { sha, files, base, head (path → text, absent when missing), pin: null | { forward, back }, roles (agent key → roles),
 *   ownerStarted (the task chain began with the owner), trialNoTap (today's trial-handbook rule) }
 * - create_repo: { repo } (the runner checked it doesn't exist yet)
 */
export function classify(action, s) {
  // Raising a spend cap (the board's raise_cap card, filed by the model gateway) is always the owner's tap.
  if (action === "raise_cap") return T(2, "raise-cap", "raising a spend cap is the owner's");
  if (["cancelled", "done"].includes(s.taskStatus)) return REJECT("closed-task", `the task is ${s.taskStatus}: a leftover request runs nothing`);
  // Fail closed: without knowing which repos are the product and the instance, nothing can be told apart from them.
  if (!s.productRepo || !s.instanceRepo || !s.agentsOrg) return T(2, "unknown-repos", "the product repo, instance repo or agents org isn't known here");
  const t = highest(action === "push" || action === "pr" ? publishParts(action, s) : action === "merge" ? mergeParts(s) : action === "close" ? closeParts(s) : action === "apply" ? applyParts(s) : action === "create_repo" ? createRepoParts(s) : []);
  // Earlier decisions on this task (owner, 2026-11-14; replaced "sticky"): the owner's own no holds until they say yes; the
  // reviewer's no holds for the same content and bounds the retries.
  const prior = t.reject ? undefined : priorPart(priorDecisions(s.records, action, s.also, requestKey(action, s), requestPatches(action, s), s.requestChain));
  if (prior) return prior.reject ? prior : { ...prior, reason: `${prior.reason} (was: ${t.reason})` };
  // A routine's cap (its `autonomy`): the stricter of it and the instance's wins. tier0: Tier 1 is the owner's; off: Tier 0 too.
  if (!t.reject && ((s.routineAutonomy === "off" && t.tier < 2) || (s.routineAutonomy === "tier0" && t.tier === 1)))
    return T(2, "routine-autonomy", `a routine's run started this task and that routine's autonomy is ${s.routineAutonomy} (was: ${t.reason})`);
  return t;
}

/** A routine's `autonomy` values, strictest first (the instance setting's names). */
export const AUTONOMY = ["off", "tier0", "full"];
/**
 * The cap on a task from the routines its work came from. `origins`: the task and every issue it traces back to, as
 * Paperclip returns them: its parents, and through each one's `originRunId` (Paperclip's record of the run that created it,
 * which no agent sets) the issue that run worked on, and so on. So an unparented task a routine's run created keeps the
 * cap. `complete`: the trace finished; `routines`: the grants table's {<Paperclip routine id>: autonomy}. The strictest
 * routine found wins. Fails closed: a routine the table doesn't know, or an invalid value, is "off" (setup writes each
 * routine's autonomy into the table before it adds the routine's triggers), and so is a trace too long to finish. None
 * found is no cap.
 */
export function routineCap(origins, complete, routines = {}) {
  const caps = origins.filter((i) => i?.originKind === "routine_execution").map((run) => (AUTONOMY.includes((routines ?? {})[run.originId]) ? routines[run.originId] : "off"));
  if (!complete) caps.push("off");
  return caps.length ? AUTONOMY[Math.min(...caps.map((c) => AUTONOMY.indexOf(c)))] : undefined;
}

/** The actions a record carries: a product PR card with `args.merge` is also a merge, so neither dodges the other's no. */
const carried = (r) => [r.action, ...(r.action === "pr" && r.args?.merge ? ["merge"] : [])];
/** A watcher's no on a stale or duplicate card (decided_by `stale:watcher`) judged nothing: neither a veto nor a rejection. */
const STALE = (r) => /^stale:/.test(r.decidedBy ?? "");

/**
 * The rebuild path's check (an earlier yes is never replayed over a later no; the request gets a fresh card instead):
 * whether a no outranks the approvals being replayed. The owner's veto on the task does; so does a judged rejection (not
 * code's refusal) of the action, or of one the request carries, decided after the earliest of those approvals (`since`),
 * that names one of these branches, is a merge card, or carries the same patch under another name (`samePatch`: record ids
 * the runner matched by content; one it couldn't read counts as the same). A rejection of another branch on the same task never does: it
 * disabled the carry-over for every later rebase (PR #36, WOR-4253).
 */
export function rejectedSince(records, action, also = [], branches = [], since = "", samePatch = new Set()) {
  if (priorDecisions(records, action, also).ownerVeto) return true;
  const mine = (b) => branches.some((x) => same(x.repo, b.repo) && x.branch === b.branch);
  return laterRejections(records, action, also, since).some((r) => r.action === "merge" || (r.args?.only ?? []).some(mine) || samePatch.has(r.id));
}

/**
 * The judged rejections (not code's refusals) of the action, or of one the request carries, decided at or after `since`.
 * The runner checks those on other branches by patch (rebuild): the same change renamed and rebased is still rejected.
 */
export function laterRejections(records, action, also = [], since = "") {
  const want = [action, ...also];
  return (records ?? []).filter((r) => r.state === "rejected" && !STALE(r) && carried(r).some((x) => want.includes(x)) && !CODE_REJECTS.includes(r.reviewCode) && String(r.decidedAt ?? "") >= String(since));
}

/**
 * What a request changes, as a key two requests share only when their content is identical: the commits (push, PR), the
 * PR heads (merge), the fleet commit (apply), a board card's digest. Never a branch name or PR number: renaming a branch
 * doesn't make a rejected change new.
 */
export function requestKey(action, s) {
  if (action === "push" || action === "pr") return keyOf((s.branches ?? []).map((b) => b.sha));
  if (action === "merge") return keyOf((s.prs ?? []).map((p) => p.head));
  if (action === "apply") return s.sha ? `apply:${s.sha}` : undefined;
  if (action === "create_repo") return s.repo ? `create_repo:${String(s.repo).toLowerCase()}` : undefined;
  return s.digest ? `digest:${s.digest}` : undefined;
}
/**
 * A branch or PR request's patch keys (each branch's or PR's change, git.mjs patchKey), sorted and joined: the same however
 * the commits are rebased or the branch named. null when any is missing (fails closed against an owner veto); undefined for
 * actions keyed otherwise.
 */
export function requestPatches(action, s) {
  const list = action === "push" || action === "pr" ? s.branches : action === "merge" ? s.prs : undefined;
  if (!list) return undefined;
  return list.length && list.every((x) => typeof x.patch === "string") ? list.map((x) => x.patch).sort().join(",") : null;
}
const recordPatches = (r) => requestPatches(r.action, { branches: r.args?.only ?? [], prs: r.args?.prs ?? [] }) ?? undefined;

/** The same key for an approval record (its args; a board-applied card's digest is its content). */
export function recordKey(r) {
  if (r.action === "push" || r.action === "pr") return keyOf((r.args?.only ?? []).map((b) => b.sha));
  if (r.action === "merge") return keyOf((r.args?.prs ?? []).map((p) => p.head));
  if (r.action === "apply") return r.args?.sha ? `apply:${r.args.sha}` : undefined;
  if (r.action === "create_repo") return r.args?.repo ? `create_repo:${String(r.args.repo).toLowerCase()}` : undefined;
  return r.digest ? `digest:${r.digest}` : undefined;
}
const keyOf = (list) => (list.length && list.every((x) => typeof x === "string" && /^[0-9a-f]{7,64}$/i.test(x)) ? list.map((x) => x.toLowerCase()).sort().join(",") : undefined);

/** Reviewer rejections a task's retries are bounded by: past this many (since the owner's last yes), the action is parked. */
export const MAX_REJECTS = 3;
/** Rejections code made without judging the change (it moved, couldn't be read, too large): they are never findings. */
export const CODE_REJECTS = ["refused_by_code", "stale_head", "check_failed", "too_large", "files_not_shown", "no_diff", "reviewer_failed"];
const byOwner = (r) => Boolean(r.decidedBy) && !/^(reviewer|auto|stale):/.test(r.decidedBy);
// An approved card a newer request replaced is `expired`, still decided (a yes).
const decided = (r) => ["approved", "used", "expired", "rejected"].includes(r.state) && Boolean(r.decidedBy);

/**
 * Earlier decisions on a task for a request (owner, 2026-11-14), from its approval records of the action (or of one the
 * request also carries; only decided records, never a Tier 0 audit row):
 * - ownerVeto: the owner's latest decision on it was a no (their later yes withdraws that), or the owner rejected exactly
 *   this content and hasn't approved that same content since (an approval of other content doesn't lift it).
 * - rejects: the AI reviewer's rejections on the task since the owner's last yes, task-wide (any branch, PR or name),
 *   except those whose exact content was approved later. At MAX_REJECTS the action is parked.
 * - same: one of those rejected exactly this content (requestKey): it stays rejected (its note). Two reviewers' unsure
 *   lifts once, after the request chain changed (`chain`: the current chain's hash).
 * - relift: that lift's earlier note: the re-review's unsure goes to the owner, not back to the agent.
 * - findings: every one of those notes, attached to the next review.
 */
export function priorDecisions(records, action, also = [], key, patches, chain) {
  const want = [action, ...(also ?? [])];
  const mine = (records ?? []).filter((r) => decided(r) && carried(r).some((x) => want.includes(x))).sort((a, b) => String(a.decidedAt ?? "").localeCompare(String(b.decidedAt ?? "")));
  const lastOwner = mine.filter(byOwner).at(-1);
  const ownerYes = mine.filter((r) => byOwner(r) && r.state !== "rejected").at(-1);
  const approvedLater = (r) => mine.some((y) => y.state !== "rejected" && String(y.decidedAt) > String(r.decidedAt) && recordKey(y) !== undefined && recordKey(y) === recordKey(r));
  const since = mine.filter((r) => r.state === "rejected" && r.decidedBy.startsWith("reviewer:") && !CODE_REJECTS.includes(r.reviewCode) && (!ownerYes || String(r.decidedAt) > String(ownerYes.decidedAt)) && !approvedLater(r));
  // Two reviewers unsure (reviewer_unsure) is about the request: the fix is often the brief or an authorisation, so the
  // same commits may come back once, after the request chain changed (`chain`, its hash now; `requestChain`, its hash
  // when they were unsure). The chain is agent-editable, so that relift happens at most once per content: the re-review
  // gets `relift` (the first round's note), and unsure again there goes to the owner (review.mjs). Unchanged or unknown
  // chain, or any other rejection of the content, and it stays rejected. It still counts toward MAX_REJECTS.
  const rejectedSame = key ? since.filter((r) => recordKey(r) === key) : [];
  const [only] = rejectedSame;
  const lifted = rejectedSame.length === 1 && only.reviewCode === "reviewer_unsure" && Boolean(only.requestChain) && Boolean(chain) && only.requestChain !== chain;
  const same = lifted ? undefined : rejectedSame[0];
  // The owner's no on this exact content holds until they approve that same content, whatever else they approved since.
  // Same content: the commits, or the patch keys (a rebased or renamed resubmission). Patch keys that couldn't be computed
  // (null) fail closed: any owner rejection of the action on the task makes it theirs.
  const sameContent = (r) => (key !== undefined && recordKey(r) === key) || (typeof patches === "string" && recordPatches(r) === patches);
  const ownerNo = mine.some((r) => byOwner(r) && r.state === "rejected" && (patches === null || (sameContent(r) && !mine.some((y) => byOwner(y) && y.state !== "rejected" && sameContent(y) && String(y.decidedAt) > String(r.decidedAt)))));
  return { ownerVeto: lastOwner?.state === "rejected" || ownerNo, same: same ? same.review || "no note" : undefined, relift: lifted ? only.review || "no note" : undefined, rejects: since.length, findings: since.map((r) => r.review).filter(Boolean) };
}

/** What earlier decisions do to a request: the owner's veto (their card), a rejected change resent, a retry past the bound. */
export function priorPart(p) {
  if (!p) return undefined;
  if (p.ownerVeto) return T(2, "owner-veto", "the owner rejected this action on this task, and only their own yes lifts it");
  if (p.same !== undefined) return REJECT("rejected-content", `the AI reviewer already rejected exactly this change on this task (its note: ${String(p.same).slice(0, 400)}). Fix what it found and ask again with the changed commits`);
  if (p.rejects >= MAX_REJECTS) return REJECT("retries-exhausted", `parked: the AI reviewer rejected this action ${p.rejects} times on this task, so it isn't reviewed again here. Report what it found to whoever asked for this work`);
  return undefined;
}

function publishParts(action, s) {
  return (s.branches ?? []).map((b) => {
    const inAgents = Boolean(s.agentsOrg) && same(orgOf(b.repo), s.agentsOrg);
    if (same(b.repo, s.instanceRepo)) return REJECT("instance-repo", "the instance repo changes only through apply");
    if (!Array.isArray(b.files)) return REJECT("unknown-files", `couldn't tell which files ${b.repo} \`${b.branch}\` changes; try again`);
    if (same(b.repo, s.productRepo)) {
      if (action === "pr" && !s.requester?.platform) return REJECT("product-pr-requester", "only the Platform Engineer (or a task the owner or the Agent Architect made) may open PRs on the product repo");
      if (b.empty || b.branch === b.defaultBranch) return REJECT("product-default-branch", `\`${b.branch}\` is the product repo's default branch: publish a branch and open a PR`);
      if (!s.requester?.platform) return REJECT("product-push", "only the Platform Engineer's line pushes to the product repo: hand product changes to the Platform Engineer");
      const what = T(1, action === "pr" ? "product-pr" : "product-push-branch", `${action === "pr" ? "a PR" : "a branch push"} to the product repo from the Platform Engineer's line`);
      return highest([...productFileParts(b.files, b.texts, s), what]);
    }
    const workflow = (b.files ?? []).find((f) => GITHUB.test(f));
    const parts = [];
    // A byte-identical copy of the product's CI template (checked in the runner's own clone) is Tier 0; any other `.github/`
    // change is the reviewer's (who flags one that weakens a check for the second reviewer).
    if (workflow && !(inAgents && b.ciTemplate === true)) parts.push(T(1, "github-dir", `it changes ${workflow}`));
    if (inAgents) {
      if (b.empty) parts.push(T(1, "empty-repo", `${b.repo} is empty: the first push lands on its default branch`));
      // Straight onto the branch apps deploy from or merge into, past the PR and its checks: weakens the merge gate.
      else if (b.branch === b.defaultBranch || (b.deployBranch && b.branch === b.deployBranch)) parts.push(PANEL("default-branch", `\`${b.branch}\` is ${b.repo}'s default or deploy branch, past its PR checks`));
      else parts.push(T(0, workflow ? "ci-template-copy" : "agents-org-branch", workflow ? `${b.repo}'s \`.github/\` is exactly the product's CI template` : `an ordinary branch of ${b.repo} in the agents org`));
      return highest(parts);
    }
    if (b.empty || b.branch === b.defaultBranch) return REJECT("outside-default-branch", `\`${b.branch}\` is ${b.repo}'s default branch, outside the agents org: publish a branch and open a PR`);
    parts.push(action === "pr" ? T(1, "outside-pr", `a draft PR to ${b.repo}, outside the agents org`) : T(1, "outside-push", `a branch push to ${b.repo}, outside the agents org`));
    return highest(parts);
  });
}

/**
 * close: prs [{ repo, dependabot? }]. Tier 0 in the agents org (reversible, no code changes); the instance repo's PRs are the
 * owner's. On the product repo only a Dependabot PR (its author verified as dependabot[bot] from the GitHub API by the runner,
 * never from text) may be closed, by the Platform Engineer's line, at Tier 0 (owner, 2026-11-13): closing changes no code,
 * the reason is posted on the PR, and reopening it undoes it.
 */
function closeParts(s) {
  return (s.prs ?? []).map((p) => {
    if (same(p.repo, s.productRepo)) {
      if (p.dependabot !== true) return REJECT("core-repo-close", `${p.repo} is the product repo: only its Dependabot PRs may be closed`);
      if (!s.requester?.platform) return REJECT("product-close-requester", "only the Platform Engineer's line may close the product repo's Dependabot PRs");
      return T(0, "product-dependabot-close", "closing a Dependabot PR of the product repo is reversible (reopen) and changes no code");
    }
    if (!same(orgOf(p.repo), s.agentsOrg)) return REJECT("outside-close", `${p.repo} is outside the agents org`);
    if (same(p.repo, s.instanceRepo)) return REJECT("core-repo-close", `${p.repo} is the instance repo: its PRs are the owner's`);
    return T(0, "agents-org-close", `closing a PR of ${p.repo} is reversible and changes no code`);
  });
}

/** A new repository's name: lowercase words joined by hyphens, as an app's name (never `.github` or a path). */
const NEW_REPO_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/**
 * create_repo: { repo }. A new private repository in the agents org, asked for only by `aidenhq create-repo` (naming, adding or
 * detecting a missing repo never creates one). It grows the org (owner, 2026-11-14): authority-expanding, so the panel
 * decides it against the request chain. Anywhere else, or a name that isn't one, code refuses it.
 */
function createRepoParts(s) {
  const repo = String(s.repo ?? "");
  const name = repo.split("/")[1] ?? "";
  if (!same(orgOf(repo), s.agentsOrg)) return [REJECT("outside-create-repo", `${repo} is outside the agents org: repositories are created only in ${s.agentsOrg}`)];
  if (same(repo, s.productRepo) || same(repo, s.instanceRepo)) return [REJECT("core-repo-create", `${repo} is the product or instance repo`)];
  if (name.length > 63 || !NEW_REPO_NAME.test(name)) return [REJECT("new-repo-name", `\`${name}\` isn't a new repository's name: lowercase letters, digits and single hyphens, starting with a letter, 63 at most`)];
  return [PANEL("agents-org-create-repo", `creating ${repo} adds a repository to the agents org`)];
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
  if (red.length) return REJECT("checks-not-green", `${ref}: ${red.length} named check(s) failed on the head (\`gh pr checks ${p.number ?? ""}\` names them). Fix it and publish again`);
  return undefined;
}

/** A merge's checks as counts the reviewer can match to any readout: "22 named checks, 21 passed, 1 skipped" (never names). */
function checkCounts(checks) {
  const n = (k) => checks.filter(k).length;
  const parts = [[n((c) => c.ok && !c.skipped), "passed"], [n((c) => c.skipped), "skipped"], [n((c) => c.pending), "running"]].filter(([k]) => k).map(([k, w]) => `${k} ${w}`);
  return [`${checks.length} named check${checks.length === 1 ? "" : "s"}`, ...parts].join(", ");
}

function mergeParts(s) {
  return (s.prs ?? []).map((p) => {
    const ref = `${p.repo}#${p.number ?? "?"}`;
    if (same(p.repo, s.productRepo)) return productMergePart(p, ref, s);
    if (same(p.repo, s.instanceRepo)) return REJECT("core-repo-merge", `${ref} is the instance repo: it changes only through apply`);
    if (!Array.isArray(p.files)) return REJECT("unknown-files", `couldn't list every file ${ref} changes; try again`);
    const friction = mergeFriction(p, ref);
    if (friction) return friction;
    const parts = [];
    // Outside the agents org: a write into someone else's repo (its own GitHub review applies too), the panel's.
    const outside = !s.agentsOrg || !same(orgOf(p.repo), s.agentsOrg);
    if (outside) parts.push(PANEL("outside-merge", `${ref} is outside the agents org (its own GitHub review applies too)`));
    const workflow = p.files.find((f) => GITHUB.test(f));
    if (workflow && !(p.ciTemplate === true && !outside)) parts.push(T(1, "github-dir", `${ref} changes ${workflow}`));
    // Existing sensitivity alone doesn't make every merge the owner's: the reviewer reads it (and flags new reach).
    if (p.sensitive) parts.push(T(1, "sensitive-app", `${ref} is a sensitive app's repo (access, caps or connects to paperclip)`));
    // A head the runner didn't push (a fork, someone else's push): the reviewer reads the diff first.
    if (!p.ownHead) parts.push(T(1, "agents-org-merge-foreign-head", `${ref}: its head isn't a commit the runner pushed to a branch of ${p.repo}`));
    // Merged at once when CI is green (owner, 2026-11-12): the PR merges on its own (an independent queue), strict and bound to
    // this head, only once every named check passed on it; red leaves it unmerged. Still running is not red.
    const n = `${p.checks.length} named check${p.checks.length === 1 ? "" : "s"}`;
    if (!outside) parts.push(p.checks.some((c) => c.pending) ? T(0, "agents-org-merge-checks-running", `${ref}: ${n}, still running on the exact head (merged only once green)`) : T(0, "agents-org-merge", `${ref}: ${n}, all green on the exact head`));
    return highest(parts);
  });
}

/**
 * A product PR's merge (owner, 2026-11-13): the reviewer's when the Platform Engineer's line asks, the PR's head is one the
 * runner pushed (no fork, no one else's push), it is the card's head, no gate code, and its named checks aren't red. Still
 * running is not red: a reviewer-approved merge runs the strict queue, which merges only once every named check is green on
 * that exact head. Never Tier 0: the product reaches every instance through the pin.
 */
function productMergePart(p, ref, s) {
  if (!s.requester?.platform) return REJECT("product-merge-requester", `${ref}: only the Platform Engineer's line merges product PRs`);
  if (!Array.isArray(p.files)) return REJECT("unknown-files", `couldn't list every file ${ref} changes; try again`);
  // A Dependabot pin bump: the reviewer's alone when every condition holds; otherwise the rules below.
  if (p.dependabot === true) {
    const d = dependabotMergePart(p, ref);
    if (d.tier === 1) return d;
  }
  const friction = mergeFriction(p, ref);
  if (friction) return friction;
  const what = p.ownHead
    ? T(1, "product-merge", `${ref}: a product PR from the Platform Engineer's line. On its head: ${checkCounts(p.checks)}. Code merges it only at that head, once every named check has passed (skipped counts as passed) and main is green`)
    : T(1, "product-merge-foreign-head", `${ref}: its head isn't a commit the runner pushed to a branch of the product repo (the reviewer reads that exact head)`);
  return highest([...productFileParts(p.files, p.texts, s), what]);
}

/**
 * Whether a PR's commits (GitHub REST, oldest first: [{ sha, author, committer, verified }]) are all Dependabot's and end at
 * `head`: author dependabot[bot], signed by GitHub (verified) and committed by web-flow or dependabot[bot]. Any other
 * commit, the runner's own included, leaves the PR to the ordinary product rules.
 */
export function dependabotCommits(commits, head) {
  const D = "dependabot[bot]";
  return commits.length > 0 && commits.at(-1).sha === head && commits.every((c) => c.author === D && c.verified === true && ["web-flow", D].includes(c.committer));
}

/** The supply-chain job in .github/workflows/ci.yml (npm-age and pins): a Dependabot merge needs it by name, green. */
export const SUPPLY_CHAIN_CHECK = "supply-chain";

/**
 * A Dependabot PR's merge on the product repo (owner, 2026-11-13): Tier 1 (`product-dependabot-merge`) only when the runner
 * verified from the GitHub API that the PR and every commit on its head are Dependabot's (`p.dependabot`), the head is the
 * card's, every named check passed on it (none still running) with the supply-chain check among them, and every changed
 * file is a pin-only change by content (`p.texts` holds each file's base and head), no version jumping a major. Gate files
 * and `.github/workflows/` included: there only pins may move. Anything else, or anything unreadable, is Tier 2.
 */
function dependabotMergePart(p, ref) {
  const no = (rule, reason) => T(2, rule, `${ref} (Dependabot): ${reason}`);
  if (!p.headMatches) return no("head-moved", "moved since the card");
  const checks = p.checks ?? [];
  if (!checks.length) return no("no-checks", "no named checks");
  const notGreen = checks.filter((c) => !c.ok || c.pending);
  if (notGreen.length) return no("dependabot-checks", `${notGreen.map((c) => c.name).join(", ")} not green (still running counts here)`);
  if (!checks.some((c) => c.name === SUPPLY_CHAIN_CHECK)) return no("dependabot-supply-chain", `no \`${SUPPLY_CHAIN_CHECK}\` check`);
  if (!p.files.length) return no("unknown-files", "changes no files");
  for (const f of p.files) {
    const why = pinOnly(f, p.texts?.[f]);
    if (why) return no("dependabot-not-pin-only", `${f}: ${why}`);
  }
  return T(1, "product-dependabot-merge", `${ref}: a Dependabot PR (author and every commit verified), pin-only changes in ${p.files.length} file${p.files.length === 1 ? "" : "s"}, no major jump, every named check green on the exact head (${SUPPLY_CHAIN_CHECK} included)`);
}

const LOCKFILE = /(^|\/)package-lock\.json$/;
const PACKAGE_JSON = /(^|\/)package\.json$/;
const DOCKERFILE = /(^|\/)(Dockerfile[^/]*|[^/]+\.Dockerfile)$/;
const WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/;

/** Why `f` is not a pin-only change (a string), or undefined when it is. `t`: { base, head } texts; missing or one-sided fails. */
export function pinOnly(f, t) {
  const kind = LOCKFILE.test(f) ? lockfileWhy : PACKAGE_JSON.test(f) ? packageJsonWhy : DOCKERFILE.test(f) ? dockerfileWhy : WORKFLOW.test(f) ? workflowWhy : COMPOSE.test(f) ? composeWhy : undefined;
  if (!kind) return "not a lockfile, package.json, Dockerfile, compose file or workflow";
  if (typeof t?.base !== "string" || typeof t?.head !== "string") return "couldn't read it on both sides (added, removed or unread)";
  try {
    return kind(t.base, t.head);
  } catch {
    return "doesn't parse";
  }
}

/**
 * The major of a version or tag, for "no major jump": its first number, or `0.<minor>` below 1 (semver: 0.x minors break).
 * Undefined without a number (a tag such as `latest`): a change from such a tag fails closed.
 */
export function majorOf(v) {
  const m = /(\d+)(?:\.(\d+))?/.exec(String(v ?? ""));
  if (!m) return undefined;
  return Number(m[1]) === 0 ? `0.${m[2] ?? ""}` : String(Number(m[1]));
}
const majorJump = (a, b) => a !== b && (majorOf(a) === undefined || majorOf(a) !== majorOf(b));

/** A plain version (exact, or a ^/~ range on one version): no npm: alias, git, URL, file: or dist-tag. */
const PLAIN_VERSION = /^[\^~]?\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
const DEP_MAPS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
const withoutDeps = (o) => Object.fromEntries(Object.entries(o ?? {}).filter(([k]) => !DEP_MAPS.includes(k)));

/** Dependency maps: the same names on both sides, only plain versions changing, no major jump. */
function depMapsWhy(b, h) {
  for (const k of DEP_MAPS) {
    const [bm, hm] = [b?.[k] ?? {}, h?.[k] ?? {}];
    if (!eq(Object.keys(bm).sort(), Object.keys(hm).sort())) return `${k}: a dependency added or removed`;
    for (const name of Object.keys(hm)) {
      if (bm[name] === hm[name]) continue;
      if (!PLAIN_VERSION.test(String(bm[name])) || !PLAIN_VERSION.test(String(hm[name]))) return `${k}.${name}: not a plain version (${hm[name]})`;
      if (majorJump(bm[name], hm[name])) return `${k}.${name}: major jump ${bm[name]} → ${hm[name]}`;
    }
  }
  return undefined;
}

function packageJsonWhy(base, head) {
  const [b, h] = [JSON.parse(base), JSON.parse(head)];
  if (!eq(withoutDeps(b), withoutDeps(h))) return "changes more than dependency versions (scripts, overrides or another field)";
  return depMapsWhy(b, h);
}

/**
 * package-lock.json (v2/v3): only `packages` changes; its root entry as package.json; every new or changed entry resolves
 * from registry.npmjs.org with an integrity hash (bundled entries excepted), gains no install script and is no link; a
 * version on both sides never jumps a major (transitive entries included).
 */
function lockfileWhy(base, head) {
  const [b, h] = [JSON.parse(base), JSON.parse(head)];
  if (!(b.lockfileVersion >= 2) || b.lockfileVersion !== h.lockfileVersion) return "not a v2/v3 lockfile on both sides";
  const { packages: bp = {}, ...bRest } = b;
  const { packages: hp = {}, ...hRest } = h;
  if (!eq(bRest, hRest)) return "changes more than `packages`";
  for (const [path, e] of Object.entries(hp)) {
    const was = bp[path];
    if (eq(was, e)) continue;
    if (path === "") {
      if (!was || !eq(withoutDeps(was), withoutDeps(e))) return "the root entry changes more than dependency versions";
      const why = depMapsWhy(was, e);
      if (why) return `root: ${why}`;
      continue;
    }
    if (e.link || was?.link) return `${path}: a link entry changes`;
    if ("name" in e) return `${path}: an alias (\`name\` ${e.name})`;
    if (Boolean(e.inBundle) !== Boolean(was?.inBundle) || e.inBundle) return `${path}: a bundled entry changes`;
    if (e.hasInstallScript && !was?.hasInstallScript) return `${path}: gains an install script`;
    // The tarball of exactly this package and version (the name from the path key): no other package, host or alias.
    const name = path.split("node_modules/").pop();
    if (!/^(@[\w.-]+\/)?[\w.-]+$/.test(name) || e.resolved !== `https://registry.npmjs.org/${name}/-/${name.split("/").pop()}-${e.version}.tgz` || !e.integrity) return `${path}: not resolved to ${name}@${e.version} on registry.npmjs.org with an integrity hash`;
    if (was && was.version !== e.version && majorJump(was.version, e.version)) return `${path}: major jump ${was.version} → ${e.version}`;
  }
  return undefined;
}

/** Line by line: the same number of lines, and `ok(baseLine, headLine)` (a reason when not) for every changed one. */
function linesWhy(base, head, ok) {
  const [b, h] = [base.replace(/\r\n/g, "\n").split("\n"), head.replace(/\r\n/g, "\n").split("\n")];
  if (b.length !== h.length) return "lines added or removed";
  for (let i = 0; i < b.length; i++) {
    if (b[i] === h[i]) continue;
    const why = ok(b[i], h[i]);
    if (why) return `line ${i + 1}: ${why}`;
  }
  return undefined;
}

const tagOf = (ref) => /:([^/:]+)$/.exec(String(ref ?? "").replace(/@sha256:[0-9a-f]+$/, ""))?.[1] ?? "";
/** The same image repository, and no major jump between the tags. */
const imageWhy = (a, b) => (imageRepo(a) !== imageRepo(b) ? `another image (${imageRepo(a)} → ${imageRepo(b)})` : majorJump(tagOf(a), tagOf(b)) ? `major jump ${tagOf(a)} → ${tagOf(b)}` : undefined);

const FROM = /^(\s*FROM\s+(?:--platform=\S+\s+)?)(\S+)((?:\s+AS\s+\S+)?\s*)$/i;
/** A Dockerfile: only FROM lines change, each on the same image, with the same flags and stage name. */
function dockerfileWhy(base, head) {
  return linesWhy(base, head, (bl, hl) => {
    const [bm, hm] = [FROM.exec(bl), FROM.exec(hl)];
    if (!bm || !hm) return "not a FROM line";
    if (bm[1] !== hm[1] || bm[3] !== hm[3]) return "the FROM line's flags or stage name change";
    return imageWhy(bm[2], hm[2]);
  });
}

const USES = /^(\s*(?:-\s+)?uses:\s+)([\w.-]+\/[\w./-]+)@([0-9a-f]{40})(\s+#\s*)(\S+)\s*$/;
/** A workflow: only `uses: owner/action@<sha> # tag` lines change, each on the same action and step, still SHA-pinned. */
function workflowWhy(base, head) {
  return linesWhy(base, head, (bl, hl) => {
    const [bm, hm] = [USES.exec(bl), USES.exec(hl)];
    if (!bm || !hm) return "not a SHA-pinned `uses:` line";
    if (bm[1] !== hm[1] || bm[2] !== hm[2]) return `another action or step (${bm[2]} → ${hm[2]})`;
    return majorJump(bm[5], hm[5]) ? `major jump ${bm[5]} → ${hm[5]}` : undefined;
  });
}

/** A compose file: the image-bump rule (composeParts), and no major jump in any service's image. */
function composeWhy(base, head) {
  if (composeParts("", base, head)[0].rule !== "product-image-bump") return "changes more than image tags or digests";
  const [b, h] = [parse(base), parse(head)];
  for (const [name, svc] of Object.entries(h.services ?? {})) {
    const was = b.services?.[name]?.image;
    const why = svc?.image === was ? undefined : imageWhy(was, svc?.image);
    if (why) return `${name}: ${why}`;
  }
  return undefined;
}

/**
 * The product files that need more than one reviewer's plain read: the gate's core (panel), other gate code and a role
 * holder's handbook (Tier 1, named), and module.yaml or a compose file (root or a module's fragment) judged by content.
 * `texts` maps those config files to { base, head } (text, or undefined when absent on that side); a config file without
 * an entry couldn't be read: refused, to ask again.
 */
function productFileParts(files, texts = {}, s) {
  const parts = [];
  for (const f of files) {
    let m;
    if (GATE_CORE.some((g) => g.test(f))) parts.push(PANEL("gate-core", `it changes the gate's own core (${f})`));
    else if (GATE_CODE.some((g) => g.test(f))) parts.push(T(1, "product-gate", `it changes gate code (${f})`));
    else if ((m = /^modules\/[^/]+\/agents\/([a-z0-9][a-z0-9-]*)\/AGENTS\.md$/.exec(f)) && (ROLE_AGENTS.has(m[1]) || (s.roles?.[m[1]] ?? []).length)) parts.push(T(1, "role-handbook", `handbook of ${m[1]}, which holds a role`));
    else if (/^modules\/[^/]+\/module\.yaml$/.test(f) || COMPOSE.test(f)) {
      const t = texts?.[f];
      if (!t) parts.push(REJECT("unknown-content", `couldn't read ${f} on both sides; try again`));
      else parts.push(...(COMPOSE.test(f) ? composeParts(f, t.base, t.head) : moduleParts(f, t.base, t.head, s.connections)));
    }
  }
  return parts;
}

/** Any compose file in the product (the root's, every module's fragment, whatever a module's `compose:` names). */
export const COMPOSE = /(^|\/)(docker-)?compose[^/]*\.ya?ml$/;
/** An image reference without its tag and digest: `registry/name`. */
const imageRepo = (ref) => String(ref ?? "").replace(/@sha256:[0-9a-f]+$/, "").replace(/:[^/:]+$/, "");

/**
 * A compose file: an image bump (only `services.*.image` tags or digests change, same image repository, same services) is
 * the reviewer's; volumes, privileges, networks, capabilities, devices, env, a new service or another image the owner's.
 */
function composeParts(f, baseText, headText) {
  const [b, h] = [parse(baseText), parse(headText)];
  if (!b || !h) return [PANEL("product-compose", `${f} doesn't parse, or is added or removed`)];
  const noImages = (c) => ({ ...c, services: Object.fromEntries(Object.entries(c.services ?? {}).map(([k, v]) => [k, { ...(v ?? {}), image: imageRepo(v?.image) }])) });
  return eq(noImages(b), noImages(h)) ? [T(1, "product-image-bump", `${f}: image tags or digests only`)] : [PANEL("product-compose", `${f} changes more than image tags or digests (volumes, privileges, network, env, services or another image)`)];
}

/** What a module agent may change with one reviewer: everything else (model, connections, roles, image, a new agent) is the panel's. */
const MODULE_AGENT_SAFE = new Set(["reasoning_effort", "timeout_sec", "heartbeat", "persona", "max_parallel", "graded", "brief"]);
/**
 * Module keys that are the reviewer's (text, labels, schedules without a model); agents, routines, connections and apps are
 * checked below; the rest (settings and their defaults such as autonomy, compose, codex_args, isolation, secrets) are the panel's.
 */
const MODULE_SAFE = new Set(["name", "description", "requires", "labels", "company"]);

/**
 * A module.yaml change, by content (the instance apply's rules, applied to the product): new or wider grants, new tools,
 * models, roles, images, new agents, credentials, the tool-only sandbox (codex_args) and sensitive apps are authority-
 * expanding: the panel's.
 */
function moduleParts(f, baseText, headText, connections = {}) {
  const b = baseText === undefined ? {} : parse(baseText);
  const h = headText === undefined ? undefined : parse(headText);
  if (b === null || h === null) return [REJECT("unparseable", `${f} doesn't parse`)];
  if (h === undefined) return [PANEL("module-removed", `removes ${f}`)];
  const parts = [];
  const why = (rule, reason) => parts.push(PANEL(rule, `${f}: ${reason}`));
  for (const k of changedKeys(b, h)) {
    if (MODULE_SAFE.has(k)) continue;
    if (k === "agents") {
      for (const key of changedKeys(b.agents, h.agents)) {
        const [ba, ha] = [b.agents?.[key], h.agents?.[key]];
        if (!ha) continue; // an agent removed: the reviewer's
        if (!ba) why("module-new-agent", `adds agent ${key}`);
        else {
          // Tags as compiled, with this module's own connections as the change leaves them (a retag here counts).
          const wider = newGrants(ba.connections, ha.connections, { ...connections, ...(h.connections ?? {}) });
          if (wider.length) why("new-grants", `${key} gets new grants: ${wider.join(", ")}`);
          const roles = [ha.roles ?? []].flat().filter((r) => ![ba.roles ?? []].flat().includes(r));
          if (roles.length) why("module-roles", `${key} gets roles ${roles.join(", ")}`);
          const other = changedKeys(ba, ha).filter((x) => x !== "connections" && x !== "roles" && !MODULE_AGENT_SAFE.has(x));
          if (other.length) why("module-agent-fields", `${key} changes ${other.join(", ")}`);
        }
      }
    } else if (k === "routines") {
      const models = changedKeys(b.routines, h.routines).filter((r) => h.routines?.[r] && !eq(b.routines?.[r]?.model, h.routines[r].model));
      if (models.length) why("module-routine-model", `routine model changes (${models.join(", ")})`);
      const caps = routineAutonomyChanges(b.routines, h.routines);
      if (caps.length) why("routine-autonomy", `routine autonomy changes (${caps.join(", ")})`);
    } else if (k === "connections") {
      for (const c of changedKeys(b.connections, h.connections)) {
        const [bc, hc] = [b.connections?.[c], h.connections?.[c]];
        if (!hc) continue;
        const tools = (x) => Object.values(x?.tools ?? {}).flat();
        // A tool newly under write or read (a destructive one retagged) widens what the `write` or `read` shorthand grants.
        const moved = (tag) => (t) => (hc.tools?.[tag] ?? []).includes(t) && !(bc.tools?.[tag] ?? []).includes(t);
        const added = !bc ? ["(new connection)"] : tools(hc).filter((t) => !tools(bc).includes(t) || moved("write")(t) || moved("read")(t));
        const fields = changedKeys(bc ?? {}, hc).filter((x) => x !== "guide" && x !== "tools");
        if (added.length || fields.length) why("module-tools", `connection ${c}: ${[...added, ...fields].join(", ")}`);
      }
    } else if (k === "apps") {
      const ps = appsParts(b.apps ?? [], h.apps ?? []);
      parts.push(...ps.filter((x) => x.panel || x.tier === 2).map((x) => ({ ...x, reason: `${f}: ${x.reason}` })));
    } else why("module-key", `changes ${k}`);
  }
  return parts.length ? parts : [T(1, "module-config", `${f}: no new grants, tools, models, roles or credentials`)];
}

const parse = (text) => {
  try {
    return text == null ? undefined : (YAML.parse(String(text)) ?? {});
  } catch {
    return null; // unparseable: unrecognised
  }
};
const eq = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const changedKeys = (a = {}, b = {}) => [...new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])].filter((k) => !eq(a?.[k], b?.[k]));

/**
 * Grants `head` gives that `base` didn't: a connection added, or a wider grant (read → write, more tools). `conns` is each
 * connection's tags ({ name: { tools: { read, write, destructive } } }, from the compiled config): where `write` was, a list
 * is wider when it names any tool outside the connection's read and write tags (a destructive one: `write` never covers it),
 * and wider whenever the connection's tags aren't known (fail closed).
 */
export function newGrants(base = {}, head = {}, conns = {}) {
  const out = [];
  for (const [conn, g] of Object.entries(head ?? {})) {
    const was = (base ?? {})[conn];
    if (eq(was, g) || (was === "read" && g === "read")) continue;
    if (was === "write" && g === "read") continue;
    const tags = conns?.[String(conn).replace(/\?$/, "")]?.tools;
    if (was === "write" && Array.isArray(g) && tags && g.every((t) => [...(tags.read ?? []), ...(tags.write ?? [])].includes(t))) continue;
    if (Array.isArray(g) && Array.isArray(was) && g.every((t) => was.includes(t))) continue;
    out.push(conn);
  }
  return out;
}

/** Routines whose `autonomy` (their cap on approvals) is set, changed or dropped: always the owner's. */
const routineAutonomyChanges = (b = {}, h = {}) => [...new Set([...Object.keys(b ?? {}), ...Object.keys(h ?? {})])].filter((r) => (b?.[r]?.autonomy != null || h?.[r]?.autonomy != null) && !eq(b?.[r]?.autonomy, h?.[r]?.autonomy) && h?.[r]);

const AGENT_SAFE = new Set(["name", "description", "model", "reasoning_effort", "timeout_sec", "routines", "budget", "max_parallel", "heartbeat"]);
const OVERRIDE_SAFE = { agents: new Set(["model", "reasoning_effort", "timeout_sec", "heartbeat"]), routines: new Set(["schedules", "status", "model"]) };

function applyParts(s) {
  const parts = [];
  const def = (key, side) => s[side]?.[`agents/${key}/agent.yaml`];
  for (const f of s.files ?? []) {
    let m;
    if (f === "instance.yaml") parts.push(...instanceParts(s));
    else if (f === "apps.yaml") {
      const [b, h] = [parse(s.base?.[f]), parse(s.head?.[f])];
      parts.push(...(b === null || h === null ? [REJECT("unparseable", "apps.yaml doesn't parse")] : appsParts(b?.apps ?? [], h?.apps ?? [], s.moduleApps)));
    } else if ((m = /^agents\/([a-z0-9][a-z0-9-]*)\/agent\.yaml$/.exec(f))) parts.push(agentDefPart(m[1], parse(def(m[1], "base")), parse(def(m[1], "head")), s));
    // A curated memory (the Librarian's proposal; compiled into the agent's handbook as facts, never instructions): the
    // reviewer decides, for a role holder too (owner, 2026-11-14), and flags one that redirects authority.
    else if ((m = /^agents\/([a-z0-9][a-z0-9-]*)\/memory\.md$/.exec(f))) parts.push(ROLE_AGENTS.has(m[1]) || (s.roles?.[m[1]] ?? []).length ? T(1, "role-memory", `memory of ${m[1]}, which holds a role`) : T(1, "agent-memory", `memory of ${m[1]}, an agent without a role`));
    else if ((m = /^agents\/([a-z0-9][a-z0-9-]*)\/AGENTS\.md$/.exec(f))) {
      const key = m[1];
      const base = parse(def(key, "base"));
      const head = parse(def(key, "head"));
      if (ROLE_AGENTS.has(key) || (s.roles?.[key] ?? []).length) parts.push(T(1, "role-handbook", `handbook of ${key}, which holds a role`));
      else if (base === undefined) {
        // A new agent's handbook: only alongside its new agent.yaml, in trial, in this same change; anything else is refused.
        const added = (s.files ?? []).includes(`agents/${key}/agent.yaml`) && head?.trial === true;
        parts.push(!added ? REJECT("handbook-without-agent", `${key}'s handbook, without a new trial agent.yaml in the change`) : s.ownerStarted ? T(0, "trial-agent-new", `${key}'s handbook, with its new trial agent, on a task the owner started`) : T(1, "trial-agent-new-agent-task", `${key}'s handbook, with its new trial agent, on an agent-origin task`));
      } else if (base === null) parts.push(REJECT("unparseable", `agents/${key}/agent.yaml doesn't parse`));
      else if (base.trial === true) parts.push(s.trialNoTap ? T(0, "trial-handbook", `handbook of ${key}, an agent in trial`) : T(1, "trial-handbook-agent-task", `handbook of ${key}, an agent in trial, on an agent-origin task`));
      else parts.push(T(1, "agent-handbook", `handbook of ${key}, a graduated agent without a role`));
    } else if ((m = /^agents\/([\w.-]+)\.md$/.exec(f))) {
      const roles = s.roles?.[m[1]] ?? [];
      parts.push(ROLE_AGENTS.has(m[1]) || roles.length ? T(1, "role-handbook", `handbook of ${m[1]}, which holds a role`) : T(1, "module-handbook", `handbook additions for ${m[1]}, an agent without a role`));
    } else parts.push(PANEL("unrecognised-file", `${f} isn't a file apply recognises`));
  }
  return parts;
}

function agentDefPart(key, base, head, s) {
  if (base === null || head === null) return REJECT("unparseable", `agents/${key}/agent.yaml doesn't parse`);
  if (head === undefined) return T(1, "agent-removed", `removes agent ${key}`);
  const caps = routineAutonomyChanges(base?.routines, head.routines);
  if (caps.length) return PANEL("routine-autonomy", `${key}: routine autonomy changes (${caps.join(", ")})`);
  if (base === undefined) {
    if (head.trial !== true) return PANEL("untrialed-agent", `new agent ${key} isn't in trial`);
    // Only the safe fields (no roles, image or other privileges); any write grant goes to the reviewer at least.
    const other = Object.keys(head).filter((k) => k !== "trial" && k !== "connections" && !AGENT_SAFE.has(k));
    if (other.length) return PANEL("new-agent-fields", `new agent ${key} sets ${other.join(", ")}`);
    if (Object.values(head.connections ?? {}).some((g) => g !== "read")) return T(1, "trial-agent-new-writes", `adds ${key} in trial, with write or tool-level grants`);
    return s.ownerStarted ? T(0, "trial-agent-new", `adds ${key} in trial, on a task the owner started`) : T(1, "trial-agent-new-agent-task", `adds ${key} in trial, on an agent-origin task`);
  }
  const keys = changedKeys(base, head);
  const wider = newGrants(base.connections, head.connections, s.connections);
  if (wider.length) return PANEL("new-grants", `${key} gets new grants: ${wider.join(", ")}`);
  const other = keys.filter((k) => k !== "connections" && k !== "trial" && !AGENT_SAFE.has(k));
  if (other.length) return PANEL("agent-fields", `${key} changes ${other.join(", ")}`);
  if (keys.includes("trial")) {
    if (base.trial === true && head.trial !== true) return T(1, "graduation", `${key} graduates, keeping only the tools and connections it had in trial`);
    return T(1, "agent-into-trial", `${key}'s trial flag changes`);
  }
  return T(1, "agent-tuning", `${key}: ${keys.join(", ") || "no field"} changes`);
}

function instanceParts(s) {
  const base = parse(s.base?.["instance.yaml"]);
  const head = parse(s.head?.["instance.yaml"]);
  if (!base || !head) return [REJECT("unparseable", "instance.yaml doesn't parse")];
  const parts = [];
  for (const k of changedKeys(base, head)) {
    // A rollback can undo a security fix: the panel's. A pin off product main is refused.
    if (k === "product") parts.push(s.pin?.forward ? T(1, "pin-forward", "the product pin moves forward along product main") : s.pin?.back ? PANEL("pin-backwards", "the product pin moves backwards (a rollback)") : REJECT("pin-unknown", "the product pin moves, and not along product main"));
    else if (k === "settings") {
      for (const sk of changedKeys(base.settings, head.settings)) {
        const was = [base.settings?.[sk] ?? []].flat();
        const now = [head.settings?.[sk] ?? []].flat();
        parts.push(sk === "slack_post_channels" && was.every((c) => now.includes(c)) ? T(1, "slack-channels", `adds Slack channels agents may post to`) : PANEL("settings", `changes the setting ${sk}`));
      }
    } else if (k === "overrides") {
      for (const kind of changedKeys(base.overrides, head.overrides)) {
        const safe = OVERRIDE_SAFE[kind];
        for (const name of changedKeys(base.overrides?.[kind], head.overrides?.[kind])) {
          const fields = changedKeys(base.overrides?.[kind]?.[name], head.overrides?.[kind]?.[name]);
          parts.push(safe && fields.every((x) => safe.has(x)) ? T(1, kind === "agents" ? "model-change" : "routine-schedule", `${kind} ${name}: ${fields.join(", ")}`) : PANEL("overrides", `overrides ${kind} ${name}: ${fields.join(", ")}`));
        }
      }
    } else parts.push(PANEL("instance-key", `changes ${k} in instance.yaml`));
  }
  return parts;
}

/**
 * An app entry as apps-mcp's AppSchema leaves it (services/apps-mcp/src/registry.ts): defaults, and `database` / `api` adding
 * their network and secrets. Kept in step with it by hand; the tiers test pins the cases.
 */
export function normalizeApp(raw) {
  const a = { caps: [], connects: [], secrets: [], stateful: false, untrusted: false, ...(raw ?? {}) };
  if (a.database) a.connects = [...new Set([...a.connects, a.database])];
  a.secrets = [...new Set([...a.secrets, ...(a.database ? ["DATABASE_URL"] : [])])];
  return a;
}

/** apps-mcp's isSensitive, as a list of reasons: access, database, stateful, untrusted, caps, or connects to paperclip or a restricted app. */
export function sensitiveTraits(app, all) {
  return [
    app.access && "access",
    app.share && "share (people outside the tailnet)",
    app.database && "database",
    app.stateful && "stateful",
    app.untrusted && "untrusted",
    app.caps.length && "caps",
    app.connects.some((c) => c === "paperclip" || c === "sources" || all.find((x) => x.name === c && (x.access || x.share))) && "connects to paperclip, the sources network, or a restricted or shared app",
  ].filter(Boolean);
}

/**
 * The registry change, per app: everything apps-mcp calls sensitive is authority-expanding (the panel's), except the spec's
 * one carve-out (an app whose only sensitive trait is `database: warehouse`, ordinary DB provisioning: Tier 1). New secrets
 * (after the schema's additions) and an API write path are the panel's too. Removing an app is the reviewer's.
 * `moduleApps`: the module apps, for restricted-app lookups.
 */
function appsParts(base, head, moduleApps = []) {
  const list = (l) => (Array.isArray(l) ? l : []).map(normalizeApp);
  const was = new Map(list(base).map((a) => [a.name, a]));
  const now = new Map(list(head).map((a) => [a.name, a]));
  const all = [...now.values(), ...list(moduleApps)];
  const parts = [];
  for (const name of [...was.keys()].filter((n) => !now.has(n))) parts.push(T(1, "app-removed", `removes app ${name}`));
  for (const [name, a] of now) {
    const b = was.get(name);
    if (eq(a, b)) continue;
    const traits = sensitiveTraits(a, all);
    const secrets = a.secrets.filter((x) => !(b?.secrets ?? []).includes(x) && !(x === "DATABASE_URL" && a.database === "warehouse"));
    const warehouseOnly = traits.length === 1 && traits[0] === "database" && a.database === "warehouse";
    const why = [...(warehouseOnly ? [] : traits), a.api && "an API write path", secrets.length && `new secrets ${secrets.join(", ")}`].filter(Boolean);
    if (why.length) parts.push(PANEL("sensitive-app", `app ${name}: ${why.join(", ")}`));
    else parts.push(T(1, warehouseOnly ? "app-warehouse" : "app-registry", `${b ? "changes" : "adds"} app ${name}${warehouseOnly ? " (a warehouse database)" : ""}`));
  }
  return parts;
}
