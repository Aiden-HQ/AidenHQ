// opencode on engine@1: the command line for a job spec, and its JSON events as engine events.
import type { EngineEvent, JobSpec } from "../sdk/types.ts";
import { tracker, withArg } from "../sdk/progress.ts";

const JOB_TOKEN_ENV = "AIDENHQ_JOB_TOKEN";
const STATE: Record<string, "done" | "doing" | "todo"> = { completed: "done", in_progress: "doing", pending: "todo" };

/**
 * `opencode run` with the prompt as its argument, OpenRouter through the given endpoint with the job's model token.
 * Non-interactive: an unanswered permission prompt is auto-rejected and ends the run, so everything is allowed (the runner's
 * sandbox limits writes); its default asks before reading `.env` files, which repositories track too. No web for a job
 * holding private data. Its title calls use the job's model, not opencode's default small model.
 */
export function opencodeCommand(spec: JobSpec, base: NodeJS.ProcessEnv = process.env): { argv: string[]; env: NodeJS.ProcessEnv } {
  // The model key goes on under opencode's own name.
  const { AIDENHQ_MODEL_TOKEN: modelKey, ...inherited } = base;
  const argv = ["opencode", "run", "--format", "json", "--model", `openrouter/${spec.model.id}`];
  if (spec.model.effort) argv.push("--variant", spec.model.effort);
  if (spec.session) argv.push("--session", spec.session);
  const web = spec.web ? "allow" : "deny";
  return {
    argv: [...argv, spec.prompt],
    env: {
      ...inherited,
      OPENROUTER_API_KEY: modelKey ?? "",
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        permission: { read: "allow", edit: "allow", bash: "allow", webfetch: web, websearch: web, external_directory: "allow", doom_loop: "allow" },
        autoupdate: false,
        share: "disabled",
        provider: { openrouter: { options: { baseURL: spec.model.base_url } } },
        small_model: `openrouter/${spec.model.id}`,
        mcp: Object.fromEntries(spec.mcp.map((r) => [r.name, { type: "remote", url: r.url, headers: { Authorization: `Bearer {env:${JOB_TOKEN_ENV}}` }, oauth: false, enabled: true }])),
      }),
    },
  };
}

/** opencode's events as engine events: its session, text, todo list, tool calls and token use. The last text is the answer. */
export function opencodeEvents(spec: JobSpec, emit: (e: EngineEvent) => void) {
  const p = tracker();
  let session = "";
  let last = "";
  return {
    take(e: any) {
      if (e?.sessionID && !session) emit({ t: "session", id: (session = String(e.sessionID)) });
      let changed = false;
      if (e?.type === "text" && e.part?.text) (last = e.part.text), (changed = p.said(e.part.text));
      if (e?.type === "tool_use" && e.part?.tool === "todowrite") changed = p.plan((e.part.state?.input?.todos ?? []).map((t: any) => ({ step: t.activeForm && t.status === "in_progress" ? t.activeForm : t.content, done: t.status === "completed", ...(STATE[t.status] === "doing" ? { doing: true } : {}) })));
      else if (e?.type === "tool_use" && e.part?.tool) changed = p.step(withArg(e.part.tool, e.part.state?.input), e.timestamp);
      if (changed) emit(p.snapshot());
      if (e?.type === "step_finish" && e.part?.tokens) {
        const t = e.part.tokens;
        emit({ t: "usage", input: t.input ?? 0, cached: t.cache?.read ?? 0, output: (t.output ?? 0) + (t.reasoning ?? 0), model: spec.model.id });
      }
    },
    last: () => last,
  };
}
