// Which tier a write is (the tiered-approvals design), from verified state only: the requester the runner looked up,
// the repos, branches and files git and GitHub report, the instance diff it computed. Pure: no I/O. Tier 0 runs at once,
// Tier 1 goes to the AI reviewer, Tier 2 to the owner; `reject: true` is refused by code before any review. A request
// with several parts takes its highest part; anything not recognised is Tier 2.
import YAML from "yaml";

/** Gate code in the product repo: changing it is always the owner's decision. */
const PRODUCT_GATES = [
  /^services\/board\/src\/(approvals|app)\.ts$/,
  /(^|\/)agent-auth\.ts$/, // services/shared/agent-auth.ts and every synced copy
  /^services\/runner\/src\/(tiers|review|authorize|merges|apply)\.mjs$/,
  /^scripts\/(modules|paperclip-setup)\.mjs$/,
  /^ops\//,
  /^modules\/core\/security\//,
  /launcher/i,
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
 * - every action: { agentsOrg, productRepo, instanceRepo, requester: { platform }, sticky }
 * - push/pr: branches [{ repo, branch, defaultBranch, deployBranch?, empty, files }]
 * - merge: prs [{ repo, files, checks: [{ name, ok, pending }] (advisory checks such as design-review left out), headMatches, ownHead (a commit the runner pushed to a same-repo branch), sensitive }]
 * - apply: { files, base, head (path → text, absent when missing), pin: null | { forward, back }, roles (agent key → roles),
 *   ownerStarted (the task chain began with the owner), trialNoTap (today's trial-handbook rule) }
 */
export function classify(action, s) {
  if (["cancelled", "done"].includes(s.taskStatus)) return REJECT("closed-task", `the task is ${s.taskStatus}: a leftover request runs nothing`);
  // Fail closed: without knowing which repos are the product and the instance, nothing can be told apart from them.
  if (!s.productRepo || !s.instanceRepo || !s.agentsOrg) return T(2, "unknown-repos", "the product repo, instance repo or agents org isn't known here");
  const t = highest(action === "push" || action === "pr" ? publishParts(action, s) : action === "merge" ? mergeParts(s) : action === "close" ? closeParts(s) : action === "apply" ? applyParts(s) : []);
  // Sticky: after the owner or the reviewer rejected this action on this task, it is the owner's from then on.
  if (s.sticky && !t.reject && t.tier < 2) return T(2, "sticky", `rejected before on this task (was: ${t.reason})`);
  return t;
}

function publishParts(action, s) {
  return (s.branches ?? []).map((b) => {
    const inAgents = Boolean(s.agentsOrg) && same(orgOf(b.repo), s.agentsOrg);
    if (same(b.repo, s.instanceRepo)) return T(2, "instance-repo", "the instance repo changes only through apply");
    if (!Array.isArray(b.files)) return T(2, "unknown-files", `couldn't tell which files ${b.repo} \`${b.branch}\` changes`);
    if (same(b.repo, s.productRepo)) {
      if (action !== "pr") return T(2, "product-push", "a push to the product repo");
      if (!s.requester?.platform) return REJECT("product-pr-requester", "only the Platform Engineer or the Agent Architect may open PRs on the product repo");
      const gate = (b.files ?? []).find((f) => PRODUCT_GATES.some((g) => g.test(f)) || GITHUB.test(f));
      return gate ? T(2, "product-gate", `it changes gate code (${gate})`) : T(1, "product-pr", "a PR to the product repo by the Platform Engineer or the Architect");
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

/** close: prs [{ repo }]. Tier 0 in the agents org (reversible, no code changes); the product and instance repos' PRs are the owner's. */
function closeParts(s) {
  return (s.prs ?? []).map((p) => {
    if (!same(orgOf(p.repo), s.agentsOrg)) return REJECT("outside-close", `${p.repo} is outside the agents org`);
    if (same(p.repo, s.instanceRepo) || same(p.repo, s.productRepo)) return REJECT("core-repo-close", `${p.repo} is the instance or product repo: its PRs are the owner's`);
    return T(0, "agents-org-close", `closing a PR of ${p.repo} is reversible and changes no code`);
  });
}

function mergeParts(s) {
  return (s.prs ?? []).map((p) => {
    const ref = `${p.repo}#${p.number ?? "?"}`;
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
    // A head the runner didn't push (a fork, someone else's push): the reviewer reads the diff first.
    if (!p.ownHead) return T(1, "agents-org-merge-foreign-head", `${ref}: its head isn't a commit the runner pushed to a branch of ${p.repo}`);
    // Merged at once when CI is green (owner, 2026-11-12): the PR merges on its own (an independent queue), strict and bound to
    // this head, only once every named check passed on it; red leaves it unmerged. Still running is not red.
    if (p.checks.some((c) => c.pending)) return T(0, "agents-org-merge-checks-running", `${ref}: ${p.checks.length} named check${p.checks.length === 1 ? "" : "s"}, still running on the exact head (merged only once green)`);
    return T(0, "agents-org-merge", `${ref}: ${p.checks.length} named check${p.checks.length === 1 ? "" : "s"}, all green on the exact head`);
  });
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

/** Grants `head` gives that `base` didn't: a connection added, or a wider grant (read → write, more tools). */
export function newGrants(base = {}, head = {}) {
  const out = [];
  for (const [conn, g] of Object.entries(head ?? {})) {
    const was = (base ?? {})[conn];
    if (eq(was, g) || was === "write" || (was === "read" && g === "read")) continue;
    if (Array.isArray(g) && Array.isArray(was) && g.every((t) => was.includes(t))) continue;
    out.push(conn);
  }
  return out;
}

const AGENT_SAFE = new Set(["name", "description", "model", "reasoning_effort", "timeout_sec", "routines", "budget", "max_parallel", "catch_up"]);
const OVERRIDE_SAFE = { agents: new Set(["model", "reasoning_effort", "timeout_sec"]), routines: new Set(["schedules", "status", "model"]) };

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
  if (base === undefined) {
    if (head.trial !== true) return T(2, "untrialed-agent", `new agent ${key} isn't in trial`);
    // Only the safe fields (no roles, image or other privileges); any write grant goes to the reviewer at least.
    const other = Object.keys(head).filter((k) => k !== "trial" && k !== "connections" && !AGENT_SAFE.has(k));
    if (other.length) return T(2, "new-agent-fields", `new agent ${key} sets ${other.join(", ")}`);
    if (Object.values(head.connections ?? {}).some((g) => g !== "read")) return T(1, "trial-agent-new-writes", `adds ${key} in trial, with write or tool-level grants`);
    return s.ownerStarted ? T(0, "trial-agent-new", `adds ${key} in trial, on a task the owner started`) : T(1, "trial-agent-new-agent-task", `adds ${key} in trial, on an agent-origin task`);
  }
  const keys = changedKeys(base, head);
  const wider = newGrants(base.connections, head.connections);
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
  a.secrets = [...new Set([...a.secrets, ...(a.database ? ["DATABASE_URL"] : []), ...(a.api ? [a.api.token] : []), ...(a.share?.host ? ["AIDENHQ_GATE_SECRET"] : [])])];
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
