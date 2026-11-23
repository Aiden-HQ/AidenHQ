import { defineConfig } from "deepsec/config";
import { generatedMatchersPlugin } from "./generated-matchers.js";

export default defineConfig({
  defaultThinkingLevel: "medium", // <deepsec:default-thinking-level>
  defaultModel: "openrouter/anthropic/claude-haiku-5.5", // <deepsec:default-model>
  defaultAgent: "pi", // <deepsec:default-agent>
  ai: {"mode":"local","provider":"local"}, // <deepsec:model-route>
  projects: [
    { id: "repo", root: ".." },
    // <deepsec:projects-insert-above>
  ],
  plugins: [generatedMatchersPlugin],
});
