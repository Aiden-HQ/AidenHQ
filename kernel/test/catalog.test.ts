// The model picker's catalog rows from OpenRouter's list entries (gateway/prices.ts catalogOf).
import { test } from "node:test";
import assert from "node:assert/strict";
import { catalogOf } from "../src/gateway/prices.ts";

test("catalogOf: a priced text model with its capabilities; images, routers and unnamed entries are left out", () => {
  const text = { id: "~openai/gpt-sol-latest", name: "OpenAI: GPT Sol", created: 1760000000, context_length: 400000, pricing: { prompt: "0.000002", completion: "0.00001" }, architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] }, supported_parameters: ["tools", "reasoning", "max_tokens"] };
  assert.deepEqual(catalogOf(text), { id: "~openai/gpt-sol-latest", name: "OpenAI: GPT Sol", provider: "openai", created: 1760000000, context: 400000, output: 400000, in: 2, out: 10, tools: true, reasoning: true });
  assert.equal(catalogOf({ ...text, top_provider: { max_completion_tokens: 64000 } })?.output, 64000);
  assert.equal(catalogOf({ ...text, architecture: { input_modalities: ["text"], output_modalities: ["image"] } }), undefined);
  assert.equal(catalogOf({ ...text, pricing: { prompt: "-1", completion: "-1" } }), undefined);
  assert.equal(catalogOf({ ...text, id: undefined }), undefined);
  assert.equal(catalogOf({ ...text, id: "anthropic/claude-haiku-5.5:batch" }), undefined);
  assert.equal(catalogOf({ ...text, supported_parameters: undefined })?.tools, false);
});
