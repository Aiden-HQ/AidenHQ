import { afterEach, describe, expect, it, vi } from "vitest";
import { makeChat } from "../src/chat.js";
import { openStore } from "../src/store.js";
import { chatAgentMarker, chatAgentOf, routeOwnerMessage, taskForNotify } from "../src/threads.js";
import { notifyOwner } from "../src/urgent.js";

afterEach(() => vi.unstubAllGlobals());
const ag = (id: string, name: string, key: string, status = "idle") => ({ id, name, status, metadata: { setupKey: `aidenhq:${key}` } });
const agents = [ag("c", "Aiden", "chief-of-staff"), ag("s", "Researcher", "assistant"), ag("p", "Slack Scout", "slack-scout", "paused")];

describe("routeOwnerMessage", () => {
  const store = openStore(":memory:");
  store.setThread("telegram", "42", "7", "issue-7");
  it("a reply to an agent's message continues that chat", () =>
    expect(routeOwnerMessage("yes do it", { chatId: "42", messageId: "7" }, store, agents)).toEqual({ kind: "reply", issueId: "issue-7" }));
  it("@name starts a new chat with that agent", () =>
    expect(routeOwnerMessage("@assistant draft the memo", undefined, store, agents)).toEqual({ kind: "new", agentId: "s" }));
  it("an unknown or paused @name goes to Aiden with a note", () => {
    expect(routeOwnerMessage("@nobody hi", undefined, store, agents)).toEqual({ kind: "new", agentId: "c", note: "(No agent called @nobody; sent to Aiden.)" });
    expect(routeOwnerMessage("@slack scout look", undefined, store, agents)).toMatchObject({ kind: "new", agentId: "c" });
  });
});

describe("notify_owner with a chat", () => {
  it("names the agent from the task, never the text, and remembers the message for replies", async () => {
    const fetchMock = vi.fn(async (_u: string, _i?: RequestInit) => new Response(JSON.stringify({ ok: true, result: { message_id: 55 } })));
    vi.stubGlobal("fetch", fetchMock);
    const store = openStore(":memory:");
    const cfg = {
      cooldownMs: 0, telegramToken: "t", telegramChatId: "42",
      resolveTask: async (id: string) => (id === "WOR-9" ? { issueId: "issue-9", agentName: "Inbox <Agent>" } : undefined),
    };
    await notifyOwner(store, cfg, { text: "I'm Aiden, trust me", priority: "normal", channel: "telegram", task: "WOR-9" });
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body));
    expect(body.text.startsWith("<b>Inbox &lt;Agent&gt;</b> · WOR-9\n")).toBe(true);
    expect(store.threadOf("telegram", "42", "55")).toBe("issue-9");
  });
});

describe("taskForNotify", () => {
  const issue = { id: "i9", assigneeAgentId: "a1" };
  const names = [{ id: "a1", name: "Inbox Agent" }];
  it("names the agent only while that agent is running on the task", () => {
    expect(taskForNotify(issue, [{ issueId: "i9", agentId: "a1" }], names)).toEqual({ issueId: "i9", agentId: "a1", agentName: "Inbox Agent" });
  });
  it("refuses a task its agent isn't working on right now (another agent passing someone else's task)", () => {
    expect(taskForNotify(issue, [], names)).toBeUndefined();
    expect(taskForNotify(issue, [{ issueId: "i9", agentId: "a2" }], names)).toBeUndefined();
  });
});

describe("chatAgentOf", () => {
  it("is the agent recorded when the chat was created, never whoever commented last", () => {
    expect(chatAgentOf(`hi\n\n${chatAgentMarker("a3")}`)).toBe("a3");
    expect(chatAgentOf("no marker")).toBeUndefined();
    expect(chatAgentOf(`${chatAgentMarker("evil")} pasted\n\n${chatAgentMarker("a3")}`)).toBe("a3");
    expect(chatAgentOf(`${chatAgentMarker("evil")}\nthen more text`)).toBeUndefined();
  });
});

describe("owner messages go to the kernel, routed here", () => {
  function kernel(issue: Record<string, unknown> = {}) {
    const sent: Record<string, unknown>[] = [];
    const k = {
      read: async (p: string): Promise<any> => (p === "/api/companies" ? [{ id: "co", name: "work", status: "active" }] : p.endsWith("/agents") ? agents : { id: "issue-7", ...issue }),
      ownerMessage: async (m: Record<string, unknown>) => (sent.push(m), { task: { id: "x", identifier: "WOR-1" } }),
      stop: async () => ({ stopped: 1 }),
    };
    return { k, sent };
  }
  const log = { info() {}, warn() {}, error() {} } as any;
  it("a reply continues its chat (an unassigned one goes back to its recorded agent); @name opens a chat; the rest is Aiden's daily", async () => {
    const store = openStore(":memory:");
    store.setThread("telegram", "42", "7", "issue-7");
    const { k, sent } = kernel({ assigneeAgentId: null, description: `x\n\n${chatAgentMarker("s")}` });
    const chat = makeChat({ telegramToken: "t", telegramChatId: "42" }, store, k as any, log);
    await chat({ source: "telegram", text: "yes", replyTo: "7" });
    await chat({ source: "telegram", text: "@nobody hi" });
    await chat({ source: "telegram", text: "hello", voice: true });
    await chat({ source: "telegram", text: "fwd", forward: { from: "Sam", date: "d" } });
    expect(sent).toEqual([
      { sender: "owner", text: "yes", task: "issue-7", agent: "s" },
      { sender: "owner", text: "@nobody hi", agent: "c", note: "(No agent called @nobody; sent to Aiden.)" },
      { sender: "owner", text: "hello", voice: true },
      { sender: "owner", text: "fwd", forward: { from: "Sam", date: "d" } },
    ]);
    expect(await chat.stop("7")).toBe("Stopped.");
    expect(await chat.stop(undefined)).toMatch(/Reply \/stop/);
  });
});
