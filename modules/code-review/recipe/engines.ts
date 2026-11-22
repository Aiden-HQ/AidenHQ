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
//   parts of the change it read isn't tracked (said as a note, `untracked`: real partial coverage, a failed or cut-off run, is
//   still incomplete). Recheck goes to codex.
// skill:<option id>: an installed upstream skill or plugin (the engineer image's /opt/review, pinned) run by its own harness
//   (claude-code or codex, the catalog's `run.harness`) over the change or, in tree mode, the whole tree (the empty tree as base):
//   the skill's own slash command with the range as its argument, then, in the same session, our "restate the findings as JSON"
//   step. Same sandbox and token rules as the harness's own engine; only that skill (never the repo's) is loaded. It reads the tree
//   its own way, so which files it read isn't tracked (said as a note, never partial coverage).
// deepsec: Vercel's scanner (deepsec.ts) on its pi backend through the gateway: scan, process and revalidate (or `process --diff`).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deepsec } from "./deepsec.ts";
import { run, stopped } from "./proc.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
/** Each engine's efforts (what it accepts), and whether it answers our prompts (verify, recheck) or only reviews. */
export const ENGINES: Record<string, { efforts: string[]; asks: boolean }> = {
  codex: { efforts: ["minimal", "low", "medium", "high", "xhigh"], asks: true },
  "claude-code": { efforts: ["low", "medium", "high", "xhigh", "max"], asks: true },
  codegenie: { efforts: ["low", "medium", "high", "xhigh", "max"], asks: false },
  "codex-native": { efforts: ["minimal", "low", "medium", "high", "xhigh"], asks: false },
  deepsec: { efforts: ["minimal", "low", "medium", "high", "xhigh"], asks: false },
};
/** The harnesses a `skill:<option id>` engine runs in. */
const HARNESSES = ["claude-code", "codex"];
const MODEL = /^~?[\w.-]+\/[\w.:~-]+$/;

/** One review run's engine, model and effort (JSON from the spec, with the repo's ignore globs and max_nits). */
export interface Combo {
  engine: string; model: string; effort: string; ignore?: string[]; max_nits?: number; mandatory?: boolean;
  /** `skill:<id>` engines: the catalog option's `run.harness` and `run.skill` (see resolveSkill). */
  harness?: string; skill?: string;
}
export interface EngineInput {
  prompt: string; instructions: string; model: string; effort: string; root: string; base: string; minutes?: string | number; scratch: string;
  /** The finder step: an engine with a review of its own runs it, then answers `prompt` from it. */
  own?: boolean;
  /** The merge base (trusted): where an engine that reads repo config takes it from. */
  trusted?: string;
  /** `tree`: the whole tree at the head (base is the empty tree); else the change. */
  target?: "tree" | "pr";
  /** Skill engines: the harness, the skill (resolveSkill) and where the image keeps skills (default /opt/review). */
  harness?: string; skill?: string; skillsRoot?: string;
  /** deepsec: its spend cap, and the files of a pending setup (JSON: path to text) to scan with instead of setting up. */
  budget_usd?: number; setupFiles?: Record<string, string>;
}
/** `calls`: the repo tools a run called, with the arguments code checks coverage by (path, the page `from`, `stat`). */
/** `incomplete`: the engine covered only part of the change. `untracked`: it reads the change its own way, so which parts it read
 * isn't tracked (its tool calls aren't reported): a note, never partial coverage. */
/** `covered`: the files the engine reports it analysed (deepsec). `setup`: files the engine set the repo up with (deepsec init). */
export interface EngineResult { message: string; read: boolean; calls?: Call[]; cause?: string; incomplete?: string; untracked?: string; covered?: string[]; setup?: Record<string, string> }
/** `whole`: a read through the shell (`git diff`) whose output came back whole, of the paths after `--` or, with none, all. */
export type Call = { tool: string; path?: string; from?: number; stat?: boolean; whole?: boolean };
/**
 * A shell command that reads the change's diff over the review's range (`git diff <base>..HEAD`, `<base>...HEAD` or
 * `<base> HEAD`; not a listing such as --stat or --name-only), as the reads it makes: one per path after `--`, or the whole
 * diff. Any other range reads something else: no read.
 */
export function shellDiff(command: unknown, base: string): Call[] {
  const c = String(command ?? "").replace(/^\s*cd\s+\S+\s*&&\s*/, ""); // `cd <repo> && git diff …`
  if (!/^\s*git\b[^|;&<>]*\bdiff\b/.test(c) || /[|;&<>]/.test(c)) return [];
  // The range ends the command, or ends what comes before ` -- <paths>`: `git diff <base> HEAD src/x` names paths without `--`,
  // which isn't a read of the whole diff (nor one counted per path).
  const range = c.split(/\s--\s/)[0]!;
  // Not a read of the diff (options only, never the paths): a listing, no patch (--no-patch, -s in any bundle, --quiet,
  // --exit-code, --check) or output written to a file.
  if (/--(stat|numstat|shortstat|name-only|name-status|summary|dirstat|raw|no-patch|quiet|check|exit-code|output)\b|\s-[A-Za-z]*s[A-Za-z]*(?=\s|$)/.test(range)) return [];
  if (!/^[0-9a-f]{7,40}$/.test(base) || !new RegExp(`(^|\\s)${base.slice(0, 7)}[0-9a-f]*(\\.\\.\\.?|\\s+)HEAD\\s*$`).test(range)) return [];
  const paths = c.split(/\s--\s/)[1]?.trim().split(/\s+/).map((x) => x.replace(/^['"]|['"]$/g, "")).filter(Boolean) ?? [];
  return paths.length ? paths.map((path) => ({ tool: "diff", path, whole: true })) : [{ tool: "diff", whole: true }];
}
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
  const skill = typeof c.engine === "string" && c.engine.startsWith("skill:");
  if (skill && (!HARNESSES.includes(c.harness as string) || typeof c.skill !== "string" || !c.skill)) return `a skill engine names its harness (${HARNESSES.join(" or ")}) and skill`;
  const e = skill ? ENGINES[c.harness!] : ENGINES[c.engine];
  if (!e) return `engine is one of ${Object.keys(ENGINES).join(", ")}, skill:<option>`;
  if (typeof c.model !== "string" || !MODEL.test(c.model)) return "model is an OpenRouter model id (e.g. ~deepseek/deepseek-flash-latest)";
  if (!e.efforts.includes(c.effort)) return `effort for ${skill ? c.harness : c.engine} is one of ${e.efforts.join(", ")}`;
  return undefined;
}

/** How the recipe runs a combo: codex fans out (2 finders and a verifier past low effort); the others run their own review once. */
export function plan(c: Combo) {
  if (c.engine !== "codex") return { finders: 1, verify: false };
  return ["minimal", "low"].includes(c.effort) ? { finders: 1, verify: false } : { finders: 2, verify: true };
}

/** The engine that answers our prompts for this combo, and at what effort: its own, or codex on the same model (max is its xhigh). */
export function asker(c: Pick<Combo, "engine" | "effort" | "harness">) {
  if (c.engine.startsWith("skill:")) return { engine: c.harness!, effort: c.effort };
  if (ENGINES[c.engine]?.asks) return { engine: c.engine, effort: c.effort };
  return { engine: "codex", effort: ENGINES.codex!.efforts.includes(c.effort) ? c.effort : "xhigh" };
}

export async function runEngine(engine: string, i: EngineInput): Promise<EngineResult> {
  if (engine === "codex") return codex(i);
  if (engine === "claude-code") return claudeCode(i);
  if (engine === "codegenie") return codegenie(i);
  if (engine === "codex-native") return codexNative(i);
  if (engine === "deepsec") return deepsecEngine(i);
  if (engine.startsWith("skill:")) return skillEngine(i);
  throw new Error(`no engine ${engine}`);
}

/** An installed skill: how its harness invokes it, the skill folders to load and the plugin folders to enable. */
export interface Skill { invocation: string; skillDirs: string[]; pluginDirs: string[] }
/** Where the engineer image keeps what it installs for these options: skills/<owner>__<repo>/ (a pinned checkout) and plugins/<name>/. */
const SKILLS_ROOT = "/opt/review";

/**
 * The catalog's `run.skill` as an installed skill. `/<plugin>:<command>` is a Claude Code plugin (plugins/<plugin>); `/<name>` a
 * skill of that name under skills/ (or, when none is installed, the harness's own command, e.g. `/code-review`); and
 * `<owner>/<repo>:<name>` the skill `<name>` of that one repo (names repeat across repos), invoked as `/<name>` (`$<name>` in codex).
 * Only what the image installed is ever loaded: never a skill, plugin or setting of the repo under review.
 */
export function resolveSkill(skill: string, harness: string, root = SKILLS_ROOT): Skill {
  const repo = /^([\w.-]+)\/([\w.-]+):([\w.-]+)$/.exec(skill);
  const cmd = /^\/([\w.-]+)(?::([\w.-]+))?$/.exec(skill);
  if (!repo && !cmd) throw new Error(`skill "${skill}" is /<name>, /<plugin>:<command> or <owner>/<repo>:<name>`);
  const sigil = harness === "codex" ? "$" : "/";
  if (cmd?.[2]) {
    const dir = join(root, "plugins", cmd[1]!);
    if (harness !== "claude-code" || !existsSync(dir)) throw new Error(`plugin ${cmd[1]} isn't installed for ${harness}`);
    return { invocation: skill, skillDirs: [], pluginDirs: [dir] };
  }
  const name = (repo ? repo[3] : cmd![1])!;
  const base = repo ? join(root, "skills", `${repo[1]}__${repo[2]}`) : join(root, "skills");
  let found: string[] = [];
  try { found = readdirSync(base, { recursive: true }).map(String).filter((f) => basename(dirname(f)) === name && basename(f) === "SKILL.md" && !f.split("/").includes("node_modules")).sort().map((f) => join(base, dirname(f))); } catch {}
  if (!found.length && repo) throw new Error(`skill ${name} isn't installed from ${repo[1]}/${repo[2]}`);
  return { invocation: `${sigil}${name}`, skillDirs: found.slice(0, 1), pluginDirs: [] };
}

/** The skill's folders linked into the harness's user skills folder (a fresh one per run: nothing else is loaded). */
function linkSkills(sk: Skill | undefined, dir: string) {
  if (!sk?.skillDirs.length) return;
  mkdirSync(dir, { recursive: true });
  for (const d of sk.skillDirs) symlinkSync(d, join(dir, basename(d)));
}

async function skillEngine(i: EngineInput): Promise<EngineResult> {
  const sk = resolveSkill(String(i.skill), String(i.harness), i.skillsRoot);
  if (!i.own) return i.harness === "codex" ? codex(i) : claudeCode(i); // an ask (recheck): the harness answers it plainly
  const r = await (i.harness === "codex" ? codex(i, sk) : claudeCode(i, sk));
  // It ran its own way: a finished run counts as read, and says its coverage isn't tracked.
  return r.cause ? r : { ...r, read: true, untracked: `${sk.invocation} reads the code its own way, so which files it read isn't tracked` };
}

/** deepsec's scan as our finder JSON, its coverage and, after a setup, the files to commit (deepsec.ts). */
async function deepsecEngine({ model, effort, root, base, trusted, minutes, scratch, target, budget_usd, setupFiles }: EngineInput): Promise<EngineResult> {
  try {
    const { review, setup } = await deepsec({ root, target: target ?? "pr", base, trusted: trusted ?? base, model, effort, budget_usd: budget_usd ?? 5, scratch, setupFiles, minutes });
    return { message: JSON.stringify({ findings: review.findings, stale_guidance: [] }), read: true, covered: review.covered, ...(review.incomplete ? { incomplete: review.incomplete } : {}), ...(setup ? { setup } : {}) };
  } catch (e) {
    return { message: "", read: false, cause: String((e as Error).message ?? e).slice(0, 300) };
  }
}

const gateway = () => String(process.env.OPENROUTER_BASE_URL || "").replace(/\/$/, "");

async function codex({ prompt, instructions, model, effort, root, base, minutes, scratch, own }: EngineInput, sk?: Skill): Promise<EngineResult> {
  const tmp = mkdtempSync(join(scratch, "codex-"));
  const home = join(tmp, "home"), cwd = join(tmp, "cwd"); // cwd: empty, not a repository, so codex loads nothing of the repo
  mkdirSync(home);
  mkdirSync(cwd);
  linkSkills(sk, join(home, "skills"));
  writeFileSync(join(home, "config.toml"), codexConfig({ model: String(model).replace(/^openrouter\//, ""), effort, url: gateway(), instructions, repo: { root, base } }));
  const out = join(tmp, "answer.txt");
  const calls: Call[] = [];
  const turn = async (task: string, resume?: string) => {
    const r = await run("codex", ["exec", ...(resume ? ["resume", resume] : []), "--skip-git-repo-check", "--ignore-rules", "--json", "-o", out, task], { cwd, minutes, env: codexEnv(home) });
    const events: CodexEvent[] = r.stdout.split("\n").map((l) => { try { return JSON.parse(l); } catch { return undefined; } }).filter(Boolean);
    calls.push(...events.filter((e) => e?.type === "item.completed" && e.item?.type === "mcp_tool_call" && e.item.status === "completed" && !e.item.error && !e.item.result?.isError)
      .flatMap((e) => callOf(e.item!.tool!, e.item!.arguments) ?? []));
    const done = r.code === 0 && events.some((e) => e?.type === "turn.completed");
    const said = events.filter((e) => e?.type === "error" || e?.type === "turn.failed").map((e) => e.message ?? e.error?.message ?? "").join(" ");
    return { r, done, said, thread: events.find((e) => e?.type === "thread.started")?.thread_id };
  };
  let session: string | undefined;
  if (sk && own) {
    // The skill's own run over the range, its findings then restated as our JSON in the same thread.
    const first = await turn(`${sk.invocation} ${base}..HEAD`);
    if (!first.done || !first.thread) return { message: "", read: false, calls, cause: first.done ? "codex gave no thread to continue" : stopped(first.r, first.said) };
    session = first.thread;
    prompt = `Now restate every finding of that run in this shape (and any problem you confirm while checking them). Check each one's line in the file at the head with the repo tools first.\n${prompt}`;
  }
  const last = await turn(prompt, session);
  let message = "";
  try { message = readFileSync(out, "utf8"); } catch {}
  return { message: last.done ? message : "", read: calls.some((c) => c.tool === "diff"), calls, cause: last.done ? undefined : stopped(last.r, last.said) };
}

/** How Claude Code says a tool's output didn't come back whole: persisted to a file with a preview shown, at the start of the
 * result (never a word inside the diff itself). */
const CUT = /^\s*(<persisted-output>|Output too large|\[?\d+ (characters|lines) truncated)/i;
/** A tool result (a plain string, or an array of text blocks) that didn't come back whole. */
export const cutShort = (content: unknown) =>
  CUT.test((typeof content === "string" ? content : Array.isArray(content) ? content.map((b) => (typeof b?.text === "string" ? b.text : "")).join("\n") : "").slice(0, 400));

// Claude Code's repo tools are ours (the same read-only MCP server codex gets), named mcp__repo__<tool>.
const REPO_TOOLS = ["diff", "log", "show", "blame", "read_file", "list_files", "search", "definition", "references", "diagnostics"];
type CodexEvent = { type?: string; thread_id?: string; message?: string; error?: { message?: string }; item?: { type?: string; tool?: string; status?: string; error?: unknown; result?: { isError?: boolean }; arguments?: Record<string, unknown>; aggregated_output?: string; command?: string } };
type ClaudeEvent = { type?: string; subtype?: string; session_id?: string; result?: string; is_error?: boolean; message?: { content?: { type?: string; id?: string; name?: string; tool_use_id?: string; is_error?: boolean; content?: unknown; input?: { path?: unknown; command?: unknown } }[] } };

async function claudeCode({ prompt, instructions, model, effort, root, base, minutes, scratch, own }: EngineInput, sk?: Skill): Promise<EngineResult> {
  const tmp = mkdtempSync(join(scratch, "claude-"));
  const home = join(tmp, "home"), cwd = join(tmp, "cwd");
  mkdirSync(home);
  mkdirSync(cwd);
  // Claude Code's sandbox for its Bash (the access policy above): read-only everywhere but its empty cwd, no network restriction
  // (none set, so no network namespace), never run outside it.
  mkdirSync(join(home, ".claude"));
  linkSkills(sk, join(home, ".claude", "skills"));
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
    ...(sk?.pluginDirs ?? []).flatMap((d) => ["--plugin-dir", d]), "--allowedTools", ["Agent", "Bash", ...REPO_TOOLS.map((t) => `mcp__repo__${t}`)].join(","), "--append-system-prompt", instructions, "--output-format", "stream-json", "--verbose"];
  const calls: Call[] = [];
  const turn = async (task: string, resume?: string) => {
    const r = await run("claude", ["-p", task, ...base_args, ...(resume ? ["--resume", resume] : [])], { cwd, env, minutes });
    const events: ClaudeEvent[] = r.stdout.split("\n").map((l) => { try { return JSON.parse(l); } catch { return undefined; } }).filter(Boolean);
    // Claude Code's own review reads the diff with its shell too (`git diff`): a read that came back whole (no error, not cut
    // short by Claude Code's output limit) counts like the repo tools' diff.
    const shell = new Map<string, Call[]>();
    for (const e of events) for (const c of e.type === "assistant" ? e.message?.content ?? [] : []) {
      const t = c.type === "tool_use" && /^mcp__repo__(\w+)$/.exec(String(c.name))?.[1];
      const call = t ? callOf(t, c.input) : undefined;
      if (call) calls.push(call);
      if (c.type === "tool_use" && c.name === "Bash" && c.id) { const reads = shellDiff(c.input?.command, base); if (reads.length) shell.set(c.id, reads); }
    }
    for (const e of events) for (const c of e.type === "user" ? e.message?.content ?? [] : []) {
      const reads = c.type === "tool_result" && c.tool_use_id ? shell.get(c.tool_use_id) : undefined;
      if (reads && !c.is_error && !cutShort(c.content)) calls.push(...reads);
    }
    const end = events.findLast((e) => e.type === "result");
    return { r, end, ok: r.code === 0 && end?.subtype === "success" && !end.is_error };
  };
  let session: string | undefined;
  if (own) {
    // Claude Code's own review of the change (base..HEAD in the box's history), or the skill's command over that range, its
    // findings then restated as our JSON.
    const first = await turn(sk ? `${sk.invocation} ${base}..HEAD` : `/code-review ${effort} ${base}..HEAD --max-findings all`);
    if (!first.ok) return { message: "", read: false, calls, cause: stopped(first.r, first.end?.result ?? "") };
    if (!first.end?.session_id) return { message: "", read: false, calls, cause: "claude gave no session to continue" };
    session = first.end.session_id;
    prompt = `Now restate every finding of that ${sk ? "run" : "review"} in this shape (and any problem you confirm while checking them). Check each one's line in the file at the head with the repo tools first.\n${prompt}`;
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
    // Its failure mode is the failure scenario an important finding needs (review.ts clean).
    failure_scenario: String(f.failureMode ?? ""), why: String(f.whyThisMatters ?? ""), evidence: String(f.evidence?.changedCode ?? ""), fix_brief: String(f.suggestedFix ?? ""),
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

/** A command's output cut by codex before the model saw it. */
export const TRUNCATED = /^Warning: truncated output \(original token count: \d+\)|^\.\.\. \d+ bytes omitted \.\.\.$/m;
/** The shell commands of codex's session rollouts (JSONL) with the output the model got back, paired by call id. */
export function nativeOutputs(rollouts: string[]) {
  const out: { command: string; output: string }[] = [];
  for (const text of rollouts) {
    const calls = new Map<string, string>();
    for (const l of text.split("\n")) {
      if (!l.includes("function_call")) continue;
      try {
        const p = JSON.parse(l)?.payload;
        if (p?.type === "function_call" && p.name === "exec_command") calls.set(String(p.call_id), String(JSON.parse(p.arguments ?? "{}").cmd ?? ""));
        else if (p?.type === "function_call_output" && calls.has(String(p.call_id))) out.push({ command: calls.get(String(p.call_id))!, output: String(p.output ?? "") });
      } catch {}
    }
  }
  return out;
}

/** The review in codex's session rollouts (JSONL): the last ExitedReviewMode item's output, or undefined. */
export function nativeReview(rollouts: string[]): NativeReview | undefined {
  let found: NativeReview | undefined;
  for (const text of rollouts) for (const l of text.split("\n")) {
    if (!l.includes("ExitedReviewMode")) continue;
    try { const e = JSON.parse(l); if (e?.payload?.item?.type === "ExitedReviewMode" && e.payload.item.review_output) found = e.payload.item.review_output; } catch {}
  }
  return found;
}

/** codex review's findings as our finder JSON: P0-P2 important, P3 (or none) a nit; its absolute paths made relative to `roots`.
 * Its body is the why: an important one's failure scenario is the body's "Failure scenario:" line the brief asks for (clean). */
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
set = { ${Object.entries({ PATH: process.env.PATH, ...gitEnv() }).map(([k, v]) => `${k} = ${q(v)}`).join(", ")} }

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

/**
 * The git environment for a checkout whose branch wrote its own .gitattributes and config, one definition for our git calls (gitSafe)
 * and the shell codex runs git in (codexConfig), so the review and the coverage check see the same diff: attributes come from the empty
 * tree (never the work tree's, which could mark a file -diff or set a filter or driver), no system or global config, no attributes file.
 */
export function gitEnv(): Record<string, string> {
  const empty = execFileSync("git", ["hash-object", "-t", "tree", "/dev/null"], { encoding: "utf8" }).trim();
  return { GIT_ATTR_SOURCE: empty, GIT_ATTR_NOSYSTEM: "1", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.attributesFile", GIT_CONFIG_VALUE_0: "/dev/null" };
}
/** git over such a checkout (gitEnv), without textconv or external diff drivers when diffing. */
export function gitSafe(cwd: string, args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 1 << 28, env: { ...process.env, ...gitEnv() }, stdio: ["ignore", "pipe", "ignore"] });
}

/** The files of the change from `base` that a review must see, renames as delete and add: the path and whether it has a hunk (a binary
 * file, a mode change or an empty file has none). Lockfiles and generated files are no requirement. undefined when git can't list them. */
export function changeFiles(root: string, base: string): { path: string; hunks: boolean }[] | undefined {
  try {
    const out = gitSafe(root, ["-c", "core.quotePath=false", "diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--numstat", "-z", base, "HEAD"]);
    return out.split("\0").filter(Boolean).map((l) => { const [a, r, ...p] = l.split("\t"); return { path: p.join("\t"), hunks: a !== "-" && Number(a) + Number(r) > 0 }; })
      .filter((f) => !/(^|\/)(go\.sum|bun\.lockb)$|[-.]lock(\.json|\.yaml)?$|\.snap$|\.map$|\.min\.(js|css)$/.test(f.path));
  } catch { return undefined; }
}

/** A git header line with its C-quoted names ("a/caf\303\251") decoded. */
export const unquoteGit = (line: string) => line.replace(/"((?:[^"\\]|\\.)*)"/g, (_m, q: string) => {
  const bytes: number[] = [];
  for (let i = 0; i < q.length; i++) {
    if (q[i] !== "\\") { bytes.push(...Buffer.from(q[i]!)); continue; }
    const o = /^[0-7]{3}/.exec(q.slice(i + 1));
    if (o) { bytes.push(parseInt(o[0], 8)); i += 3; } else { bytes.push(...Buffer.from(({ n: "\n", t: "\t", r: "\r" } as Record<string, string>)[q[i + 1]!] ?? q[i + 1] ?? "")); i++; }
  }
  return Buffer.from(bytes).toString("utf8");
});

async function codexNative({ instructions, model, effort, root, base, minutes, scratch, own }: EngineInput): Promise<EngineResult> {
  if (!own) throw new Error("codex-native only reviews");
  const tmp = mkdtempSync(join(scratch, "codex-native-"));
  const home = join(tmp, "home");
  mkdirSync(home);
  writeFileSync(join(home, "config.toml"), codexConfig({ model: String(model).replace(/^openrouter\//, ""), effort, url: gateway(), instructions }));
  const r = await run("codex", ["exec", "review", "--base", base, "--ignore-rules", "--json", "-o", join(tmp, "answer.txt")], { cwd: root, minutes, env: codexEnv(home) });
  const events: CodexEvent[] = r.stdout.split("\n").map((l) => { try { return JSON.parse(l); } catch { return undefined; } }).filter(Boolean);
  // It read the change: commands that name the requested base (its sha, the merge base's, or `git merge-base`) printed the patch of every file the change touches, a hunk each (a lockfile or generated
  // file may be left out). Codex 0.166.0's review prompt only says "Run `git diff <base>`": the model fetches the diff itself, so a
  // `git show HEAD` or a cut-off output is a part of the change, not the read.
  const wanted = changeFiles(root, base);
  // The base as codex names it: the sha, the merge base's sha, or `git merge-base …` computing it.
  const names = [base, (() => { try { return execFileSync("git", ["merge-base", base, "HEAD"], { cwd: root, encoding: "utf8" }).trim(); } catch { return ""; } })()].filter(Boolean).map((x) => x.slice(0, 7));
  const namesBase = (c: unknown) => /git\s+merge-base\b/.test(String(c ?? "")) || names.some((n) => String(c ?? "").includes(n));
  let rollouts: string[] = [];
  try { rollouts = readdirSync(join(home, "sessions"), { recursive: true }).map(String).filter((f) => f.endsWith(".jsonl")).map((f) => readFileSync(join(home, "sessions", f), "utf8")); } catch {}
  // What the model was shown: the outputs of the commands that name the base, as the session recorded them (the events carry the
  // command's whole output, up to 1 MiB, which is more than the model sees). Codex 0.166.0 cuts a long output and says so:
  // "Warning: truncated output (original token count: N)" with "... N bytes omitted ..." where the middle went. Such an output
  // shows a part of a patch (a header and a first hunk), so it counts for nothing.
  const shown = nativeOutputs(rollouts).filter((o) => namesBase(o.command) && !TRUNCATED.test(o.output)).map((o) => o.output).join("\n");
  // A change's file list that can't be made is no coverage proof. Codex's own diff may quote paths (git's core.quotePath) and pair a
  // rename's two names in one header: decode the headers, and a file is covered when a header names it on either side.
  // Codex's own diff output as blocks, one per file header, each with whether a hunk (`@@`) followed it: headers alone are not the patch.
  const blocks: { header: string; hunk: boolean }[] = [];
  for (const l of shown.split("\n")) {
    if (l.startsWith("diff --git ")) blocks.push({ header: unquoteGit(l), hunk: false });
    else if ((l.startsWith("@@ ") || l.startsWith("similarity index 100%")) && blocks.length) blocks.at(-1)!.hunk = true; // a pure rename has no hunk
  }
  const covers = (p: string, b: { header: string }) => b.header.startsWith(`diff --git a/${p} `) || b.header.endsWith(` b/${p}`);
  // Nothing to require (only lockfiles or generated files changed): nothing to read. A file list that can't be made is no proof.
  const read = wanted !== undefined && wanted.every((f) => blocks.some((b) => covers(f.path, b) && (!f.hunks || b.hunk))) && (wanted.length === 0 || blocks.length > 0);
  const v = nativeReview(rollouts);
  // A review is one codex finished whose output parsed (codex leaves overall_correctness empty when the model's answer didn't).
  const done = r.code === 0 && events.some((e) => e.type === "turn.completed") && !!v && ["patch is correct", "patch is incorrect"].includes(String(v.overall_correctness));
  const said = events.filter((e) => e.type === "error" || e.type === "turn.failed").map((e) => e.message ?? e.error?.message ?? "").join(" ");
  if (!done) return { message: "", read, cause: r.code === 0 && !r.timedOut ? "codex review gave no review" : stopped(r, said) };
  if (!read) {
    // Loud: what its commands said instead (a sandbox that wouldn't start, git refusing), so the cause is visible on the run.
    const cmds = events.filter((e) => e.type === "item.completed" && e.item?.type === "command_execution");
    const last = String(cmds.at(-1)?.item?.aggregated_output ?? "").replace(/\s+/g, " ").trim().slice(-300);
    return { message: "", read, cause: `it never read the whole diff: ${cmds.length} command${cmds.length === 1 ? "" : "s"} ran${last ? `; the last printed: ${last}` : ""}` };
  }
  return { message: JSON.stringify({ findings: nativeFindings(v!, [root.replace(/\/$/, ""), realpathSync(root)]), stale_guidance: [] }), read, untracked: "codex review read the change with git itself, so which parts it read isn't tracked" };
}
