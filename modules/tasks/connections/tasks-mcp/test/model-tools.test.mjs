// advisor_ask and fanout_map (src/models.mjs) against a fake gateway: the per-run limit (5 calls, all on GPT Sol), a
// placeholder brief and the fan-out bound refuse without calling the gateway; failed items come back not_covered. Each call
// carries this module's key and the caller assertion, so the gateway bills the caller's run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bridge, parse } from "./helpers.mjs";

const SOL = "~openai/gpt-sol-latest";

/** One run with a fake Paperclip + gateway; call(name, args) → { error?, out? }. */
function run() {
  const calls = [];
  const handler = async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const send = (status, x) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(x));
    if (req.url === "/api/agents/me") return send(200, { id: "me", name: "Alfred" });
    const b = JSON.parse(body);
    calls.push({ url: req.url, model: b.model, auth: req.headers.authorization, caller: req.headers["x-aidenhq-caller"], text: b.messages.at(-1).content });
    if (b.messages.at(-1).content.includes("BAD")) return send(500, { error: { message: "upstream broke" } });
    send(200, { choices: [{ message: { content: `answer from ${b.model}` } }], usage: { cost: 0.001 } });
  };
  const b = bridge({ handler, agents: { me: { key: "assistant" } }, run: `run-${Math.random()}` });
  return { call: async (name, args) => parse(await b.call(name, args)), calls };
}

test("advisor_ask: every call on GPT Sol, 5 per run, the 6th refused; placeholders refused; a gateway error gives its slot back", async () => {
  const r = run();
  const q = (s) => `${s}: retry the failing deploy, or roll back first?`;
  assert.match((await r.call("advisor_ask", { question: "placeholder", context: "x".repeat(50) })).error, /empty or a placeholder/);
  assert.match((await r.call("advisor_ask", { question: "ok?" })).error, /empty or a placeholder/);
  assert.match((await r.call("advisor_ask", { question: q("BAD") })).error, /upstream broke/);
  for (let i = 0; i < 5; i++) assert.equal((await r.call("advisor_ask", { question: q(`q${i}`), context: "facts" })).out.model, SOL);
  assert.match((await r.call("advisor_ask", { question: q("sixth") })).error, /advisor_limit/);
  assert.equal(r.calls.length, 6);
  assert.ok(r.calls.every((c) => c.model === SOL && c.url === "/advisor/api/v1/chat/completions" && c.auth === "Bearer tasks-service-key" && c.caller?.split(".").length === 3));
});

test("fanout_map: at most 25 items; a failed item comes back not_covered", async () => {
  const r = run();
  assert.match((await r.call("fanout_map", { instruction: "summarise", items: Array(26).fill("x") })).error, /at most 25/);
  assert.equal(r.calls.length, 0);
  const { out } = await r.call("fanout_map", { instruction: "summarise", items: ["one", "BAD", "three"] });
  assert.equal(out.covered, 2);
  assert.equal(out.results[0].result, "answer from ~deepseek/deepseek-flash-latest");
  assert.match(out.results[1].not_covered, /500/);
  assert.ok(r.calls.every((c) => c.url === "/fanout/api/v1/chat/completions" && c.caller));
});
