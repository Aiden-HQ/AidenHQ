// Which tier a write is (the tiered-approvals design), from verified state only: the requester the runner looked up,
// the repos, branches and files git and GitHub report, the instance diff it computed. Pure: no I/O. Tier 0 runs at once,
// Tier 1 goes to the AI reviewer, and `panel: true` on Tier 1 (authority-expanding) to it and a second reviewer, who must
// both approve; Tier 2 is the owner's: their own veto, a split panel, or nothing recognised. Friction (checks red, a head
// that moved, an unreadable file) is never the owner's: `reject: true` refuses it by code and tells the agent why. A
// request with several parts takes its highest part (Tier 1 with the panel above plain Tier 1).
// The git rules are the code host's (modules/codehost-github/src/plan.mjs), the product's own files and the owner-approval
// records the platform check's (modules/platform/src/check.mjs); this file combines them with the module and apply rules,
// and the shared rules (kernel/src/tier.ts: earlier decisions). The tier is a proposal on the merits: the kernel applies the
// caps (the instance's autonomy, a routine's) when the request is filed (tier.ts computeTier).
import { PANEL, applyParts, appsParts, changedKeys, eq, newGrants, parse, routineAutonomyChanges } from "../../../kernel/src/apply-tier.ts";
import { REJECT, T, highest, meritOwner, priorDecisions, priorPart, requestKey, requestPatches, requestTargets } from "../../../kernel/src/tier.ts";
import { planParts } from "../../../modules/codehost-github/src/plan.mjs";
import { COMPOSE, GATE_CORE as MODULES_GATE_CORE, check, imageRepo } from "../../../modules/platform/src/check.mjs";
import { GATE_CORE as PRODUCT_GATE_CORE } from "./gate-core.mjs";

/** The gate's core: the product's own paths (gate-core.mjs) and the official modules' (their platform check). */
export const GATE_CORE = [...PRODUCT_GATE_CORE, ...MODULES_GATE_CORE];

// The apply's rules (each instance file's, and the module authority a move brings) are the kernel's (apply-tier.ts), which
// plans every kernel.apply; the product module.yaml rules below share their helpers.
export { newGrants, normalizeApp, sensitiveTraits } from "../../../kernel/src/apply-tier.ts";
const same = (a, b) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();

/**
 * The tier of one request. `s` is the verified state:
 * - every action: { agentsOrg, agentsOrgs (one per enabled code host: the GitHub agents org, local), productRepo, modulesRepo (the official modules repo: its PR card may merge, plan.mjs), instanceRepo, requester: { platform }, records (the task's approval records,
 *   from the board: earlier decisions, see priorDecisions), also (the actions the request also carries) }
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
  return meritOwner(onMerits(action, s));
}

function onMerits(action, s) {
  // Raising a spend cap (the board's raise_cap card, filed by the model gateway) is always the owner's tap.
  if (action === "raise_cap") return T(2, "raise-cap", "raising a spend cap is the owner's");
  if (["cancelled", "done"].includes(s.taskStatus)) return REJECT("closed-task", `the task is ${s.taskStatus}: a leftover request runs nothing`);
  // Fail closed: without knowing which repos are the product and the instance, nothing can be told apart from them.
  if (!s.productRepo || !s.instanceRepo || ![s.agentsOrgs ?? s.agentsOrg].flat().filter(Boolean).length) return T(2, "unknown-repos", "the product repo, instance repo or agents org isn't known here");
  const t = highest(action === "push" || action === "pr" || action === "merge" ? gitParts(action, s) : action === "close" || action === "create_repo" ? planParts(action, s).flat() : action === "apply" ? applyParts(s) : []);
  // Earlier decisions on this task (owner, 2026-11-14; replaced "sticky"): the owner's own no holds until they say yes; the
  // reviewer's no holds for the same content and bounds the retries.
  // The retry bound is per branch or PR (tier.ts priorDecisions): another branch's rejections never park this one.
  const prior = t.reject ? undefined : priorPart(priorDecisions(s.records, action, s.also, requestKey(action, s), requestPatches(action, s), s.requestChain, requestTargets(action, s)));
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
    const v = check({ kind: `codehost-github.${action}`, args: withDocs(item), facts: { productRepo: s.productRepo, roles: s.roles, gateCore: PRODUCT_GATE_CORE } });
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
      // The generated compose's input (scripts/compiler/services.ts): image tags or digests only is an image bump.
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
