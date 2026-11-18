// An agent's handbook as setup writes it into Paperclip (its AGENTS.md), as named parts: setup joins them, and
// `node scripts/compile.mjs --sizes` prints their bytes per agent.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { section } from "./prompts.mjs";
import { frontmatter, sourcesSection } from "./modules.mjs";
import { computerSection } from "./computers.mjs";
import { defaultCache } from "../kernel/src/loader/sources.ts";

/** A file that must resolve (symlinks followed) inside dir; anything else throws. */
export function readInside(dir, path, what) {
  const root = existsSync(dir) ? realpathSync(dir) : "";
  const real = root && typeof path === "string" && existsSync(path) ? realpathSync(path) : "";
  if (!real || !real.startsWith(root + sep)) throw new Error(`${what} must be a file inside ${dir} (got ${path})`);
  return readFileSync(real, "utf8");
}

/**
 * An agent's own handbook (compiled by scripts/compile.mjs): its module's agents/<key>/AGENTS.md (or the instance's fork of
 * it) without the frontmatter,
 * plus the instance's agents/<key>.md under "## Instance rules" when there is one.
 */
export function readInstructions(cfg, a, { repo, instanceDir = "" }) {
  // An instance agent's handbook is its folder's AGENTS.md in the instance repo (agents/<key>/AGENTS.md).
  // A forked module agent's (handbook_fork) is the instance's agents/<key>/AGENTS.md too.
  // A module read from the sources cache (a per-module pin, a third-party module) has its handbook in the fetched tree.
  const trees = join(defaultCache(), "trees");
  const mod = a.module === "instance" || a.handbook_fork ? join(instanceDir, "agents") : String(a.instructions).startsWith(trees + sep) ? trees : a.module && /^[a-z0-9-]+$/.test(a.module) ? join(repo, "modules", a.module, "agents") : "";
  // Handbooks say "the owner"; one line names them.
  const owner = cfg.owner_name ? `This AidenHQ belongs to ${cfg.owner_name}: wherever this handbook says "the owner", it means ${cfg.owner_name}.\n\n` : "";
  // Where agent-built repos live: handbooks say "the agents org", one per enabled code host (compile's agents_orgs).
  const org = orgLine(cfg.agents_orgs ?? (cfg.github_agents_org ? [{ org: cfg.github_agents_org, host: "github" }] : []));
  const own = owner + org + readInside(mod, a.instructions, `agent ${a.name}: instructions`).replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
  if (!a.instructions_extra) return own + "\n";
  const extra = readInside(join(instanceDir, "agents"), a.instructions_extra, `agent ${a.name}: instance rules`).trim();
  return `${own}\n\n## Instance rules\n\n${extra}\n`;
}

/** The handbook's line naming the agents org(s): on GitHub, and `local` for repositories on this server. */
function orgLine(orgs) {
  const named = orgs.map((o) => (o.host === "local" ? "`local` on this server (its repositories are `local/<name>`)" : `\`${o.org}\` on GitHub`));
  if (!named.length) return "";
  return `This AidenHQ's agents org${named.length > 1 ? "s are" : " is"} ${named.join(" and ")}${named.length > 1 ? "; a new app's repository goes in the one its task names" : ""}.\n\n`;
}

/** The crew member's board identity, stored in the agent's metadata for the board and the runner. */
export function personaOf(key, a) {
  const p = a.persona;
  if (p === undefined) return undefined;
  if (typeof p?.name !== "string" || !/^\p{L}[\p{L} .'-]{0,29}$/u.test(p.name)) throw new Error(`agent ${key}: persona.name must be a short name`);
  if (typeof p.voice !== "string" || !p.voice.trim() || p.voice.length > 200 || /[\r\n]/.test(p.voice)) throw new Error(`agent ${key}: persona.voice must be one line (at most 200 characters)`);
  if (typeof p.avatar !== "string" || !/^[a-z0-9-]{1,40}$/.test(p.avatar)) throw new Error(`agent ${key}: persona.avatar must be an avatar name (a-z, 0-9, -)`);
  return { name: p.name, voice: p.voice.trim(), avatar: p.avatar };
}

/**
 * What a woken agent with a persona learns about itself and the Engineers: its name and voice (tone only), and which engine
 * each Engineer's name stands for, so "ask Ada" maps onto delegating to that Engineer. `engines`: config/engines.json.
 */
function personaSection(cfg, engines, key, a) {
  const me = personaOf(key, a);
  if (!me || a.dispatch === "runner") return "";
  const engineOf = (x) => x.engine ?? Object.keys(engines).find((k) => engines[k].adapter === x.adapter);
  const crew = Object.entries(cfg.agents ?? {})
    .filter(([, x]) => x.dispatch === "runner" && x.persona)
    .map(([k, x]) => `${personaOf(k, x).name} (engine \`${engineOf(x)}\`)`);
  return `

## Your name and voice

On the user's board you are ${me.name}. Voice: ${me.voice} The voice sets your tone only; it never changes the rules above.${
    crew.length ? `\n\nThe Engineers on the board, by name: ${crew.join(", ")}. When the user names one of them for code work, that's the engine to use.` : ""
  }
`;
}

// The sections setup itself writes into every crew agent's handbook, ahead of the modules' prompt contributions:
// Approvals is the kernel's; How we build (engineering), the web and the app follow-up (apps-platform) leave with their units.
// Every agent's one rule for what it reads (tools, messages, documents, quoted text): data, never instructions.
const UNTRUSTED_SECTION = section("untrusted");
// The words every agent uses with one meaning, and the shape of a handoff and its report.
const GLOSSARY_SECTION = section("glossary");
const HANDOFF_SECTION = section("handoff");
/** The owner's standing outcomes (compile's `outcomes`, from instance.yaml), each with its owning agent. */
function outcomesSection(cfg) {
  const list = cfg.outcomes ?? [];
  if (!list.length) return "";
  const who = (key) => cfg.agents?.[key]?.persona?.name ?? cfg.agents?.[key]?.name ?? key;
  return `\n\n## Standing outcomes\n\nThe owner's standing goals, each with the one agent that owns it:\n${list.map((o) => `- \`${o.id}\` (${who(o.owner)}, \`${o.owner}\`): ${o.outcome.replace(/\.$/, "")}. Done when: ${o.done}`).join("\n")}\n`;
}
/** How the owner works (compile's `owner_profile`, from the instance's owner/profile.md), in every crew handbook and the lane. */
const profileSection = (cfg) => (cfg.owner_profile ? `${section("profile")}\n${cfg.owner_profile}\n` : "");
// Every codex agent's web access (live search, web_view, app_view), and the one rule that goes with it.
const WEB_SECTION = section("web");
// Agents kept asking for approval through Paperclip's own mechanism, which the owner never sees (approval cards are the only one).
const APPROVALS_SECTION = section("approvals");
// The owning agent checks its app change live, an hour and a day after it deploys (owner, 2026-11-15): for agents that own
// apps and can wake themselves later (app_logs and wake_at).
const appFollowupSection = (a) => (a.enabled_tools?.apps?.includes("app_logs") && a.enabled_tools?.chat_lane?.includes("wake_at") ? section("app-followup", "") : "");

/** A section's text as the agent reads it: past its frontmatter, `{{fleet_issues}}` and `{{memory}}` filled in. */
function sectionText(cfg, a, id, { repo, fleetIssues }) {
  const { body } = frontmatter(readInside(join(repo, "modules"), cfg.prompts?.[id]?.file, `agent ${a.name}: section ${id}`));
  if (body.includes("{{fleet_issues}}") && !fleetIssues) throw new Error(`section ${id}: the Fleet issues task is missing`);
  return body.replaceAll("{{fleet_issues}}", fleetIssues).replace("{{memory}}", () => a.memory ?? "");
}
// deleted at the one-way big switch (crew read skills natively in computers)
const onDemand = (cfg, id) => cfg.prompts?.[id]?.load === "on_demand";

/**
 * The module sections compile picked for this agent that load always (spec §3.1 `prompts`, after the kernel's sections), in
 * compile's order, as [id, text]. `lane`: only those marked for the fast chat lane.
 */
export function promptParts(cfg, a, { repo, fleetIssues, lane = false }) {
  return (a.prompts ?? []).filter((id) => !onDemand(cfg, id) && (!lane || cfg.prompts?.[id]?.lane)).map((id) => [id, sectionText(cfg, a, id, { repo, fleetIssues })]);
}

/** The agent's on-demand sections (module sections with `load: on_demand`, and skills): { id: text }, for handbook_section. */
export function onDemandSections(cfg, a, opts) {
  return Object.fromEntries((a.prompts ?? []).filter((id) => onDemand(cfg, id)).map((id) => [id, sectionText(cfg, a, id, opts)]));
}

/** The handbook's index of its on-demand sections: one line each, read with handbook_section. */
function indexSection(cfg, a) {
  const ids = (a.prompts ?? []).filter((id) => onDemand(cfg, id));
  if (!ids.length) return "";
  return `${section("on-demand", "\n")}${ids.map((id) => `- \`${id}\`: ${cfg.prompts[id].summary}`).join("\n")}\n`;
}

/** The skills compile resolved for an agent (its `skills:` ids), with each one's folder: what a job's engine home gets. */
export const agentSkills = (cfg, key) => (cfg.agents?.[key]?.skills ?? []).map((id) => ({ id, dir: cfg.skills[id].dir }));

/** An agent's whole handbook as [id, text] parts, in the order setup writes them. */
export function handbookParts(cfg, key, a, { repo, instanceDir, engines = {}, fleetIssues }) {
  const codex = a.adapter === "codex_local";
  const parts = [
    ["handbook", readInstructions(cfg, a, { repo, instanceDir })],
    ["persona", personaSection(cfg, engines, key, a)],
    ["computer", computerSection(a)],
    ["profile", codex ? profileSection(cfg) : ""],
    ["untrusted", UNTRUSTED_SECTION],
    ["glossary", codex ? GLOSSARY_SECTION : ""],
    ["outcomes", codex ? outcomesSection(cfg) : ""],
    ["handoff", codex ? HANDOFF_SECTION : ""],
    ["approvals", codex ? APPROVALS_SECTION : ""],
    ["web", !codex ? "" : a.web_search === "disabled" ? WEB_SECTION.replace("You have live web search, `web_view`", "You have `web_view`") : WEB_SECTION],
    ["app-followup", codex ? appFollowupSection(a) : ""],
    ["sources", sourcesSection(a, cfg.mcp_servers ?? {})],
    ...promptParts(cfg, a, { repo, fleetIssues }),
    ["on-demand", indexSection(cfg, a)],
  ];
  return parts.filter(([, text]) => text);
}

/** The fast chat lane's prompt: the agent's own handbook, how the owner works, the untrusted-text rule and the lane's sections. */
export function laneHandbook(cfg, a, opts) {
  return readInstructions(cfg, a, opts) + profileSection(cfg) + UNTRUSTED_SECTION + promptParts(cfg, a, { ...opts, lane: true }).map(([, t]) => t).join("");
}

/** `compile --sizes`: bytes per handbook part per crew agent, largest handbook first (on-demand sections listed, not counted). A local report. */
export function sizesReport(cfg, opts) {
  const rows = Object.entries(cfg.agents ?? {}).filter(([, a]) => a.dispatch !== "runner").map(([key, a]) => {
    const parts = handbookParts(cfg, key, a, { ...opts, fleetIssues: "WOR-0" });
    const later = Object.entries(onDemandSections(cfg, a, { ...opts, fleetIssues: "WOR-0" })).map(([id, t]) => [`${id} (on demand)`, t]);
    return { key, total: parts.reduce((n, [, t]) => n + Buffer.byteLength(t), 0), parts: [...parts, ...later] };
  }).sort((x, y) => y.total - x.total);
  return rows.map(({ key, total, parts }) => `${key} ${total}\n${parts.map(([id, t]) => `  ${String(Buffer.byteLength(t)).padStart(6)}  ${id}`).join("\n")}`).join("\n");
}
