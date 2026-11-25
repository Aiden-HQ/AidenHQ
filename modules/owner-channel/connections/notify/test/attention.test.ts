import { expect, it } from "vitest";
import { dropQueuedNeeds, flushDigest, queueDigest } from "../src/attention.js";
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

it("a long digest goes as several messages under the transport limit, each told once it went", async () => {
  const store = openStore(":memory:");
  const cfg = { mode: "enforce" as const, blocked: [], dailyCap: 99, digestHours: [9], timezone: "UTC" };
  for (let n = 0; n < 20; n++) queueDigest(store, { agent: "Worker", text: `${n} ${"x".repeat(300)}`, source: "worker" });
  const sent: string[] = [];
  let fail = 2; // the second message fails: its items and the rest stay queued
  expect(await flushDigest(store, cfg, async (t) => (--fail === 0 ? false : (sent.push(t), true)), Date.UTC(2026, 10, 17, 9))).toBe(false);
  expect(sent).toHaveLength(1);
  expect(sent[0]!.length).toBeLessThanOrEqual(3100);
  const left = JSON.parse(store.getKv("digest:queue")!).length;
  expect(store.recentTold(3, 50, Date.UTC(2026, 10, 17, 9)).length + left).toBe(20);
  expect(await flushDigest(store, cfg, async (t) => (sent.push(t), true), Date.UTC(2026, 10, 17, 9, 5))).toBe(true);
  expect(sent.every((t) => t.length <= 3100)).toBe(true);
  expect(store.recentTold(3, 50, Date.UTC(2026, 10, 17, 9, 5))).toHaveLength(20);
});

it("a digest appends the kernel's confirmed connection needs, and says so when it can't read them", async () => {
  const cfg = { digestHours: [9], timezone: "UTC", mode: "observe" as const, blocked: [], dailyCap: 99 };
  const at = Date.UTC(2026, 10, 17, 9);
  const run = async (needs: () => Promise<string[]>, queued = true) => {
    const store = openStore(":memory:");
    if (queued) queueDigest(store, { agent: "Worker", text: "other" }, at - 1000);
    let out = "";
    await flushDigest(store, cfg, async (t) => ((out = t), true), at, needs);
    return { out, left: JSON.parse(store.getKv("digest:queue") || "[]") as unknown[] };
  };
  const ok = await run(async () => ["GitHub isn't connected (not connected): https://board/connect/github"]);
  expect(ok.out).toContain("other");
  expect(ok.out).toContain("GitHub isn't connected");
  expect(ok.left).toEqual([]);
  expect((await run(async () => [])).out).not.toContain("connect");
  expect((await run(async () => { throw new Error("kernel down"); })).out).toContain("couldn't check connections");
  expect((await run(async () => ["GitHub isn't connected"], false)).out).toContain("GitHub isn't connected");
  expect((await run(async () => { throw new Error("kernel down"); }, false)).out).toBe("");
});

it("a digest that fails partway does not resend the connection lines already delivered (afdc1671)", async () => {
  const cfg = { digestHours: [9], timezone: "UTC", mode: "observe" as const, blocked: [], dailyCap: 99 };
  const at = Date.UTC(2026, 10, 17, 9);
  const store = openStore(":memory:");
  for (let n = 0; n < 8; n++) queueDigest(store, { agent: "Worker", text: `${n} ${"x".repeat(300)}` }, at - 1000);
  const lines = [`GitHub isn't connected: ${"a".repeat(260)}`, `Google isn't connected: ${"b".repeat(260)}`];
  const sent: string[] = [];
  let calls = 0;
  await flushDigest(store, cfg, async (t) => (++calls === 2 ? false : (sent.push(t), true)), at, async () => lines);
  expect(sent.join("\n")).toContain("GitHub isn't connected");
  expect(sent.join("\n")).not.toContain("Google isn't connected");
  await flushDigest(store, cfg, async (t) => (sent.push(t), true), at + 60_000, async () => lines);
  const all = sent.join("\n");
  expect(all.split("GitHub isn't connected").length - 1).toBe(1);
  expect(all.split("Google isn't connected").length - 1).toBe(1);
});

it("queued connection lines from before the digest pulled them are dropped at startup (1099443c)", () => {
  const store = openStore(":memory:");
  queueDigest(store, { agent: "AidenHQ", text: "GitHub isn't connected (not connected): http://board/connect/github", source: "kernel" });
  queueDigest(store, { agent: "AidenHQ", text: "Google isn't connected (sign-in expired), and work is waiting on it: http://board/connect/google", source: "kernel" });
  queueDigest(store, { agent: "Worker", text: "other" });
  dropQueuedNeeds(store);
  expect((JSON.parse(store.getKv("digest:queue")!) as { text: string }[]).map((i) => i.text)).toEqual(["other"]);
});

it("a connection line keeps its whole reconnect link in the digest (d5305a6e)", async () => {
  const cfg = { digestHours: [9], timezone: "UTC", mode: "observe" as const, blocked: [], dailyCap: 99 };
  const link = `https://github.com/orgs/acme/sso?${"q".repeat(450)}`;
  const store = openStore(":memory:");
  queueDigest(store, { agent: "Worker", text: "other" }, Date.UTC(2026, 10, 17, 8));
  let out = "";
  await flushDigest(store, cfg, async (t) => ((out = t), true), Date.UTC(2026, 10, 17, 9), async () => [`GitHub isn't connected (acme needs SSO authorization): ${link}`]);
  expect(out).toContain(link);
});

// A connection need the kernel queues is a decision: decisions never wait for the digest, so its loopback caveat (next to
// the /connect link) reaches the owner whole, never through the digest line's 300-character clip (AidenHQ#1755).
it("a connection decision reaches the owner whole on a channel, caveat included, and is never digested", async () => {
  const store = openStore(":memory:");
  const caveat = "(this address is loopback-only: open it on this host or through the SSH tunnel setup printed; for a real address, run sudo ops/setup.sh --unattended --exposure public, or --exposure tailscale for remote access over a tailnet)";
  const text = `Google needs you to connect it so I can ${"x".repeat(80)}: http://localhost:3121/connect/google ${caveat}`;
  const sent: { kind: string; text: string }[] = [];
  const attention = { mode: "enforce" as const, blocked: [], dailyCap: 99, digestHours: Array.from({ length: 24 }, (_, h) => h), timezone: "UTC" };
  const d: Deps = { store, transports: ["channel-telegram"], attention, send: async (_to, m) => (sent.push(m), { sent: true }) };
  await notify(d, { kind: "decision", text, task: "WOR-1", head: { agentName: "Aiden", issueId: "i1" } });
  expect(sent).toHaveLength(1);
  expect(sent[0]!.text).toContain("http://localhost:3121/connect/google");
  expect(sent[0]!.text).toContain(caveat);
  expect(JSON.parse(store.getKv("digest:queue") || "[]")).toEqual([]);
});
