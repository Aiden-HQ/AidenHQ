// The socket ingress line: one info log per inbound events_api message, with its shape and never its text, before the pairing,
// owner-chat and routing filters can drop it. A DM that pairs nobody must still be observable.
import { expect, it, vi } from "vitest";

const handlers: ((msg: unknown) => Promise<void>)[] = [];
const states: ((s: string) => void)[] = [];
vi.mock("@slack/socket-mode", () => ({ default: { SocketModeClient: class { on(ev: string, fn: (msg: unknown) => Promise<void>) { if (ev === "slack_event") handlers.push(fn); else if (ev === "connected" || ev === "disconnected") states.push(fn as unknown as (s: string) => void); } async start() {} } } }));
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

  // Connects and disconnects reach /healthz's state.
  (states[0] as () => void)();
  expect(onState).toHaveBeenLastCalledWith("connected");
  (states[1] as () => void)();
  expect(onState).toHaveBeenLastCalledWith("disconnected");
});

it("a non-events_api message is not logged as an inbound event", async () => {
  const info = vi.fn();
  await startSocket({ appToken: "xapp-test", store: openStore(":memory:"), log: { info, warn() {}, error() {} } as never, pair: async () => false });
  const handle = handlers.at(-1)!;
  await handle({ type: "hello", body: {}, ack: async () => {} });
  expect(info.mock.calls.filter((c) => c[1] === "slack event in")).toEqual([]);
});
