// The review engines: each takes one task (the prompt and the brief), reads the checkout `root` with `base` as the diff's start,
// and hands back its final message; fan-out, verification, dedupe, ranking and the schema are the recipe's (review.ts), the same
// for every engine. An engine runs in the check box: no credentials but the run's capped model token (OPENROUTER_API_KEY, through
// the gateway at OPENROUTER_BASE_URL), no shell, its only view of the repo the read-only repo tools (review-tools.ts: the head
// tree and the box's own history; nothing runs or connects), and nothing of the PR loaded as its config.
//
// codex: the CI reviewer's own runner and config (code-review.ts, synced from the CI template): shell, hooks, plugins, apps,
//   memories and web search off, an empty cwd, project docs off. Every task is our prompt.
// claude-code: `claude -p` through the gateway's Anthropic-format route (ANTHROPIC_BASE_URL at its /api, the run's token as the
//   bearer), from an empty cwd, user settings only (an empty HOME: no project settings, hooks, skills, MCP or CLAUDE.md of the PR),
//   built-in tools off but Agent, the repo tools as its MCP server. Its finder step is Claude Code's own `/code-review <effort>`
//   over the change, then, in the same session, our finder prompt restates what it found as our JSON; verify and recheck are our
//   prompts.
// codegenie: Polygon's review harness (`codegenie review --format json`) on a worktree of the trusted base (its codegenie.toml and
//   .codegenie/skills are the base branch's, never the PR's) with the head as review data, its OpenRouter calls sent to the gateway
//   by gateway-fetch.ts. It only reviews: its findings are mapped to ours, and the recipe's other prompts (recheck) go to codex on
//   the same model.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config, runCodex } from "./code-review.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
/** Each engine's efforts (what it accepts), and whether it answers our prompts (verify, recheck) or only reviews. */
export const ENGINES: Record<string, { efforts: string[]; asks: boolean }> = {
  codex: { efforts: ["minimal", "low", "medium", "high", "xhigh"], asks: true },
  "claude-code": { efforts: ["low", "medium", "high", "xhigh", "max"], asks: true },
  codegenie: { efforts: ["low", "medium", "high", "xhigh", "max"], asks: false },
};
const MODEL = /^~?[\w.-]+\/[\w.:~-]+$/;

/** One review run's engine, model and effort (JSON from the spec, with the repo's ignore globs and max_nits). */
export interface Combo { engine: string; model: string; effort: string; ignore?: string[]; max_nits?: number }
export interface EngineInput {
  prompt: string; instructions: string; model: string; effort: string; root: string; base: string; minutes?: string | number; scratch: string;
  /** The finder step: an engine with a review of its own runs it, then answers `prompt` from it. */
  own?: boolean;
  /** The merge base (trusted): where an engine that reads repo config takes it from. */
  trusted?: string;
}
/** `calls`: the repo tools a run called, with the arguments code checks coverage by (path, the page `from`, `stat`). */
export interface EngineResult { message: string; read: boolean; calls?: Call[]; cause?: string; incomplete?: string }
export type Call = { tool: string; path?: string; from?: number; stat?: boolean };
/**
 * A tool call's coverage arguments, as code reads them from the call's own input; undefined for one with a wrong-typed
 * argument, which the tools refuse (review-tools argsProblem), so a refused call never counts as a read.
 */
export const callOf = (tool: string, a: Record<string, unknown> | undefined): Call | undefined => {
  const wrong = (a?.path !== undefined && typeof a.path !== "string") || (a?.from !== undefined && !Number.isInteger(a.from)) || (a?.stat !== undefined && typeof a.stat !== "boolean");
  return wrong ? undefined : { tool, ...(typeof a?.path === "string" ? { path: a.path } : {}), ...(Number(a?.from) > 1 ? { from: Number(a!.from) } : {}), ...(a?.stat === true ? { stat: true } : {}) };
};

/** Why a combo can't run, or undefined. */
export function comboProblem(c: Combo | null | undefined) {
  if (!c || typeof c !== "object") return "a combo is an object";
  const e = ENGINES[c.engine];
  if (!e) return `engine is one of ${Object.keys(ENGINES).join(", ")}`;
  if (typeof c.model !== "string" || !MODEL.test(c.model)) return "model is an OpenRouter model id (e.g. ~deepseek/deepseek-flash-latest)";
  if (!e.efforts.includes(c.effort)) return `effort for ${c.engine} is one of ${e.efforts.join(", ")}`;
  return undefined;
}

/** How the recipe runs a combo: codex fans out (2 finders and a verifier past low effort); the others run their own review once. */
export function plan(c: Combo) {
  if (c.engine !== "codex") return { finders: 1, verify: false };
  return ["minimal", "low"].includes(c.effort) ? { finders: 1, verify: false } : { finders: 2, verify: true };
}

/** The engine that answers our prompts for this combo, and at what effort: its own, or codex on the same model (max is its xhigh). */
export function asker(c: Pick<Combo, "engine" | "effort">) {
  if (ENGINES[c.engine]?.asks) return { engine: c.engine, effort: c.effort };
  return { engine: "codex", effort: ENGINES.codex!.efforts.includes(c.effort) ? c.effort : "xhigh" };
}

export async function runEngine(engine: string, i: EngineInput): Promise<EngineResult> {
  if (engine === "codex") return codex(i);
  if (engine === "claude-code") return claudeCode(i);
  if (engine === "codegenie") return codegenie(i);
  throw new Error(`no engine ${engine}`);
}

const gateway = () => String(process.env.OPENROUTER_BASE_URL || "").replace(/\/$/, "");

async function codex({ prompt, instructions, model, effort, root, base, minutes, scratch }: EngineInput): Promise<EngineResult> {
  const tmp = mkdtempSync(join(scratch, "codex-"));
  const home = join(tmp, "home"), cwd = join(tmp, "cwd"); // cwd: empty, not a repository, so codex loads nothing of the repo
  mkdirSync(home);
  mkdirSync(cwd);
  writeFileSync(join(home, "config.toml"), config({ model: String(model).replace(/^openrouter\//, ""), effort, url: gateway(), root, base, instructions }));
  const r = await runCodex({ prompt, home, cwd, out: join(tmp, "answer.txt"), key: process.env.OPENROUTER_API_KEY, minutes });
  const calls = r.events.filter((e) => e?.type === "item.completed" && e.item?.type === "mcp_tool_call" && e.item.status === "completed" && !e.item.error && !e.item.result?.isError)
    .flatMap((e) => callOf(e.item!.tool!, e.item!.arguments) ?? []);
  const done = r.code === 0 && r.events.some((e) => e?.type === "turn.completed");
  const said = r.events.filter((e) => e?.type === "error" || e?.type === "turn.failed").map((e) => e.message ?? e.error?.message ?? "").join(" ");
  const cause = done ? undefined : r.timedOut ? "timed out" : /\b402\b|cap_reached/.test(said + r.stderr) ? "the run's budget ran out" : `the engine stopped (exit ${r.code})`;
  return { message: done ? r.message : "", read: calls.some((c) => c.tool === "diff"), calls, cause };
}

/** A child process to its end (killed at `minutes`): exit code, stdout, the tail of stderr. */
async function run(cmd: string, args: string[], o: { cwd: string; env: Record<string, string>; minutes?: string | number }) {
  const child = spawn(cmd, args, { cwd: o.cwd, env: o.env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "", timedOut = false;
  child.stdout.on("data", (d: Buffer) => (stdout += d));
  child.stderr.on("data", (d: Buffer) => { stderr += d; if (stderr.length > 1e6) stderr = stderr.slice(-5e5); });
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, Number(o.minutes ?? 20) * 60_000);
  const code = await new Promise<number | null>((ok) => { child.on("close", ok); child.on("error", () => ok(null)); });
  clearTimeout(timer);
  return { code, stdout, stderr, timedOut };
}
const stopped = (r: { code: number | null; stderr: string; timedOut: boolean }, said = "") =>
  r.timedOut ? "timed out" : /\b402\b|cap_reached|budget/i.test(said + r.stderr) ? "the run's budget ran out" : `the engine stopped (exit ${r.code})`;

// Claude Code's repo tools are ours (the same read-only MCP server codex gets), named mcp__repo__<tool>.
const REPO_TOOLS = ["diff", "log", "show", "blame", "read_file", "list_files", "search", "definition", "references", "diagnostics"];
type ClaudeEvent = { type?: string; subtype?: string; session_id?: string; result?: string; is_error?: boolean; message?: { content?: { type?: string; name?: string; input?: { path?: unknown } }[] } };

async function claudeCode({ prompt, instructions, model, effort, root, base, minutes, scratch, own }: EngineInput): Promise<EngineResult> {
  const tmp = mkdtempSync(join(scratch, "claude-"));
  const home = join(tmp, "home"), cwd = join(tmp, "cwd");
  mkdirSync(home);
  mkdirSync(cwd);
  const mcp = join(tmp, "mcp.json");
  writeFileSync(mcp, JSON.stringify({ mcpServers: { repo: { command: process.execPath, args: [join(HERE, "review-tools.ts"), root, base] } } }));
  const m = String(model).replace(/^openrouter\//, "");
  const env = {
    PATH: String(process.env.PATH), HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude"),
    // The gateway's Anthropic-format route (/api/v1/messages) with the run's capped token as the bearer; every model id Claude Code
    // might send is the combo's (so every call is priced and capped like the rest).
    ANTHROPIC_BASE_URL: gateway().replace(/\/v1$/, ""), ANTHROPIC_AUTH_TOKEN: String(process.env.OPENROUTER_API_KEY ?? ""), ANTHROPIC_API_KEY: "",
    ANTHROPIC_DEFAULT_OPUS_MODEL: m, ANTHROPIC_DEFAULT_SONNET_MODEL: m, ANTHROPIC_DEFAULT_HAIKU_MODEL: m, CLAUDE_CODE_SUBAGENT_MODEL: m,
    CLAUDE_CODE_ALWAYS_ENABLE_EFFORT: "1", CLAUDE_CODE_EFFORT_LEVEL: effort,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
  };
  const base_args = ["--model", m, "--effort", effort, "--setting-sources", "user", "--strict-mcp-config", "--mcp-config", mcp, "--tools", "Agent",
    "--allowedTools", ["Agent", ...REPO_TOOLS.map((t) => `mcp__repo__${t}`)].join(","), "--append-system-prompt", instructions, "--output-format", "stream-json", "--verbose"];
  const calls: Call[] = [];
  const turn = async (task: string, resume?: string) => {
    const r = await run("claude", ["-p", task, ...base_args, ...(resume ? ["--resume", resume] : [])], { cwd, env, minutes });
    const events: ClaudeEvent[] = r.stdout.split("\n").map((l) => { try { return JSON.parse(l); } catch { return undefined; } }).filter(Boolean);
    for (const e of events) for (const c of e.type === "assistant" ? e.message?.content ?? [] : []) {
      const t = c.type === "tool_use" && /^mcp__repo__(\w+)$/.exec(String(c.name))?.[1];
      const call = t ? callOf(t, c.input) : undefined;
      if (call) calls.push(call);
    }
    const end = events.findLast((e) => e.type === "result");
    return { r, end, ok: r.code === 0 && end?.subtype === "success" && !end.is_error };
  };
  let session: string | undefined;
  if (own) {
    // Claude Code's own review of the change (base..HEAD in the box's history), its findings then restated as our JSON.
    const first = await turn(`/code-review ${effort} ${base}..HEAD --max-findings all`);
    if (!first.ok) return { message: "", read: false, calls, cause: stopped(first.r, first.end?.result ?? "") };
    session = first.end?.session_id;
    prompt = `Now restate every finding of that review, and only those, in this shape. Check each one's line in the file at the head with the repo tools first.\n${prompt}`;
  }
  const last = await turn(prompt, session);
  if (!last.ok) return { message: "", read: calls.some((c) => c.tool === "diff"), calls, cause: stopped(last.r, last.end?.result ?? "") };
  return { message: String(last.end?.result ?? ""), read: calls.some((c) => c.tool === "diff"), calls };
}

/** codegenie's JSON review (its ReviewResult), as far as the mapping reads it. */
type GenieFinding = { title?: string; severity?: string; path?: string; anchor?: { line?: number }; publication?: string; failureMode?: string; whyThisMatters?: string; evidence?: { changedCode?: string }; suggestedFix?: string };
type GenieReview = { findings?: GenieFinding[]; summaryOnlyFindings?: GenieFinding[]; coverage?: { totalHunks?: number; reviewedHunks?: number }; budgetSummary?: { completeness?: string; partialReasons?: unknown[] } };
const GENIE_SEVERITY: Record<string, string> = { critical: "important", high: "important", medium: "important", low: "nit" };
const DEPTH: Record<string, string> = { low: "light", medium: "normal", high: "normal", xhigh: "deep", max: "deep" };
// Its reasoning level: codegenie's own normalization (its CLI's aliases) of our effort, since codegenie refuses a level the model
// doesn't list (DeepSeek Flash lists low, high and max: medium was refused as a config error). The effort's depth is DEPTH's.
const REASONING: Record<string, string> = { low: "low", medium: "high", high: "high", xhigh: "max", max: "max" };

/** codegenie's review as our finder JSON: its published findings (inline or summary-only), its severity mapped to ours. */
export function genieFindings(v: GenieReview) {
  return [...(v.findings ?? []), ...(v.summaryOnlyFindings ?? [])].filter((f) => f.publication !== "suppressed" && typeof f.path === "string" && Number.isInteger(f.anchor?.line)).map((f) => ({
    severity: GENIE_SEVERITY[String(f.severity)] ?? "nit", path: f.path, line: f.anchor!.line, title: String(f.title ?? ""),
    why: [f.failureMode, f.whyThisMatters].filter(Boolean).join("\n\n"), evidence: String(f.evidence?.changedCode ?? ""), fix_brief: String(f.suggestedFix ?? ""),
  }));
}

async function codegenie({ model, effort, root, base, minutes, scratch, own, trusted }: EngineInput): Promise<EngineResult> {
  if (!own) throw new Error("codegenie only reviews");
  const tmp = mkdtempSync(join(scratch, "codegenie-"));
  const home = join(tmp, "home");
  mkdirSync(home);
  // Its working tree is the trusted base (codegenie reads codegenie.toml and .codegenie/skills from it); the head is review data.
  const tree = join(tmp, "base");
  const git = (a: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...a], { cwd: root, env: { PATH: String(process.env.PATH), HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, encoding: "utf8" }).trim();
  const head = git(["rev-parse", "HEAD"]);
  git(["worktree", "add", "--detach", "-q", tree, trusted ?? base]);
  const r = await run("codegenie", ["review", "--base", base, "--head", head, "--provider", "openrouter", "--model", String(model).replace(/^openrouter\//, ""), "--reasoning", REASONING[effort] ?? effort,
    "--depth", DEPTH[effort] ?? "normal", "--max-time", String(Math.max(1, Number(minutes ?? 20) - 2)), "--format", "json", "--no-progress", "--ci", "--no-cache"], {
    cwd: tree, minutes,
    env: { PATH: String(process.env.PATH), HOME: home, OPENROUTER_API_KEY: String(process.env.OPENROUTER_API_KEY ?? ""), CODEGENIE_GATEWAY: gateway(), NODE_OPTIONS: `--import=${join(HERE, "gateway-fetch.ts")}` },
  });
  let v: GenieReview | undefined;
  try { v = JSON.parse(r.stdout); } catch {}
  if (r.code !== 0 || !v || !Array.isArray(v.findings)) return { message: "", read: false, cause: stopped(r) };
  const b = v.budgetSummary, cov = v.coverage;
  const partial = b?.completeness && b.completeness !== "complete" ? `codegenie's review was ${b.completeness}` : cov?.totalHunks && (cov.reviewedHunks ?? 0) < cov.totalHunks ? `codegenie reviewed ${cov.reviewedHunks ?? 0} of ${cov.totalHunks} hunks` : undefined;
  // It read the change when it reviewed any of it (its coverage), or the change was empty.
  return { message: JSON.stringify({ findings: genieFindings(v), stale_guidance: [] }), read: !cov?.totalHunks || (cov.reviewedHunks ?? 0) > 0, ...(partial ? { incomplete: partial } : {}) };
}
