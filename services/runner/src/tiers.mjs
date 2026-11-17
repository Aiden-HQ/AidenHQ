// Which tier a write is (the tiered-approvals design), from verified state only: the requester the runner looked up,
// the repos, branches and files git and GitHub report, the instance diff it computed. Pure: no I/O. Tier 0 runs at once,
// Tier 1 goes to the AI reviewer, and `panel: true` on Tier 1 (authority-expanding) to it and a second reviewer, who must
// both approve; Tier 2 is the owner's: their own veto, a split panel, or nothing recognised. Friction (checks red, a head
// that moved, an unreadable file) is never the owner's: `reject: true` refuses it by code and tells the agent why. A
// request with several parts takes its highest part (Tier 1 with the panel above plain Tier 1).
// The git rules are the code host's (modules/codehost-github/src/plan.mjs), the product's own files and the owner-approval
// records the platform check's (modules/platform/src/check.mjs); this file combines them with the module and apply rules,
// and the shared rules (kernel/src/tier.ts: earlier decisions and the caps).
import YAML from "yaml";
import { classifyModules, diffAll, marketplaceChanges } from "../../../kernel/src/loader/authority.ts";
import { REJECT, T, highest, meritOwner, priorDecisions, priorPart, requestKey, requestPatches, routineCapped } from "../../../kernel/src/tier.ts";
import { planParts } from "../../../modules/codehost-github/src/plan.mjs";
import { COMPOSE, GATE_CORE, check, imageRepo } from "../../../modules/platform/src/check.mjs";

/** Authority-expanding: the reviewer and a second reviewer on another model family must both approve. */
const PANEL = (rule, reason) => ({ tier: 1, rule, reason, panel: true });
/** New module authority (spec §5.7): the AI reviewer first, then the owner with its verdict; a reviewer reject is final. */
const OWNER_AFTER_REVIEW = (rule, reason, panel) => ({ tier: 2, rule, reason, reviewFirst: true, ...(panel ? { panel: true } : {}) });
const same = (a, b) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();

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
    else if ((m = /^agents\/([a-z0-9][a-z0-9-]*)\/memory\.md$/.exec(f))) parts.push((s.roles?.[m[1]] ?? []).length ? T(1, "role-memory", `memory of ${m[1]}, which holds a role`) : T(1, "agent-memory", `memory of ${m[1]}, an agent without a role`));
    else if ((m = /^agents\/([a-z0-9][a-z0-9-]*)\/AGENTS\.md$/.exec(f))) {
      const key = m[1];
      const base = parse(def(key, "base"));
      const head = parse(def(key, "head"));
      if ((s.roles?.[key] ?? []).length) parts.push(T(1, "role-handbook", `handbook of ${key}, which holds a role`));
      else if (base === undefined) {
        // A new agent's handbook: only alongside its new agent.yaml, in trial, in this same change; anything else is refused.
        const added = (s.files ?? []).includes(`agents/${key}/agent.yaml`) && head?.trial === true;
        parts.push(!added ? REJECT("handbook-without-agent", `${key}'s handbook, without a new trial agent.yaml in the change`) : s.ownerStarted ? T(0, "trial-agent-new", `${key}'s handbook, with its new trial agent, on a task the owner started`) : T(1, "trial-agent-new-agent-task", `${key}'s handbook, with its new trial agent, on an agent-origin task`));
      } else if (base === null) parts.push(REJECT("unparseable", `agents/${key}/agent.yaml doesn't parse`));
      else if (base.trial === true) parts.push(s.trialNoTap ? T(0, "trial-handbook", `handbook of ${key}, an agent in trial`) : T(1, "trial-handbook-agent-task", `handbook of ${key}, an agent in trial, on an agent-origin task`));
      else parts.push(T(1, "agent-handbook", `handbook of ${key}, a graduated agent without a role`));
    } else if ((m = /^agents\/([\w.-]+)\.md$/.exec(f))) {
      const roles = s.roles?.[m[1]] ?? [];
      parts.push(roles.length ? T(1, "role-handbook", `handbook of ${m[1]}, which holds a role`) : T(1, "module-handbook", `handbook additions for ${m[1]}, an agent without a role`));
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
 * The instance's third-party marketplace changes are read here from both instance.yaml sides; a new one is the owner's.
 */
function moduleAuthorityParts(s, base, head) {
  if (s.modulesError || !s.modules) return [REJECT("unknown-content", `couldn't read the module changes${s.modulesError ? ` (${s.modulesError})` : ""}; try again`)];
  let markets;
  try { markets = marketplaceChanges(base, head); } catch (err) { return [REJECT("unparseable", `instance.yaml marketplaces: ${String(err.message ?? err).slice(0, 200)}`)]; }
  const diffs = [...markets, ...diffAll(s.modules)];
  // The official marketplace moving with every module's folder tree id unchanged (the 5b switch): no authority, the reviewer's.
  if (!diffs.length) return changedKeys(base, head).includes("marketplaces") ? [T(1, "marketplace-same-trees", "the official marketplace moves; every module's folder tree id is unchanged")] : [];
  const c = classifyModules(diffs);
  return [c.reviewFirst ? OWNER_AFTER_REVIEW(c.rule, c.reason, c.panel) : c.panel ? PANEL(c.rule, c.reason) : T(1, c.rule, c.reason)];
}

function instanceParts(s) {
  const base = parse(s.base?.["instance.yaml"]);
  const head = parse(s.head?.["instance.yaml"]);
  if (!base || !head) return [REJECT("unparseable", "instance.yaml doesn't parse")];
  const parts = [];
  const keys = changedKeys(base, head);
  if (["product", "modules", "marketplaces"].some((k) => keys.includes(k))) parts.push(...moduleAuthorityParts(s, base, head));
  for (const k of keys) {
    if (k === "modules" || k === "marketplaces") continue; // the module parts above
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
 * An app entry as apps-mcp's AppSchema leaves it (modules/apps-platform/apps-mcp/src/registry.ts): defaults, and `database` / `api` adding
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
