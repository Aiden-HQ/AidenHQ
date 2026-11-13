import { describe, expect, it } from "vitest";
import { deciderOf, foldCount, foldNoise, foldsInChat, isNoise, shortTitle, shownDecision } from "../web/src/conversation.js";
import { groupChats } from "../web/src/sidebar.js";
import type { Approval, ChatMessage, ChatRow } from "../web/src/types.js";

const at = (m: number) => `2026-11-13T12:${String(m).padStart(2, "0")}:00Z`;
const notice = (id: string, m: number, text = "Wake-up: something WOR-1 waits on changed.\n- WOR-2 is now done."): ChatMessage => ({ kind: "notice", id, at: at(m), text });
const notes = (id: string, m: number, n: number): ChatMessage => ({ kind: "notes", id, at: at(m), agent: "Runner", notes: Array.from({ length: n }, () => ({ by: "Runner", text: "ok", at: at(m) })) });
const reply = (id: string, m: number): ChatMessage => ({ kind: "reply", id, at: at(m), agent: "Aiden", text: "Done." });

describe("folding progress lines", () => {
  it("folds a run of notes and wake-ups into one line, keeps lone lines and anything that needs reading", () => {
    const ms = [notes("a", 1, 3), notice("b", 2), notes("c", 4, 5), reply("d", 5), notice("e", 6), reply("f", 7), notice("g", 8, "**Failed:** push refused (approval A1)"), notice("h", 9)];
    const items = ms.map((m) => ({ key: m.id, at: m.at, m }));
    const out = foldNoise(items, (it) => isNoise(it.m));
    expect(out.map((x) => ("type" in x ? x.key : x.key))).toEqual(["fold:a", "d", "e", "f", "g", "h"]);
    const fold = out[0] as Extract<(typeof out)[number], { type: "fold" }>;
    expect(fold.until).toBe(at(4));
    expect(foldCount(fold.items.map((x) => x.m))).toBe(9);
  });
});

describe("approval cards in a chat", () => {
  const card = (o: Partial<Approval>) => ({ state: "approved", outcome: "applied", ...o }) as Approval;
  it("folds decided cards, keeps pending ones whole and one decided while on screen open", () => {
    expect(foldsInChat(card({}), false)).toBe(true);
    expect(foldsInChat(card({ state: "rejected", outcome: null }), false)).toBe(true);
    expect(foldsInChat(card({ state: "pending", outcome: null }), true)).toBe(false);
    expect(foldsInChat(card({}), true)).toBe(false);
  });
});

describe("a tapped approval", () => {
  const pending = { id: "A1", state: "pending", tier: 2, outcome: null, decidedBy: null } as unknown as Approval;
  it("shows the tap at once, lets the board's copy win once it moves on, and goes back to pending when refused", () => {
    expect(shownDecision(pending, "approve")).toMatchObject({ state: "approved" });
    expect(deciderOf(shownDecision(pending, "reject"))).toBe("you");
    // The board's copy has moved on (applied): it wins over the tap.
    const applied = { ...pending, state: "approved", outcome: "applied", decidedBy: "account:x", decidedByName: "Sam" } as Approval;
    expect(shownDecision(applied, "approve")).toBe(applied);
    // A refused tap clears it: the card is pending again, with its buttons.
    expect(shownDecision(pending, null)).toBe(pending);
  });
});

describe("chat titles", () => {
  it("shortens a long first line to its first sentence or a word boundary", () => {
    expect(shortTitle("Short one")).toBe("Short one");
    expect(shortTitle("Roadmap keeper is down again. Can you look at why the dashboard stopped updating overnight?")).toBe("Roadmap keeper is down again");
    expect(shortTitle("Starting a fresh chat: Paperclip stopped waking you on the old one (WOR-1320) after the bug")).toBe("Starting a fresh chat: Paperclip stopped waking you on…");
  });

  it("puts TEST chats in a folded bucket unless one needs you", () => {
    const row = (id: string, title: string, o: Partial<ChatRow> = {}): ChatRow => ({ identifier: id, title, open: false, agent: { key: "a", name: "Aiden" }, state: "idle", updatedAt: at(1), unread: false, ...o });
    const { front } = groupChats([row("W-1", "Real work"), row("W-2", "TEST (throwaway, ignore): ping"), row("W-3", "TEST: relay", { open: true, state: "waiting for you" })], [{ key: "a", name: "Aiden", front: true }]);
    expect(front!.tests.map((c) => c.identifier)).toEqual(["W-2"]);
    expect(front!.chats.map((c) => c.identifier)).toEqual(["W-3"]);
    expect(front!.earlier.map((c) => c.identifier)).toEqual(["W-1"]);
  });
});
