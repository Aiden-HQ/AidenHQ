// Short no-tools Codex calls with a JSON schema for their answer (askCodex), used by the runner's
// small readings: the go-ahead on sub-tasks, the check on an Engineer's GitHub writes
// (authorize.mjs) and comments that arrive while a task is busy (busy.mjs). Also the model names a
// request can use. The runner no longer reads requests for the agent: every comment goes to the
// Engineer (docs/design/conversational-engineers.md).
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/** Codex model slugs known to the local Codex install (newest first, as Codex lists them). */
export function codexModels(file = join(homedir(), ".codex/models_cache.json")) {
  try {
    return JSON.parse(readFileSync(file, "utf8")).models.map((m) => m.slug).filter(Boolean);
  } catch {
    return [];
  }
}

/** "astra" → "gpt-6-astra": an exact slug, or the first model whose name contains the word. */
export function resolveModelAlias(name, models) {
  const n = String(name ?? "").trim().toLowerCase();
  if (!n) return undefined;
  const exact = models.find((m) => m.toLowerCase() === n);
  if (exact) return exact;
  return models.find((m) => m.toLowerCase().split(/[-_.\s]+/).includes(n) || m.toLowerCase().endsWith(`-${n}`));
}

/**
 * "deepseek" → "deepseek/deepseek-v4.1-flash", "glm5.3-flash" → "z-ai/glm-5.3-flash": a known OpenRouter
 * model by id, by name, or by a word in it (first in the list wins); a full provider/model id is kept as is.
 */
export function resolveOpenRouterModel(name, models) {
  const n = String(name ?? "").trim().toLowerCase().replace(/^openrouter\//, "");
  if (!n) return undefined;
  const flat = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const known =
    models.find((m) => m.toLowerCase() === n) ??
    models.find((m) => flat(m.split("/").pop()) === flat(n)) ??
    models.find((m) => flat(m).includes(flat(n)));
  if (known) return known;
  return /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/.test(n) ? n : undefined;
}

/** A task's description, followed by the user's task it is part of, whose text the request builds on. */
export function withParent(description, parent) {
  const own = String(description ?? "").trim();
  if (!parent) return own;
  return [own, `The task this is part of (${parent.identifier}): ${parent.title}`, String(parent.description ?? "").trim()].filter(Boolean).join("\n\n");
}

/**
 * One no-tools Codex call with a JSON schema for its answer; resolves with the parsed JSON. Models that ignore
 * the schema (OpenRouter) sometimes answer in plain text: ask once more, then fail closed.
 */
export async function askCodex(cfg, prompt, schema) {
  try { return await askCodexOnce(cfg, prompt, schema); } catch (e) {
    if (!/^no single JSON answer/.test(e.message)) throw e;
    return askCodexOnce(cfg, `${prompt}\n\nAnswer with one JSON object only, matching the schema. No prose, no YAML.`, schema);
  }
}

async function askCodexOnce(cfg, prompt, schema) {
  const dir = mkdtempSync(join(tmpdir(), "aidenhq-intake-"));
  try {
    writeFileSync(join(dir, "schema.json"), JSON.stringify(schema));
    const out = join(dir, "out.json");
    const model = cfg.intake?.model;
    const argv = [
      "codex", "exec", "--ephemeral", "--skip-git-repo-check", "-s", "read-only",
      "-c", `model_reasoning_effort="${cfg.intake?.reasoning_effort ?? "low"}"`,
      "--output-schema", join(dir, "schema.json"), "-o", out,
      ...(model ? ["-m", model] : []),
      ...(cfg.intake?.codex_args ?? []), // e.g. the OpenRouter provider, for a host without a ChatGPT login
      "-",
    ];
    const env = { ...process.env };
    if (cfg.intake?.codex_args?.length && existsSync(cfg.openrouterKeyFile)) env.OPENROUTER_API_KEY = readFileSync(cfg.openrouterKeyFile, "utf8").trim();
    delete env.SSH_AUTH_SOCK;
    await new Promise((resolve, reject) => {
      const child = spawn(argv[0], argv.slice(1), { cwd: dir, env, stdio: ["pipe", "ignore", "pipe"] });
      let err = "";
      child.stderr.on("data", (d) => (err = (err + d).slice(-2000)));
      const timer = setTimeout(() => child.kill("SIGKILL"), (cfg.intake?.timeout_seconds ?? 180) * 1000);
      child.on("error", reject);
      child.on("close", (code) => {
        clearTimeout(timer);
        code === 0 && existsSync(out) ? resolve() : reject(new Error(`intake exited with ${code}: ${err.trim().split("\n").pop() ?? ""}`));
      });
      child.stdin.end(prompt);
    });
    return parseJsonAnswer(readFileSync(out, "utf8"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------ go-ahead for sub-tasks

export const APPROVAL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["decision"],
  properties: { decision: { type: "string", enum: ["start", "hold", "other"] } },
};

export function approvalPrompt({ user, title, waiting, comment }) {
  return `${user} asked the Research Assistant to split the task "${title}" into Engineer tasks. These are created and waiting for ${user}'s go-ahead before any of them starts:

${waiting.map((w) => `- ${w.identifier}: ${String(w.title).replace(/[\r\n]+/g, " ").slice(0, 160)}`).join("\n")}

Read ${user}'s newest comment on that task and answer with JSON:
- "start": a clear go-ahead to start ALL of the waiting tasks as they are ("go", "go ahead", "start them", "looks good, run them", "👍").
- "hold": explicitly not yet ("wait", "don't start yet", "hold off").
- "other": anything else, including a go-ahead with changes or exceptions ("go, but skip X", "use opus instead", "add repo Y first"), questions and edits. Those go to the Research Assistant.
When in doubt, "other". Do not run any tools.

<<<COMMENT
${String(comment).replace(/<<<|>>>/g, "‹‹‹").slice(0, 4000)}
COMMENT>>>`;
}

/** Is the newest comment on a parent task the go-ahead for its waiting sub-tasks? Rejects on failure. */
export async function readApproval({ cfg, user, title, waiting, comment }) {
  const raw = await askCodex(cfg, approvalPrompt({ user, title, waiting, comment }), APPROVAL_SCHEMA);
  return ["start", "hold", "other"].includes(raw?.decision) ? raw.decision : "other";
}

/**
 * Models that ignore --output-schema (e.g. via OpenRouter) may wrap the JSON in a fence or prose.
 * Fail closed: the answer must be exactly one JSON object (the whole output, one fenced block, or the single
 * span from the first "{" to the last "}"); zero or several candidates throw.
 */
export function parseJsonAnswer(text) {
  const t = String(text).trim();
  try { return JSON.parse(t); } catch {}
  const parses = (c) => { try { return [JSON.parse(c)]; } catch { return []; } };
  const fenced = [...t.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].flatMap((m) => parses(m[1]));
  if (fenced.length > 1) throw new Error("ambiguous answer: several JSON blocks");
  if (fenced.length === 1) return fenced[0];
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  const span = a >= 0 && b > a ? parses(t.slice(a, b + 1)) : [];
  if (span.length === 1 && span[0] && typeof span[0] === "object" && !Array.isArray(span[0])) return span[0];
  throw new Error(`no single JSON answer: ${t.slice(0, 80)}`);
}
