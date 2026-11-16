// The fast chat lane end to end against a fake gateway: a board message becomes a streamed turn with a tool call and a
// reply, timed; a slow turn still replies by the deadline; a reply that only promises is continued by the lane itself
// (also after a restart) and a failing continuation says so; the board's internal API; wakes are owner-local and fire once.
import { createHmac } from "node:crypto";
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { LaneAgent } from "../src/lane/config.js";
import { ACK, makeLane } from "../src/lane/lane.js";
import { laneRoutes } from "../src/lane/serve.js";
import { openLaneStore } from "../src/lane/store.js";
import { parseWhen } from "../src/lane/time.js";

const servers: http.Server[] = [];
afterEach(() => servers.splice(0).forEach((s) => s.close()));
const serve = (h: http.RequestListener) => new Promise<string>((r) => { const s = http.createServer(h).listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(s.address() as { port: number }).port}`)); servers.push(s); });
const sse = (res: http.ServerResponse, chunks: unknown[]) => { res.writeHead(200, { "content-type": "text/event-stream" }); for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`); res.end("data: [DONE]\n\n"); };
const quiet = { info() {}, warn() {} };
const agent: LaneAgent = { key: "aria", id: "ag-aria", name: "Aria", apiKey: "pcp_agent", model: "z-ai/glm-flash", reasoning: "low", deadlineS: 8, prompt: "You are Aria, the owner's EA.", tools: [{ connection: "google", name: "calendar_list_events" }] };

describe("fast chat lane", () => {
  it("answers a board message with a tool call through the gateway, as a capped lane token, and times it", async () => {
    const calls: { auth: string; body: any }[] = [];
    const gw = await serve((req, res) => {
      let b = "";
      req.on("data", (d) => (b += d)).on("end", () => {
        const body = JSON.parse(b);
        calls.push({ auth: String(req.headers.authorization), body });
        if (calls.length === 1) sse(res, [{ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "calendar_list_events", arguments: '{"from":' } }] } }] }, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"today"}' } }] } }] }]);
        else sse(res, [{ choices: [{ delta: { content: "Your next meeting is " } }] }, { choices: [{ delta: { content: "1:1 with Sam at 15:00." } }] }]);
      });
    });
    const store = openLaneStore(":memory:");
    const toolCalls: unknown[] = [];
    const lane = makeLane({
      store, agents: () => ({ aria: agent }), gatewayUrl: gw, laneSecret: "lane-secret", timezone: "Indian/Mauritius", ownerName: "Sam", log: quiet,
      tools: { defs: async () => [{ type: "function", function: { name: "calendar_list_events", parameters: { type: "object" } } }], call: async (_a, name, args) => (toolCalls.push([name, args]), "15:00 1:1 with Sam") },
      deliver: async () => {},
    });
    const routes = laneRoutes({ lane, store, agents: () => ({ aria: agent }), token: "internal", log: quiet });
    const api = await serve(async (req, res) => { if (!(await routes(req, res, new URL(req.url!, "http://x")))) res.writeHead(404).end(); });

    expect((await fetch(`${api}/lane/aria/messages`)).status).toBe(401);
    const auth = { authorization: "Bearer internal", "content-type": "application/json" };
    expect((await fetch(`${api}/lane/aria/messages`, { method: "POST", headers: auth, body: JSON.stringify({ text: "what's my next meeting?" }) })).status).toBe(202);
    for (let i = 0; i < 100 && store.recent("aria", "board", 0).length < 2; i++) await new Promise((r) => setTimeout(r, 20));

    const got = (await (await fetch(`${api}/lane/aria/messages`, { headers: auth })).json()) as { messages: { role: string; text: string }[] };
    expect(got.messages.map((m) => [m.role, m.text])).toEqual([["owner", "what's my next meeting?"], ["agent", "Your next meeting is 1:1 with Sam at 15:00."]]);
    expect(toolCalls).toEqual([["calendar_list_events", { from: "today" }]]);
    // The credential is a lane token (agent kind, the agent's id) signed with the lane secret, never a job token.
    const token = calls[0]!.auth.replace("Bearer ahqj_", "");
    const [body, mac] = token.split(".");
    expect(mac).toBe(createHmac("sha256", "lane-secret").update(body!).digest("base64url"));
    expect(JSON.parse(Buffer.from(body!, "base64url").toString())).toMatchObject({ k: "agent", a: "ag-aria", c: "Aria" });
    expect(calls[0]!.body).toMatchObject({ model: "z-ai/glm-flash", stream: true, reasoning: { effort: "low" } });
    expect(calls[0]!.body.messages[0].content).toContain("(Indian/Mauritius)");
    expect(calls[1]!.body.messages.at(-1)).toEqual({ role: "tool", tool_call_id: "c1", content: "15:00 1:1 with Sam" });
    const [turn] = store.turns("aria") as { first_sent_at: number; final_sent_at: number; status: string; tools: string }[];
    expect(turn).toMatchObject({ status: "ok", tools: "calendar_list_events" });
    expect(turn!.first_sent_at).toBeGreaterThan(0);
  });

  it("past the deadline it says it is on it, then the answer follows; a failed turn still replies", async () => {
    let n = 0;
    const gw = await serve((_req, res) => { n++; if (n === 1) setTimeout(() => sse(res, [{ choices: [{ delta: { content: "Done: here it is." } }] }]), 300); else res.writeHead(500).end("boom"); });
    const store = openLaneStore(":memory:");
    const lane = makeLane({ store, agents: () => ({ aria: { ...agent, deadlineS: 0.05 } }), gatewayUrl: gw, laneSecret: "s", timezone: "UTC", ownerName: "Sam", log: quiet, tools: { defs: async () => [], call: async () => "" }, deliver: async () => {} });
    await lane.receive("aria", "board", "write me a memo");
    expect(store.recent("aria", "board", 0).map((m) => m.text)).toEqual(["write me a memo", "On it: this needs a little longer. I'll follow up here.", "Done: here it is."]);
    await lane.receive("aria", "board", "again?");
    expect(store.recent("aria", "board", 0).at(-1)!.text).toMatch(/^Sorry, that didn't work/);
  });

  it("a reply that only promises is continued by the lane, after a restart too; a failing continuation says so", async () => {
    // The live case: the model answers "On it" with no task_create and no tools. A one-word check calls it DEFERRED.
    const bodies: any[] = [];
    let mode: "ok" | "down" = "ok";
    const gw = await serve((req, res) => {
      let b = "";
      req.on("data", (x) => (b += x)).on("end", () => {
        const body = JSON.parse(b);
        bodies.push(body);
        if (mode === "down") return void res.writeHead(500).end("boom");
        const sys = String(body.messages[0].content);
        const last = String(body.messages.at(-1).content);
        if (sys.startsWith("You check one chat reply")) return sse(res, [{ choices: [{ delta: { content: /^Reply: On it/m.test(last) ? "DEFERRED" : "FINAL" } }] }]);
        if (last.startsWith("[continue]")) return sse(res, [{ choices: [{ delta: { content: "H1 OKRs: ship the gateway; halve costs." } }] }]);
        sse(res, [{ choices: [{ delta: { content: "On it — summarizing the H1 2027 Company OKRs doc now." } }] }]);
      });
    });
    let clock = Date.UTC(2026, 10, 15, 7, 6);
    const store = openLaneStore(":memory:");
    const mk = () => makeLane({ store, agents: () => ({ aria: agent }), gatewayUrl: gw, laneSecret: "s", timezone: "UTC", ownerName: "Sam", log: quiet, tools: { defs: async () => [], call: async () => "" }, deliver: async () => {}, now: () => clock });
    await mk().receive("aria", "board", "summarize the H1 OKRs");
    expect(store.recent("aria", "board", 0).map((m) => m.text)).toEqual(["summarize the H1 OKRs", "On it — summarizing the H1 2027 Company OKRs doc now.", "H1 OKRs: ship the gateway; halve costs."]);
    expect(bodies.find((b) => String(b.messages.at(-1).content).startsWith("[continue]")).messages.at(-1).content).toContain('"summarize the H1 OKRs"');

    // A restart after the lane said "on it": the turn row is left running; the next lane owes it and answers, once.
    store.add("aria", "board", "owner", "and the H2 ones?", clock);
    store.startTurn("aria", "board", agent.model, clock);
    store.add("aria", "board", "agent", ACK, clock);
    const lane = mk();
    lane.resume();
    await lane.tick();
    for (let i = 0; i < 100 && lane.busy("aria", "board"); i++) await new Promise((r) => setTimeout(r, 20));
    expect(store.recent("aria", "board", 0).slice(3).map((m) => m.text)).toEqual(["and the H2 ones?", ACK, "H1 OKRs: ship the gateway; halve costs."]);

    // The gateway goes down during a continuation: the owner hears it, it retries a minute later, then gives up out loud.
    store.add("aria", "board", "owner", "and Q3?", clock);
    store.add("aria", "board", "agent", "On it.", clock);
    store.owe("aria", "board", "continue", "and Q3?", clock, clock);
    mode = "down";
    await lane.tick();
    for (let i = 0; i < 100 && lane.busy("aria", "board"); i++) await new Promise((r) => setTimeout(r, 20));
    expect(store.recent("aria", "board", 0).at(-1)!.text).toMatch(/^Couldn't finish "and Q3\?" yet \(model call failed \(500\).*Retrying in a minute\.$/);
    clock += 61_000;
    await lane.tick();
    for (let i = 0; i < 100 && lane.busy("aria", "board"); i++) await new Promise((r) => setTimeout(r, 20));
    expect(store.recent("aria", "board", 0).at(-1)!.text).toMatch(/^Couldn't finish "and Q3\?" \(.*Ask me again/);
    expect(store.recent("aria", "board", 0).slice(6).map((m) => m.text.split(" (")[0])).toEqual(["and Q3?", "On it.", 'Couldn\'t finish "and Q3?" yet', 'Couldn\'t finish "and Q3?"']);
    expect(store.due("continue", clock + 3600_000)).toEqual([]);
  });

  it("wakes: owner-local times, each fires once", () => {
    const now = Date.UTC(2026, 10, 14, 12, 0);
    expect(parseWhen("2026-11-14 17:00", "Indian/Mauritius", now)).toBe(Date.UTC(2026, 10, 14, 13, 0));
    expect(parseWhen("in 20 minutes", "Indian/Mauritius", now)).toBe(now + 20 * 60_000);
    expect(parseWhen("tomorrow-ish", "Indian/Mauritius", now)).toBeUndefined();
    const store = openLaneStore(":memory:");
    store.addWake("aria", now + 1000, "call the bank", "board", null, now);
    expect(store.takeDue(now)).toEqual([]);
    expect(store.takeDue(now + 2000).map((w) => w.note)).toEqual(["call the bank"]);
    expect(store.takeDue(now + 3000)).toEqual([]);
  });
});
