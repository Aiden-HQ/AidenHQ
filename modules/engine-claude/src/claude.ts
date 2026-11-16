// Claude Code on engine@1: the command line for a job spec, and its stream-json events as engine events.
import type { EngineEvent, JobSpec } from "../sdk/types.ts";
import { tracker, withArg, type PlanItem } from "../sdk/progress.ts";

const JOB_TOKEN_ENV = "AIDENHQ_JOB_TOKEN";
// Its built-in tools for coding jobs. Everything else (scheduling, remote triggers, notifications, messaging, workflows) is
// left out; MCP servers, plugins and claude.ai connectors are off entirely. TaskCreate/TaskUpdate/TaskList: its own task list.
const TOOLS = "Bash,Read,Edit,Write,NotebookEdit,Task,TaskStop,TaskCreate,TaskUpdate,TaskList,WebFetch,WebSearch";

/**
 * Headless, no prompts (the runner's sandbox is the write boundary), and nothing from your own setup: its own config dir, no
 * settings files (yours or the repo's: no hooks), no MCP servers but the job's through the proxy, no claude.ai connectors.
 * Streamed input, so comments reach a run in progress; each is echoed back once taken in (--replay-user-messages).
 */
export function claudeCommand(spec: JobSpec, base: NodeJS.ProcessEnv = process.env): { argv: string[]; env: NodeJS.ProcessEnv } {
  // No model token (its own sign-in), and the subscription token, never an API key.
  const { AIDENHQ_MODEL_TOKEN: _model, ANTHROPIC_API_KEY: _api, ...inherited } = base;
  const mcpServers = Object.fromEntries(spec.mcp.map((r) => [r.name, { type: "http", url: r.url, headers: { Authorization: `Bearer \${${JOB_TOKEN_ENV}}` } }]));
  const argv = [
    "claude", "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--replay-user-messages",
    "--permission-mode", "bypassPermissions",
    "--setting-sources", "",
    "--strict-mcp-config", "--mcp-config", JSON.stringify({ mcpServers }),
    "--tools", spec.web ? TOOLS : TOOLS.replace(",WebFetch,WebSearch", ""),
  ];
  if (spec.model.id) argv.push("--model", spec.model.id);
  if (spec.model.effort) argv.push("--effort", spec.model.effort === "minimal" ? "low" : spec.model.effort);
  if (spec.session) argv.push("--resume", spec.session);
  return { argv, env: { ...inherited, ...(spec.state ? { CLAUDE_CONFIG_DIR: spec.state } : {}), ENABLE_CLAUDEAI_MCP_SERVERS: "false", DISABLE_AUTOUPDATER: "1" } };
}

const STATE: Record<string, "done" | "doing" | "todo"> = { completed: "done", in_progress: "doing", pending: "todo" };
const item = (id: string | undefined, step: string, state: string): PlanItem => ({ ...(id ? { id } : {}), step, done: state === "done", ...(state === "doing" ? { doing: true } : {}) });

/** Claude Code's stream-json as engine events: its session, words, task list, tool calls, usage and each turn's answer. */
export function claudeEvents(spec: JobSpec, emit: (e: EngineEvent) => void) {
  const p = tracker();
  const creating = new Map<string, string>(); // TaskCreate tool_use id → subject, until its result names the task
  let session = "";
  return {
    take(e: any): { replay?: true; result?: string } {
      let changed = false;
      if (e?.type === "system" && e.subtype === "init" && e.session_id && !session) emit({ t: "session", id: (session = String(e.session_id)) });
      if (e?.type === "assistant" && Array.isArray(e.message?.content)) {
        for (const c of e.message.content) {
          if (c.type === "text") changed = p.said(c.text) || changed;
          if (c.type !== "tool_use") continue;
          if (!/^(TodoWrite|TaskCreate|TaskUpdate)$/.test(c.name)) changed = p.step(withArg(c.name, c.input)) || changed;
          if (c.name === "TodoWrite") changed = p.plan((Array.isArray(c.input?.todos) ? c.input.todos : []).map((t: any) => item(undefined, t.activeForm && t.status === "in_progress" ? t.activeForm : t.content, STATE[t.status] ?? "todo"))) || changed;
          if (c.name === "TaskCreate" && c.input?.subject) creating.set(c.id, c.input.subject);
          if (c.name === "TaskUpdate" && c.input?.taskId) {
            const id = String(c.input.taskId);
            const { status, subject } = c.input;
            const plan = p.items();
            if (status === "deleted") changed = p.plan(plan.filter((i) => i.id !== id)) || changed;
            else changed = p.plan(plan.map((i) => (i.id === id ? item(id, subject || i.step, STATE[status] ?? (i.done ? "done" : i.doing ? "doing" : "todo")) : i))) || changed;
          }
        }
      }
      if (e?.type === "user" && Array.isArray(e.message?.content)) {
        for (const c of e.message.content) {
          const subject = c.type === "tool_result" && creating.get(c.tool_use_id);
          if (!subject) continue;
          creating.delete(c.tool_use_id);
          const id = e.tool_use_result?.task?.id ?? /#(\d+)/.exec(JSON.stringify(c.content))?.[1];
          if (id && !c.is_error) changed = p.plan([...p.items().filter((i) => i.id !== String(id)), item(String(id), subject, "todo")]) || changed;
        }
      }
      if (changed) emit(p.snapshot());
      if (e?.type === "result" && e.usage) emit({ t: "usage", input: (e.usage.input_tokens ?? 0) + (e.usage.cache_creation_input_tokens ?? 0), cached: e.usage.cache_read_input_tokens ?? 0, output: e.usage.output_tokens ?? 0, model: spec.model.id || "claude" });
      if (e?.type === "user" && e.isReplay) return { replay: true };
      if (e?.type === "result" && typeof e.result === "string") return { result: e.result };
      return {};
    },
  };
}
