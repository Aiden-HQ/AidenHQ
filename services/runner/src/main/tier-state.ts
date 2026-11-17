import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../config.mjs";
import { definitionsOf } from "../apply.ts";
import { applyCardArgs, asApproval, cardOf, planOf } from "../cards.ts";
import { applyCard } from "../../../../kernel/src/kinds.ts";
import { authorityLines, diffAll, marketplaceChanges, moduleInputs } from "../../../../kernel/src/loader/authority.ts";
import { hostFetch, officialSides, withRemote } from "../../../../kernel/src/loader/sources.ts";
import { git, remoteIsEmpty, patchKeyAt, treeIs } from "../../../../modules/codehost-github/src/git.mjs";
import { READ } from "../../../../modules/codehost-github/src/github-app.ts";
import { splitAnswered } from "../answered.ts";
import { origins } from "../paperclip.ts";
import { UserError } from "../../../../modules/codehost-github/src/workspace.ts";
import * as merges from "../../../../modules/codehost-github/src/merge-gate.mjs";
import YAML from "yaml";
import { classify, normalizeApp, sensitiveTraits } from "../tiers.mjs";
import { autonomyCap, priorDecisions, requestKey, requestPatches, routineCap } from "../../../../kernel/src/tier.ts";
import { fileContext } from "../../../shared/review-files.mjs";
import { ALREADY_APPLIED } from "../evidence.ts";
import { dependabotCommits } from "../../../../modules/platform/src/check.mjs";
import { app, cfg, execFileP, gho, log, pc, sameRepo, state } from "./context.ts";
import { ownerMadeTask, trialNoTap } from "./watch.ts";
import { mergeGithub } from "./merge.ts";
import { MovedHead, branchRows, cardBases, createRepoText, findRealGh, fleetBranch, fleetDiffText, githubDefault, prRequest, prepareWorkspace, productBump, readGrants, withTrusted } from "./unsplit.ts";

// ------------------------------------------------------------------ approval records

/**
 * Pushes, PRs, merges and fleet applies are kernel records (lean-core 3b): the exact request (targets, commit shas, the args
 * replayed here) waits for the AI reviewer and the owner's tap or exact typed reply, then runApprovals() claims it once and
 * runs it. Nothing the agent says or holds approves it; a model never stands in for the tap.
 */
class AwaitingApproval extends Error {}
const waitingFor = (a: any, issue: any) =>
  a.tier === 1 && a.reviewFirst
    ? `Waiting for the AI reviewer, then for ${cfg.selfName}'s approval (${a.id}): the reviewer reads it first${a.reviewFirst === "final" ? " and its reject is final (the reason is posted here)" : ""}; then a card on the Approvals page and in Telegram shows ${cfg.selfName} its verdict. It runs on their tap, and the result is posted here. Nothing more to do now: end your turn and say in one line what is waiting for their approval.`
    : a.tier === 1
    ? `Waiting for the AI reviewer (${a.id}): it approves this, rejects it with a reason posted here, or sends it to ${cfg.selfName}. It runs once approved, and the result is posted here. Nothing more to do now: end your turn and say in one line what is waiting for review.`
    : `Waiting for ${cfg.selfName}'s approval (${a.id}${a.replaced ? ", replacing the earlier request" : ""}): a card on the Approvals page and in Telegram${a.replaced ? "" : `; replying \`apply ${issue.identifier}\` works too`}. It runs on their tap, and the result is posted here. Nothing more to do now: end your turn and say in one line what is waiting for their approval.`;

/** The kernel, as the runner: its own kinds with runner_writes_key, the reviews it asks for with reviewer_key. Throws with the kernel's reason. */
const keyIn = (file: any) => (existsSync(file) ? readFileSync(file, "utf8").trim() : "");
async function kernel(method: any, path: any, body?: any, { key = cfg.runnerWritesKeyFile, ms = 60_000 } = {}) {
  const res = await fetch(`${cfg.kernelUrl}${path}`, { method, headers: { authorization: `Bearer ${keyIn(key)}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(ms) });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(`${method} ${path.split("?")[0]} → ${res.status}: ${String(j?.error?.message ?? "").slice(0, 300)}`), { status: res.status });
  return j;
}
/** A task's records, newest first, as tiering reads them (cards.ts asApproval). */
const recordsOn = async (issue: any) => ((await kernel("GET", `/v1/writes?state=recent&task=${encodeURIComponent(issue.id)}&limit=50`)).records ?? []).map(asApproval);
const kindOf = (action: any) => (action === "apply" ? "kernel.apply" : `runner.${action}`);

/**
 * File (or find, when the same request is already open) the record for one exact request, with the runner's plan from its
 * tier parts (`ts`): the kernel raises it by what it derives itself and never lowers it. The card is written here from
 * `args` (an apply's from its args and `diff`, whose hash binds it). Tier 0 comes back claimed (`used`): run it, then
 * reportOutcome. `carries`: approved records whose commits a rebuild replays (no new card for them).
 */
async function fileApproval(issue: any, { action, args, diff, ts, carries }: any) {
  const card = action === "apply" ? applyCard(args, diff ?? "") : cardOf(action, args);
  const plan = { ...planOf(...ts), card, ...(action === "apply" ? { targets: { diff: createHash("sha256").update(diff ?? "").digest("hex") } } : {}), ...(carries?.length ? { carries } : {}) };
  const a = asApproval(await kernel("POST", "/v1/writes", { kind: kindOf(action), task: issue.id, identifier: issue.identifier, args, plan }));
  log("approval filed", { issue: issue.identifier, approval: a.id, action, state: a.state, tier: a.tier, panel: a.panel });
  return a;
}
// ------------------------------------------------------------------ tiered approvals

/**
 * The instance's autonomy (grants table, read fresh: it is the pause switch): off (every write is the owner's card, the
 * reviewer reading Tier 1 first: tiers.mjs autonomyCap), tier0 (Tier 0 runs at once; the reviewer only notes its verdict),
 * full (the reviewer decides Tier 1).
 */
const autonomyNow = () => (["tier0", "full"].includes(readGrants()?.autonomy) ? readGrants().autonomy : "off");
/** The guard found the change already satisfied on the target: no card; the evidence goes back to the agent instead. */
class AlreadyApplied extends Error {}
/**
 * The duplicate-card guard's evidence comment on the task (reason `already_applied`), once per request: W5's grader or the
 * delegator can finish the task from it. Returns what the agent is told.
 */
async function alreadyApplied(issue: any, action: any, key: any, evidence: any) {
  const text = `**Already satisfied on main** (\`${ALREADY_APPLIED}\`, ${action}): ${evidence}. No approval card was filed.`;
  const once = `already_applied:${issue.id}:${action}:${key}`;
  if (!state.get(once)) {
    await pc.comment(issue.id, text);
    state.set(once, new Date().toISOString());
  }
  log("already applied", { issue: issue.identifier, action, key: key.slice(0, 120) });
  return `${text} Nothing more to do for it: say so in one line.`;
}
/** The runner's own key to the board (reviewer_key): its usage reports. */
const runnerKey: any = () => (existsSync(cfg.reviewerKeyFile) ? { "x-reviewer-key": readFileSync(cfg.reviewerKeyFile, "utf8").trim() } : {});

/** The apps registry (instance apps.yaml plus the module apps), and the module apps alone, as plain entries. */
function appsRegistry() {
  const read = (p: any) => {
    try {
      return (YAML.parse(readFileSync(p, "utf8"))?.apps ?? []).filter(Boolean);
    } catch {
      return [];
    }
  };
  const modules = read(join(process.env.AIDENHQ_CONFIG_DIR ?? join(REPO_ROOT, "config"), "apps.modules.yaml"));
  const instanceDir = process.env.AIDENHQ_INSTANCE_DIR?.replace(/^~(?=\/)/, process.env.HOME ?? "");
  return { all: [...(instanceDir ? read(join(instanceDir, "apps.yaml")) : []), ...modules], modules };
}

/** A run's issue never changes: run id → the issueId it worked on (null: none). */
const runIssue = new Map();
const traceOrigins = (full: any) => origins(pc, full, runIssue);

/** Each connection's tool tags (read, write, destructive) from the compiled config; {} when it can't be read (grant changes then fail closed). */
function connectionTags() {
  try {
    const servers = YAML.parse(readFileSync(join(process.env.AIDENHQ_CONFIG_DIR ?? join(REPO_ROOT, "config"), "paperclip.yaml"), "utf8"))?.mcp_servers ?? {};
    return Object.fromEntries(Object.entries(servers).map(([k, c]: any) => [k, { tools: { read: c.tools?.read ?? [], write: c.tools?.write ?? [], destructive: c.tools?.destructive ?? [] } }]));
  } catch {
    return {};
  }
}

/**
 * What every tier check needs: the requester (looked up, never claimed), the task chain, and the task's approval records
 * (earlier decisions of `action` and of the `also` actions the request carries: a product PR card that also merges counts
 * a rejected merge too; tiers.mjs priorDecisions).
 */
async function commonTierState(issue: any, action: any, also = []) {
  const full = await pc.issue(issue.id);
  const grants = readGrants();
  let root = full;
  for (let i = 0; i < 6 && root.parentId; i++) root = await pc.issue(root.parentId);
  const walked = !root.parentId; // a chain longer than the walk is unknown: never owner-started
  const creator = grants?.agents?.[full.createdByAgentId];
  // A task the runner filed itself (a Dependabot PR's) carries the board key's user, but is never the owner's.
  const ownerMade = ownerMadeTask(full);
  // Two reviewers' unsure carries the request chain it saw (its hash, kept on the record by the kernel): the same content is
  // reviewed again only once that chain changed (tier.ts priorDecisions).
  const split = splitAnswered(await recordsOn(full), await pc.comments(full.id).catch(() => []), cfg.selfName, await pc.me().catch(() => undefined));
  const { records } = split;
  return {
    answers: split.answers,
    requestChain: chainHash(await prRequest(full).catch(() => "")),
    agentsOrg: cfg.agentsOrg,
    productRepo: cfg.productRepo,
    instanceRepo: cfg.apply?.repo,
    // The Platform Engineer, a task the Agent Architect made, or the owner's own task (ruling: the owner may always ask).
    // Only these write to the product repo below Tier 2; an Engineer's product push stays the owner's.
    requester: { platform: (grants?.agents?.[full.assigneeAgentId]?.roles ?? []).includes("platform-engineer") || (creator?.roles ?? []).includes("architect") || ownerMade },
    taskStatus: full.status,
    records,
    also,
    // The cap of the routine whose run started this chain (its `autonomy`, in the grants table by Paperclip routine id).
    routineAutonomy: await traceOrigins(full).then(({ issues, complete }) => routineCap(issues, complete, grants?.routines)),
    connections: connectionTags(),
    ownerStarted: walked && ownerMadeTask(root),
    trialNoTap: trialNoTap(full, grants),
    roles: Object.fromEntries(Object.values(grants?.agents ?? {}).map((a: any) => [a.key, a.roles ?? []])),
    moduleApps: appsRegistry().modules,
    full,
  };
}

/** The request chain's hash (what the reviewer was shown as what was asked; the kernel keeps it with an unsure-twice rejection). */
const chainHash = (chain: any) => (chain ? createHash("sha256").update(chain).digest("hex").slice(0, 32) : "");

/** One branch as tiering sees it: empty repo, default/deploy branch, and the files it changes against the default branch. */
async function branchTierState(r: any, sha: any, bound: any) {
  const empty = await remoteIsEmpty(r.path).catch(() => true);
  // `bound`: the card's trusted base (bindBase): the range reviewed is that one, whatever the workspace's origin says now.
  // A product branch without one (a card from before bases were bound) has no base it can trust: unknown files, Tier 2.
  const base = empty ? "" : bound || (sameRepo(r.repo, cfg.productRepo) ? "" : await git(r.path, "merge-base", `refs/remotes/origin/${r.defaultBase}`, sha).catch(() => ""));
  const files = base ? (await git(r.path, "diff", "--no-renames", "--name-only", base, sha).catch(() => null))?.split("\n").filter(Boolean) ?? null : null;
  const app = appsRegistry().all.find((a) => String(a.repo).toLowerCase() === r.repo.toLowerCase());
  const texts = sameRepo(r.repo, cfg.productRepo) && files ? await productTexts(files, (rev: any, f: any) => git(r.path, "show", `${rev}:${f}`), base, sha) : undefined;
  const ciTemplate = files?.some((f) => /(^|\/)\.github\//.test(f)) && inAgentsOrg(r.repo) ? await ciTemplateCopy(r.repo, sha, { from: r.path }) : undefined;
  // The change's content key (the owner's veto binds to it), in the runner's own clone; unread, it fails closed against a veto.
  const patch = await trustedPatch(r.repo, sha, { from: r.path });
  return { repo: r.repo, branch: r.branch, ...(patch ? { patch } : {}), defaultBranch: r.defaultBase, deployBranch: app?.branch ?? (app ? "main" : undefined), empty, files: empty ? [] : files, ...(texts ? { texts } : {}), ...(ciTemplate ? { ciTemplate } : {}), base, path: r.path, sha };
}

/**
 * A commit's content key (git.mjs patchKey) computed in the runner's own clone, never the agent's workspace: the commit is
 * sent there from the workspace `from` (git's transfer hashes every object) or fetched as PR `pr`'s head, and used only if
 * it is exactly `sha`; keyed from where it leaves GitHub's default branch. Undefined when anything fails.
 */
async function trustedPatch(slug: any, sha: any, { from, pr }: any = {}) {
  try {
    if (!/^[0-9a-f]{40}$/.test(sha ?? "")) return undefined;
    const main = await githubDefault(slug);
    return await withTrusted(slug, [main], async (path: any, [tip]: any, out: any) => {
      if (from) await git(from, "push", "--quiet", "--no-verify", "--force", path, `${sha}:${out}`);
      else await git(path, "fetch", "--quiet", "origin", `+refs/pull/${Number(pr)}/head:${out}`);
      return patchKeyAt(path, out, sha, tip);
    });
  } catch (err: any) {
    log("patch key unread", { repo: slug, sha, err: String(err.message ?? err).slice(0, 200) });
    return undefined;
  }
}

const inAgentsOrg = (repo: any) => Boolean(cfg.agentsOrg) && String(repo).split("/")[0]!.toLowerCase() === cfg.agentsOrg.toLowerCase() && !sameRepo(repo, cfg.apply?.repo ?? "") && !sameRepo(repo, cfg.productRepo ?? "");

/**
 * Whether commit `sha` of `slug` carries exactly the product's CI template as its `.github/` (tiers.mjs `ciTemplate`, Tier 0):
 * its `.github` tree, read in the runner's own clone (sent there from the workspace `from`, or fetched from GitHub's PR head
 * `pr`: git's transfer hashes every object), is the same tree object as `modules/ci/template/.github` at the product
 * commit this host runs (the runner's own checkout's HEAD, never anything an agent wrote). Equal trees: the same paths, modes
 * and bytes, so no symlink, no extra or missing workflow file. False on anything else, or when it can't be read.
 */
async function ciTemplateCopy(slug: any, sha: any, { from, pr }: any = {}) {
  try {
    if (!/^[0-9a-f]{40}$/.test(sha ?? "")) return false;
    const want = await git(REPO_ROOT, "rev-parse", "--verify", "HEAD:modules/ci/template/.github");
    const main = await githubDefault(slug);
    return await withTrusted(slug, [main], async (path: any, _: any, out: any) => {
      if (from) await git(from, "push", "--quiet", "--no-verify", "--force", path, `${sha}:${out}`);
      else await git(path, "fetch", "--quiet", "origin", `+refs/pull/${Number(pr)}/head:${out}`);
      if ((await git(path, "rev-parse", "--verify", `${out}^{commit}`)) !== sha) return false;
      return treeIs(path, sha, ".github", want);
    });
  } catch (err: any) {
    log("ci template check failed", { repo: slug, sha, err: String(err.message ?? err).slice(0, 200) });
    return false;
  }
}

/**
 * A product change's module.yaml and compose files (`all`: every file) on both sides, for tiering by content:
 * { path: { base, head } }, a side undefined where the file is absent; a file left out when a read failed (tiers.mjs then
 * fails closed).
 */
const PRODUCT_CONFIG = /^modules\/[^/]+\/module\.yaml$|(^|\/)(docker-)?compose[^/]*\.ya?ml$/;
async function productTexts(files: any, show: any, base: any, head: any, all = false) {
  const read = async (rev: any, f: any) => {
    try {
      return { text: await show(rev, f) };
    } catch (err: any) {
      return /does not exist|exists on disk, but not in|HTTP 404|Not Found/i.test(`${err.message ?? err} ${err.stderr ?? ""}`) ? { text: undefined } : null;
    }
  };
  const out: any = {};
  for (const f of files.filter((x: any) => all || PRODUCT_CONFIG.test(x))) {
    const [b, h] = [await read(base, f), await read(head, f)];
    if (b && h) out[f] = { base: b.text, head: h.text };
  }
  return out;
}

/**
 * The files a PR changes on GitHub, or null when the list can't be trusted whole: GitHub lists at most 3000, so a count
 * that differs from the PR's changed_files (or reaches the cap) fails closed (Tier 2).
 */
async function prFiles(repo: any, number: any) {
  const opts = await gho(repo, READ, { maxBuffer: 16 * 1024 * 1024 });
  const gh = await findRealGh();
  const files = (await execFileP(gh, ["api", "--paginate", `repos/${repo}/pulls/${number}/files?per_page=100`, "--jq", ".[].filename"], opts)).stdout.split("\n").filter(Boolean);
  const count = Number((await execFileP(gh, ["api", `repos/${repo}/pulls/${number}`, "--jq", ".changed_files"], opts)).stdout.trim());
  return files.length === count && count < 3000 ? files : null;
}

/** Each PR as tiering sees it: its files, its named checks on the head, whether the head is the card's, and the app's sensitivity. */
async function mergeTierState(prs: any) {
  const { all } = appsRegistry();
  return Promise.all(
    prs.map(async (p: any) => {
      const pr = (await mergeGithub.pr(p.repo, p.number))?.repository?.pullRequest;
      const checks = merges.namedChecks(pr?.commits?.nodes?.[0]?.commit?.statusCheckRollup).map((c: any) => ({ name: c.name, ok: c.ok, pending: c.pending, ...(c.skipped ? { skipped: true } : {}) }));
      const files = await prFiles(p.repo, p.number).catch(() => null);
      const app = all.find((a) => String(a.repo).toLowerCase() === p.repo.toLowerCase());
      // apps-mcp's isSensitive, with the spec's one carve-out (as for apply): `database: warehouse` as the only trait.
      const traits = app ? sensitiveTraits(normalizeApp(app), all.map(normalizeApp)) : [];
      const sensitive = traits.length > 0 && !(traits.length === 1 && traits[0] === "database" && app.database === "warehouse");
      // A merge without a card needs a head the runner itself pushed (any task's), on a branch of the same repo (no fork).
      const ownHead = Boolean(pr) && pr.isCrossRepository === false && state.pushedHead(p.repo, pr.headRefName, pr.headRefOid);
      // A product PR that is Dependabot's (its author and every commit, from the API): every changed file is read for tiering by content.
      const dependabot = sameRepo(p.repo, cfg.productRepo) && files && pr ? await dependabotPr(p.repo, p.number, pr).catch(() => false) : false;
      const texts = sameRepo(p.repo, cfg.productRepo) && files && pr ? await productMergeTexts(p.repo, files, pr, dependabot).catch(() => ({})) : undefined;
      const ciTemplate = files?.some((f) => /(^|\/)\.github\//.test(f)) && inAgentsOrg(p.repo) && pr?.headRefOid === p.head ? await ciTemplateCopy(p.repo, p.head, { pr: p.number }) : undefined;
      // The PR's content key at exactly the card's head, fetched into the runner's own clone (the owner's veto binds to it);
      // a head that moved or can't be read gives none, which fails closed against a veto.
      const patch = pr && p.head ? await trustedPatch(p.repo, p.head, { pr: p.number }) : undefined;
      return { repo: p.repo, number: p.number, url: p.url, head: p.head, ...(patch ? { patch } : {}), files, ...(texts ? { texts } : {}), ...(ciTemplate ? { ciTemplate } : {}), checks, headMatches: Boolean(p.head) && pr?.headRefOid === p.head, ownHead, sensitive, ...(dependabot ? { dependabot } : {}) };
    }),
  );
}

/**
 * A product PR's config files (`all`: every changed file) at its merge base and its head (GitHub's compare and contents
 * APIs), for productTexts.
 */
async function productMergeTexts(repo: any, files: any, pr: any, all = false) {
  const opts = await gho(repo, READ, { maxBuffer: 64 * 1024 * 1024 });
  const gh = await findRealGh();
  const base = (await execFileP(gh, ["api", `repos/${repo}/compare/${pr.baseRef?.target?.oid}...${pr.headRefOid}`, "--jq", ".merge_base_commit.sha"], opts)).stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(base)) return {};
  const show = async (rev: any, f: any) => (await execFileP(gh, ["api", "-H", "Accept: application/vnd.github.raw", `repos/${repo}/contents/${f.split("/").map(encodeURIComponent).join("/")}?ref=${rev}`], opts)).stdout;
  return productTexts(files, show, base, pr.headRefOid, all);
}

const DEPENDABOT = "dependabot[bot]";
/** The PR's author on GitHub (REST: { login, type }), read by the runner; never from text. */
async function prAuthor(repo: any, number: any) {
  const { stdout } = await execFileP(await findRealGh(), ["api", `repos/${repo}/pulls/${number}`, "--jq", "{ login: .user.login, type: .user.type, commits: .commits, sameRepo: (.head.repo.full_name == .base.repo.full_name) }"], await gho(repo, READ));
  return JSON.parse(stdout);
}

/**
 * Whether a PR is Dependabot's, from the GitHub API: opened by dependabot[bot] (a Bot) from a branch of the same repo, and
 * every commit on it Dependabot's (tiers.mjs dependabotCommits: author dependabot[bot], committed and signed by GitHub;
 * an author email alone can be forged). A commit of anyone else's, the runner's included, leaves the ordinary rules.
 * A commit list GitHub can't give whole (over 250) fails closed.
 */
async function dependabotPr(repo: any, number: any, pr: any) {
  if (pr.isCrossRepository !== false) return false;
  const a = await prAuthor(repo, number);
  if (a.login !== DEPENDABOT || a.type !== "Bot" || !a.sameRepo) return false;
  const { stdout } = await execFileP(await findRealGh(), ["api", "--paginate", `repos/${repo}/pulls/${number}/commits?per_page=100`, "--jq", ".[] | { sha, author: .author.login, committer: .committer.login, verified: .commit.verification.verified }"], await gho(repo, READ, { maxBuffer: 16 * 1024 * 1024 }));
  const commits = stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  if (commits.length !== a.commits || commits.length >= 250) return false;
  return dependabotCommits(commits, pr.headRefOid);
}

/** The instance change as tiering sees it: every changed file (and the agent.yaml of each handbook) at `baseRev` and at the change. */
async function applyTierState(b: any, bump: any, baseRev = b.base) {
  const paths = [...new Set([...b.files, ...definitionsOf(b.files)])];
  const at = async (rev: any) => Object.fromEntries((await Promise.all(paths.map(async (p) => [p, await git(b.r.path, "show", `${rev}:${p}`).catch(() => undefined)]))).filter(([, t]) => t !== undefined));
  const [base, head] = [await at(baseRev), await at(b.sha)];
  return { sha: b.sha, files: b.files, base, head, pin: bump && !bump.error ? { forward: Boolean(bump.forward), back: Boolean(bump.back) } : null, ...(await moduleTierState(base["instance.yaml"], head["instance.yaml"])) };
}

/**
 * The module side of an apply (tiers.mjs moduleAuthorityParts, spec §5.7): when the product pin or the `modules:` list moves,
 * each module's manifest at the old and new product (this checkout's git, which productBump fetched) and whether its code
 * changed. { modulesError } when anything can't be read: the tier fails closed.
 */
async function moduleTierState(baseText: any, headText: any) {
  if (baseText === undefined || headText === undefined) return {};
  try {
    const [bi, hi] = [YAML.parse(baseText) ?? {}, YAML.parse(headText) ?? {}];
    if (["product", "modules", "marketplaces"].every((k) => JSON.stringify(bi[k] ?? null) === JSON.stringify(hi[k] ?? null))) return {};
    const [from, to] = [String(bi.product ?? ""), String(hi.product ?? "")];
    if (![from, to].every((x) => /^[0-9a-f]{40}$/.test(x))) return { modulesError: "the product pin isn't a full commit on both sides" };
    // The official modules by folder tree id (the product's ./modules, or the `aidenhq` marketplace from 5b); third-party
    // modules (instance.yaml marketplaces:), fetched at their pinned shas; a new marketplace is the owner's.
    const fetch = { ...hostFetch(REPO_ROOT), parse: (t: any) => YAML.parse(t) };
    const sides = withRemote({ baseInstance: bi, headInstance: hi, ...officialSides(bi, hi, from, to, REPO_ROOT, fetch) }, fetch);
    return { modules: moduleInputs({ ...sides, always: [] }), marketplaces: marketplaceChanges(bi, hi) };
  } catch (err: any) {
    return { modulesError: String(err.message ?? err).split("\n")[0]!.slice(0, 200) };
  }
}

/** The authority lines an apply card carries (its args, so in its digest): one per module change, code-chosen words only. */
const authorityOf = (st: any): any => {
  const diffs = st?.modules ? [...(st.marketplaces ?? []), ...diffAll(st.modules)] : [];
  return [authorityLines(diffs), diffs.some((d) => d.changes.some((c: any) => c.owner))];
};

/** The tier of a request now: classify() over the common state plus the action's own. Logged. */
async function tierFor(issue: any, action: any, own: any, also: any = []) {
  const common = await commonTierState(issue, action, also);
  const s = { ...common, ...own };
  const t = autonomyCap(classify(action, s), autonomyNow());
  log("tier", { issue: issue.identifier, action, tier: t.tier, rule: t.rule, reject: Boolean(t.reject), panel: Boolean(t.panel), reviewFirst: Boolean(t.reviewFirst) });
  // The reviewer's earlier rejections on this task, attached to a fresh review of the changed request.
  const prior = priorDecisions(common.records, action, also, requestKey(action, s), requestPatches(action, s), common.requestChain);
  return { ...t, full: common.full, previous: [...common.answers, ...prior.findings], relift: prior.relift };
}

/**
 * The current tier of a recorded request (just before running a reviewer-approved one, and before reviewing): from the
 * same verified state as when it was filed. { tier, reason, rule, diff?, files? }. The agent's PR text is not part of it:
 * the reviewer is reasoning-blind (modules/ai-reviewer).
 */
async function currentTier(issue: any, a: any, { withDiff = false, bases }: any = {}) {
  if (a.action === "push" || a.action === "pr") {
    const task = state.task(issue.id);
    const workspace = await prepareWorkspace(issue, task, { clone: false });
    const rows = await branchRows(issue, workspace);
    const branches = [];
    for (const b of a.args.only) {
      const r = rows.find((x) => x.repo.toLowerCase() === b.repo.toLowerCase() && x.branch === b.branch);
      const tip = r ? await git(r.path, "rev-parse", "--verify", `refs/heads/${b.branch}^{commit}`).catch(() => "") : "";
      if (tip !== b.sha) throw new MovedHead(`${b.repo} \`${b.branch}\` moved since the card`);
      branches.push(await branchTierState(r, b.sha, b.base));
    }
    const t = await tierFor(issue, a.action, { branches }, a.args.merge ? ["merge"] : []);
    if (!withDiff) return t;
    // Each section names the base branch its records are read from (the same read the records block is built from), so the
    // reviewer can tie a record to exactly the change it was approved for.
    const read = bases ?? (await cardBases({ branches: a.args.only }));
    const diffs = await Promise.all(branches.map(async (b, i) => `### ${b.repo} ${b.branch} (${b.sha.slice(0, 12)})${read[i]?.base ? ` base ${read[i].base}` : ""}\n${b.base ? await git(b.path, "-c", "core.attributesFile=/dev/null", "diff", "--no-ext-diff", "--no-textconv", "--text", "--no-renames", b.base, b.sha).catch(() => "") : "(no base to diff against)"}`));
    const files = branches.flatMap((b) => (b.files ?? []).map((f) => ({ name: `${b.repo} ${f}`, read: () => git(b.path, "show", `${b.sha}:${f}`) })));
    return { ...t, diff: diffs.join("\n\n"), files: await readFiles(files), bases: read };
  }
  if (a.action === "merge") {
    const prs = await mergeTierState(a.args.prs);
    const t = await tierFor(issue, "merge", { prs });
    if (!withDiff) return t;
    const read = bases ?? (await cardBases({ prs: a.args.prs }));
    const diffs = await Promise.all(prs.map(async (p, i) => `### ${p.url}${read[i]?.base ? ` base ${read[i].base}` : ""}\n${(await execFileP(await findRealGh(), ["pr", "diff", p.url], await gho(p.repo, READ, { maxBuffer: 32 * 1024 * 1024 })).catch(() => ({ stdout: "" }))).stdout}`));
    const gh = await findRealGh();
    const files = prs.flatMap((p, i) => (p.files ?? []).map((f: any) => ({ name: `${p.repo} ${f}`, read: async () => (await execFileP(gh, ["api", "-H", "Accept: application/vnd.github.raw", `repos/${p.repo}/contents/${f.split("/").map(encodeURIComponent).join("/")}?ref=${a.args.prs[i].head}`], await gho(p.repo, READ, { maxBuffer: 16 * 1024 * 1024 }))).stdout })));
    return { ...t, diff: diffs.join("\n\n"), files: await readFiles(files), bases: read };
  }
  if (a.action === "apply") {
    const workspace = await prepareWorkspace(issue, state.task(issue.id), { clone: false });
    const b: any = await fleetBranch(issue, workspace);
    if (b.error) throw new UserError(b.error);
    if (b.sha !== a.args.sha) throw new MovedHead("the fleet branch moved since the card");
    const bump = await productBump(b);
    if (bump?.error) throw new UserError(bump.error);
    const st = await applyTierState(b, bump);
    const t = await tierFor(issue, "apply", st);
    // The module changes the card lists (and its digest covers) must be the ones recomputed now.
    const now = applyCardArgs(b, ...authorityOf(st));
    if (JSON.stringify([now.authority ?? [], now.ownerRequired ?? false]) !== JSON.stringify([a.args.authority ?? [], a.args.ownerRequired ?? false])) throw new UserError("the module changes no longer match the card");
    if (!withDiff) return t;
    const diff = await fleetDiffText(b, bump);
    if (createHash("sha256").update(diff).digest("hex") !== a.targets.diff) throw new UserError("the change no longer matches the card's diff");
    // The module changes the product move brings, as code computed them from the manifests at both commits (the reviewer
    // reads them as facts; the modules' own descriptions and commit messages stay claims).
    const lines = a.args.authority ?? [];
    return { ...t, diff: lines.length ? `${diff}\n\nModule changes (the authority diff, computed by code from the module manifests; owner = new authority):\n${lines.join("\n")}` : diff };
  }
  if (a.action === "create_repo") {
    if (!app) throw new UserError("the GitHub App isn't set up here");
    if (await app.repoExists(a.args.repo)) throw new UserError(`${a.args.repo} already exists`);
    const t = await tierFor(issue, "create_repo", { repo: a.args.repo });
    return withDiff ? { ...t, diff: createRepoText(a.args.repo) } : t;
  }
  throw new UserError(`no tier rule for ${a.action}`);
}

/** The changed files' text for the reviewer (fileContext): read in order, a file that can't be read (deleted) skipped, past 300 not read. */
async function readFiles(list: any) {
  const files = [];
  for (const [i, f] of list.entries()) files.push({ name: f.name, text: i < 300 ? await f.read().catch(() => undefined) : null });
  return fileContext(files);
}

export { AlreadyApplied, AwaitingApproval, DEPENDABOT, alreadyApplied, applyTierState, authorityOf, autonomyNow, branchTierState, commonTierState, currentTier, fileApproval, inAgentsOrg, kernel, keyIn, mergeTierState, prAuthor, prFiles, recordsOn, runnerKey, tierFor, trustedPatch, waitingFor };
