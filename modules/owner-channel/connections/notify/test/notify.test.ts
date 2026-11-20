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

  it("the kernel's question from a waiting agent goes to the owner's first channel headed by that agent and task, so the reply lands there; never posted on the task; that agent's mutes and brake apply", async () => {
    const { d, sent, posted } = world();
    expect(await notify(d, { kind: "decision", text: "WOR-1 waits on your answer: keep v1?", task: "WOR-1", head: { agentName: "Kai", issueId: "i-1" } })).toEqual({ sent: true });
    expect(sent).toEqual([{ to: "slack", m: { kind: "decision", text: "WOR-1 waits on your answer: keep v1?", head: { agent: "Kai", task: "WOR-1", issue: "i-1" } } }]);
    expect(posted).toEqual([]);
    // Its asking agent's mutes and the task's loop brake hold as for the agent's own notify.
    const braked: string[] = [];
    d.attention = { mode: "enforce", blocked: ["kai"], dailyCap: 40, digestHours: [], timezone: "UTC" };
    d.brake = async (task, agent) => (braked.push(`${task}:${agent}`), { allow: true });
    const asker = { id: "ag-kai", key: "kai", roles: [] };
    expect(await notify(d, { kind: "decision", text: "WOR-2 waits on your answer: drop v1?", task: "WOR-2", head: { agentName: "Kai", issueId: "i-2" }, asker })).toMatchObject({ sent: false, reason: "blocked" });
    expect([sent.length, braked]).toEqual([1, ["WOR-2:ag-kai"]]);
  });

  it("the same dedupe_key from two agents reaches the owner once", async () => {
    const { d, sent } = world();
    expect(await notify(d, { kind: "alert", text: "prod is down", dedupe_key: "slack:C1:1.0" }, agent("triage"))).toEqual({ sent: true });
    expect(await notify(d, { kind: "alert", text: "Prod down!", dedupe_key: "slack:C1:1.0" }, agent("scout"))).toEqual({ sent: true, reason: "duplicate" });
    expect(sent).toEqual([{ to: "slack", m: { kind: "alert", text: "prod is down" } }]);
  });

  it("a muted fyi reaches no channel; a result still does", async () => {
    const { d, sent } = world();
    d.muteFyi = true;
    expect(await notify(d, { kind: "fyi", text: "nightly sync ran" }, agent("crew"))).toMatchObject({ sent: false, reason: "muted" });
    expect(sent).toEqual([]);
    expect(await notify(d, { kind: "done", text: "report ready" }, agent("crew"))).toEqual({ sent: true });
    expect(sent).toHaveLength(1);
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

  it("a kernel message waits for a channel to be set up; an agent's, with nowhere to land, says so", async () => {
    const { d, sent, up } = world({ "slack": "off", "channel-telegram": "off" });
    // Installed but not connected (Slack set up, never signed in): never reported as sent.
    expect(await notify(d, { kind: "done", text: "Board account reset for sam@example.com" })).toEqual({ sent: false, queued: true, note: expect.any(String) });
    expect(await notify(d, { kind: "done", text: "x" }, agent("crew"))).toMatchObject({ sent: false, reason: "error" });
    expect(await retry(d)).toBe(0);
    up["channel-telegram"] = "up";
    expect(await retry(d)).toBe(1);
    expect(sent.map((s) => s.m.text)).toEqual(["Board account reset for sam@example.com"]);
  });

  it("an agent's reply on its chat: posted as its comment, headed on the phone, the channel the owner wrote from first", async () => {
    const { d, sent, posted } = world();
    d.resolveTask = async () => ({ issueId: "i9", agentId: "a1", agentName: "Architect", ownerVia: "telegram" });
    expect(await notify(d, { kind: "decision", text: "Which?", task: "WOR-9", questions: [{ question: "Size?", options: ["S", "L"] }] }, agent("a1"))).toEqual({ sent: true, onChat: true });
    expect(posted[0]).toContain("<!-- aidenhq-questions:");
    expect(sent[0]!.to).toBe("channel-telegram");
    expect(sent[0]!.m).toMatchObject({ head: { agent: "Architect", task: "WOR-9", issue: "i9" }, asks: true });
    expect(sent[0]!.m.text).toContain("A) S (recommended)");
    // Another agent naming that task gets no chat and no head; the owner on the board keeps the reply there.
    expect(await notify(d, { kind: "done", text: "x", task: "WOR-9" }, agent("a2"))).toEqual({ sent: true });
    expect(sent[1]!.m.head).toBeUndefined();
    d.resolveTask = async () => ({ issueId: "i9", agentId: "a1", agentName: "Architect", ownerVia: "board" });
    expect(await notify(d, { kind: "done", text: "built", task: "WOR-9" }, agent("a1"))).toEqual({ sent: true, onChat: true });
    expect(sent).toHaveLength(2);
  });

  it("in trial, a message can't be routed into a task's chat", async () => {
    const { d, sent } = world();
    const client = new Client({ name: "t", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([buildServer(d, agent("aria"), true).connect(a), client.connect(b)]);
    const call = async (args: Record<string, unknown>) => JSON.parse(((await client.callTool({ name: "notify", arguments: args })).content as { text: string }[])[0]!.text);
    expect((await call({ kind: "done", text: "x", task: "WOR-1" })).sent).toBe(false);
    expect(await call({ kind: "done", text: "Done: the draft is in." })).toEqual({ sent: true });
    // Strict: a misspelled field is an error the agent sees, not silently dropped.
    expect((await client.callTool({ name: "notify", arguments: { kind: "done", text: "hi", "questions:": [] } })).isError).toBe(true);
    expect(sent).toHaveLength(1);
  });
});
