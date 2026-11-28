import { expect, test } from "bun:test";
import { CHAT_GAP_MS, sender } from "../src/send.js";
import { createIngest, markAgentSend } from "../src/ingest.js";
import { createSummon, renderLinks } from "../src/summon.js";
import { openStore } from "../src/store.js";
import { chat, log, ME, msg, newMessage, scriptedTd, tmpDb } from "./helpers.js";
import { FakeTd } from "./fake-td.js";

async function ingestEvents(chats: ReturnType<typeof chat>[], updates: unknown[], tweak?: (s: ReturnType<typeof openStore>) => void) {
  const store = openStore(tmpDb());
  tweak?.(store);
  const { td } = scriptedTd(chats, {});
  const ing = createIngest({ td, store, me: () => ME, settings: { muted: "tagged", exclude: new Set(), backfillDays: 30 }, log });
  const events: any[] = [];
  for (const u of updates) await ing.handle(u as any);
  await ing.idle();
  await ing.drain({ warehouse: undefined, kernel: { event: async (e) => void events.push(e) } });
  return events;
}

test("an outgoing message is from_owner with no thread; an incoming one is not", async () => {
  const events = await ingestEvents([chat(-10, "group")], [newMessage(msg(-10, 1, { outgoing: true, text: "ok. cc Aria" })), newMessage(msg(-10, 2, { text: "sure", replyTo: 1 }))]);
  const [mine, theirs] = events;
  expect(mine.from_owner).toBe(true);
  expect(mine.thread).toBeUndefined();
  expect(mine.id).toBe("-10:1");
  expect(theirs.from_owner).toBe(false);
  expect(theirs.thread).toBeUndefined();
  expect(theirs.data.thread).toBe("1");
});

test("a summoned muted group forwards everyone's messages; an untouched one does not", async () => {
  const chats = [chat(-10, "group", { muted: true }), chat(-11, "group", { muted: true })];
  const events = await ingestEvents(chats, [newMessage(msg(-10, 1)), newMessage(msg(-11, 1))], (s) => s.db.prepare(`INSERT INTO summoned_chats (chat_id, until) VALUES (-10, ?)`).run(Date.now() + 60_000));
  expect(events.map((e) => e.resource)).toEqual(["-10"]);
});

function setup(exclude: number[] = [-99]) {
  const store = openStore(tmpDb());
  const clock = { t: 1_000_000 };
  const fake: FakeTd = new FakeTd()
    .on("getChat", (r: any) => ({ id: r.chat_id, title: "T", type: { _: "chatTypeSupergroup" } }))
    .on("sendMessage", (r: any) => ({ id: 900 + fake.calls.length, chat_id: r.chat_id }))
    .on("addMessageReaction", {})
    .on("getMessage", { id: 5 })
    .on("getUser", (r: any) => ({ id: r.user_id, first_name: `User${r.user_id}`, last_name: "" }));
  const ex = sender({
    td: () => fake, store, now: () => clock.t,
    // the ingest side's job: the final id arrives with updateMessageSendSucceeded, and the id is marked agent-sent
    onAgentSend: (chat, temp, write) => {
      store.db.prepare(`INSERT INTO agent_pending (chat_id, temp_message_id, write_id, final_message_id) VALUES (?, ?, ?, ?)`).run(chat, temp, write, temp + 1000);
      store.db.prepare(`INSERT INTO agent_sent (chat_id, message_id) VALUES (?, ?)`).run(chat, temp + 1000);
    },
  });
  const summon = createSummon({ td: () => fake, store, settings: { exclude: new Set(exclude) }, run: ex.run, now: () => clock.t });
  return { store, fake, summon, clock };
}
const body = { resource: "-10", in_reply_to: "-10:5", text: "Booked. Sent by Aria from [AidenHQ](https://aidenhq.ai)", key: "k1" };

test("reply to an excluded chat is refused with 403 and sends nothing", async () => {
  const { summon, fake } = setup();
  for (const op of ["reply", "react", "context"]) expect((await summon.handle(op, { ...body, resource: "-99", message: "-99:5", emoji: "eyes", n: 5 })).status).toBe(403);
  expect(fake.calls.filter((c) => c._ === "sendMessage" || c._ === "addMessageReaction")).toEqual([]);
});

test("reply with a repeated key sends once and returns the first id", async () => {
  const { summon, fake, clock } = setup();
  const a = await summon.handle("reply", body);
  clock.t += CHAT_GAP_MS * 2;
  const b = await summon.handle("reply", body);
  expect(a.status).toBe(200);
  expect(b).toEqual(a);
  expect((a.body as any).id).toMatch(/^-10:\d+$/);
  expect(fake.calls.filter((c) => c._ === "sendMessage")).toHaveLength(1);
  const sent = fake.calls.find((c) => c._ === "sendMessage") as any;
  expect(sent.reply_to.message_id).toBe(5);
});

test("the link renders as a text-link entity", async () => {
  const { summon, fake } = setup();
  await summon.handle("reply", body);
  const sent = fake.calls.find((c) => c._ === "sendMessage") as any;
  expect(sent.input_message_content.text.text).toBe("Booked. Sent by Aria from AidenHQ");
  expect(sent.input_message_content.text.entities).toEqual([{ _: "textEntity", offset: 26, length: 7, type: { _: "textEntityTypeTextUrl", url: "https://aidenhq.ai" } }]);
});

test("the sent message comes back through ingest as stored, never as an event", async () => {
  const store = openStore(tmpDb());
  const { td } = scriptedTd([chat(-10, "group")], {});
  td.on("sendMessage", (r: any) => ({ ...msg(-10, 1000, { outgoing: true, text: "Booked.", sending: true }), chat_id: r.chat_id }));
  const ing = createIngest({ td, store, me: () => ME, settings: { muted: "tagged", exclude: new Set(), backfillDays: 30 }, log });
  const ex = sender({ td: () => td, store, onAgentSend: (c, t, w) => markAgentSend(store, c, t, w) });
  const summon = createSummon({ td: () => td, store, settings: { exclude: new Set() }, run: ex.run });
  const reply = summon.handle("reply", { resource: "-10", in_reply_to: "-10:5", text: "Booked.", key: "k" });
  await new Promise((r) => setTimeout(r, 50));
  // TDLib's success update: the temporary id 1000 becomes 2000
  await ing.handle({ _: "updateMessageSendSucceeded", old_message_id: 1000, message: msg(-10, 2000, { outgoing: true, text: "Booked." }) } as any);
  expect(((await reply).body as any).id).toBe("-10:2000");
  const events: any[] = [];
  await ing.drain({ warehouse: undefined, kernel: { event: async (e) => void events.push(e) } });
  expect(events).toEqual([]);
});

test("the send cap still applies, as a 429", async () => {
  const { summon } = setup();
  expect((await summon.handle("reply", body)).status).toBe(200);
  expect((await summon.handle("reply", { ...body, key: "k2" })).status).toBe(429);
});

test("react puts 👀 on the message; context reads the chat oldest first and marks it watched", async () => {
  const { summon, fake, store } = setup();
  fake.on("getChatHistory", { messages: [{ id: 3, sender_id: { _: "messageSenderUser", user_id: 7 }, is_outgoing: false, date: 100, content: { _: "messageText", text: { text: "newer" } } }, { id: 2, sender_id: { _: "messageSenderUser", user_id: 42 }, is_outgoing: true, date: 90, content: { _: "messageText", text: { text: "older" } } }] });
  expect((await summon.handle("react", { resource: "-10", message: "-10:5", emoji: "eyes" })).status).toBe(200);
  expect((fake.calls.find((c) => c._ === "addMessageReaction") as any).reaction_type.emoji).toBe("👀");
  const r = await summon.handle("context", { resource: "-10", before: "-10:5", n: 2 });
  expect((r.body as any).messages.map((m: any) => [m.id, m.author, m.is_owner, m.text])).toEqual([["-10:2", "User42", true, "older"], ["-10:3", "User7", false, "newer"]]);
  expect(store.db.prepare(`SELECT 1 FROM summoned_chats WHERE chat_id = -10`).get()).toBeTruthy();
});

test("renderLinks leaves text without links alone", () => {
  expect(renderLinks("plain [x] (y)")).toEqual({ text: "plain [x] (y)", entities: [] });
});

test("a reply into a forum topic carries the topic; balanced parentheses stay in a link", async () => {
  const { summon, fake } = setup();
  fake.on("getMessage", { id: 5, topic_id: { _: "messageTopicForum", forum_topic_id: 77 } });
  await summon.handle("reply", { ...body, text: "See [Mercury](https://en.wikipedia.org/wiki/Mercury_(planet))." });
  const sent = fake.calls.find((c) => c._ === "sendMessage") as any;
  expect(sent.topic_id).toEqual({ _: "messageTopicForum", forum_topic_id: 77 });
  expect(sent.input_message_content.text.text).toBe("See Mercury.");
  expect(sent.input_message_content.text.entities[0].type.url).toBe("https://en.wikipedia.org/wiki/Mercury_(planet)");
});

test("context keeps reading short pages until n", async () => {
  const { summon, fake } = setup();
  const m = (id: number) => ({ id, sender_id: { _: "messageSenderUser", user_id: 7 }, is_outgoing: false, date: id, content: { _: "messageText", text: { text: `m${id}` } } });
  const pages = [[m(9)], [m(8), m(7)], [m(6), m(5)], []];
  fake.on("getChatHistory", () => ({ messages: pages.shift() }));
  const r = await summon.handle("context", { resource: "-10", n: 5 });
  expect((r.body as any).messages.map((x: any) => x.text)).toEqual(["m5", "m6", "m7", "m8", "m9"]);
});
