import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// A verdict reason the engine can emit but github-mcp's STATUS_STATE lacks makes every status post for it a 422 (spend_limit did).
test("every verdict reason code the engine can emit is a commit-status reason github-mcp accepts", () => {
  const engine = readFileSync(new URL("../service/src/engine.ts", import.meta.url), "utf8");
  const render = readFileSync(new URL("../../github/connections/github-mcp/src/review-render.ts", import.meta.url), "utf8");
  const accepted = new Set([...render.match(/STATUS_STATE = \{([^}]*)\}/)![1]!.matchAll(/(\w+):/g)].map((m) => m[1]));
  const emitted = new Set([...engine.matchAll(/\bcode: "(\w+)"/g)].map((m) => m[1]!).concat("queued", "failed", "pass"));
  const kernel = new Set(JSON.parse(readFileSync(new URL("../schemas/status.json", import.meta.url), "utf8")).properties.reason.enum);
  assert.deepEqual([...kernel].sort(), [...accepted].sort(), "the kernel's status schema and github-mcp's STATUS_STATE list the same reasons");
  assert.ok(emitted.size > 8);
  for (const c of emitted) assert.ok(accepted.has(c), `${c} is not a STATUS_STATE key`);
});

test("only the gateway's cap_reached is the install's spend limit; any other 402 is the provider's refusal", async () => {
  const { stopped } = await import("../recipe/proc.ts");
  const r = (stderr: string) => ({ code: 1, stderr, timedOut: false });
  assert.match(stopped(r('402 {"error":"cap_reached"}')), /spend limit/);
  assert.match(stopped(r("HTTP 402 Payment Required")), /model provider refused the call \(402\)/);
  assert.doesNotMatch(stopped(r("HTTP 402 Payment Required")), /spend limit|spend cap|cap_reached/i);
});
