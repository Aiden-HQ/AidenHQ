// The one place opencode's config is built (nothing hand-maintained): gateway provider and models, the curated plugins and the
// agent's own instructions and skills, all from the job spec. Its connections are code (`tools: code`): typed files the kernel
// generated in the state folder, whose index is one of the instructions; no MCP server is configured.
import { join } from "node:path";
import type { JobSpec } from "../sdk/types.ts";

export interface OpencodeConfig {
  $schema: string;
  autoupdate: false;
  share: "disabled";
  enabled_providers: string[];
  model: string;
  permission: { edit: "allow"; bash: "allow"; webfetch: "allow" | "deny" };
  provider: { aidenhq: { npm: string; name: string; options: { baseURL: string; apiKey: string }; models: Record<string, { name: string; tool_call: true; reasoning: true; limit: { context: number; input: number; output: number }; options?: { reasoningEffort: string } }> } };
  compaction: { auto: true; reserved: 0 };
  instructions: string[];
  plugin: string[];
}

/** A model id as the gateway knows it: OpenRouter's prefix is the provider's, not part of the id. */
const modelId = (id: string) => id.replace(/^openrouter\//, "");

/** A model's real window, from the gateway's list. */
export interface Limits { context: number; output: number }

/** Where compaction starts, as a share of a model's window (opencode compacts when a session's tokens pass `limit.input` less `compaction.reserved`). */
const COMPACT_AT = 0.8;
/** The most output opencode asks of a model in one call (its own cap), kept free of the window below the threshold. */
const OUTPUT_ASK = 32_000;

/**
 * Every model the job offers, sized from the gateway's own list (GET <base_url>/models with the run token, through the launcher): opencode compacts
 * only for a model with a context limit, and the window it assumes is the model's real one. A model the list doesn't size
 * stops the session at start.
 */
export async function modelLimits(spec: JobSpec, token: string, get: typeof fetch = fetch): Promise<Record<string, Limits>> {
  const ids = [...new Set([spec.model.id, ...(spec.model.models ?? [])].map(modelId))];
  const res = await get(`${spec.model.base_url}/models?ids=${encodeURIComponent(ids.join(","))}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`the gateway's model list answered ${res.status}`);
  const listed = new Map(((await res.json()) as { data: { id: string; context_length?: number; max_completion_tokens?: number }[] }).data.map((m) => [m.id, m]));
  const limits: Record<string, Limits> = {};
  for (const id of ids) {
    const m = listed.get(id);
    if (!m?.context_length || !m.max_completion_tokens) throw new Error(`the gateway lists no context window for model ${id}`);
    limits[id] = { context: m.context_length, output: m.max_completion_tokens };
  }
  return limits;
}

export function opencodeConfig(spec: JobSpec, { plugins, stateDir, limits }: { plugins: string[]; stateDir: string; limits: Record<string, Limits> }): OpencodeConfig {
  const def = modelId(spec.model.id);
  const models: OpencodeConfig["provider"]["aidenhq"]["models"] = {};
  for (const id of [def, ...(spec.model.models ?? []).map(modelId)]) {
    const l = limits[id] ?? (() => { throw new Error(`no context window for model ${id}`); })();
    models[id] ??= { name: id, tool_call: true, reasoning: true, limit: { context: l.context, input: Math.max(Math.floor(l.context / 2), Math.min(Math.floor(l.context * COMPACT_AT), l.context - Math.min(l.output, OUTPUT_ASK))), output: l.output }, ...(id === def && spec.model.effort ? { options: { reasoningEffort: spec.model.effort } } : {}) };
  }
  return {
    $schema: "https://opencode.ai/config.json",
    autoupdate: false,
    share: "disabled",
    // Only our gateway: opencode's own hosted models stay unlisted.
    enabled_providers: ["aidenhq"],
    model: `aidenhq/${def}`,
    permission: { edit: "allow", bash: "allow", webfetch: spec.web ? "allow" : "deny" },
    // The key is the box's run token, read from the environment: never written to disk. @ai-sdk/openai-compatible is bundled.
    provider: { aidenhq: { npm: "@ai-sdk/openai-compatible", name: "AidenHQ", options: { baseURL: spec.model.base_url, apiKey: `{env:${spec.model.token_env}}` }, models } },
    // Automatic, at COMPACT_AT of each window: `reserved: 0` leaves the threshold at limit.input alone (the default would take a further 20k off).
    compaction: { auto: true, reserved: 0 },
    // The handbook, then the index of the job's tool files (the kernel's proxy decides every call the scripts make).
    instructions: [join(stateDir, "AGENTS.md"), spec.tools?.index ?? (() => { throw new Error("job.json names no tool index: this engine reaches its tools as code"); })()],
    plugin: plugins,
  };
}
