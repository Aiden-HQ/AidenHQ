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
  const held = stopped(r('503 {"error":"spend_held","message":"the rest of the spend limit is held by calls in flight"}'));
  assert.match(held, /held the call/);
  assert.doesNotMatch(held, /spend limit|spend cap|cap_reached/i);
  // The raw 503 text a caller appends to the cause ("the rest of the spend limit is held") is no limit either.
  const engine = readFileSync(new URL("../service/src/engine.ts", import.meta.url), "utf8");
  const limit = new RegExp(engine.match(/const SPEND_LIMIT = \/(.*)\/i;/)![1]!, "i");
  assert.ok(!limit.test("the rest of the spend limit is held by calls in flight"));
  assert.ok(limit.test("the install's spend limit was reached"));
  assert.doesNotMatch(stopped(r("HTTP 402 Payment Required")), /spend limit|spend cap|cap_reached/i);
});

test("a cap_reached the reviewer merely read, or a provider rate limit, is not the install's spend limit", async () => {
  const { stopped } = await import("../recipe/proc.ts");
  const r = (stderr: string) => ({ code: 1, stderr, timedOut: false });
  assert.doesNotMatch(stopped(r('throw fail(402, "cap_reached", `${what} ...`)\nupstream stream error rate_limit_exceeded')), /spend limit/);
  assert.match(stopped(r("upstream stream error: rate_limit_exceeded")), /rate limited/);
  assert.match(stopped(r("unexpected status 402: spend cap reached: the install's daily limit, $50.00 of $50.00")), /spend limit/);
});
