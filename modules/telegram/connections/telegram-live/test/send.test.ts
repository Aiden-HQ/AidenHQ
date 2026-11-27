import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { CHAT_GAP_MS, SEND_CAP_PER_HOUR, normalise, sender } from "../src/send.js";
import { openStore } from "../src/store.js";
import { READ_STATE_METHODS } from "../src/td.js";
import { FakeTd } from "./fake-td.js";

const store = () => openStore(join(mkdtempSync(join(tmpdir(), "tg-")), "s.sqlite"));
const rid = (n: number) => `k-${n.toString(16).padStart(16, "0")}`;
const rec = (n: number, chat: string, text = "hi") => ({ id: rid(n), kind: "telegram.send", digest: "d", idempotency_key: "i", args: { action: "send", chat_id: chat, text, agent: "Aiden" } });

function setup(clock = { t: 1_000_000 }) {
  const s = store();
  const fake: FakeTd = new FakeTd().on("sendMessage", (r: { chat_id?: unknown }) => ({ id: 900 + fake.calls.length, chat_id: r.chat_id }));
  // the ingest side's job: the final id arrives with updateMessageSendSucceeded
  const ex = sender({
    td: () => fake,
    store: s,
    now: () => clock.t,
    onAgentSend: (chat, temp, write) => {
      s.db.prepare(`INSERT INTO agent_pending (chat_id, temp_message_id, write_id, final_message_id) VALUES (?, ?, ?, ?)`).run(chat, temp, write, temp + 1000);
    },
  });
  return { s, fake, ex, clock };
}

test("normalise maps the six shapes", () => {
  const n = (a: object) => normalise({ chat_id: "-1", ...a }, "Aiden").action;
  expect(n({ text: "x" })).toBe("send");
  expect(n({ reply_to_message_id: "2", text: "x" })).toBe("reply");
  expect(n({ message_id: "2", emoji: "👍" })).toBe("react");
  expect(n({ from_chat_id: "-2", message_id: "2" })).toBe("forward");
  expect(n({ message_id: "2", text: "x" })).toBe("edit");
  expect(n({ message_id: "2" })).toBe("delete");
  expect(() => normalise({ chat_id: "-1" }, "Aiden")).toThrow();
});

test("the same record id sends once", async () => {
  const { ex, fake } = setup();
  const a = await ex.execute(rec(1, "-1"));
  const b = await ex.execute(rec(1, "-1"));
  expect(fake.calls.filter((c) => c._ === "sendMessage")).toHaveLength(1);
  expect(a.ok).toBe(true);
  expect(b).toEqual(a);
});

test("a record caught mid-send by a restart is unknown, never retried", async () => {
  const { ex, fake, s } = setup();
  s.db.prepare(`INSERT INTO writes (id, state, at) VALUES (?, 'sending', 1)`).run(rid(2));
  const r = await ex.execute(rec(2, "-1"));
  expect(r.ok).toBe(false);
  expect(r.text).toContain("unknown");
  expect(fake.calls).toEqual([]);
  expect((s.db.prepare(`SELECT state FROM writes WHERE id = ?`).get(rid(2)) as { state: string }).state).toBe("unknown");
});

test("the hourly cap and the per-chat gap", async () => {
  const { ex, clock } = setup();
  for (let i = 0; i < SEND_CAP_PER_HOUR; i++) expect((await ex.execute(rec(100 + i, String(-10 - i)))).ok).toBe(true);
  const over = await ex.execute(rec(200, "-999"));
  expect(over.ok).toBe(false);
  expect(over.text).toContain("Send cap reached");
  clock.t += 3_600_001;
  expect((await ex.execute(rec(300, "-5"))).ok).toBe(true);
  clock.t += CHAT_GAP_MS / 2;
  const gap = await ex.execute(rec(301, "-5"));
  expect(gap.ok).toBe(false);
  expect(gap.text).toContain("Send cap reached");
});

test("edit plans refuse a message that is not the owner's, and nothing reads state", async () => {
  const { ex, fake } = setup();
  fake.on("getChat", { id: -1, title: "T", type: { _: "chatTypeSupergroup" } }).on("getMessage", { id: 2, is_outgoing: false });
  const req = { kind: "telegram.send", args: { chat_id: "-1", message_id: "2", text: "x" }, requester: { name: "Aiden" } as any, task: "t" };
  await expect(ex.plan(req)).rejects.toThrow("only your own messages");
  expect(fake.calls.filter((c) => READ_STATE_METHODS.has(c._))).toEqual([]);
});

test("plans put the words they act on in the card's details", async () => {
  const { ex, fake } = setup();
  fake
    .on("getChat", { id: -1, title: "T", type: { _: "chatTypeSupergroup" } })
    .on("getMessage", { id: 2, is_outgoing: true, content: { _: "messageText", text: { _: "formattedText", text: "old words", entities: [] } } });
  const plan = (args: object) => ex.plan({ kind: "telegram.send", args, requester: { name: "Aiden" } as any, task: "t" });
  expect((await plan({ chat_id: "-1", text: "hello" })).card?.details).toBe("hello");
  expect((await plan({ chat_id: "-1", message_id: "2", text: "new words" })).card?.details).toBe("Was: old words\nNow: new words");
  expect((await plan({ chat_id: "-1", message_id: "2" })).card?.details).toBe("Deletes for everyone: old words");
  expect((await plan({ chat_id: "-1", from_chat_id: "-1", message_id: "2" })).card?.details).toBe("Forwards from T: old words");
});
