// The review engines: each only invokes its agent on one prompt and hands back what it said; fan-out, verification, dedupe,
// ranking and the schema are the recipe's (review.mjs), the same for every engine. An engine runs in the check box: no
// credentials but the run's capped model token (OPENROUTER_API_KEY, through the gateway at OPENROUTER_BASE_URL), no shell, its
// only tools the read-only repo tools (review-tools.mjs: the head tree and the box's own history, nothing runs or connects).
//
// codex: the CI reviewer's own runner and config (code-review.mjs, synced from the CI template): shell, hooks, plugins, apps,
// memories and web search off, nothing of the repo loaded as config (an empty cwd, project docs off).
// claude-code, codegenie: declared names, not built yet: a reviewer naming one is refused with a clear message.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config, runCodex } from "./code-review.mjs";

export const EFFORTS = ["minimal", "low", "medium", "high", "xhigh"];
const BUILT = { codex: true, "claude-code": false, codegenie: false };

/** Why a reviewer profile can't run, or undefined: engine, model and effort are checked together. */
export function profileProblem(p) {
  if (!p || typeof p !== "object") return "a reviewer is an object";
  if (!(p.engine in BUILT)) return `engine is one of ${Object.keys(BUILT).join(", ")}`;
  if (!BUILT[p.engine]) return `the ${p.engine} engine isn't built yet: use codex`;
  if (typeof p.model !== "string" || !/^~?[\w.-]+\/[\w.:~-]+$/.test(p.model)) return "model is an OpenRouter model id (e.g. ~deepseek/deepseek-flash-latest)";
  if (p.verifier != null && (typeof p.verifier !== "string" || !/^~?[\w.-]+\/[\w.:~-]+$/.test(p.verifier))) return "verifier is an OpenRouter model id";
  if (!EFFORTS.includes(p.effort)) return `effort is one of ${EFFORTS.join(", ")}`;
  if (!Number.isInteger(p.finders) || p.finders < 1 || p.finders > 4) return "finders is 1 to 4";
  return undefined;
}

/**
 * One engine run: `prompt` (the task) with `instructions` (the brief), reading the checkout `root` with `base` as the diff's
 * start. Returns { message, read, cause }: the final message, whether it read the diff (a review that never looked is none),
 * and why there's no message.
 */
export async function runEngine(engine, { prompt, instructions, model, effort, root, base, minutes, scratch }) {
  if (engine !== "codex") throw new Error(`the ${engine} engine isn't built yet: use codex`);
  const tmp = mkdtempSync(join(scratch, "codex-"));
  const home = join(tmp, "home"), cwd = join(tmp, "cwd"); // cwd: empty, not a repository, so codex loads nothing of the repo
  mkdirSync(home);
  mkdirSync(cwd);
  const url = String(process.env.OPENROUTER_BASE_URL || "").replace(/\/$/, "");
  writeFileSync(join(home, "config.toml"), config({ model: String(model).replace(/^openrouter\//, ""), effort, url, root, base, instructions }));
  const r = await runCodex({ prompt, home, cwd, out: join(tmp, "answer.txt"), key: process.env.OPENROUTER_API_KEY, minutes });
  const calls = r.events.filter((e) => e?.type === "item.completed" && e.item?.type === "mcp_tool_call" && e.item.status === "completed" && !e.item.error && !e.item.result?.isError)
    .map((e) => ({ tool: e.item.tool, path: typeof e.item.arguments?.path === "string" ? e.item.arguments.path : undefined }));
  const done = r.code === 0 && r.events.some((e) => e?.type === "turn.completed");
  const said = r.events.filter((e) => e?.type === "error" || e?.type === "turn.failed").map((e) => e.message ?? e.error?.message ?? "").join(" ");
  const cause = done ? undefined : r.timedOut ? "timed out" : /\b402\b|cap_reached/.test(said + r.stderr) ? "the run's budget ran out" : `the engine stopped (exit ${r.code})`;
  return { message: done ? r.message : "", read: calls.some((c) => c.tool === "diff"), calls, cause };
}
