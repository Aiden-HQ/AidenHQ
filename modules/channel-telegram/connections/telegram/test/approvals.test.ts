// Cards decided with the kernel's single-use tokens: kept here, never in Telegram; a button maps to its card, a typed reply to
// the one card held for its task, Approve all to one decision per card; the decide setting keeps some cards for the board.
import { describe, expect, it } from "vitest";
import { approvalPress, decideByReply, decideCard, parseReply, syncCards } from "../src/approvals.js";
import type { Card } from "../src/kernel.js";
import { openStore } from "../src/store.js";

const card = (id: string, identifier: string, extra: Partial<Card> = {}): Card => ({ id, identifier, kind: "push", tier: 2, digest: `d-${id}`, sentence: `Push ${identifier}.`, changes: "c", reads: "r", cost: "none", requestedBy: "Eng", replaced: false, ...extra });

function fakeKernel(pending: Card[]) {
  const decided: { token: string; sender: string; reply?: true }[] = [];
  let issued = new Set<string>();
  return {
    decided,
    cards: async (resync = false) => {
      if (resync) issued = new Set();
      const cards = pending.map((c) => (issued.has(c.id) ? c : (issued.add(c.id), { ...c, tokens: { approve: `ta-${c.id}`, reject: `tr-${c.id}` } })));
      return { cards, finished: [], ended: [] };
    },
    decide: async (b: { token: string; sender: string; reply?: true }) => (decided.push(b), { ok: true as const, id: "x", identifier: "WOR-1", sentence: "Push.", state: b.token.startsWith("tr") ? "rejected" : "approved" }),
  };
}
const sender = () => {
  const sent: { text: string; markup: any }[] = [];
  return { sent, send: async (text: string, markup: unknown) => (sent.push({ text, markup }), sent.length) };
};
const press = (cb: string) => ({ callback_query: { data: cb, message: { chat: { id: 42 }, message_id: 9 } } });

describe("cards", () => {
  it("sends each card once with buttons; a press decides with the stored token, which never appears in Telegram", async () => {
    const store = openStore(":memory:");
    const k = fakeKernel([card("A00000001", "WOR-1")]);
    const { sent, send } = sender();
    await syncCards(k, store, send, "all", true);
    await syncCards(k, store, send, "all");
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent)).not.toContain("ta-A00000001");
    const approve = sent[0]!.markup.inline_keyboard[0][0].callback_data;
    const p = approvalPress(press(approve), "42", store)!;
    expect(p).toMatchObject({ ids: ["A00000001"], decision: "approve" });
    expect(approvalPress(press(approve), "42", store)).toBeNull(); // one-shot
    expect(await decideCard(k, store, "A00000001", "approve", "owner")).toMatchObject({ ok: true, state: "approved" });
    expect(k.decided).toEqual([{ token: "ta-A00000001", sender: "owner" }]);
    expect(await decideCard(k, store, "A00000001", "reject", "owner")).toMatchObject({ ok: false }); // its tokens are gone
  });

  it("telegram_decide standard: an apply comes without buttons and can't be decided here", async () => {
    const store = openStore(":memory:");
    const k = fakeKernel([card("A00000003", "WOR-3", { kind: "apply" }), card("A00000004", "WOR-4")]);
    const { sent, send } = sender();
    await syncCards(k, store, send, "standard", true);
    expect(sent.map((s) => Boolean(s.markup))).toEqual([false, true]);
    expect(sent[0]!.text).toContain("Decide this one [on the board](#/approvals/");
    expect(await decideCard(k, store, "A00000003", "approve", "owner")).toMatchObject({ ok: false });
  });

  it("an exact typed reply decides the one card held for that task, stamped as a reply; a replaced request needs its tap", async () => {
    expect(parseReply("Apply wor-5.")).toEqual({ decision: "approve", task: "WOR-5" });
    const store = openStore(":memory:");
    const k = fakeKernel([card("A00000005", "WOR-5"), card("A00000006", "WOR-6", { replaced: true })]);
    await syncCards(k, store, sender().send, "all", true);
    expect(await decideByReply(k, store, "WOR-5", "approve", "owner", "all")).toMatchObject({ ok: true });
    expect(k.decided).toEqual([{ token: "ta-A00000005", sender: "owner", reply: true }]);
    expect(await decideByReply(k, store, "WOR-6", "approve", "owner", "all")).toMatchObject({ ok: false, reason: expect.stringContaining("changed") });
    expect(await decideByReply(k, store, "WOR-9", "approve", "owner", "all")).toMatchObject({ ok: false });
  });

});
