import { describe, expect, it } from "vitest";
import { approvalPress, parseReply, sendBatch, sendCards, type PendingApproval } from "../src/approvals.js";
import { openStore } from "../src/store.js";

const card = (id: string, replaced = false): PendingApproval => ({ id, identifier: "WOR-184", digest: "d".repeat(40), sentence: "Apply a change.", changes: "instance.yaml", reads: "Nothing new.", cost: "No model cost.", requestedBy: "Fleet Engineer", replaced });

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

  it("2+ carded cards with a new one: one list stored on the board, Approve all / Reject all carrying its id; not resent", async () => {
    const store = openStore(":memory:");
    const pending = [card("A00000003"), card("A00000004")];
    const stored: unknown[] = [];
    const board = { pending: async () => pending, batch: async (items: { id: string; digest: string }[]) => (stored.push(items), { batch: "B0000000a", approvals: pending.map((a) => ({ id: a.id, identifier: a.identifier, sentence: a.sentence })) }) };
    const sent: { text: string; markup: any }[] = [];
    const send = async (text: string, markup: unknown) => (sent.push({ text, markup }), 7);
    expect(await sendBatch(board, store, send)).toBe(false); // no card sent yet
    await sendCards(board, store, async () => true);
    expect(await sendBatch(board, store, send)).toBe(true);
    expect(stored[0]).toEqual(pending.map((a) => ({ id: a.id, digest: a.digest })));
    const [reject, approve] = sent[0]!.markup.inline_keyboard[0];
    expect([reject.text, approve.text]).toEqual(["Reject all 2", "Approve all 2"]);
    const press = { callback_query: { id: "cb", data: approve.callback_data, message: { message_id: 7, chat: { id: 42 } } } };
    expect(approvalPress(press, "42", store)).toMatchObject({ id: "B0000000a", decision: "approve" });
    expect(await sendBatch(board, store, send)).toBe(false); // same cards: no second list
    // A refusing board (batch_approvals off) is asked once per set of cards, not every tick.
    pending.push(card("A00000005"));
    await sendCards(board, store, async () => true);
    let asked = 0;
    const off = { pending: board.pending, batch: async () => (asked++, Promise.reject(new Error("board batch → 409"))) };
    await expect(sendBatch(off, store, send)).rejects.toThrow("409");
    expect(await sendBatch(off, store, send)).toBe(false);
    expect(asked).toBe(1);
  });

  it("parses only an exact typed reply", () => {
    expect(parseReply("apply WOR-184")).toEqual({ decision: "approve", task: "WOR-184" });
    expect(parseReply("Reject wor-9!")).toEqual({ decision: "reject", task: "WOR-9" });
    expect(parseReply("ok apply WOR-184 please")).toBeUndefined();
  });
});

describe("the card itself shows the outcome", () => {
  it("the sent card's message id is kept, and its outcome edits that message", async () => {
    const { sendOutcomes } = await import("../src/approvals.js");
    const store = openStore(":memory:");
    await sendCards({ pending: async () => [card("A00000009")] }, store, async () => 77);
    const finished = [{ id: "A00000009", identifier: "WOR-184", state: "used", outcome: "applied", outcomeText: "ok", sentence: "s" }];
    const edits: [number, string][] = [];
    const edit = async (id: number, t: string) => (edits.push([id, t]), true);
    expect(await sendOutcomes({ finished: async () => finished as never }, store, edit)).toBe(1);
    expect(edits).toEqual([[77, expect.stringContaining("Done · WOR-184")]]);
    // Once only, and never a separate message: a card never sent, or one whose message id wasn't kept, is skipped.
    store.setKv("card:A00000002", "1");
    const more = [...finished, { id: "A00000002", identifier: "WOR-9", state: "unknown", outcome: null, outcomeText: null, sentence: "Merge" }, { id: "A00000003", identifier: "WOR-1", state: "used", outcome: "failed", outcomeText: "x", sentence: "y" }];
    expect(await sendOutcomes({ finished: async () => more as never }, store, edit)).toBe(0);
    expect(edits).toHaveLength(1);
  });
});
