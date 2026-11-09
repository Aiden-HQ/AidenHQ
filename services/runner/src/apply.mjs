// What `aidenhq apply` may land: the instance repo's config only (instance.yaml, apps.yaml, handbook additions).
// Product code and module handbooks change through Engineer PRs; the instance pins the product (`product: <sha>`), so
// upgrading the product is itself an instance change that the owner sees with its commit log.
import YAML from "yaml";
import { git } from "./git.mjs";

// Agents the instance defines itself live in agents/<key>/ (agent.yaml + AGENTS.md).
export const APPLY_PATHS = /^(instance\.yaml|apps\.yaml|agents\/[\w.-]+\.md|agents\/[a-z0-9][a-z0-9-]*\/(agent\.yaml|AGENTS\.md))$/;

/** Files a change touches outside what apply may land. */
export const strayFiles = (files) => files.filter((f) => !APPLY_PATHS.test(f));

const HANDBOOK = /^agents\/([a-z0-9][a-z0-9-]*)\/AGENTS\.md$/;
const DEFINITION = /^agents\/([a-z0-9][a-z0-9-]*)\/agent\.yaml$/;
/** An agent.yaml that puts its agent in trial (a top-level `trial: true`). */
export function isTrial(text) {
  try {
    return text != null && YAML.parse(String(text))?.trial === true;
  } catch {
    return false;
  }
}
/** The agent.yaml paths whose content the two checks below need, at the merge base and at the change. */
export const definitionsOf = (files) => [...new Set(files.map((f) => HANDBOOK.exec(f)?.[1] ?? DEFINITION.exec(f)?.[1]).filter(Boolean))].map((k) => `agents/${k}/agent.yaml`);

/**
 * Agents a change adds that don't start in trial. A new agent always starts read-only ("draft, don't do"), so tap 1 is
 * safe to approve; its write grants come with tap 2, a change to an agent that already exists. `base`/`head`: path → text
 * (undefined when the file isn't there).
 */
export const untrialedNewAgents = (files, base, head) =>
  files.filter((f) => DEFINITION.test(f) && base[f] === undefined && head[f] !== undefined && !isTrial(head[f])).map((f) => DEFINITION.exec(f)[1]);

/**
 * The trial exception: a change that only edits the handbooks of agents in trial lands without a
 * tap. In trial means at the merge base (main as it was), not on the branch, and the definition isn't in the change.
 */
export const trialHandbookOnly = (files, base) =>
  files.length > 0 && files.every((f) => HANDBOOK.test(f) && isTrial(base[`agents/${HANDBOOK.exec(f)[1]}/agent.yaml`]));

/**
 * The graduation card's list of what changed without a tap: when the change flips an agent from trial to not-trial,
 * the handbook-only commits on main touching its AGENTS.md since the commit that added its agent.yaml (tap 1), up to the
 * change's merge base. Built from git by the runner, never from agent-written text. "" when nothing graduates.
 */
export async function trialEditsText(repoPath, base, files, texts) {
  const out = [];
  for (const def of definitionsOf(files)) {
    if (!isTrial(texts.base[def]) || texts.head[def] === undefined || isTrial(texts.head[def])) continue;
    const key = def.split("/")[1];
    const book = `agents/${key}/AGENTS.md`;
    const added = (await git(repoPath, "log", "--diff-filter=A", "--format=%H", base, "--", def)).split("\n").filter(Boolean).pop();
    if (!added) continue;
    const edits = [];
    for (const sha of (await git(repoPath, "log", "--first-parent", "--format=%H", `${added}..${base}`, "--", book)).split("\n").filter(Boolean)) {
      const [date, short, ...subject] = (await git(repoPath, "log", "-1", "--format=%as%x09%h%x09%s", sha)).split("\t");
      const diff = (mode, ...paths) => git(repoPath, "diff", "--no-renames", mode, `${sha}^1`, sha, ...paths);
      const [num] = (await diff("--numstat", "--", book)).split("\n").map((l) => l.split("\t"));
      const others = (await diff("--name-only")).split("\n").filter((f) => f && f !== book);
      const subj = subject.join(" ").replace(/[\x00-\x1f\x7f]/g, "").slice(0, 100);
      edits.push(`${short}  ${date}  ${subj}  (+${num?.[0] ?? 0} -${num?.[1] ?? 0})${others.length ? `  also changed: ${others.slice(0, 5).join(", ")}${others.length > 5 ? ` +${others.length - 5} more` : ""}` : ""}`);
    }
    out.push(`${key}: ${edits.length ? `${edits.length} handbook change${edits.length === 1 ? "" : "s"} since the trial began (those not marked "also changed" landed without a tap):\n${edits.join("\n")}` : "no handbook changes since the trial began."}`);
  }
  return out.length ? `Trial edits that landed without a tap:\n${out.join("\n")}` : "";
}

/**
 * Who may use the trial exception: a task the owner created, or one the Agent Architect created (its follow-ups included), by
 * the `architect` role in the host's grants table (never Paperclip metadata, which agents can edit). Any other agent's
 * task gets a card. No grants table: a card (fail closed).
 */
const isArchitect = (grants, agentId) => Boolean(agentId) && (grants?.agents?.[agentId]?.roles ?? []).includes("architect");

/** The delegating agent's follow-ups on its task: always the Architect's; any delegator's on a task that runs without the owner's go-ahead (`approved`). */
export const architectFollowUps = (comments, delegatorId, grants, { approved = false } = {}) =>
  delegatorId && (approved || isArchitect(grants, delegatorId)) ? comments.filter((c) => c.authorAgentId === delegatorId) : [];

export function trialNoTapBy(issue, grants) {
  if (issue?.createdByAgentId) return isArchitect(grants, issue.createdByAgentId);
  return Boolean(issue?.createdByUserId);
}

/** instance.yaml's top-level `product:` pin (a full sha), or undefined. */
export function productPin(text) {
  return /^product:[ \t]*["']?([0-9a-f]{40})["']?[ \t]*(?:#.*)?$/m.exec(String(text ?? ""))?.[1];
}

/**
 * How a `product:` move reads to the owner: an upgrade adds commits, a rollback removes them (and says so). undefined when
 * neither pin is an ancestor of the other (diverged): that move is refused.
 */
export function bumpTitle({ from, to, forward, back }) {
  const s = (x) => `\`${x.slice(0, 9)}\``;
  if (!from) return `Product pinned at ${s(to)}`;
  if (forward) return `Product upgrade ${s(from)} → ${s(to)}, adding these commits`;
  if (back) return `Product DOWNGRADE (rollback) ${s(from)} → ${s(to)}, removing these commits`;
}

// `node apply.mjs product-pin <instance.yaml>`: the pin, for ops/apply-config.sh (one parser for both).
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href && process.argv[2] === "product-pin") {
  const { readFileSync } = await import("node:fs");
  process.stdout.write(productPin(readFileSync(process.argv[3], "utf8")) ?? "");
}
