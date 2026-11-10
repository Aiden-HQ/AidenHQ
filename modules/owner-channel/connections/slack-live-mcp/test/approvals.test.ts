import { describe, expect, it } from "vitest";
import { approvalPress, parseReply, sendCards, type PendingApproval } from "../src/approvals.js";
import { openStore } from "../src/store.js";

const card = (id: string, replaced = false): PendingApproval => ({ id, identifier: "WOR-184", sentence: "Apply a change.", changes: "instance.yaml", reads: "Nothing new.", cost: "No model cost.", requestedBy: "Fleet Engineer", replaced });

describe("approval cards in Telegram", () => {
  it("one card per pending record, with buttons that carry its id, each used once", async () => {
    const store = openStore(":memory:");
    const sent: { text: string; markup: any }[] = [];
    const board = { pending: async () => [card("A00000001")] };
    expect(await sendCards(board, store, async (text, markup) => (sent.push({ text, markup }), true))).toBe(1);
    expect(await sendCards(board, store, async () => true)).toBe(0); // not again
    expect(sent[0]!.text).toContain("reply `apply WOR-184`");
    const [approve, reject] = sent[0]!.markup.inline_keyboard[0];
    expect([approve.text, reject.text]).toEqual(["Approve", "Reject"]);
    const press = (data: string, chat = 42) => ({ callback_query: { id: "cb", data, message: { message_id: 9, chat: { id: chat } } } });
    expect(approvalPress(press(approve.callback_data, 7), "42", store)).toBeNull(); // another chat
    expect(approvalPress(press(approve.callback_data), "42", store)).toEqual({ id: "A00000001", decision: "approve", chatId: "42", messageId: 9 });
    expect(approvalPress(press(approve.callback_data), "42", store)).toBeNull(); // one-shot
  });

  it("a replaced request gets its own card, which says a typed reply won't approve it", async () => {
    const store = openStore(":memory:");
    const texts: string[] = [];
    await sendCards({ pending: async () => [card("A00000002", true)] }, store, async (t) => (texts.push(t), true));
    expect(texts[0]).toContain("replaces an earlier request");
  });

  it("parses only an exact typed reply", () => {
    expect(parseReply("apply WOR-184")).toEqual({ decision: "approve", task: "WOR-184" });
    expect(parseReply("Reject wor-9!")).toEqual({ decision: "reject", task: "WOR-9" });
    expect(parseReply("ok apply WOR-184 please")).toBeUndefined();
  });
});

describe("the result follows the card", () => {
  it("once a carded request has an outcome, Telegram hears it once; requests never carded are skipped", async () => {
    const { sendOutcomes } = await import("../src/approvals.js");
    const { openStore } = await import("../src/store.js");
    const store = openStore(":memory:");
    store.setKv("card:A00000001", "1");
    store.setKv("card:A00000002", "1");
    const finished = [
      { id: "A00000001", identifier: "WOR-840", state: "used", outcome: "applied", outcomeText: "Applied: main is now 4f8aa0d.", sentence: "Apply a change" },
      { id: "A00000002", identifier: "WOR-9", state: "unknown", outcome: null, outcomeText: null, sentence: "Merge" },
      { id: "A00000003", identifier: "WOR-1", state: "used", outcome: "failed", outcomeText: "x", sentence: "y" },
    ];
    const sent: string[] = [];
    const board = { finished: async () => finished as never };
    expect(await sendOutcomes(board, store, async (t) => (sent.push(t), true))).toBe(2);
    expect(sent[0]).toMatch(/✅ Done · WOR-840/);
    expect(sent[0]).toContain("4f8aa0d");
    expect(sent[1]).toMatch(/⚠️.*WOR-9/);
    expect(await sendOutcomes(board, store, async (t) => (sent.push(t), true))).toBe(0);
  });
});

describe("the card itself shows the outcome", () => {
  it("the sent card's message id is kept, and its outcome edits that message", async () => {
    const { sendOutcomes } = await import("../src/approvals.js");
    const store = openStore(":memory:");
    await sendCards({ pending: async () => [card("A00000009")] }, store, async () => 77);
    const finished = [{ id: "A00000009", identifier: "WOR-184", state: "used", outcome: "applied", outcomeText: "ok", sentence: "s" }];
    const edits: [number, string][] = [];
    await sendOutcomes({ finished: async () => finished as never }, store, async () => true, async (id, t) => edits.push([id, t]));
    expect(edits).toEqual([[77, expect.stringContaining("Done · WOR-184")]]);
  });
});
