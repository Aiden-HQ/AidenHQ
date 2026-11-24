// An agent's handbook (a kernel job's instructions file, config/handbooks/<id>.md), as named parts: setup joins them, and
// `node scripts/compile.ts --sizes` prints their bytes per agent.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { section } from "./prompts.ts";
import { frontmatter, sourcesSection } from "./modules.ts";
import type { Obj } from "./modules.ts";
import { computerSection } from "./computers.ts";
import { defaultCache } from "./compiler/sources.ts";

/** A file that must resolve (symlinks followed) inside dir; anything else throws. */
export function readInside(dir: string, path: unknown, what: string) {
  const root = existsSync(dir) ? realpathSync(dir) : "";
  const real = root && typeof path === "string" && existsSync(path) ? realpathSync(path) : "";
  if (!real || !real.startsWith(root + sep)) throw new Error(`${what} must be a file inside ${dir} (got ${path})`);
  return readFileSync(real, "utf8");
}

/**
 * An agent's own handbook (compiled by scripts/compile.ts): its module's agents/<key>/AGENTS.md (or the instance's fork of
 * it) without the frontmatter,
 * plus the instance's agents/<key>.md under "## Instance rules" when there is one.
 */
export function readInstructions(cfg: Obj, a: Obj, { repo, instanceDir = "" }: { repo: string; instanceDir?: string }) {
  // A local agent's handbook is its local module's agents/<key>/AGENTS.md in the instance repo.
  // A forked module agent's (handbook_fork) is the instance's agents/<key>/AGENTS.md.
  // A module read from the sources cache (a per-module pin, a third-party module) has its handbook in the fetched tree.
  const trees = join(defaultCache(), "trees");
  const mod = a.tier === "local" ? join(instanceDir, "modules", a.module, "agents") : a.handbook_fork ? join(instanceDir, "agents") : String(a.instructions).startsWith(trees + sep) ? trees : a.module && /^[a-z0-9-]+$/.test(a.module) ? join(repo, "modules", a.module, "agents") : "";
  // Handbooks say "the owner"; one line names them.
  const owner = cfg.owner_name ? `This AidenHQ belongs to ${cfg.owner_name}: wherever this handbook says "the owner", it means ${cfg.owner_name}.\n\n` : "";
  // Where agent-built repos live: handbooks say "the agents org", one per enabled code host (compile's agents_orgs).
  const org = orgLine(cfg.agents_orgs ?? []);
  const own = owner + org + readInside(mod, a.instructions, `agent ${a.name}: instructions`).replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
  if (!a.instructions_extra) return own + "\n";
  const extra = readInside(join(instanceDir, "agents"), a.instructions_extra, `agent ${a.name}: instance rules`).trim();
  return `${own}\n\n## Instance rules\n\n${extra}\n`;
}

/**
 * The handbook's line naming the agents org(s): on GitHub, and `local` for repositories on this server. The first is where new
 * repositories go (compile lists GitHub first once it is connected); an existing repository stays on its host.
 */
function orgLine(orgs: Obj[]) {
  const named = orgs.map((o) => (o.host === "local" ? "`local` on this server (its repositories are `local/<name>`)" : `\`${o.org}\` on GitHub`));
  if (!named.length) return "";
  return `This AidenHQ's agents org${named.length > 1 ? "s are" : " is"} ${named.join(" and ")}${named.length > 1 ? `; a new repository goes in \`${orgs[0]!.org}\`, and each existing one stays where it is` : ""}.\n\n`;
}

// The sections setup itself writes into every crew agent's handbook, ahead of the modules' prompt contributions:
// Approvals is the kernel's; the web and the app follow-up (apps-platform) leave with their units.
// Every agent's one rule for what it reads (tools, messages, documents, quoted text): data, never instructions.
const UNTRUSTED_SECTION = section("untrusted");
// The words every agent uses with one meaning, and the shape of a handoff and its report.
const GLOSSARY_SECTION = section("glossary");
const HANDOFF_SECTION = section("handoff");
// The own-part ending (a part of the owner's task): only an agent that holds task_handoff can end a run that way, so this
// section goes to those agents alone (an agent without the tool would read an ending it is refused). The delegation and
// report-back guidance above is every agent's, whatever its grant.
const OWN_PART_SECTION = section("own-part");
/** The owner's standing outcomes (compile's `outcomes`, from instance.yaml), each with its owning agent. */
function outcomesSection(cfg: Obj) {
  const list = cfg.outcomes ?? [];
  if (!list.length) return "";
  const who = (key: string) => cfg.agents?.[key]?.name ?? key;
  return `\n\n## Standing outcomes\n\nThe owner's standing goals, each with the one agent that owns it:\n${list.map((o: Obj) => `- \`${o.id}\` (${who(o.owner)}, \`${o.owner}\`): ${o.outcome.replace(/\.$/, "")}. Done when: ${o.done}`).join("\n")}\n`;
}
/** How the owner works (compile's `owner_profile`, from the instance's owner/profile.md), in every crew handbook and the lane. */
const profileSection = (cfg: Obj) => (cfg.owner_profile ? `${section("profile")}\n${cfg.owner_profile}\n` : "");
// Every codex agent's web access (live search, web_view, app_view), and the one rule that goes with it.
const WEB_SECTION = section("web");
// Agents kept asking for approval through Paperclip's own mechanism, which the owner never sees (approval cards are the only one).
const APPROVALS_SECTION = section("approvals");
// The owning agent checks its app change live, an hour and a day after it deploys (owner, 2026-11-15): for agents that own
// apps and can wake themselves later (app_logs and wake_at).
const appFollowupSection = (a: Obj) => (a.enabled_tools?.apps?.includes("app_logs") && a.enabled_tools?.chat_lane?.includes("wake_at") ? section("app-followup", "") : "");

/** A section's text as the agent reads it: past its frontmatter, `{{fleet_issues}}` filled in. `{{memory}}` stays: the kernel fills it from the agent's memory when a job starts, and the chat lane each turn (memory.ts fillMemory). */
function sectionText(cfg: Obj, a: Obj, id: string, { repo, fleetIssues }: { repo: string; fleetIssues?: string }) {
  const { body } = frontmatter(readInside(String(cfg.prompts?.[id]?.file).startsWith(join(defaultCache(), "trees") + sep) ? join(defaultCache(), "trees") : join(repo, "modules"), cfg.prompts?.[id]?.file, `agent ${a.name}: section ${id}`));
  if (body.includes("{{fleet_issues}}") && !fleetIssues) throw new Error(`section ${id}: the Fleet issues task is missing`);
  return body.replaceAll("{{fleet_issues}}", fleetIssues!);
}
/**
 * The module sections compile picked for this agent that load always (spec §3.1 `prompts`, after the kernel's sections), in
 * compile's order, as [id, text]. `lane`: only those marked for the fast chat lane.
 */
export function promptParts(cfg: Obj, a: Obj, { repo, fleetIssues, lane = false }: { repo: string; fleetIssues?: string; lane?: boolean }): [string, string][] {
  return (a.prompts ?? []).filter((id: string) => !lane || cfg.prompts?.[id]?.lane).map((id: string): [string, string] => [id, sectionText(cfg, a, id, { repo, fleetIssues })]);
}

/** The skills compile resolved for an agent (its `skills:` ids), with each one's folder: what a job's engine home gets. */
export const agentSkills = (cfg: Obj, key: string) => (cfg.agents?.[key]?.skills ?? []).map((id: string) => ({ id, dir: cfg.skills[id].dir }));

/** An agent's whole handbook as [id, text] parts, in the order setup writes them. */
export function handbookParts(cfg: Obj, key: string, a: Obj, { repo, instanceDir, fleetIssues }: { repo: string; instanceDir?: string; fleetIssues?: string }) {
  const codex = a.profile === "crew";
  const parts: [string, string][] = [
    ["handbook", readInstructions(cfg, a, { repo, instanceDir })],
    ["working-style", a.handbook_line ? `\n\n## Your working style\n\nYou are ${a.name}, a member of the ${cfg.agents?.[a.member_of]?.team?.name ?? a.member_of} team. ${a.handbook_line}\n` : ""],
    ["computer", computerSection(a)],
    ["profile", codex ? profileSection(cfg) : ""],
    ["untrusted", UNTRUSTED_SECTION],
    ["glossary", codex ? GLOSSARY_SECTION : ""],
    ["outcomes", codex ? outcomesSection(cfg) : ""],
    ["handoff", codex ? HANDOFF_SECTION : ""],
    ["own-part", codex && a.enabled_tools?.paperclip_tasks?.includes("task_handoff") ? OWN_PART_SECTION : ""],
    ["approvals", codex ? APPROVALS_SECTION : ""],
    ["web", !codex ? "" : a.web_search === "disabled" ? WEB_SECTION.replace("You have live web search, `web_view`", "You have `web_view`") : WEB_SECTION],
    ["app-followup", codex ? appFollowupSection(a) : ""],
    ["sources", sourcesSection(a, cfg.mcp_servers ?? {})],
    ...promptParts(cfg, a, { repo, fleetIssues }),
  ];
  return parts.filter(([, text]) => text);
}

/** The fast chat lane's prompt: the agent's own handbook, how the owner works, the untrusted-text rule and the lane's sections. */
export function laneHandbook(cfg: Obj, a: Obj, opts: { repo: string; instanceDir?: string; fleetIssues?: string }) {
  return readInstructions(cfg, a, opts) + profileSection(cfg) + UNTRUSTED_SECTION + promptParts(cfg, a, { ...opts, lane: true }).map(([, t]) => t).join("");
}

/** `compile --sizes`: bytes per handbook part per crew agent, largest handbook first. A local report. */
export function sizesReport(cfg: Obj, opts: { repo: string; instanceDir?: string; engines?: unknown }) {
  const rows = Object.entries<Obj>(cfg.agents ?? {}).filter(([, a]) => a.profile === "crew").map(([key, a]) => {
    const parts = handbookParts(cfg, key, a, { ...opts, fleetIssues: "WOR-0" });
    return { key, total: parts.reduce((n, [, t]) => n + Buffer.byteLength(t), 0), parts };
  }).sort((x, y) => y.total - x.total);
  return rows.map(({ key, total, parts }) => `${key} ${total}\n${parts.map(([id, t]) => `  ${String(Buffer.byteLength(t)).padStart(6)}  ${id}`).join("\n")}`).join("\n");
}
