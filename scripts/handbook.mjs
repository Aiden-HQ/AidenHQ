// An agent's handbook as setup writes it into Paperclip (its AGENTS.md), as named parts: setup joins them, and
// `node scripts/compile.mjs --sizes` prints their bytes per agent.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { section } from "./prompts.mjs";
import { sourcesSection } from "./modules.mjs";
import { computerSection } from "./computers.mjs";

/** A file that must resolve (symlinks followed) inside dir; anything else throws. */
export function readInside(dir, path, what) {
  const root = existsSync(dir) ? realpathSync(dir) : "";
  const real = root && typeof path === "string" && existsSync(path) ? realpathSync(path) : "";
  if (!real || !real.startsWith(root + sep)) throw new Error(`${what} must be a file inside ${dir} (got ${path})`);
  return readFileSync(real, "utf8");
}

/**
 * An agent's own handbook (compiled by scripts/compile.mjs): its module's agents/<key>/AGENTS.md without the frontmatter,
 * plus the instance's agents/<key>.md under "## Instance rules" when there is one.
 */
export function readInstructions(cfg, a, { repo, instanceDir = "" }) {
  // An instance agent's handbook is its folder's AGENTS.md in the instance repo (agents/<key>/AGENTS.md).
  const mod = a.module === "instance" ? join(instanceDir, "agents") : a.module && /^[a-z0-9-]+$/.test(a.module) ? join(repo, "modules", a.module, "agents") : "";
  // Handbooks say "the owner"; one line names them.
  const owner = cfg.owner_name ? `This AidenHQ belongs to ${cfg.owner_name}: wherever this handbook says "the owner", it means ${cfg.owner_name}.\n\n` : "";
  // Where agent-built repos live: handbooks say "the agents org".
  const org = cfg.github_agents_org ? `This AidenHQ's agents org on GitHub is \`${cfg.github_agents_org}\`.\n\n` : "";
  const own = owner + org + readInside(mod, a.instructions, `agent ${a.name}: instructions`).replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
  if (!a.instructions_extra) return own + "\n";
  const extra = readInside(join(instanceDir, "agents"), a.instructions_extra, `agent ${a.name}: instance rules`).trim();
  return `${own}\n\n## Instance rules\n\n${extra}\n`;
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
 * each Engineer's name stands for, so "ask Ada" maps onto task_create_engineer_task. `engines`: config/engines.json.
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
// Every codex agent's web access (live search, web_view, app_view), and the one rule that goes with it.
const WEB_SECTION = section("web");
// Agents kept asking for approval through Paperclip's own mechanism, which the owner never sees (approval cards are the only one).
const APPROVALS_SECTION = section("approvals");
// How the builders build (owner interview, 2026-11-15): nudges, said positively. Builders are the agents with `builder: true`
// (the Architect, the DevOps Engineer, the UI/UX Designer, the UI Reviewer); the runner's Engineers get the section through
// their metadata (`build`) in the job prompt (services/runner/src/prompt.ts).
export const HOW_WE_BUILD_SECTION = section("how-we-build");
// The owning agent checks its app change live, an hour and a day after it deploys (owner, 2026-11-15): for agents that own
// apps and can wake themselves later (app_logs and wake_at).
const appFollowupSection = (a) => (a.enabled_tools?.apps?.includes("app_logs") && a.enabled_tools?.chat_lane?.includes("wake_at") ? section("app-followup", "") : "");

/**
 * The module prompt contributions compile picked for this agent (spec §3.1 `prompts`, after the kernel's sections), verbatim
 * and in compile's order, as [id, text]. `{{fleet_issues}}`: the Fleet issues task; `{{memory}}`: the agent's curated memory.
 * `lane`: only those marked for the fast chat lane.
 */
export function promptParts(cfg, a, { repo, fleetIssues, lane = false }) {
  return (a.prompts ?? []).filter((id) => !lane || cfg.prompts?.[id]?.lane).map((id) => {
    const text = readInside(join(repo, "modules"), cfg.prompts?.[id]?.file, `agent ${a.name}: prompt ${id}`);
    if (text.includes("{{fleet_issues}}") && !fleetIssues) throw new Error(`prompt ${id}: the Fleet issues task is missing`);
    return [id, text.replaceAll("{{fleet_issues}}", fleetIssues).replace("{{memory}}", () => a.memory ?? "")];
  });
}

/** An agent's whole handbook as [id, text] parts, in the order setup writes them. */
export function handbookParts(cfg, key, a, { repo, instanceDir, engines = {}, fleetIssues }) {
  const codex = a.adapter === "codex_local";
  const parts = [
    ["handbook", readInstructions(cfg, a, { repo, instanceDir })],
    ["persona", personaSection(cfg, engines, key, a)],
    ["computer", computerSection(a)],
    ["approvals", codex ? APPROVALS_SECTION : ""],
    ["how-we-build", codex && a.builder === true ? HOW_WE_BUILD_SECTION : ""],
    ["web", !codex ? "" : a.web_search === "disabled" ? WEB_SECTION.replace("You have live web search, `web_view`", "You have `web_view`") : WEB_SECTION],
    ["app-followup", codex ? appFollowupSection(a) : ""],
    ["sources", sourcesSection(a, cfg.mcp_servers ?? {})],
    ...promptParts(cfg, a, { repo, fleetIssues }),
  ];
  return parts.filter(([, text]) => text);
}

/** `compile --sizes`: bytes per handbook part per crew agent, largest handbook first. A local report. */
export function sizesReport(cfg, opts) {
  const rows = Object.entries(cfg.agents ?? {}).filter(([, a]) => a.dispatch !== "runner").map(([key, a]) => {
    const parts = handbookParts(cfg, key, a, { ...opts, fleetIssues: "WOR-0" });
    return { key, total: parts.reduce((n, [, t]) => n + Buffer.byteLength(t), 0), parts };
  }).sort((x, y) => y.total - x.total);
  return rows.map(({ key, total, parts }) => `${key} ${total}\n${parts.map(([id, t]) => `  ${String(Buffer.byteLength(t)).padStart(6)}  ${id}`).join("\n")}`).join("\n");
}
