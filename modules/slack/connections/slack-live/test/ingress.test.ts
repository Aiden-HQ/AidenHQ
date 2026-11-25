// The socket ingress line: one info log per inbound events_api message, with its shape and never its text, before the pairing,
// owner-chat and routing filters can drop it. A DM that pairs nobody must still be observable.
import { expect, it, vi } from "vitest";

const handlers: ((msg: unknown) => Promise<void>)[] = [];
const states = { connected: [] as (() => void)[], disconnected: [] as (() => void)[], close: [] as (() => void)[] };
vi.mock("@slack/socket-mode", () => ({ default: { SocketModeClient: class { on(ev: string, fn: (msg: unknown) => Promise<void>) { if (ev === "slack_event") handlers.push(fn); else (states as Record<string, (() => void)[]>)[ev]?.push(fn as unknown as () => void); } async start() {} } } }));
const { startSocket } = await import("../src/socket.js");
const { openStore } = await import("../src/store.js");

it("logs an inbound events_api message before the pairing filter, and never its text", async () => {
  const info = vi.fn();
  const log = { info, warn() {}, error() {} } as never;
  const onState = vi.fn();
  await startSocket({
    appToken: "xapp-test", store: openStore(":memory:"), log, onState,
    pair: async () => false, // the pairing filter drops it: the ingress line must already be out
  });
  const handle = handlers.at(-1)!;
  const ack = vi.fn(async () => {});
  const text = "s3cret-pairing-code-123";
  await handle({ type: "events_api", body: { event_id: "Ev42", event: { type: "message", channel_type: "im", user: "U1", channel: "D1", text } }, ack });

  const line = info.mock.calls.find((c) => c[1] === "slack event in");
  expect(line).toBeDefined();
  expect(line![0]).toEqual({ type: "message", channel_type: "im", event_id: "Ev42" });
  expect(JSON.stringify(info.mock.calls)).not.toContain(text);
  expect(JSON.stringify(info.mock.calls)).not.toContain("U1");
  expect(ack).toHaveBeenCalledOnce();

  // Connects, disconnects and a silent close (auto-reconnect never emits "disconnected") all reach /healthz's state.
  (states.connected[0] as () => void)();
  expect(onState).toHaveBeenLastCalledWith("connected");
  (states.close[0] as () => void)();
  expect(onState).toHaveBeenLastCalledWith("disconnected");
  (states.connected[0] as () => void)();
  expect(onState).toHaveBeenLastCalledWith("connected");
  (states.disconnected[0] as () => void)();
  expect(onState).toHaveBeenLastCalledWith("disconnected");
});

it("a code-shaped message that pairs nobody is not teed or forwarded", async () => {
  const tee = vi.fn();
  const forward = vi.fn(async () => undefined);
  await startSocket({ appToken: "xapp-test", store: openStore(":memory:"), log: { info() {}, warn() {}, error() {} } as never, pair: async () => false, tee, forward });
  const handle = handlers.at(-1)!;
  const ack = vi.fn(async () => {});
  // A DM between two people (or any DM the bot can't see): still a live pairing credential.
  await handle({ type: "events_api", body: { event_id: "Ev9", event: { type: "message", channel_type: "im", user: "U1", channel: "D2", text: "A".repeat(22) } }, ack });
  expect(tee).not.toHaveBeenCalled();
  expect(forward).not.toHaveBeenCalled();
  expect(ack).toHaveBeenCalledOnce();
});

it("a non-events_api message is not logged as an inbound event", async () => {
  const info = vi.fn();
  await startSocket({ appToken: "xapp-test", store: openStore(":memory:"), log: { info, warn() {}, error() {} } as never, pair: async () => false });
  const handle = handlers.at(-1)!;
  await handle({ type: "hello", body: {}, ack: async () => {} });
  expect(info.mock.calls.filter((c) => c[1] === "slack event in")).toEqual([]);
});
