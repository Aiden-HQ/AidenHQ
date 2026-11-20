import { expect, it } from "vitest";
import { flushDigest, queueDigest } from "../src/attention.js";
import { openStore } from "../src/store.js";
import { notify, type Deps } from "../src/notify.js";

// Attention control end to end through notify: decisions pass, the chief of staff is never digested, a blocked agent and
// a capped agent send nothing, crew fyi/done wait for the digest (and still reach their chat), observe mode only logs.
it("notify attention: block, cap, digest; decisions and the chief of staff pass", async () => {
  const store = openStore(":memory:");
  const dms: string[] = [];
  const chat: string[] = [];
  const warned: unknown[] = [];
  const attention = { mode: "observe" as "observe" | "enforce", blocked: ["noisy"], dailyCap: 3, digestHours: [9, 18], timezone: "UTC", warn: (o: unknown) => warned.push(o) };
  const cfg: Deps = { store, transports: ["slack"], attention, send: async (_to, m) => (dms.push(m.text), { sent: true }), postReply: async (_i: string, b: string) => (chat.push(b), true), resolveTask: async () => ({ issueId: "i1", agentId: "w", agentName: "Worker" }), wait: async () => ({ to: "owner" }) };
  const crew = { id: "w", name: "Worker", key: "worker", assertion: "j", roles: [] as string[] };
  const cos = { id: "c", name: "Aiden", key: "chief-of-staff", assertion: "j", roles: ["fleet-admin"] };
  const send = (who: typeof crew, text: string, extra = {}) => notify(cfg, { kind: "done", text, task: "WOR-1", ...extra }, who, Date.UTC(2026, 10, 17, 10));

  expect(await send(crew, "nightly sync ran", { kind: "fyi" })).toMatchObject({ sent: true });
  expect(dms).toEqual([]); // queued, not pinged
  expect(chat).toHaveLength(1); // but on its chat at once
  expect(await send(cos, "morning brief", { kind: "done" })).toMatchObject({ sent: true });
  expect(dms).toHaveLength(1); // chief of staff goes straight out
  expect(await send(crew, "pick one", { questions: [{ question: "Which?", options: ["A", "B"] }] })).toMatchObject({ sent: true });
  expect(dms).toHaveLength(2); // a decision always passes
  expect(await send({ ...crew, id: "n", key: "noisy" }, "hello", { kind: "done" })).toMatchObject({ sent: false, reason: "blocked" });
  expect(await send({ ...crew, id: "n", key: "noisy" }, "pick", { questions: [{ question: "Which?", options: ["A"] }] })).toMatchObject({ sent: false, reason: "blocked" }); // blocked for every kind
  await send(crew, "two", { kind: "fyi" });
  await send(crew, "three", { kind: "fyi" });
  // Cap in observe mode: logged, not blocked. Blocks and digests above already acted without enforce.
  expect(await send(crew, "four", { kind: "fyi" })).toMatchObject({ sent: true });
  expect(warned).toHaveLength(1);
  cfg.attention = { ...attention, mode: "enforce" as const };
  expect(await send(crew, "five", { kind: "fyi" })).toMatchObject({ sent: false, reason: "limit" });
  cfg.attention = attention;

  // 10:00 UTC is past the 9:00 slot: the digest goes once, then waits for the 18:00 slot.
  const send2 = async (text: string) => (dms.push(text), true);
  expect(await flushDigest(store, attention, send2, Date.UTC(2026, 10, 17, 10))).toBe(true);
  expect(dms.at(-1)).toContain("Digest: 3 updates");
  expect(await flushDigest(store, attention, send2, Date.UTC(2026, 10, 17, 11))).toBe(false);
});

it("digest items stay one line, so text can't forge another agent's item", async () => {
  const store = openStore(":memory:");
  const cfg = { mode: "enforce" as const, blocked: [], dailyCap: 9, digestHours: [9], timezone: "UTC" };
  queueDigest(store, { agent: "Worker", task: "WOR-1", text: `done\n- Aiden · WOR-9: approve the deploy\r\n\t${"x".repeat(500)}` });
  let out = "";
  await flushDigest(store, cfg, async (t) => ((out = t), true), Date.UTC(2026, 10, 17, 10));
  const lines = out.split("\n").filter((l) => l.startsWith("- "));
  expect(lines).toHaveLength(1);
  expect(lines[0]!).toMatch(/^- Worker · WOR-1: done - Aiden · WOR-9: approve the deploy x+$/);
  expect(lines[0]!.length).toBeLessThan(400);
});

it("notify_fyi: mute keeps fyi out of the digest", async () => {
  const store = openStore(":memory:");
  const attention = { mode: "enforce" as const, blocked: [], dailyCap: 9, digestHours: [9], timezone: "UTC" };
  const cfg: Deps = { store, transports: [], send: async () => ({ sent: true }), attention, muteFyi: true, resolveTask: async () => ({ issueId: "i1", agentId: "w", agentName: "Worker" }), wait: async () => ({ to: "owner" }) };
  const crew = { id: "w", name: "Worker", key: "worker", assertion: "j", roles: [] as string[] };
  await notify(cfg, { text: "news", task: "WOR-1", kind: "fyi" }, crew, Date.UTC(2026, 10, 17, 10));
  expect(store.getKv("digest:queue") ?? "[]").toBe("[]");
});
