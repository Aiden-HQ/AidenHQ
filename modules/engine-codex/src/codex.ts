// Codex on engine@1: the command line for a job spec, and its JSON event stream as engine events.
import { join } from "node:path";
import type { EngineEvent, JobSpec } from "../sdk/types.ts";
import { tracker, withArg, clip } from "../sdk/progress.ts";

// Off on OpenRouter, as for Paperclip's Codex agents: ChatGPT connectors, the desktop's browser and computer, OpenAI's
// image tool, memories across runs, hooks, and plugins fetched from marketplaces (unpinned code).
const CODEX_OFF = ["apps", "browser_use", "browser_use_external", "in_app_browser", "computer_use", "image_generation", "memories", "hooks", "plugins", "remote_plugin", "recommended_plugins", "plugin_discovery_prefetch", "tool_suggest"];

/**
 * The codex command line and the env it adds: OpenRouter models through model.base_url with the token named by model.token_env,
 * in the job's agent computer (the box is the boundary: Codex's own sandbox off, its connections already in the Codex home).
 */
export function codexCommand(spec: JobSpec, jobDir: string, base: NodeJS.ProcessEnv = process.env): { argv: string[]; env: NodeJS.ProcessEnv } {
  const exec = spec.session ? ["codex", "exec", "resume", spec.session] : ["codex", "exec"];
  const search = spec.web ? "live" : "disabled";
  const model = [...(spec.model.id ? ["-m", spec.model.id] : []), ...(spec.model.effort ? ["-c", `model_reasoning_effort="${spec.model.effort}"`] : [])];
  const provider = ["-c", 'model_provider="or"', "-c", 'model_providers.or.name="OpenRouter"', "-c", `model_providers.or.base_url=${JSON.stringify(spec.model.base_url)}`, "-c", `model_providers.or.env_key="${spec.model.token_env}"`, "-c", 'model_providers.or.wire_api="responses"'];
  const off = CODEX_OFF.flatMap((f) => ["-c", `features.${f}=false`]);
  // The workspace holds several clones and isn't a git repository itself.
  const argv = [...exec, "--json", "--skip-git-repo-check", "-o", join(jobDir, "last.md"),
    "-c", 'sandbox_mode="danger-full-access"', "-c", 'approval_policy="never"', ...model, "-c", `web_search="${search}"`, ...provider,
    // The box's env holds only the run's own revocable token and its read-only gh token, which its shell tools need.
    "-c", "shell_environment_policy.ignore_default_excludes=true", ...off, "-"];
  return { argv, env: { ...base, ...(spec.state ? { CODEX_HOME: spec.state } : {}) } };
}

/** Codex's --json events as engine events: its thread id, token use, messages, plan and tool calls. */
export function codexEvents(spec: JobSpec, emit: (e: EngineEvent) => void) {
  const p = tracker();
  let session = "";
  return {
    take(e: any) {
      if (e?.type === "thread.started" && e.thread_id && !session) emit({ t: "session", id: (session = String(e.thread_id)) });
      if (e?.type === "turn.completed" && e.usage) {
        const cached = e.usage.cached_input_tokens ?? 0;
        // input_tokens includes the cached ones; output_tokens the reasoning ones.
        emit({ t: "usage", input: Math.max(0, (e.usage.input_tokens ?? 0) - cached), cached, output: e.usage.output_tokens ?? 0, model: spec.model.id || "codex" });
      }
      if (!/^item\.(started|updated|completed)$/.test(e?.type ?? "") || !e.item) return;
      const it = e.item;
      let changed = false;
      if (e.type === "item.started" && it.type === "command_execution" && it.command) changed = p.step(`Running ${clip(it.command, 120)}`);
      if (e.type === "item.started" && it.type === "mcp_tool_call") changed = p.step(withArg(`${it.server} · ${it.tool}`, it.arguments));
      if (e.type === "item.started" && it.type === "web_search" && it.query) changed = p.step(`Searching the web: ${clip(it.query, 120)}`);
      if (e.type === "item.completed" && it.type === "file_change") changed = p.step(`Editing ${(it.changes ?? []).map((c: any) => c.path).join(", ") || "files"}`);
      if (it.type === "agent_message" && e.type === "item.completed") changed = p.said(it.text) || changed;
      // The plan tool's list has no "in progress": the first open item is it.
      if (it.type === "todo_list" && Array.isArray(it.items)) {
        const open = it.items.findIndex((t: any) => !t.completed);
        changed = p.plan(it.items.map((t: any, i: number) => ({ step: t.text, done: Boolean(t.completed), ...(i === open ? { doing: true } : {}) }))) || changed;
      }
      if (changed) emit(p.snapshot());
    },
  };
}
