// Which tier a write is (the tiered-approvals design), from verified state only: the requester the runner looked up,
// the repos, branches and files git and GitHub report, the instance diff it computed. Pure: no I/O. Tier 0 runs at once,
// Tier 1 goes to the AI reviewer, and `panel: true` on Tier 1 (authority-expanding) to it and a second reviewer, who must
// both approve; Tier 2 is the owner's: their own veto, a split panel, or nothing recognised. Friction (checks red, a head
// that moved, an unreadable file) is never the owner's: `reject: true` refuses it by code and tells the agent why. A
// request with several parts takes its highest part (Tier 1 with the panel above plain Tier 1).
// The git rules are the code host's (modules/codehost-github/src/plan.mjs), the product's own files and the owner-approval
// records the platform check's (modules/platform/src/check.mjs); this file combines them with the module and apply rules,
// earlier decisions and the caps.
import YAML from "yaml";
import { classifyModules, diffAll } from "../../../kernel/src/loader/authority.ts";
import { planParts } from "../../../modules/codehost-github/src/plan.mjs";
import { COMPOSE, GATE_CORE, ROLE_AGENTS, check, imageRepo } from "../../../modules/platform/src/check.mjs";

const T = (tier, rule, reason) => ({ tier, rule, reason });
/** Authority-expanding: the reviewer and a second reviewer on another model family must both approve. */
const PANEL = (rule, reason) => ({ tier: 1, rule, reason, panel: true });
const REJECT = (rule, reason) => ({ tier: 2, rule, reason, reject: true });
/** New module authority (spec §5.7): the AI reviewer first, then the owner with its verdict; a reviewer reject is final. */
const OWNER_AFTER_REVIEW = (rule, reason, panel) => ({ tier: 2, rule, reason, reviewFirst: true, ...(panel ? { panel: true } : {}) });
const same = (a, b) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();

const rank = (p) => p.tier * 2 + (p.panel ? 1 : 0);
/** The highest part (a reject beats everything; Tier 1 with the panel beats plain Tier 1); no parts is Tier 2. */
export function highest(parts) {
  if (!parts.length) return T(2, "unrecognised", "nothing recognised in the request");
  const top = parts.find((p) => p.reject) ?? parts.reduce((a, b) => (rank(b) > rank(a) ? b : a));
  // A module change is always reviewed first, whatever else the request carries; the review is a panel if any part is. A
  // part that is the owner's on its merits keeps the reviewer's reject from being final.
  if (!top.reject && top.tier === 2 && parts.some((p) => p.reviewFirst)) return { ...top, reviewFirst: true, ...(parts.some((p) => p.panel) ? { panel: true } : {}), ...(parts.some((p) => p.tier === 2 && (p.byMerit || !p.reviewFirst)) ? { byMerit: true } : {}) };
  return top;
}

/**
 * Tier 2 on its merits (the owner's veto, a spend-cap raise, an owner-approval record, unknown repos, nothing recognised):
 * the owner's tap decides, but the AI reviewer reads it first (owner, 2026-11-16: every write is reviewed before it reaches
 * the owner). Its approve and its reject both go on to the owner with the verdict on the card (`byMerit`).
 */
export const meritOwner = (t) => (!t.reject && t.tier === 2 && !t.reviewFirst ? { ...t, reviewFirst: true, byMerit: true } : t);

/** Code's own refusals that stay final on any card: the change moved, or code refused it (a closed task, a rejected copy). */
const FINAL_CODES = ["stale_head", "refused_by_code"];

/**
 * What a review-first card posts after the reviewer: an approve goes to the owner with the verdict on the card; a reject is
 * final (new module authority, autonomy off, a routine's cap: Tier 1 semantics), except on a card that is the owner's on its
 * merits (`byMerit`), where every verdict but code's own refusals goes on to the owner with the reject shown. An escalate
 * stays one. Any other card posts the verdict as it is.
 */
export function afterReview(input, v) {
  if (!input?.reviewFirst) return v;
  const by = `${v.model}${v.second ? ` and ${v.second}` : ""}`;
  if (input.byMerit && v.decision === "reject" && !FINAL_CODES.includes(v.code)) return { ...v, decision: "escalate", code: "owner_tier", reason: `The AI reviewer rejected (${by}${v.code ? `, ${v.code}` : ""}): ${v.reason} It is Tier 2 on its merits, so the owner decides: ${input.reason}` };
  if (v.decision !== "approve") return v;
  const [code, why] = input.byMerit ? ["owner_tier", "It is Tier 2 on its merits"] : input.routineCap ? ["routine_autonomy", `A routine's autonomy is ${input.routineCap}`] : input.autonomyOff ? ["autonomy_off", "Autonomy is off"] : ["new_authority", "New module authority"];
  return { ...v, decision: "escalate", code, reason: `The AI reviewer approved (${by}): ${v.reason} ${why}, so the owner decides: ${input.reason}` };
}

/** How the board holds a review-first card: "owner" (byMerit: the reviewer may only escalate), "final" (it may escalate or reject). */
export const reviewFirstOf = (...ts) => (ts.some((t) => t && !t.reject && t.byMerit) ? "owner" : ts.some((t) => t && !t.reject && t.reviewFirst) ? "final" : undefined);

/**
 * A routine's cap (its `autonomy`): the stricter of it and the instance's wins. tier0 or off: a Tier 1 write is review-first
 * (the reviewer's reject is final, its approve goes on to the owner), as autonomy off does it (autonomyCap); off: a Tier 0
 * write waits for the owner's tap.
 */
export function routineCapped(t, cap) {
  if (t.reject || !cap || cap === "full") return t;
  if (t.tier === 0 && cap === "off") return { ...T(2, "routine-autonomy", `a routine's run started this task and that routine's autonomy is ${cap} (was: ${t.reason})`), baseTier: 0 };
  if (t.tier === 1) return { ...t, tier: 2, reason: `${t.reason} (a routine's run started this task: its autonomy is ${cap})`, reviewFirst: true, routineCap: cap, baseTier: 1 };
  if (t.reviewFirst) return { ...t, reason: `${t.reason} (a routine's run started this task: its autonomy is ${cap})` };
  return t;
}

/**
 * The instance's autonomy off (lean-core decision 5: every install and update is AI-reviewed regardless): the owner decides
 * every write, but what the reviewer reads with autonomy on it still reads first. Tier 1 becomes review-first (a reject is
 * final; an approve goes on to the owner with the verdict); Tier 0 waits for the owner's tap. `baseTier`: the merit tier.
 */
export function autonomyCap(t, autonomy) {
  if (autonomy !== "off" || t.reject || t.tier === 2) return t;
  return t.tier === 0 ? { ...T(2, "autonomy-off", `autonomy is off (was: ${t.reason})`), baseTier: 0 } : { ...t, tier: 2, reviewFirst: true, autonomyOff: true, baseTier: 1 };
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
  return routineCapped(meritOwner(onMerits(action, s)), s.routineAutonomy);
}

function onMerits(action, s) {
  // Raising a spend cap (the board's raise_cap card, filed by the model gateway) is always the owner's tap.
  if (action === "raise_cap") return T(2, "raise-cap", "raising a spend cap is the owner's");
  if (["cancelled", "done"].includes(s.taskStatus)) return REJECT("closed-task", `the task is ${s.taskStatus}: a leftover request runs nothing`);
  // Fail closed: without knowing which repos are the product and the instance, nothing can be told apart from them.
  if (!s.productRepo || !s.instanceRepo || !s.agentsOrg) return T(2, "unknown-repos", "the product repo, instance repo or agents org isn't known here");
  const t = highest(action === "push" || action === "pr" || action === "merge" ? gitParts(action, s) : action === "close" || action === "create_repo" ? planParts(action, s).flat() : action === "apply" ? applyParts(s) : []);
  // Earlier decisions on this task (owner, 2026-11-14; replaced "sticky"): the owner's own no holds until they say yes; the
  // reviewer's no holds for the same content and bounds the retries.
  const prior = t.reject ? undefined : priorPart(priorDecisions(s.records, action, s.also, requestKey(action, s), requestPatches(action, s), s.requestChain));
  if (prior) return prior.reject ? prior : { ...prior, reason: `${prior.reason} (was: ${t.reason})`, ...(t.panel ? { panel: true } : {}) };
  return t;
}

/**
 * A push's, PR's or merge's parts, item by item (each branch or PR): the code host's refusal, if any, stands first; then the
 * platform check's verdict on the item's files, the module rules for a product module.yaml, and the code host's parts.
 */
function gitParts(action, s) {
  const items = action === "merge" ? s.prs ?? [] : s.branches ?? [];
  const own = planParts(action, s);
  return items.map((item, i) => {
    const v = check({ kind: `codehost-github.${action}`, args: withDocs(item), facts: { productRepo: s.productRepo, roles: s.roles } });
    const checked = v.verdict === "deny" ? [{ tier: 2, rule: v.rule, reason: v.reason, reject: true }] : v.verdict === "raise" ? [{ tier: v.tier, rule: v.rule, reason: v.reason, ...(v.panel ? { panel: true } : {}) }] : [];
    const mine = own[i] ?? [];
    return highest([...mine.filter((p) => p.reject), ...checked, ...productModuleParts(item, s), ...mine.filter((p) => !p.reject)]);
  });
}

/** The item as the check reads it: each compose file's texts with both sides parsed (the check parses nothing itself). */
const withDocs = (item) => (item.texts ? { ...item, texts: Object.fromEntries(Object.entries(item.texts).map(([f, t]) => [f, COMPOSE.test(f) && t ? { ...t, baseDoc: parse(t.base), headDoc: parse(t.head) } : t])) } : item);

/** A product change's module.yaml files outside the gate's core, by content (moduleParts); unreadable is refused. */
function productModuleParts(item, s) {
  if (!same(item.repo, s.productRepo) || !Array.isArray(item.files)) return [];
  return item.files.filter((f) => /^modules\/[^/]+\/module\.yaml$/.test(f) && !GATE_CORE.some((g) => g.test(f))).flatMap((f) => {
    const t = item.texts?.[f];
    return t ? moduleParts(f, t.base, t.head, s.connections) : [REJECT("unknown-content", `couldn't read ${f} on both sides; try again`)];
  });
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
  // gets `relift` (the first round's note), and unsure again there goes to the owner (the reviewer module). Unchanged or unknown
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



























/** What a module agent may change with one reviewer: everything else (model, connections, roles, image, a new agent) is the panel's. */
const MODULE_AGENT_SAFE = new Set(["reasoning_effort", "timeout_sec", "heartbeat", "persona", "max_parallel", "graded", "brief"]);
/**
 * Module keys that are the reviewer's (text, labels, schedules without a model); agents, routines, connections and apps are
 * checked below, services too (an image bump is the reviewer's); the rest (settings and their defaults such as autonomy,
 * board_env, privileged, codex_args, isolation, secrets) are the panel's.
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
    } else if (k === "services") {
      // The generated compose's input (kernel/src/loader/services.ts): image tags or digests only is an image bump.
      const noImages = (sv) => ({ ...(sv ?? {}), run: Object.fromEntries(Object.entries(sv?.run ?? {}).map(([n, x]) => [n, { ...(x ?? {}), image: imageRepo(x?.image) }])) });
      if (eq(noImages(b.services), noImages(h.services))) parts.push(T(1, "product-image-bump", `${f}: services image tags or digests only`));
      else why("module-services", "changes its services (env, mounts, networks, links, joins, secrets, a service or another image)");
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

/**
 * The modules a product bump or a `modules:` edit changes (spec §5.7): `s.modules` is each module's def before and after and
 * whether its code changed (the runner read them at both product commits); `s.modulesError` when it couldn't. Every module
 * change is the AI reviewer's first (the panel's when code changed); new authority adds the owner after it.
 */
function moduleAuthorityParts(s) {
  if (s.modulesError || !s.modules) return [REJECT("unknown-content", `couldn't read the module changes${s.modulesError ? ` (${s.modulesError})` : ""}; try again`)];
  const diffs = diffAll(s.modules);
  if (!diffs.length) return [];
  const c = classifyModules(diffs);
  return [c.reviewFirst ? OWNER_AFTER_REVIEW(c.rule, c.reason, c.panel) : c.panel ? PANEL(c.rule, c.reason) : T(1, c.rule, c.reason)];
}

function instanceParts(s) {
  const base = parse(s.base?.["instance.yaml"]);
  const head = parse(s.head?.["instance.yaml"]);
  if (!base || !head) return [REJECT("unparseable", "instance.yaml doesn't parse")];
  const parts = [];
  const keys = changedKeys(base, head);
  if (keys.includes("product") || keys.includes("modules")) parts.push(...moduleAuthorityParts(s));
  for (const k of keys) {
    if (k === "modules") continue; // the module parts above
    // A rollback can undo a security fix: the panel's. A pin off product main is refused.
    if (k === "product") parts.push(s.pin?.forward ? T(1, "pin-forward", "the product pin moves forward along product main") : s.pin?.back ? PANEL("pin-backwards", "the product pin moves backwards (a rollback)") : REJECT("pin-unknown", "the product pin moves, and not along product main"));
    else if (k === "settings") {
      // Every setting is the panel's. (Slack channels agents post to are no special case since 2f: a post to a channel off
      // slack_post_channels is itself a Tier 2 channel-slack.post record.)
      for (const sk of changedKeys(base.settings, head.settings)) parts.push(PANEL("settings", `changes the setting ${sk}`));
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
