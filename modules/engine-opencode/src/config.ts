// The one place opencode's config is built (nothing hand-maintained): gateway provider and models, every granted connection
// through the kernel proxy, the curated plugins and the agent's own instructions and skills, all from the job spec.
import { join } from "node:path";
import type { JobSpec } from "../sdk/types.ts";

export interface OpencodeConfig {
  $schema: string;
  autoupdate: false;
  share: "disabled";
  enabled_providers: string[];
  model: string;
  permission: { edit: "allow"; bash: "allow"; webfetch: "allow" | "deny" };
  provider: { aidenhq: { npm: string; name: string; options: { baseURL: string; apiKey: string }; models: Record<string, { name: string; tool_call: true; reasoning: true; options?: { reasoningEffort: string } }> } };
  mcp: Record<string, { type: "remote"; url: string; headers: { "X-Agent-Key": string }; enabled: true; timeout?: number }>;
  instructions: string[];
  plugin: string[];
}

/** A model id as the gateway knows it: OpenRouter's prefix is the provider's, not part of the id. */
const modelId = (id: string) => id.replace(/^openrouter\//, "");

export function opencodeConfig(spec: JobSpec, { plugins, stateDir }: { plugins: string[]; stateDir: string }): OpencodeConfig {
  const def = modelId(spec.model.id);
  const models: OpencodeConfig["provider"]["aidenhq"]["models"] = {};
  for (const id of [def, ...(spec.model.models ?? []).map(modelId)])
    models[id] ??= { name: id, tool_call: true, reasoning: true, ...(id === def && spec.model.effort ? { options: { reasoningEffort: spec.model.effort } } : {}) };
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
    // Tool-level narrowing is the kernel proxy's: grants are enforced there, per agent key.
    mcp: Object.fromEntries((spec.mcp ?? []).map((m) => [m.name, { type: "remote", url: m.url, headers: { "X-Agent-Key": `{env:${m.token_env}}` }, enabled: true, ...(m.tool_timeout_s ? { timeout: m.tool_timeout_s * 1000 } : {}) }])),
    instructions: [join(stateDir, "AGENTS.md")],
    plugin: plugins,
  };
}
