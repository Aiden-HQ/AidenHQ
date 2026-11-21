// The review engines: each takes one task (the prompt and the brief), reads the checkout `root` with `base` as the diff's start,
// and hands back its final message; fan-out, verification, dedupe, ranking and the schema are the recipe's (review.ts), the same
// for every engine. An engine runs in the check box with no credentials but the run's capped model token (OPENROUTER_API_KEY,
// through the gateway at OPENROUTER_BASE_URL), and nothing of the PR loaded as its config.
//
// One access policy for every engine that runs commands (owner, 2026-11-21: "same settings across all reviewers"): a shell that
// reads the repo and the system and runs read-only commands, with the network open; it writes nowhere but the engine's own
// per-run temp directory, and inherits no credential (codex: shell_environment_policy; Claude Code: its subprocess env scrub).
// Verdicts come only from what the shell can't write: the engine's stdout stream, or its session files outside the writable
// area. Every result is scrubbed of the token and key-shaped text (review.ts scrub). codex and codex-native get it from codex's
// own sandbox (a read-only permission profile with network on: no network namespace, which gVisor can't set up), claude-code
// from Claude Code's sandbox (bubblewrap, read-only but its empty cwd, no network restriction).
//
// codex: our prompts through `codex exec` from an empty cwd, the repo tools (review-tools.ts) as its MCP server and the shell.
// claude-code: `claude -p` through the gateway's Anthropic-format route (ANTHROPIC_BASE_URL at its /api, the run's token as the
//   bearer), from an empty cwd, user settings only (an empty HOME: no project settings, hooks, skills, MCP or CLAUDE.md of the PR),
//   built-in tools off but Agent and Bash, the repo tools as its MCP server. Its finder step is Claude Code's own
//   `/code-review <effort>` over the change, then, in the same session, our finder prompt restates what it found as our JSON;
//   verify and recheck are our prompts.
// codegenie: Polygon's review harness (`codegenie review --format json`) on a worktree of the trusted base (its codegenie.toml and
//   .codegenie/skills are the base branch's, never the PR's) with the head as review data, its OpenRouter calls sent to the gateway
//   by gateway-fetch.ts. It only reviews: its findings are mapped to ours, and the recipe's other prompts (recheck) go to codex on
//   the same model.
// codex-native: OpenAI's built-in reviewer, `codex exec review --base <base>` (its own prompt; the brief as its developer
//   instructions), in the box's checkout (review.ts history: base, head). It reads the change with git through the shell; its
//   review (the session's ExitedReviewMode, which the shell can't write) is mapped to ours. It doesn't use our repo tools, so which
//   parts of the change it read isn't tracked (said as incomplete). Recheck goes to codex.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
/** Each engine's efforts (what it accepts), and whether it answers our prompts (verify, recheck) or only reviews. */
export const ENGINES: Record<string, { efforts: string[]; asks: boolean }> = {
  codex: { efforts: ["minimal", "low", "medium", "high", "xhigh"], asks: true },
  "claude-code": { efforts: ["low", "medium", "high", "xhigh", "max"], asks: true },
  codegenie: { efforts: ["low", "medium", "high", "xhigh", "max"], asks: false },
  "codex-native": { efforts: ["minimal", "low", "medium", "high", "xhigh"], asks: false },
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
  if (engine === "codex-native") return codexNative(i);
  throw new Error(`no engine ${engine}`);
}

const gateway = () => String(process.env.OPENROUTER_BASE_URL || "").replace(/\/$/, "");

async function codex({ prompt, instructions, model, effort, root, base, minutes, scratch }: EngineInput): Promise<EngineResult> {
  const tmp = mkdtempSync(join(scratch, "codex-"));
  const home = join(tmp, "home"), cwd = join(tmp, "cwd"); // cwd: empty, not a repository, so codex loads nothing of the repo
  mkdirSync(home);
  mkdirSync(cwd);
  writeFileSync(join(home, "config.toml"), codexConfig({ model: String(model).replace(/^openrouter\//, ""), effort, url: gateway(), instructions, repo: { root, base } }));
  const out = join(tmp, "answer.txt");
  const r = await run("codex", ["exec", "--skip-git-repo-check", "--ignore-rules", "--json", "-o", out, prompt], { cwd, minutes, env: codexEnv(home) });
  const events: CodexEvent[] = r.stdout.split("\n").map((l) => { try { return JSON.parse(l); } catch { return undefined; } }).filter(Boolean);
  const calls = events.filter((e) => e?.type === "item.completed" && e.item?.type === "mcp_tool_call" && e.item.status === "completed" && !e.item.error && !e.item.result?.isError)
    .flatMap((e) => callOf(e.item!.tool!, e.item!.arguments) ?? []);
  const done = r.code === 0 && events.some((e) => e?.type === "turn.completed");
  const said = events.filter((e) => e?.type === "error" || e?.type === "turn.failed").map((e) => e.message ?? e.error?.message ?? "").join(" ");
  let message = "";
  try { message = readFileSync(out, "utf8"); } catch {}
  return { message: done ? message : "", read: calls.some((c) => c.tool === "diff"), calls, cause: done ? undefined : stopped(r, said) };
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
type CodexEvent = { type?: string; message?: string; error?: { message?: string }; item?: { type?: string; tool?: string; status?: string; error?: unknown; result?: { isError?: boolean }; arguments?: Record<string, unknown>; aggregated_output?: string } };
type ClaudeEvent = { type?: string; subtype?: string; session_id?: string; result?: string; is_error?: boolean; message?: { content?: { type?: string; name?: string; input?: { path?: unknown } }[] } };

async function claudeCode({ prompt, instructions, model, effort, root, base, minutes, scratch, own }: EngineInput): Promise<EngineResult> {
  const tmp = mkdtempSync(join(scratch, "claude-"));
  const home = join(tmp, "home"), cwd = join(tmp, "cwd");
  mkdirSync(home);
  mkdirSync(cwd);
  // Claude Code's sandbox for its Bash (the access policy above): read-only everywhere but its empty cwd, no network restriction
  // (none set, so no network namespace), never run outside it.
  mkdirSync(join(home, ".claude"));
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ sandbox: { enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false } }));
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
    CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1", // its Bash never sees the token
  };
  const base_args = ["--model", m, "--effort", effort, "--setting-sources", "user", "--strict-mcp-config", "--mcp-config", mcp, "--tools", "Agent,Bash",
    "--allowedTools", ["Agent", "Bash", ...REPO_TOOLS.map((t) => `mcp__repo__${t}`)].join(","), "--append-system-prompt", instructions, "--output-format", "stream-json", "--verbose"];
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

/** codex review's own output (its ReviewOutputEvent), as far as the mapping reads it. */
type NativeFinding = { title?: string; body?: string; priority?: number; code_location?: { absolute_file_path?: string; line_range?: { start?: number; end?: number } } };
export type NativeReview = { findings?: NativeFinding[]; overall_correctness?: string; overall_explanation?: string };

/** The review in codex's session rollouts (JSONL): the last ExitedReviewMode item's output, or undefined. */
export function nativeReview(rollouts: string[]): NativeReview | undefined {
  let found: NativeReview | undefined;
  for (const text of rollouts) for (const l of text.split("\n")) {
    if (!l.includes("ExitedReviewMode")) continue;
    try { const e = JSON.parse(l); if (e?.payload?.item?.type === "ExitedReviewMode" && e.payload.item.review_output) found = e.payload.item.review_output; } catch {}
  }
  return found;
}

/** codex review's findings as our finder JSON: P0-P2 important, P3 (or none) a nit; its absolute paths made relative to `roots`. */
export function nativeFindings(v: NativeReview, roots: string[]) {
  return (v.findings ?? []).flatMap((f) => {
    const p = f.code_location?.absolute_file_path, start = f.code_location?.line_range?.start, end = f.code_location?.line_range?.end;
    if (typeof p !== "string" || !Number.isInteger(start)) return [];
    const root = roots.find((r) => p.startsWith(`${r}/`));
    return [{
      severity: [0, 1, 2].includes(f.priority as number) ? "important" : "nit", path: root ? p.slice(root.length + 1) : p, line: start!,
      ...(Number.isInteger(end) && end! > start! ? { end_line: end! } : {}),
      title: String(f.title ?? "").replace(/^\s*\[P\d\]\s*/, ""), why: String(f.body ?? ""), evidence: "", fix_brief: "",
    }];
  });
}

/** One codex run's environment: its homes and the model key, never anything else of the caller's. */
const codexEnv = (home: string) => ({ PATH: String(process.env.PATH), HOME: home, CODEX_HOME: home, CI_REVIEW_KEY: String(process.env.OPENROUTER_API_KEY ?? "") });

/**
 * The codex config for both codex engines: the model through the gateway, the access policy (a read-only permission profile with
 * the network on, the shell inheriting no credential), nothing of the repo loaded; `repo`: the repo tools as its MCP server.
 */
export function codexConfig({ model, effort, url, instructions, repo }: { model: string; effort: string; url: string; instructions: string; repo?: { root: string; base: string } }) {
  const q = (s: unknown) => JSON.stringify(String(s)); // a TOML basic string is a JSON string
  return `model = ${q(model)}
model_provider = "review"
model_reasoning_effort = ${q(effort)}
model_context_window = 262144
default_permissions = "review"
approval_policy = "never"
web_search = "disabled"
check_for_update_on_startup = false
project_doc_max_bytes = 0
developer_instructions = ${q(instructions)}

[permissions.review]
filesystem = { ":root" = "read" }
network = { enabled = true }

[model_providers.review]
name = "review"
base_url = ${q(url)}
env_key = "CI_REVIEW_KEY"
wire_api = "responses"

[features]
hooks = false
plugins = false
apps = false
memories = false

[skills]
include_instructions = false

[shell_environment_policy]
inherit = "none"
exclude = ["CI_REVIEW_KEY", "*KEY*", "*TOKEN*", "*SECRET*"]
set = { PATH = ${q(process.env.PATH)} }

[analytics]
enabled = false

[history]
persistence = "none"
${repo ? `
[mcp_servers.repo]
command = ${q(process.execPath)}
args = [${[join(HERE, "review-tools.ts"), repo.root, repo.base].map(q).join(", ")}]
` : ""}`;
}

async function codexNative({ instructions, model, effort, root, base, minutes, scratch, own }: EngineInput): Promise<EngineResult> {
  if (!own) throw new Error("codex-native only reviews");
  const tmp = mkdtempSync(join(scratch, "codex-native-"));
  const home = join(tmp, "home");
  mkdirSync(home);
  writeFileSync(join(home, "config.toml"), codexConfig({ model: String(model).replace(/^openrouter\//, ""), effort, url: gateway(), instructions }));
  const r = await run("codex", ["exec", "review", "--base", base, "--ignore-rules", "--json", "-o", join(tmp, "answer.txt")], { cwd: root, minutes, env: codexEnv(home) });
  const events: CodexEvent[] = r.stdout.split("\n").map((l) => { try { return JSON.parse(l); } catch { return undefined; } }).filter(Boolean);
  // It read the change: a command it ran printed a diff. Not its exit code: codex chains commands.
  const read = events.some((e) => e.type === "item.completed" && e.item?.type === "command_execution" && /^diff --git /m.test(String(e.item.aggregated_output ?? "")));
  let rollouts: string[] = [];
  try { rollouts = readdirSync(join(home, "sessions"), { recursive: true }).map(String).filter((f) => f.endsWith(".jsonl")).map((f) => readFileSync(join(home, "sessions", f), "utf8")); } catch {}
  const v = nativeReview(rollouts);
  // A review is one codex finished whose output parsed (codex leaves overall_correctness empty when the model's answer didn't).
  const done = r.code === 0 && events.some((e) => e.type === "turn.completed") && !!v && ["patch is correct", "patch is incorrect"].includes(String(v.overall_correctness));
  const said = events.filter((e) => e.type === "error" || e.type === "turn.failed").map((e) => e.message ?? e.error?.message ?? "").join(" ");
  if (!done) return { message: "", read, cause: r.code === 0 && !r.timedOut ? "codex review gave no review" : stopped(r, said) };
  if (!read) {
    // Loud: what its commands said instead (a sandbox that wouldn't start, git refusing), so the cause is visible on the run.
    const cmds = events.filter((e) => e.type === "item.completed" && e.item?.type === "command_execution");
    const last = String(cmds.at(-1)?.item?.aggregated_output ?? "").replace(/\s+/g, " ").trim().slice(-300);
    return { message: "", read, cause: `it never read the diff: ${cmds.length} command${cmds.length === 1 ? "" : "s"} ran${last ? `; the last printed: ${last}` : ""}` };
  }
  return { message: JSON.stringify({ findings: nativeFindings(v!, [root.replace(/\/$/, ""), realpathSync(root)]), stale_guidance: [] }), read, incomplete: "codex review read the change with git itself, so which parts it read isn't tracked" };
}
