// Which tier a write is (the tiered-approvals design), from verified state only: the requester the runner looked up,
// the repos, branches and files git and GitHub report, the instance diff it computed. Pure: no I/O. Tier 0 runs at once,
// Tier 1 goes to the AI reviewer, Tier 2 to the owner; `reject: true` is refused by code before any review. A request
// with several parts takes its highest part; anything not recognised is Tier 2.
import YAML from "yaml";

/**
 * Gate code in the product repo: changing it is always the owner's decision (owner, 2026-11-13: only the actual gates; the
 * rest of the product is Tier 1 for the Platform Engineer's line, with module.yaml and compose files judged by content below).
 */
const PRODUCT_GATES = [
  // The approval path: tiers, the reviewer and its policy, the owner's-words check, the merge queue's writes, apply; the job jail.
  /^services\/runner\/src\/(tiers|review|authorize|merges|apply|netjail|state|config|github-app|engines)\.mjs$/,
  // What the runner trusts in an agent-writable workspace: host git on its clones (config scrub, .git checks), the files it
  // reads and writes there (outputs, Primer, attachments), the box/jail choice per Engineer, and the computer box rules.
  /^services\/runner\/src\/(git|files|workspace|commands|primer)\.mjs$/,
  /^scripts\/computers\.mjs$/,
  // The runner's main: it builds the verified state classify() trusts (requester, chain, repos) and holds the GitHub write paths.
  /^services\/runner\/src\/main\.mjs$/,
  /^modules\/core\/security\//,
  // Who an agent is and what it may call: agent-auth.ts and every synced copy, and the compiler's grants (tools, models, caps).
  /(^|\/)agent-auth\.ts$/,
  // Setup: writes the grants table and `autonomy`, builds each agent's adapter config and calls the no-shell guard.
  /^scripts\/(modules|paperclip-setup)\.mjs$/,
  // The board's approval records and decision routes, its own tier rules (deploy_app, app_run), and who signs in to decide.
  /^services\/board\/src\/(approvals|app|fleet|accounts|session)\.ts$/,
  // Tool-only agents get no shell (setup refuses one); the computer sandbox: the whole service (launcher, lib, plugin, images).
  /^scripts\/no-shell\.mjs$/,
  /^services\/computer\//,
  // The model gateway: the only holder of the OpenRouter key, and the spend caps.
  /^services\/gateway\//,
  // Host privileges: setup, apply, systemd units, the vault, the VM and box networks.
  /^ops\//,
  // The security tripwire and the supply-chain checks CI runs (the workflows themselves are .github/, below).
  /^scripts\/verify-security\.sh$|^scripts\/supply-chain\/|^\.gitleaks\.toml$/,
];
const GITHUB = /(^|\/)\.github\//;
/** Module agents that hold roles (besides any agent whose grants list roles). */
const ROLE_AGENTS = new Set(["chief-of-staff", "architect", "fleet-engineer"]);

const T = (tier, rule, reason) => ({ tier, rule, reason });
const REJECT = (rule, reason) => ({ tier: 2, rule, reason, reject: true });
const same = (a, b) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();
const orgOf = (repo) => String(repo).split("/")[0];

/** The highest part (a reject beats everything); no parts is Tier 2. */
export function highest(parts) {
  if (!parts.length) return T(2, "unrecognised", "nothing recognised in the request");
  return parts.find((p) => p.reject) ?? parts.reduce((a, b) => (b.tier > a.tier ? b : a));
}

/**
 * The tier of one request. `s` is the verified state:
 * - every action: { agentsOrg, productRepo, instanceRepo, requester: { platform }, sticky, routineAutonomy }
 * - routineAutonomy: the cap of the routine whose run the task chain started from (routineCap); absent when none
 * - connections: each connection's tool tags from the compiled config ({ name: { tools: { read, write, destructive } } })
 * - every action's requester.platform: the Platform Engineer's line (the Platform Engineer itself, a task the Agent
 *   Architect made, or the owner's own task), the only one that writes to the product repo below Tier 2
 * - push/pr: branches [{ repo, branch, defaultBranch, deployBranch?, empty, files, texts? }]
 * - merge: prs [{ repo, files, texts?, checks: [{ name, ok, pending }] (advisory checks such as design-review left out), headMatches, ownHead (a commit the runner pushed to a same-repo branch), sensitive, dependabot?, designReviewOverdue? (a UI PR whose design review never came) }]
 *   (texts, product repo only: { path: { base, head } } for each changed module.yaml and compose file, and for every changed
 *   file of a PR the runner verified as Dependabot's from the API: its author and every commit; then `dependabot: true`)
 * - close: prs [{ repo, dependabot? }] (`dependabot`: a product PR whose author the runner read from the API as dependabot[bot])
 * - apply: { files, base, head (path → text, absent when missing), pin: null | { forward, back }, roles (agent key → roles),
 *   ownerStarted (the task chain began with the owner), trialNoTap (today's trial-handbook rule) }
 */
export function classify(action, s) {
  // Raising a spend cap (the board's raise_cap card, filed by the model gateway) is always the owner's tap.
  if (action === "raise_cap") return T(2, "raise-cap", "raising a spend cap is the owner's");
  if (["cancelled", "done"].includes(s.taskStatus)) return REJECT("closed-task", `the task is ${s.taskStatus}: a leftover request runs nothing`);
  // Fail closed: without knowing which repos are the product and the instance, nothing can be told apart from them.
  if (!s.productRepo || !s.instanceRepo || !s.agentsOrg) return T(2, "unknown-repos", "the product repo, instance repo or agents org isn't known here");
  const t = highest(action === "push" || action === "pr" ? publishParts(action, s) : action === "merge" ? mergeParts(s) : action === "close" ? closeParts(s) : action === "apply" ? applyParts(s) : []);
  // Sticky: after the owner or the reviewer rejected this action on this task, it is the owner's from then on.
  if (s.sticky && !t.reject && t.tier < 2) return T(2, "sticky", `rejected before on this task (was: ${t.reason})`);
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

/**
 * `sticky` for a request from the task's approval records: a rejected card of the same action, or of one the request also
 * carries (`also`). A product PR card with `args.merge` carries a merge, so its reject makes later merges sticky, and a
 * rejected merge makes a merge-carrying PR card sticky: neither can be refiled as the other to dodge it.
 */
export function stickyFrom(records, action, also = []) {
  const carried = (r) => [r.action, ...(r.action === "pr" && r.args?.merge ? ["merge"] : [])];
  const want = [action, ...also];
  return (records ?? []).some((r) => r.state === "rejected" && carried(r).some((x) => want.includes(x)));
}

function publishParts(action, s) {
  return (s.branches ?? []).map((b) => {
    const inAgents = Boolean(s.agentsOrg) && same(orgOf(b.repo), s.agentsOrg);
    if (same(b.repo, s.instanceRepo)) return T(2, "instance-repo", "the instance repo changes only through apply");
    if (!Array.isArray(b.files)) return T(2, "unknown-files", `couldn't tell which files ${b.repo} \`${b.branch}\` changes`);
    if (same(b.repo, s.productRepo)) {
      if (action === "pr" && !s.requester?.platform) return REJECT("product-pr-requester", "only the Platform Engineer (or a task the owner or the Agent Architect made) may open PRs on the product repo");
      if (b.empty || b.branch === b.defaultBranch) return T(2, "product-default-branch", `\`${b.branch}\` is the product repo's default branch`);
      if (!s.requester?.platform) return T(2, "product-push", "a push to the product repo from outside the Platform Engineer's line");
      const parts = productFileParts(b.files, b.texts, s);
      return parts.some((p) => p.tier === 2) ? highest(parts) : T(1, action === "pr" ? "product-pr" : "product-push-branch", `${action === "pr" ? "a PR" : "a branch push"} to the product repo from the Platform Engineer's line, no gate code`);
    }
    const workflow = (b.files ?? []).find((f) => GITHUB.test(f));
    if (workflow) return T(2, "github-dir", `it changes ${workflow}`);
    if (inAgents) {
      if (b.empty) return T(2, "empty-repo", `${b.repo} is empty: the first push lands on its default branch`);
      if (b.branch === b.defaultBranch || (b.deployBranch && b.branch === b.deployBranch)) return T(2, "default-branch", `\`${b.branch}\` is ${b.repo}'s default or deploy branch`);
      return T(0, "agents-org-branch", `an ordinary branch of ${b.repo} in the agents org`);
    }
    return action === "pr" ? T(1, "outside-pr", `a draft PR to ${b.repo}, outside the agents org`) : T(2, "outside-push", `a push to ${b.repo}, outside the agents org`);
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

function mergeParts(s) {
  return (s.prs ?? []).map((p) => {
    const ref = `${p.repo}#${p.number ?? "?"}`;
    if (same(p.repo, s.productRepo)) return productMergePart(p, ref, s);
    if (!s.agentsOrg || !same(orgOf(p.repo), s.agentsOrg)) return T(2, "outside-merge", `${ref} is outside the agents org`);
    if (same(p.repo, s.instanceRepo) || same(p.repo, s.productRepo)) return T(2, "core-repo-merge", `${ref} is the instance or product repo`);
    if (!Array.isArray(p.files)) return T(2, "unknown-files", `couldn't list every file ${ref} changes`);
    const workflow = (p.files ?? []).find((f) => GITHUB.test(f));
    if (workflow) return T(2, "github-dir", `${ref} changes ${workflow}`);
    if (p.sensitive) return T(2, "sensitive-app", `${ref} is a sensitive app's repo (access, caps or connects to paperclip)`);
    if (!p.headMatches) return T(2, "head-moved", `${ref} moved since the card`);
    if (!(p.checks ?? []).length) return T(2, "no-checks", `${ref} has no named checks`);
    const red = p.checks.filter((c) => !c.ok && !c.pending);
    if (red.length) return T(2, "checks-not-green", `${ref}: ${red.map((c) => c.name).join(", ")} failed on the head`);
    // A UI PR whose design review never came within its time after the checks went green (merges.mjs DESIGN_REVIEW).
    if (p.designReviewOverdue) return T(2, "design-review-missing", `${ref} changes UI files and the UI/UX Designer's design review never came within 2 hours of its checks going green`);
    // A head the runner didn't push (a fork, someone else's push): the reviewer reads the diff first.
    if (!p.ownHead) return T(1, "agents-org-merge-foreign-head", `${ref}: its head isn't a commit the runner pushed to a branch of ${p.repo}`);
    // Merged at once when CI is green (owner, 2026-11-12): the PR merges on its own (an independent queue), strict and bound to
    // this head, only once every named check passed on it; red leaves it unmerged. Still running is not red.
    if (p.checks.some((c) => c.pending)) return T(0, "agents-org-merge-checks-running", `${ref}: ${p.checks.length} named check${p.checks.length === 1 ? "" : "s"}, still running on the exact head (merged only once green)`);
    return T(0, "agents-org-merge", `${ref}: ${p.checks.length} named check${p.checks.length === 1 ? "" : "s"}, all green on the exact head`);
  });
}

/**
 * A product PR's merge (owner, 2026-11-13): the reviewer's when the Platform Engineer's line asks, the PR's head is one the
 * runner pushed (no fork, no one else's push), it is the card's head, no gate code, and its named checks aren't red. Still
 * running is not red: a reviewer-approved merge runs the strict queue, which merges only once every named check is green on
 * that exact head. Never Tier 0: the product reaches every instance through the pin.
 */
function productMergePart(p, ref, s) {
  if (!s.requester?.platform) return T(2, "product-merge-requester", `${ref}: a product merge from outside the Platform Engineer's line`);
  if (!Array.isArray(p.files)) return T(2, "unknown-files", `couldn't list every file ${ref} changes`);
  // A Dependabot pin bump: the reviewer's when every condition holds; otherwise the rules below (a head not the runner's: Tier 2).
  if (p.dependabot === true) {
    const d = dependabotMergePart(p, ref);
    if (d.tier === 1 || !p.ownHead) return d;
  }
  const parts = productFileParts(p.files, p.texts, s);
  if (parts.some((x) => x.tier === 2)) return highest(parts);
  if (!p.headMatches) return T(2, "head-moved", `${ref} moved since the card`);
  if (!p.ownHead) return T(2, "product-merge-foreign-head", `${ref}: its head isn't a commit the runner pushed to a branch of the product repo`);
  if (!(p.checks ?? []).length) return T(2, "no-checks", `${ref} has no named checks`);
  const red = p.checks.filter((c) => !c.ok && !c.pending);
  if (red.length) return T(2, "checks-not-green", `${ref}: ${red.map((c) => c.name).join(", ")} failed on the head`);
  return T(1, "product-merge", `${ref}: a product PR from the Platform Engineer's line, no gate code, merged only once its ${p.checks.length} named check${p.checks.length === 1 ? "" : "s"} are green on the exact head`);
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
  if (composeParts("", base, head)[0].tier !== 1) return "changes more than image tags or digests";
  const [b, h] = [parse(base), parse(head)];
  for (const [name, svc] of Object.entries(h.services ?? {})) {
    const was = b.services?.[name]?.image;
    const why = svc?.image === was ? undefined : imageWhy(was, svc?.image);
    if (why) return `${name}: ${why}`;
  }
  return undefined;
}

/**
 * The product files that need more than the reviewer: gate code, `.github/`, the handbook of a module agent that holds a
 * role, and module.yaml or a compose file (root or a module's fragment) judged by content. `texts` maps those config files to { base, head } (text,
 * or undefined when absent on that side); a config file without an entry couldn't be read: the owner's.
 */
function productFileParts(files, texts = {}, s) {
  const parts = [];
  for (const f of files) {
    let m;
    if (PRODUCT_GATES.some((g) => g.test(f)) || GITHUB.test(f)) parts.push(T(2, "product-gate", `it changes gate code (${f})`));
    else if ((m = /^modules\/[^/]+\/agents\/([a-z0-9][a-z0-9-]*)\/AGENTS\.md$/.exec(f)) && (ROLE_AGENTS.has(m[1]) || (s.roles?.[m[1]] ?? []).length)) parts.push(T(2, "role-handbook", `handbook of ${m[1]}, which holds a role`));
    else if (/^modules\/[^/]+\/module\.yaml$/.test(f) || COMPOSE.test(f)) {
      const t = texts?.[f];
      if (!t) parts.push(T(2, "unknown-content", `couldn't read ${f} on both sides`));
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
  if (!b || !h) return [T(2, "product-compose", `${f} doesn't parse, or is added or removed`)];
  const noImages = (c) => ({ ...c, services: Object.fromEntries(Object.entries(c.services ?? {}).map(([k, v]) => [k, { ...(v ?? {}), image: imageRepo(v?.image) }])) });
  return eq(noImages(b), noImages(h)) ? [T(1, "product-image-bump", `${f}: image tags or digests only`)] : [T(2, "product-compose", `${f} changes more than image tags or digests (volumes, privileges, network, env, services or another image)`)];
}

/** What a module agent may change without the owner: everything else (model, connections, roles, image, a new agent) is Tier 2. */
const MODULE_AGENT_SAFE = new Set(["reasoning_effort", "timeout_sec", "heartbeat", "persona", "max_parallel", "graded", "brief"]);
/**
 * Module keys that are the reviewer's (text, labels, schedules without a model); agents, routines, connections and apps are
 * checked below; the rest (settings and their defaults such as autonomy, compose, codex_args, isolation, secrets) are Tier 2.
 */
const MODULE_SAFE = new Set(["name", "description", "requires", "labels", "company"]);

/**
 * A module.yaml change, by content (the instance apply's rules, applied to the product): new or wider grants, new tools,
 * models, roles, images, new agents, credentials, the tool-only sandbox (codex_args) and sensitive apps stay the owner's.
 */
function moduleParts(f, baseText, headText, connections = {}) {
  const b = baseText === undefined ? {} : parse(baseText);
  const h = headText === undefined ? undefined : parse(headText);
  if (b === null || h === null) return [T(2, "unparseable", `${f} doesn't parse`)];
  if (h === undefined) return [T(2, "module-removed", `removes ${f}`)];
  const parts = [];
  const why = (rule, reason) => parts.push(T(2, rule, `${f}: ${reason}`));
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
      parts.push(...ps.filter((x) => x.tier === 2).map((x) => ({ ...x, reason: `${f}: ${x.reason}` })));
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
      parts.push(...(b === null || h === null ? [T(2, "unparseable", "apps.yaml doesn't parse")] : appsParts(b?.apps ?? [], h?.apps ?? [], s.moduleApps)));
    } else if ((m = /^agents\/([a-z0-9][a-z0-9-]*)\/agent\.yaml$/.exec(f))) parts.push(agentDefPart(m[1], parse(def(m[1], "base")), parse(def(m[1], "head")), s));
    // A curated memory (the Librarian's proposal; compiled into the agent's handbook as facts, never instructions): the reviewer decides for an agent without a role, the owner for one that holds one.
    else if ((m = /^agents\/([a-z0-9][a-z0-9-]*)\/memory\.md$/.exec(f))) parts.push(ROLE_AGENTS.has(m[1]) || (s.roles?.[m[1]] ?? []).length ? T(2, "role-memory", `memory of ${m[1]}, which holds a role`) : T(1, "agent-memory", `memory of ${m[1]}, an agent without a role`));
    else if ((m = /^agents\/([a-z0-9][a-z0-9-]*)\/AGENTS\.md$/.exec(f))) {
      const key = m[1];
      const base = parse(def(key, "base"));
      const head = parse(def(key, "head"));
      if (ROLE_AGENTS.has(key) || (s.roles?.[key] ?? []).length) parts.push(T(2, "role-handbook", `handbook of ${key}, which holds a role`));
      else if (base === undefined) {
        // A new agent's handbook: only alongside its new agent.yaml, in trial, in this same change; anything else is unrecognised.
        const added = (s.files ?? []).includes(`agents/${key}/agent.yaml`) && head?.trial === true;
        parts.push(!added ? T(2, "handbook-without-agent", `${key}'s handbook, without a new trial agent.yaml in the change`) : s.ownerStarted ? T(0, "trial-agent-new", `${key}'s handbook, with its new trial agent, on a task the owner started`) : T(1, "trial-agent-new-agent-task", `${key}'s handbook, with its new trial agent, on an agent-origin task`));
      } else if (base === null) parts.push(T(2, "unparseable", `agents/${key}/agent.yaml doesn't parse`));
      else if (base.trial === true) parts.push(s.trialNoTap ? T(0, "trial-handbook", `handbook of ${key}, an agent in trial`) : T(1, "trial-handbook-agent-task", `handbook of ${key}, an agent in trial, on an agent-origin task`));
      else parts.push(T(1, "agent-handbook", `handbook of ${key}, a graduated agent without a role`));
    } else if ((m = /^agents\/([\w.-]+)\.md$/.exec(f))) {
      const roles = s.roles?.[m[1]] ?? [];
      parts.push(ROLE_AGENTS.has(m[1]) || roles.length ? T(2, "role-handbook", `handbook of ${m[1]}, which holds a role`) : T(1, "module-handbook", `handbook additions for ${m[1]}, an agent without a role`));
    } else parts.push(T(2, "unrecognised-file", `${f} isn't a file apply recognises`));
  }
  return parts;
}

function agentDefPart(key, base, head, s) {
  if (base === null || head === null) return T(2, "unparseable", `agents/${key}/agent.yaml doesn't parse`);
  if (head === undefined) return T(2, "agent-removed", `removes agent ${key}`);
  const caps = routineAutonomyChanges(base?.routines, head.routines);
  if (caps.length) return T(2, "routine-autonomy", `${key}: routine autonomy changes (${caps.join(", ")})`);
  if (base === undefined) {
    if (head.trial !== true) return T(2, "untrialed-agent", `new agent ${key} isn't in trial`);
    // Only the safe fields (no roles, image or other privileges); any write grant goes to the reviewer at least.
    const other = Object.keys(head).filter((k) => k !== "trial" && k !== "connections" && !AGENT_SAFE.has(k));
    if (other.length) return T(2, "new-agent-fields", `new agent ${key} sets ${other.join(", ")}`);
    if (Object.values(head.connections ?? {}).some((g) => g !== "read")) return T(1, "trial-agent-new-writes", `adds ${key} in trial, with write or tool-level grants`);
    return s.ownerStarted ? T(0, "trial-agent-new", `adds ${key} in trial, on a task the owner started`) : T(1, "trial-agent-new-agent-task", `adds ${key} in trial, on an agent-origin task`);
  }
  const keys = changedKeys(base, head);
  const wider = newGrants(base.connections, head.connections, s.connections);
  if (wider.length) return T(2, "new-grants", `${key} gets new grants: ${wider.join(", ")}`);
  const other = keys.filter((k) => k !== "connections" && k !== "trial" && !AGENT_SAFE.has(k));
  if (other.length) return T(2, "agent-fields", `${key} changes ${other.join(", ")}`);
  if (keys.includes("trial")) {
    if (base.trial === true && head.trial !== true) return T(1, "graduation", `${key} graduates, keeping only the tools and connections it had in trial`);
    return T(2, "agent-into-trial", `${key}'s trial flag changes`);
  }
  return T(1, "agent-tuning", `${key}: ${keys.join(", ") || "no field"} changes`);
}

function instanceParts(s) {
  const base = parse(s.base?.["instance.yaml"]);
  const head = parse(s.head?.["instance.yaml"]);
  if (!base || !head) return [T(2, "unparseable", "instance.yaml doesn't parse")];
  const parts = [];
  for (const k of changedKeys(base, head)) {
    if (k === "product") parts.push(s.pin?.forward ? T(1, "pin-forward", "the product pin moves forward along product main") : s.pin?.back ? T(2, "pin-backwards", "the product pin moves backwards (a rollback)") : T(2, "pin-unknown", "the product pin moves, and not forward"));
    else if (k === "settings") {
      for (const sk of changedKeys(base.settings, head.settings)) {
        const was = [base.settings?.[sk] ?? []].flat();
        const now = [head.settings?.[sk] ?? []].flat();
        parts.push(sk === "slack_post_channels" && was.every((c) => now.includes(c)) ? T(1, "slack-channels", `adds Slack channels agents may post to`) : T(2, "settings", `changes the setting ${sk}`));
      }
    } else if (k === "overrides") {
      for (const kind of changedKeys(base.overrides, head.overrides)) {
        const safe = OVERRIDE_SAFE[kind];
        for (const name of changedKeys(base.overrides?.[kind], head.overrides?.[kind])) {
          const fields = changedKeys(base.overrides?.[kind]?.[name], head.overrides?.[kind]?.[name]);
          parts.push(safe && fields.every((x) => safe.has(x)) ? T(1, kind === "agents" ? "model-change" : "routine-schedule", `${kind} ${name}: ${fields.join(", ")}`) : T(2, "overrides", `overrides ${kind} ${name}: ${fields.join(", ")}`));
        }
      }
    } else parts.push(T(2, "instance-key", `changes ${k} in instance.yaml`));
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
 * The registry change, per app: everything apps-mcp calls sensitive is Tier 2, except the spec's one carve-out (an app whose
 * only sensitive trait is `database: warehouse`, ordinary DB provisioning: Tier 1). New secrets (after the schema's
 * additions) and an API write path are Tier 2 too. `moduleApps`: the module apps, for restricted-app lookups.
 */
function appsParts(base, head, moduleApps = []) {
  const list = (l) => (Array.isArray(l) ? l : []).map(normalizeApp);
  const was = new Map(list(base).map((a) => [a.name, a]));
  const now = new Map(list(head).map((a) => [a.name, a]));
  const all = [...now.values(), ...list(moduleApps)];
  const parts = [];
  for (const name of [...was.keys()].filter((n) => !now.has(n))) parts.push(T(2, "app-removed", `removes app ${name}`));
  for (const [name, a] of now) {
    const b = was.get(name);
    if (eq(a, b)) continue;
    const traits = sensitiveTraits(a, all);
    const secrets = a.secrets.filter((x) => !(b?.secrets ?? []).includes(x) && !(x === "DATABASE_URL" && a.database === "warehouse"));
    const warehouseOnly = traits.length === 1 && traits[0] === "database" && a.database === "warehouse";
    const why = [...(warehouseOnly ? [] : traits), a.api && "an API write path", secrets.length && `new secrets ${secrets.join(", ")}`].filter(Boolean);
    if (why.length) parts.push(T(2, "sensitive-app", `app ${name}: ${why.join(", ")}`));
    else parts.push(T(1, warehouseOnly ? "app-warehouse" : "app-registry", `${b ? "changes" : "adds"} app ${name}${warehouseOnly ? " (a warehouse database)" : ""}`));
  }
  return parts;
}
