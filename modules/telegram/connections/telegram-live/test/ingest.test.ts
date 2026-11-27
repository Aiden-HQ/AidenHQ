import { describe, expect, it } from "vitest";
import { READ_STATE_METHODS } from "../src/td.js";
import { NOW_MS, chat, ingestOn, msg, newMessage, openStore, outbox, scriptedTd, tmpDb } from "./helpers.js";

describe("ingest", () => {
  it("agent send fires nothing", async () => {
    const store = openStore(tmpDb());
    const group = chat(-100, "supergroup");
    const { td, methods } = scriptedTd([group], {});
    const ingest = ingestOn(store, td);
    ingest.markAgentSend(-100, 5, "k-1");
    // TDLib's temporary id first, then the final id once the server took it.
    td.emit(newMessage(msg(-100, 5, { outgoing: true, sending: true, text: "on it" })));
    td.emit({ _: "updateMessageSendSucceeded", old_message_id: 5, message: msg(-100, 1048576, { outgoing: true, text: "on it" }) });
    await ingest.idle();
    expect(outbox(store, "kernel")).toEqual([]);
    const messages = outbox(store, "warehouse").filter((i) => i.t === "message");
    expect(messages.map((i) => i.row.message_id)).toEqual(["1048576"]);
    expect(store.db.prepare(`SELECT message_id FROM agent_sent`).all()).toEqual([{ message_id: 1048576 }]);
    expect(store.db.prepare(`SELECT final_message_id FROM agent_pending`).get()).toEqual({ final_message_id: 1048576 });

    // The user's own message from another device is an event, labelled outgoing.
    td.emit(newMessage(msg(-100, 2097152, { outgoing: true, text: "I'll send the deck tomorrow" })));
    await ingest.idle();
    const events = outbox(store, "kernel");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ connection: "telegram_account", resource: "-100", id: "-100:2097152", kind: "message", labels: ["group", "outgoing"], data: { outgoing: true } });
    expect(methods.filter((m) => READ_STATE_METHODS.has(m))).toEqual([]);
    ingest.stop();
  });

  it("an agent send whose success update was lost fires nothing: matched on its text from the sending record", async () => {
    const t0 = NOW_MS - 60_000;
    const store = openStore(tmpDb());
    const { td } = scriptedTd([chat(-100, "supergroup")], {});
    const ingest = ingestOn(store, td);
    store.db.prepare(`INSERT INTO writes (id, state, chat_id, at, body) VALUES ('k-1', 'sending', -100, ?, 'on it')`).run(t0);
    td.emit(newMessage(msg(-100, 1048576, { outgoing: true, text: "on it" })));
    await ingest.idle();
    expect(outbox(store, "kernel")).toEqual([]);
    td.emit(newMessage(msg(-100, 2097152, { outgoing: true, text: "something else" })));
    await ingest.idle();
    expect(outbox(store, "kernel")).toHaveLength(1);
    ingest.stop();
  });

  it("edits, deletes and reactions store without events", async () => {
    const store = openStore(tmpDb());
    const { td } = scriptedTd([chat(7, "dm")], {});
    const ingest = ingestOn(store, td);
    td.emit(newMessage(msg(7, 1, { text: "first" })));
    await ingest.idle();
    expect(outbox(store, "kernel")).toHaveLength(1);
    td.emit({ _: "updateMessageContent", chat_id: 7, message_id: 1, new_content: { _: "messageText", text: { _: "formattedText", text: "first, edited", entities: [] } } });
    td.emit({ _: "updateMessageEdited", chat_id: 7, message_id: 1, edit_date: 1_800_000_100 });
    const reacted = { _: "messageInteractionInfo", view_count: 0, forward_count: 0, reactions: { _: "messageReactions", reactions: [{ _: "messageReaction", type: { _: "reactionTypeEmoji", emoji: "👍" }, total_count: 1, is_chosen: false }] } };
    td.emit({ _: "updateMessageInteractionInfo", chat_id: 7, message_id: 1, interaction_info: reacted });
    td.emit({ _: "updateMessageInteractionInfo", chat_id: 7, message_id: 1, interaction_info: { ...reacted, view_count: 3 } }); // a view count: nothing new
    td.emit({ _: "updateDeleteMessages", chat_id: 7, message_ids: [1], is_permanent: true, from_cache: false });
    td.emit({ _: "updateDeleteMessages", chat_id: 7, message_ids: [99], is_permanent: true, from_cache: false }); // never ingested
    td.emit({ _: "updateMessageEdited", chat_id: 7, message_id: 98, edit_date: 1 }); // never ingested
    await ingest.idle();
    expect(outbox(store, "kernel")).toHaveLength(1);
    const items = outbox(store, "warehouse").filter((i) => i.t !== "chat");
    expect(items.map((i) => i.t)).toEqual(["message", "message", "message", "reaction", "tombstone"]);
    expect(items[1].row).toMatchObject({ message_id: "1", text: "first, edited" });
    expect(items[2].row.edited_at).toBe(new Date(1_800_000_100_000).toISOString());
    expect(items[3].row.reactions).toEqual([{ reaction: "👍", count: 1, mine: false }]);
    expect(items[4].row).toMatchObject({ chat_id: "7", message_id: "1", deleted: true, text: null });
    ingest.stop();
  });
});
