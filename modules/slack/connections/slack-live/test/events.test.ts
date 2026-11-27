// Routines' events: a kept Slack event goes to the kernel's event router once, after the pairing, owner-chat and bound-mention
// routing, with its bot flag; a kernel that didn't take it leaves the envelope unacked (Slack redelivers).
import { expect, it, vi } from "bun:test";

const handlers: ((msg: unknown) => Promise<void>)[] = [];
vi.mock("@slack/socket-mode", () => ({ default: { SocketModeClient: class { on(ev: string, fn: (msg: unknown) => Promise<void>) { if (ev === "slack_event") handlers.push(fn); } async start() {} } } }));
const { startSocket } = await import("../src/socket.js");
const { openStore } = await import("../src/store.js");

it("a kept Slack event is forwarded once, after owner routing, with its bot flag", async () => {
  const forwarded: unknown[] = [];
  let failing = false;
  const forward = vi.fn(async (e: unknown) => { if (failing) throw new Error("POST /v1/events -> 503"); forwarded.push(e); });
  const delivered: string[] = [];
  const log = { info() {}, warn() {}, error() {} } as never;
  await startSocket({
    appToken: "xapp-test", store: openStore(":memory:"), forward, log,
    chat: { owner: () => ({ user: "UOWNER", channel: "DOWNER" }), deliver: async (t) => void delivered.push(t) },
    pair: async () => false,
    bind: { command: async () => "", mention: async (ev: { channel?: string }) => ev?.channel === "CBOUND" },
  });
  const handle = handlers.at(-1)!;
  const send = async (event: Record<string, string>, id: string) => { const ack = vi.fn(async () => {}); await handle({ type: "events_api", body: { event_id: id, event }, ack }); return ack; };

  // The owner's own message in their command channel is chat; a bound channel's @mention is that agent's task: neither is forwarded.
  await send({ type: "message", user: "UOWNER", channel: "DOWNER", ts: "1.1", text: "hi Aiden" }, "Ev1");
  await send({ type: "app_mention", user: "U2", channel: "CBOUND", ts: "1.2", text: "<@B1> look" }, "Ev2");
  expect(delivered).toEqual(["hi Aiden"]);
  expect(forward).not.toHaveBeenCalled();

  // A person's message and a bot's post are forwarded, the bot's flagged; a join is not an event.
  const ack = await send({ type: "message", user: "U2", channel: "C1", ts: "1.3", text: "deploy is red" }, "Ev3");
  await send({ type: "message", bot_id: "B9", channel: "C1", ts: "1.4", text: "build failed" }, "Ev4");
  await send({ type: "message", subtype: "channel_join", user: "U3", channel: "C1", ts: "1.5", text: "joined" }, "Ev5");
  expect(ack).toHaveBeenCalledOnce();
  expect(forwarded).toEqual([
    { connection: "slack", resource: "C1", id: "C1:1.3", kind: "message", author: "U2", text: "deploy is red", bot: false, url: "https://slack.com/archives/C1/p13" },
    { connection: "slack", resource: "C1", id: "C1:1.4", kind: "message", author: "B9", text: "build failed", bot: true, url: "https://slack.com/archives/C1/p14" },
  ]);

  // The kernel didn't take it: not acked, so Slack redelivers.
  failing = true;
  const unacked = await send({ type: "message", user: "U2", channel: "C1", ts: "1.6", text: "again" }, "Ev6");
  expect(unacked).not.toHaveBeenCalled();

  // The owner's task emoji is an event (added or removed); anyone else's reaction or another emoji is not.
  failing = false;
  forwarded.length = 0;
  const react = (type: string, user: string, reaction: string, at: string) => send({ type, user, reaction, item: { type: "message", channel: "C1", ts: "1.7" }, event_ts: at } as never, `Ev${at}`);
  await react("reaction_added", "UOWNER", "pushpin", "2.1");
  await react("reaction_removed", "UOWNER", "pushpin", "2.2");
  await react("reaction_added", "U2", "pushpin", "2.3");
  await react("reaction_added", "UOWNER", "eyes", "2.4");
  expect(forwarded.map((e) => [(e as { kind: string }).kind, (e as { id: string }).id, (e as { url: string }).url])).toEqual([
    ["reaction_added", "C1:1.7:reaction_added:2.1", "https://slack.com/archives/C1/p17"],
    ["reaction_removed", "C1:1.7:reaction_removed:2.2", "https://slack.com/archives/C1/p17"],
  ]);
});
