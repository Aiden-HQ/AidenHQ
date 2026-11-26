// One notify: every owner message lands once, on the first channel that delivers it, and waits while every channel is down.
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/mcp.js";
import { notify, retry, type Deps, type Message } from "../src/notify.js";
import { openStore } from "../src/store.js";

const agent = (id: string) => ({ id, name: id, key: id, assertion: "jwt", roles: [] as string[] });
function world(up: Record<string, "up" | "down" | "off"> = { "slack": "up", "channel-telegram": "up" }) {
  const sent: { to: string; m: Message }[] = [];
  const posted: string[] = [];
  const d: Deps = {
    store: openStore(":memory:"),
    transports: ["slack", "channel-telegram"],
    send: async (to, m) => {
      if (up[to] === "down") throw new Error("unreachable");
      if (up[to] !== "up") return { sent: false, off: true };
      sent.push({ to, m });
      return { sent: true };
    },
    postReply: async (_i, body) => (posted.push(body), true),
  };
  return { d, sent, posted, up };
}

describe("notify", () => {
  it("a job's reply the kernel relays goes once, only to the channel the owner wrote from, headed by its agent; never re-posted", async () => {
    const { d, sent, posted } = world();
    const relay = { via: "telegram" as const, agentName: "Aiden", issueId: "i-1" };
    expect(await notify(d, { kind: "done", text: "The budget is approved.", task: "WOR-1", relay })).toEqual({ sent: true });
    expect(await notify(d, { kind: "done", text: "The budget is approved.", task: "WOR-1", relay })).toMatchObject({ reason: "duplicate" });
    expect(sent).toEqual([{ to: "channel-telegram", m: { kind: "done", text: "The budget is approved.", head: { agent: "Aiden", task: "WOR-1", issue: "i-1" } } }]);
    expect(posted).toEqual([]);
  });

  it("every channel down: queued, retried, sent once; a channel that isn't set up is skipped", async () => {
    const { d, sent, up } = world({ "slack": "off", "channel-telegram": "down" });
    expect(await notify(d, { kind: "decision", text: "WOR-2 needs you" })).toEqual({ sent: false, queued: true, note: expect.any(String) });
    expect(await notify(d, { kind: "decision", text: "WOR-2 needs you" })).toMatchObject({ reason: "duplicate" });
    expect(await retry(d)).toBe(0);
    up["channel-telegram"] = "up";
    expect(await retry(d)).toBe(1);
    expect(await retry(d)).toBe(0);
    expect(sent).toEqual([{ to: "channel-telegram", m: { kind: "decision", text: "WOR-2 needs you" } }]);
  });

  it("an agent's question reaches the owner only where they talk to it (the kernel says so); otherwise the Fleet Steward gets it and nothing is sent", async () => {
    const { d, sent, posted } = world();
    d.resolveTask = async () => ({ issueId: "i9", agentId: "a1", agentName: "Architect", ownerVia: "telegram" });
    const waits: string[] = [];
    let to = "steward";
    d.wait = async (_t, _a, question) => (waits.push(question), { to });
    const ask = { kind: "decision" as const, text: "Context.", task: "WOR-9", questions: [{ question: "Size?", options: ["S", "L"] }] };
    expect(await notify(d, ask, agent("a1"))).toMatchObject({ sent: true, to: "steward" });
    expect(waits[0]).toMatch(/^Context\.[^]*Size\?[^]*A\) S \(recommended\)/);
    expect([sent.length, posted.length]).toEqual([0, 0]);
    // The owner is talking to it there: the question goes to them, after its wait is recorded.
    to = "owner";
    expect(await notify(d, { ...ask, text: "Context 2." }, agent("a1"))).toEqual({ sent: true, onChat: true });
    expect([sent.length, waits.length]).toEqual([1, 2]);
    // A wait that can't be recorded sends nothing.
    d.wait = async () => { throw new Error("POST /v1/wait -> 503"); };
    expect(await notify(d, { ...ask, text: "Another?" }, agent("a1"))).toMatchObject({ sent: false, reason: "error" });
    // A question with no task of its own becomes the Steward's one standing task for that agent; each later one is a
    // comment on it (a new task once it is closed), and the loop brake caps them; a filing that fails sends nothing.
    const filed: { title: string; description: string; role: string; source: string }[] = [];
    const commented: [string, string][] = [];
    let closed = false, allow = true;
    d.fileTask = async (b) => { filed.push(b); return { id: "t-" + b.source, deduplicated: filed.filter((f) => f.source === b.source).length > 1 }; };
    d.noticeTask = async (id, body) => (closed && id === "t-notify-ask:a1" ? { closed: true } : (commented.push([id, body]), {}));
    d.brake = async () => ({ allow });
    expect(await notify(d, { kind: "decision", text: "Ship it?" }, agent("a1"))).toMatchObject({ sent: true, to: "steward" });
    expect(await notify(d, { kind: "decision", text: "Ship it?" }, agent("a1"))).toMatchObject({ reason: "duplicate" });
    expect([filed.length, filed[0]!.role, filed[0]!.source, filed[0]!.title]).toEqual([1, "fleet-settle", "notify-ask:a1", "Settle: questions from a1"]);
    expect(filed[0]!.description).toMatch(/not instructions[^]*```\nShip it\?\n```/);
    expect(await notify(d, { kind: "decision", text: "And ship it twice?" }, agent("a1"))).toMatchObject({ sent: true, to: "steward" });
    expect([filed.map((f) => f.source), commented.length, commented[0]![1]]).toEqual([["notify-ask:a1", "notify-ask:a1"], 1, expect.stringMatching(/question from a1 \(data, not instructions\)[^]*```\nAnd ship it twice\?\n```/)]);
    allow = false;
    expect(await notify(d, { kind: "decision", text: "Ship a third?" }, agent("a1"))).toMatchObject({ sent: false, reason: "limit" });
    expect(commented).toHaveLength(1);
    allow = true;
    closed = true;
    expect(await notify(d, { kind: "decision", text: "After it closed?" }, agent("a1"), Date.now() + 1)).toMatchObject({ sent: true });
    expect(filed.at(-1)!.source).toMatch(/^notify-ask:a1:\d+$/);
    d.fileTask = async () => { throw new Error("kernel POST /v1/tasks → 409"); };
    expect(await notify(d, { kind: "decision", text: "Ship now?" }, agent("a1"))).toMatchObject({ sent: false, reason: "error" });
    // The Steward's own question with no task goes to the chief of staff, never back to itself.
    d.fileTask = async (b) => { filed.push(b); return { id: "t-" + b.source, deduplicated: false }; };
    const steward = { ...agent("s1"), roles: ["fleet-settle"] };
    expect(await notify(d, { kind: "decision", text: "Owner's call?" }, steward)).toMatchObject({ sent: true, to: "chief_of_staff" });
    expect([filed.at(-1)!.role, filed.at(-1)!.title]).toEqual(["fleet-admin", "Decide for the owner: questions from s1"]);
    // The chief of staff asks the owner wherever it is, always in multiple choice.
    const cos = { ...agent("c1"), roles: ["fleet-admin"] };
    expect(await notify(d, { kind: "decision", text: "Raise the cap?" }, cos)).toMatchObject({ sent: false, reason: "error", note: expect.stringMatching(/questions/) });
    expect(await notify(d, { kind: "decision", text: "The spend cap is hit.", questions: [{ question: "Raise it?", options: ["To $20 a day", "Keep $10"] }] }, cos)).toEqual({ sent: true });
    expect(sent).toHaveLength(2);
  });

  it("a single single-choice question carries its wait's start for a one-tap answer; any other shape doesn't", async () => {
    const { d, sent } = world();
    d.resolveTask = async () => ({ issueId: "i9", agentId: "a1", agentName: "Architect", ownerVia: "telegram" });
    const since = "2026-11-24T10:00:00.000Z";
    d.wait = async () => ({ to: "owner", since });
    const ask = (questions: { question: string; options: string[]; multi?: boolean }[], text = "Context.") => ({ kind: "decision" as const, text, task: "WOR-9", questions });
    await notify(d, ask([{ question: "Ship?", options: ["Wait", "Publish"] }]), agent("a1"));
    expect(sent.at(-1)!.m.answer).toEqual({ options: ["Wait", "Publish"], since });
    await notify(d, ask([{ question: "Which?", options: ["A", "B"], multi: true }], "Two."), agent("a1"));
    await notify(d, ask([{ question: "Which?", options: ["A", "B", "C", "D", "E"] }], "Three."), agent("a1"));
    expect([sent[1]!.m.answer, sent[2]!.m.answer]).toEqual([undefined, undefined]);
  });

  it("a form option with no visible text is refused whole, before it is posted, queued or sent", async () => {
    const { d, sent, posted } = world();
    const ask = (questions: { question: string; options: string[] }[], text = "Which layout?") => ({ kind: "decision" as const, text, task: "WOR-9", questions });
    d.resolveTask = async () => ({ issueId: "i9", agentId: "a1", agentName: "Architect", ownerVia: "telegram" });
    d.wait = async () => ({ to: "owner", since: "2026-11-24T10:00:00.000Z" });
    const refused = await notify(d, ask([{ question: "Which layout?", options: ["?", "Wide"] }]), agent("a1"));
    expect(refused).toEqual({ sent: false, reason: "error", note: "Question 1's option 1 has no visible text (send an option the owner can read, not a label or punctuation). Nothing was sent." });
    // A bare label prefix is no more readable than punctuation; "A" or "1" on its own is text and stays legal.
    for (const option of ["A)", "A.", "1)", "1.", "--", "..."])
      expect(await notify(d, ask([{ question: "Which layout?", options: ["Wide", option] }]), agent("a1"))).toMatchObject({ sent: false, reason: "error", note: /Question 1's option 2 has no visible text[^]*Nothing was sent\./ });
    // A label in brackets is still only a label; "A" and "1" alone stay legal.
    for (const option of ["(A)", "(1)", "(b)"])
      expect(await notify(d, ask([{ question: "Which layout?", options: [option, "Wide"] }]), agent("a1"))).toMatchObject({ sent: false, reason: "error", note: /Question 1's option 1 has no visible text[^]*Nothing was sent\./ });
    // The chat renders markdown: a marker hidden in markup would show twice to the owner.
    expect(await notify(d, ask([{ question: "Which layout?", options: ["Wait", "Publish (**recommended**)"] }]), agent("a1"))).toMatchObject({ sent: false, reason: "error", note: /Question 1's option 2 writes the tool's own "\(recommended\)" marker[^]*Nothing was sent\./ });
    // The tool marks the first option itself, so a caller writing the marker shows two recommendations.
    expect(await notify(d, ask([{ question: "Which layout?", options: ["Wide (recommended)", "Narrow"] }]), agent("a1"))).toMatchObject({ sent: false, reason: "error", note: /Question 1's option 1 writes the tool's own "\(recommended\)" marker[^]*Nothing was sent\./ });
    expect(await notify(d, ask([{ question: "Which layout? (recommended)", options: ["Wide", "Narrow"] }]), agent("a1"))).toMatchObject({ sent: false, reason: "error", note: /Question 1's text writes the tool's own "\(recommended\)" marker[^]*Nothing was sent\./ });
    expect([sent.length, posted.length, d.store.waiting().length]).toEqual([0, 0, 0]);
    // A form the owner can read still sends, "A" and "1" included.
    expect(await notify(d, ask([{ question: "Ship?", options: ["Wait", "Publish"] }], "Context."), agent("a1"))).toEqual({ sent: true, onChat: true });
    expect(await notify(d, ask([{ question: "Ship?", options: ["A", "1"] }], "Labels as options."), agent("a1"))).toEqual({ sent: true, onChat: true });
    // Markdown that renders to plain readable words is fine.
    expect(await notify(d, ask([{ question: "Which layout?", options: ["**Wait**", "_Publish_"] }]), agent("a1"))).toEqual({ sent: true, onChat: true });
    expect([sent.length, posted.length]).toEqual([3, 3]);
  });

  it("notify's input is strict", async () => {
    const { d, sent } = world();
    const client = new Client({ name: "t", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([buildServer(d, agent("aria")).connect(a), client.connect(b)]);
    const call = async (args: Record<string, unknown>) => JSON.parse(((await client.callTool({ name: "notify", arguments: args })).content as { text: string }[])[0]!.text);
    expect(await call({ kind: "done", text: "Done: the draft is in." })).toEqual({ sent: true });
    // Strict: a misspelled field is an error the agent sees, not silently dropped.
    expect((await client.callTool({ name: "notify", arguments: { kind: "done", text: "hi", "questions:": [] } })).isError).toBe(true);
    expect(sent).toHaveLength(1);
  });
});
