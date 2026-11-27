import { describe, expect, it } from "bun:test";
import { makeChat } from "../src/chat.js";
import { openStore } from "../src/store.js";
import { chatAgentMarker } from "../src/threads.js";

const ag = (id: string, name: string, key: string, status = "idle", lifecycleHolds: string[] = []) => ({ id, name, status, lifecycleHolds, metadata: { setupKey: `aidenhq:${key}` } });
const agents = [ag("c", "Aiden", "chief-of-staff"), ag("s", "Researcher", "assistant"), ag("p", "Slack Scout", "slack-scout", "idle", ["manual"]), ag("d", "Devops", "devops", "paused")];

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
