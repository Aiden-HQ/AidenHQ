// The exact push/pr commands, repository names, and which Engineer and engine a task runs on (engine kinds from the compiled
// registry, config/engines.json: `useEngines`). Pure functions (unit-tested): no I/O here.

export const RUNNER_MARKER = "<!-- aidenhq-runner -->";

/** Whether a comment carries one of our markers. */
export const hasMarker = (body, marker) => String(body ?? "").includes(marker);

/** A message relayed from chat by the Chief of Staff. */
export const RELAY_MARKER = "<!-- aidenhq-relay -->";

/** The board's marks: a message on the user's task for other agents only, and where a delivered one came from. */
export const FOR_OTHERS = "<!-- aidenhq-for-others -->";

/** The chat a message delivered from another one came from: the task's identifier. */
export function deliveredFrom(body) {
  return /<!-- aidenhq-from:([A-Z][A-Z0-9]*-\d+)(?::[0-9a-f-]{36})? -->/.exec(String(body ?? ""))?.[1];
}

// Publishing to GitHub is the one irreversible action, so it takes the exact word. Everything
// else in a comment, including stop/status/reset/cleanup, is read by the intake (intake.mjs).
const COMMANDS = new Map([
  ["push", "push"],
  ["pr", "pr"],
  ["draft pr", "pr"],
  ["open pr", "pr"],
]);

/** Remove HTML comments: hidden text never counts as the user's words. */
export const stripHidden = (s) => String(s ?? "").replace(/<!--[\s\S]*?-->/g, "");

/**
 * Remove a description's copies of a grade's rubric: each `Graded before done (…)` line and the numbered criteria under
 * it. A removed block is rubric material, not the request: the row's own rubric is the only criteria list the grader
 * answers (grade.ts), so extra criteria lines in the task's words must not reach the model as if they were criteria.
 */
export const stripRubric = (s) => {
  const text = String(s ?? "");
  const heading = /^[ \t]*Graded before done \([^)]*\):/;
  const criterion = /^[ \t]*\d+\.[ \t]/;
  const blank = /^[ \t]*$/;
  const kept = [];
  const lines = text.split("\n");
  let removed = false;
  for (let i = 0; i < lines.length; i++) {
    if (!heading.test(lines[i])) {
      kept.push(lines[i]);
      continue;
    }
    removed = true;
    // The heading and every criterion line after it; blank lines only when another criterion follows, so the request's
    // own text after the block stays as it was.
    while (i + 1 < lines.length) {
      if (criterion.test(lines[i + 1])) {
        i++;
        continue;
      }
      let k = i + 1;
      while (k < lines.length && blank.test(lines[k])) k++;
      if (k > i + 1 && k < lines.length && criterion.test(lines[k])) {
        i = k - 1;
        continue;
      }
      break;
    }
  }
  return removed ? kept.join("\n").replace(/\n{3,}/g, "\n\n").trim() : text;
};

/** "push" or "pr" when the whole comment is exactly that word; otherwise undefined. */
export function parseCommand(body) {
  // Only a message the Chief of Staff relayed from chat (relay marker and its "Written in chat" line) may be a command.
  // Other delivered messages carry a note line, so they never match.
  const raw = String(body ?? "");
  const text = hasMarker(raw, RELAY_MARKER) ? stripHidden(raw).replace(/\n\n_Written in chat on [A-Z][A-Z0-9]*-\d+\._\s*$/, "") : stripHidden(raw);
  return COMMANDS.get(text.trim().toLowerCase().replace(/[.!]+$/, ""));
}


export function repoAllowed(repo, allowedOrgs) {
  return Boolean(repo) && allowedOrgs.some((o) => o.toLowerCase() === repo.org.toLowerCase());
}

/** Find allowlisted repositories mentioned in free text (URLs or org/repo tokens). */
export function findRepos(text, allowedOrgs) {
  return mentionedRepos(text).filter((r) => repoAllowed(r, allowedOrgs));
}

/**
 * Every org/repo token in free text, in any org. Many aren't repositories at all ("DA/L1"), so
 * ones outside the allowed orgs only count once GitHub confirms them as public (`publicRepo`).
 */
export function mentionedRepos(text) {
  const found = new Map();
  // Dots belong to names (acme/widget.js); one only ends a name at the end of a sentence
  // ("see org/repo."). A match never starts inside another token (".js/pull" in a URL).
  const re = /(?:https?:\/\/github\.com\/|git@github\.com:|(?<![\w.\/@:-]))([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?=[\s/#?)\]>,;:'"`]|\.(?:[\s)\]>,;:'"`]|$)|$)/g;
  for (const m of String(text ?? "").matchAll(re)) {
    if (/^\.+$/.test(m[1]) || /^\.+$/.test(m[2])) continue;
    // An all-digit name is a Projects board or issue number ("acme/28"), not a repository.
    if (/^\d+$/.test(m[2])) continue;
    const repo = { org: m[1], name: m[2], slug: `${m[1]}/${m[2]}` };
    if (!found.has(repo.slug.toLowerCase())) found.set(repo.slug.toLowerCase(), repo);
  }
  return [...found.values()];
}

/**
 * Resolve the engine for a job: `engines.default` in the config (codex if unset), `engine: claude` (Claude Code),
 * `engine: openrouter` / `glm` (configured default OpenRouter model), `engine: openrouter:<model>`,
 * or a bare OpenRouter model id like `z-ai/glm-5.3`. A Claude model name alone (`model: opus`)
 * picks Claude Code.
 */
export function resolveEngine(directives, cfg, previous) {
  const raw = (directives.engine ?? "").trim().toLowerCase();
  const model = directives.model?.trim();
  if (!raw && !model) return previous ?? resolveEngine({ engine: cfg.engines.default ?? "codex" }, cfg); // engines.default: the engine with an Engineer
  if (raw === "codex") return { kind: "codex", model: model || cfg.engines.codex.model || undefined };
  if (["claude", "claude-code", "claude code", "anthropic"].includes(raw)) return { kind: "claude", model: model || cfg.engines.claude?.model || undefined };
  // OpenRouter models run on Codex through the gateway (codex-openrouter); `opencode` names the fallback engine.
  if (raw === "opencode") return { kind: "openrouter", model: model || cfg.engines.openrouter.model };
  if (raw === "glm" || raw === "openrouter" || raw === "codex-openrouter") return { kind: "codex-openrouter", model: model || cfg.engines["codex-openrouter"]?.model || cfg.engines.openrouter.model };
  if (raw.startsWith("openrouter:")) return { kind: "codex-openrouter", model: directives.engine.trim().slice("openrouter:".length) };
  if (raw.includes("/")) return { kind: "codex-openrouter", model: directives.engine.trim() };
  if (!raw && isClaudeModel(model)) return { kind: "claude", model };
  if (!raw && model) return { kind: previous?.kind === "claude" ? "codex" : previous?.kind ?? "codex", model };
  if (ENGINES_REG[raw]) return { kind: raw, model: model || defaultModel(raw, cfg) }; // any other kind a module provides
  throw new Error(`unknown engine "${directives.engine}" (use codex, codex-openrouter, claude, openrouter, or openrouter:<model>)`);
}

// The engine registry (config/engines.json), set once by the runner at start and by tests.
let ENGINES_REG = {};
export const useEngines = (reg) => void (ENGINES_REG = reg ?? {});
/** The engine kinds the enabled modules provide. */
export const engineKinds = () => Object.keys(ENGINES_REG);
// The Engineer agents' engine: the one setup recorded (module.yaml `engine:`), else the kind that names its Paperclip adapter.
export const engineOf = (agent) => (ENGINES_REG[agent?.metadata?.engine] ? agent.metadata.engine : agent?.adapterType ? Object.keys(ENGINES_REG).find((k) => ENGINES_REG[k].adapter === agent.adapterType) : undefined);
/** The prefix a kind's Paperclip model ids carry (e.g. a router's), or "" when they are plain model names. */
export const modelPrefix = (kind) => ENGINES_REG[kind]?.model_prefix ?? "";
/** Where a kind's effort override is stored in the adapter config. */
const effortKey = (kind) => ENGINES_REG[kind]?.effort_key;
// A kind's default model: config/runner.yaml engines.<kind>.model; a router kind without one takes the router's.
const defaultModel = (kind, cfg) => cfg.engines?.[kind]?.model || (modelPrefix(kind) ? cfg.engines?.openrouter?.model : undefined) || undefined;
const EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh", "max"]);
/** How the board names a run's engine: the kind's label ("{model}" filled in), with the model and effort. */
export function engineLabel(e) {
  const label = ENGINES_REG[e.kind]?.label ?? e.kind;
  if (label.includes("{model}")) return label.replace("{model}", e.model ?? "");
  const details = [e.model, e.effort && `${e.effort} effort`].filter(Boolean).join(", ");
  return `${label}${details ? ` (${details})` : ""}`;
}

/**
 * The executor picked on the task in Paperclip: the Engineer agent it's assigned to sets the engine;
 * the task's model override, else the agent's primary model, else config/runner.yaml sets the model.
 * Undefined when the task isn't assigned to an Engineer.
 */
export function pickedEngine(issue, engineers, cfg) {
  const agent = engineers.find((a) => a.id === issue?.assigneeAgentId);
  const kind = engineOf(agent);
  if (!kind) return undefined;
  const override = issue.assigneeAdapterOverrides?.adapterConfig ?? {};
  const primary = agent.adapterConfig ?? {};
  // opencode ids are provider/model; only OpenRouter models are runnable here.
  const prefix = modelPrefix(kind);
  const usable = (m) => {
    const v = typeof m === "string" ? m.trim() : "";
    if (!prefix) return v;
    return v.startsWith(prefix) ? v.slice(prefix.length) : "";
  };
  const fallback = defaultModel(kind, cfg);
  const model = usable(override.model) || usable(primary.model) || fallback || undefined;
  const key = effortKey(kind);
  const effort = key ? String(override[key] ?? primary[key] ?? "").trim().toLowerCase() : "";
  // Private reads come with the Engineer (module.yaml `private_reads: true`), never with an engine or a task.
  // A box Engineer (module.yaml `image:` on a runner agent, setup's metadata.box) runs its jobs in an agent computer (engines.mjs boxCommand).
  return { kind, model, ...(EFFORTS.has(effort) ? { effort } : {}), ...(agent.metadata?.privateReads === true ? { reads: true } : {}), ...(agent.metadata?.box === true && kind === "codex-openrouter" ? { box: true } : {}) };
}

/**
 * The Paperclip fields that show `engine` as the task's picker: the matching Engineer as assignee,
 * and a model override unless the model is that Engineer's primary model. Undefined if no Engineer runs it.
 */
// A specialised Engineer (its own brief: the App Engineer, the Platform Engineer) runs only what is assigned to it: never
// picked, or borrowed as a persona, by its engine kind. Whether its jobs run in a computer doesn't matter here.
export const generalEngineers = (engineers) => engineers.filter((a) => !a.metadata?.brief);
const byKind = generalEngineers;

export function pickerFor(engine, engineers) {
  const agent = byKind(engineers).find((a) => engineOf(a) === engine.kind);
  if (!agent) return undefined;
  const model = engine.model ? `${modelPrefix(engine.kind)}${engine.model}` : engine.model;
  const config = { ...(model && model !== agent.adapterConfig?.model ? { model } : {}), ...(engine.effort && effortKey(engine.kind) ? { [effortKey(engine.kind)]: engine.effort } : {}) };
  return { assigneeAgentId: agent.id, assigneeAdapterOverrides: Object.keys(config).length ? { adapterConfig: config } : null };
}

/** The router models offered for the first Engineer on a router engine (config/paperclip.yaml `models`), primary first. */
export function openrouterModels(engineers) {
  const agent = byKind(engineers).find((a) => modelPrefix(engineOf(a)));
  const prefix = modelPrefix(engineOf(agent));
  const ids = [agent?.adapterConfig?.model, ...(Array.isArray(agent?.metadata?.models) ? agent.metadata.models : [])];
  return [...new Set(ids.filter((m) => typeof m === "string" && prefix && m.startsWith(prefix)).map((m) => m.slice(prefix.length)))];
}

/** The Engineer's board identity for an engine: name and voice, when setup gave it one. */
export function personaFor(kind, engineers, assigned) {
  // A specialised Engineer is its own persona; the others share one per engine.
  const p = (assigned?.metadata?.brief ? assigned : byKind(engineers).find((a) => engineOf(a) === kind))?.metadata?.persona;
  return typeof p?.name === "string" && p.name ? { name: p.name, voice: typeof p.voice === "string" ? p.voice : "" } : undefined;
}

/** The Engineers' names and the engines they stand for ("Ada" → claude), for the intake. */
export function crewNames(engineers) {
  return engineers.flatMap((a) => {
    const engine = engineOf(a);
    const name = a.metadata?.persona?.name;
    return engine && typeof name === "string" && name ? [{ name, engine }] : [];
  });
}

/** Claude Code model names: the aliases (opus, sonnet, haiku, fable) or a full `claude-…` id. */
export function isClaudeModel(model) {
  return /^(opus|sonnet|haiku|fable|claude-[a-z0-9.-]+)(\[1m\])?$/i.test(String(model ?? "").trim());
}

/**
 * The request in a task's description, when the user wrote the task themselves: created with
 * their own key, by no agent, and without the source marker that AidenHQ's generated tasks
 * carry. Descriptions of generated tasks hold Slack/email text and stay untrusted context.
 */
export function ownRequest(issue) {
  const text = String(issue?.description ?? "");
  if (!issue?.createdByUserId || issue.createdByAgentId || /<!--\s*source:/.test(text)) return "";
  return stripHidden(text).trim();
}

/** A part of the user's task they gave an Engineer themselves: their own request, no go-ahead needed. */
export function isUserPart(issue, engineers) {
  return Boolean(issue?.parentId && issue.createdByUserId && !issue.createdByAgentId && engineers.some((e) => e.id === issue.assigneeAgentId));
}

/**
 * A sub-task an agent (the Researcher) created for an Engineer under one of the user's tasks. Its
 * description is agent-written, so it waits for the user's go-ahead before it is the request.
 */
export function isAgentSubtask(issue) {
  return Boolean(issue?.parentId && issue.createdByAgentId && !issue.createdByUserId);
}

/**
 * A task left in progress with a check still ahead (Paperclip's `executionPolicy.monitor.nextCheckAt`): the run settled
 * into that wait, so the task keeps its status and Paperclip wakes it at that time. The time, or undefined.
 */
export function settledWait(issue, now = Date.now()) {
  if (issue?.status !== "in_progress") return undefined;
  const at = issue?.executionPolicy?.monitor?.nextCheckAt;
  const t = typeof at === "string" ? Date.parse(at) : NaN;
  return Number.isFinite(t) && t > now ? new Date(t).toISOString() : undefined;
}

/**
 * Where a finished queue leaves its task: an agent's sub-task whose PRs all merged, with no other open PR of its own
 * (openPrUrls: the task's PRs not known merged), is done; the delegating agent hears it on the parent. The owner's own
 * tasks, a queue that stopped, and a task with another PR still open stay in review.
 */
export function finishedStatus(issue, queue, openPrUrls = []) {
  const left = openPrUrls.filter((u) => !queue.prs.some((p) => p.url.toLowerCase() === String(u).toLowerCase()));
  return queue.state === "done" && !left.length && isAgentSubtask(issue) ? "done" : "in_review";
}

/**
 * Whether an agent's Engineer sub-task runs without the owner's go-ahead: one delegated from a chat, or under a task an
 * agent or routine created (an app incident). A routine's run is its own root even when started by hand (the run's task
 * then carries the owner as creator): its request is the routine's prompt, from config. `chain`: the sub-task, then each
 * parent up to the root (null: one that couldn't be read).
 */
export function runsUnasked(chain) {
  const [full] = chain;
  const root = chain.at(-1);
  if (!isAgentSubtask(full) || chain.length < 2 || chain.includes(null) || root.parentId) return false;
  return Boolean(root.labels?.some((l) => l.name === "chat") || !root.createdByUserId || root.originKind === "routine_execution");
}

/**
 * A rule or access proposal, Coach finding, product bug or Dependabot sweep an agent filed straight to the Platform Engineer
 * (`task_create`, marker `rule:` / `coach:` / `product-bug:` / `dependabot:`; the
 * Librarian's `task_propose_rule` wraps it as `delegate:<parent>:rule:...`). It runs without the owner's go-ahead: its only
 * output is a fleet apply card, which the AI reviewer or the owner still decides (the runner pushes and merges nothing without
 * one). Three checks, none of them typeable in free text: the marker is the tool's own last line (the tools strip `<!--` from
 * what agents write, so it can't appear mid-description), the assignee is the Platform Engineer, and the creator is an agent
 * whose grants (the host's table, not Paperclip metadata) let it file tasks.
 */
export function isRuleProposal(issue, grants) {
  const filer = grants?.agents?.[issue?.createdByAgentId]?.tools?.paperclip_tasks ?? [];
  return Boolean(
    issue?.createdByAgentId && !issue.createdByUserId &&
    grants?.agents?.[issue.assigneeAgentId]?.key === "fleet-engineer" &&
    (filer.includes("task_create") || filer.includes("task_propose_rule")) &&
    /\n<!--\s*source:(?:delegate:[^:\s]+:)?(?:rule|coach|product-bug|dependabot):[A-Za-z0-9:._\/-]+\s*-->\s*$/.test(String(issue.description ?? "")),
  );
}
