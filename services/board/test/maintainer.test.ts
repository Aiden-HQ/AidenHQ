import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { maintainerIssues, maintainerTick, maintainerWake, startMaintainer, type MaintainerBatch, type MaintainerIssue } from "../src/maintainer.js";

const kv = () => {
  const m = new Map<string, string>();
  return { meta: (k: string) => m.get(k), setMeta: (k: string, v: string) => void m.set(k, v) };
};
const logs = () => {
  const info: { o: object; m: string }[] = [];
  const warn: { o: object; m: string }[] = [];
  return { info: (o: object, m: string) => void info.push({ o, m }), warn: (o: object, m: string) => void warn.push({ o, m }), infoLines: info, warnLines: warn };
};
const issue = (number: number, trusted = true): MaintainerIssue => ({ number, title: `Issue ${number}`, trusted, labeled_at: "2026-01-01T00:00:00Z", actor: trusted ? "maintainer" : "stranger" });

/** A github-mcp stand-in: each call answers with the next batch, and `seen` records the cursor asked for. */
function server(batches: (MaintainerBatch | Error)[], seen: string[] = []) {
  let i = 0;
  return async (since: string) => {
    seen.push(since);
    const next = batches[Math.min(i++, batches.length - 1)]!;
    if (next instanceof Error) throw next;
    return next;
  };
}

describe("the Maintainer's issue watcher", () => {
  it("a trusted issue fires exactly one webhook, with its number", async () => {
    const fired: MaintainerIssue[] = [];
    const count = await maintainerTick({ issues: server([{ issues: [issue(41)], cursor: "c1" }]), fire: async (i) => (fired.push(i), true), store: kv(), log: logs() });
    expect(count).toBe(1);
    expect(fired.map((i) => i.number)).toEqual([41]);
  });

  it("an untrusted issue fires nothing and is logged once, across ticks", async () => {
    const log = logs(), fired: MaintainerIssue[] = [], store = kv();
    const issues = server([{ issues: [issue(41, false)], cursor: "c1" }]);
    await maintainerTick({ issues, fire: async (i) => (fired.push(i), true), store, log });
    await maintainerTick({ issues, fire: async (i) => (fired.push(i), true), store, log });
    expect(fired).toEqual([]);
    expect(log.infoLines).toHaveLength(1);
    expect(log.infoLines[0]!.m).toMatch(/untrusted/);
    expect(log.infoLines[0]!.o).toMatchObject({ issue: 41, actor: "stranger" });
  });

  it("the same issue twice across two polls fires once", async () => {
    const fired: number[] = [], store = kv(), seen: string[] = [];
    const issues = server([{ issues: [issue(7)], cursor: "c1" }, { issues: [issue(7)], cursor: "c2" }], seen);
    const tick = () => maintainerTick({ issues, fire: async (i) => (fired.push(i.number), true), store, log: logs() });
    await tick();
    await tick();
    expect(fired).toEqual([7]);
    expect(seen).toEqual(["", "c1"]);
  });

  it("a restart with the stored cursor re-fires nothing and skips nothing", async () => {
    const fired: number[] = [], store = kv();
    // The first board delivers issue 1 and stores cursor c1.
    await maintainerTick({ issues: server([{ issues: [issue(1)], cursor: "c1" }]), fire: async (i) => (fired.push(i.number), true), store, log: logs() });
    // The restarted board asks from c1; github-mcp still names the delivered issue and a new one.
    const seen: string[] = [];
    const issues = server([{ issues: [issue(1), issue(2)], cursor: "c2" }], seen);
    await maintainerTick({ issues, fire: async (i) => (fired.push(i.number), true), store, log: logs() });
    expect(seen).toEqual(["c1"]);
    expect(fired).toEqual([1, 2]);
  });

  it("a github-mcp error leaves the cursor unchanged, fires nothing and says it once", async () => {
    const fired: number[] = [], store = kv(), log = logs();
    await maintainerTick({ issues: server([{ issues: [], cursor: "c1" }]), fire: async (i) => (fired.push(i.number), true), store, log });
    const down = server([new Error("github-mcp is not reachable")]);
    await maintainerTick({ issues: down, fire: async (i) => (fired.push(i.number), true), store, log });
    await maintainerTick({ issues: down, fire: async (i) => (fired.push(i.number), true), store, log });
    expect(fired).toEqual([]);
    expect(log.warnLines).toHaveLength(1);
    expect(JSON.parse(store.meta("maintainer_issues")!).cursor).toBe("c1");
  });

  it("polls every 5 minutes by default and skips a tick while the last call is still in flight", async () => {
    vi.useFakeTimers();
    try {
      delete process.env.MAINTAINER_POLL_MINUTES;
      let calls = 0;
      let release = () => {};
      const issues = async () => {
        calls++;
        await new Promise<void>((r) => (release = r));
        return { issues: [], cursor: `c${calls}` };
      };
      startMaintainer({ wiring: () => ({ issues, fire: async () => true }), store: kv(), log: logs() });
      await vi.advanceTimersByTimeAsync(60_000); // the first look, a minute after start
      expect(calls).toBe(1);
      await vi.advanceTimersByTimeAsync(60_000); // still in flight: this tick does nothing
      expect(calls).toBe(1);
      release();
      await vi.advanceTimersByTimeAsync(5 * 60_000); // the default interval, not 1 minute
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is off until a module supplies github-mcp's token and the routine's webhook", () => {
    const dir = mkdtempSync(join(tmpdir(), "maintainer-"));
    expect(maintainerIssues({})).toBeUndefined();
    expect(maintainerIssues({ MAINTAINER_ISSUES_TOKEN_FILE: join(dir, "absent") })).toBeUndefined();
    expect(maintainerWake({ MAINTAINER_WEBHOOK_URL_FILE: join(dir, "absent"), MAINTAINER_WEBHOOK_SECRET_FILE: join(dir, "absent") })).toBeUndefined();
    writeFileSync(join(dir, "token"), "t".repeat(32));
    expect(typeof maintainerIssues({ MAINTAINER_ISSUES_TOKEN_FILE: join(dir, "token") })).toBe("function");
  });

  it("picks up a webhook setup writes after the board started, without a restart", async () => {
    vi.useFakeTimers();
    try {
      const dir = mkdtempSync(join(tmpdir(), "maintainer-"));
      const env = { MAINTAINER_WEBHOOK_URL_FILE: join(dir, "url"), MAINTAINER_WEBHOOK_SECRET_FILE: join(dir, "secret"), MAINTAINER_ISSUES_TOKEN_FILE: join(dir, "token") };
      // apply started the board with the webhook files still empty (compile creates optional secrets empty).
      for (const f of Object.values(env)) writeFileSync(f, "");
      writeFileSync(env.MAINTAINER_ISSUES_TOKEN_FILE, "t".repeat(32));
      let calls = 0;
      const issues = async () => (calls++, { issues: [], cursor: "c" });
      const log = logs();
      startMaintainer({ wiring: () => (maintainerWake(env) && maintainerIssues(env) ? { issues, fire: async () => true } : undefined), store: kv(), log, minutes: 1 });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(calls).toBe(0);
      expect(log.infoLines.map((l) => l.m)).toEqual([expect.stringMatching(/waiting/)]);
      // setup writes the routine's webhook.
      writeFileSync(env.MAINTAINER_WEBHOOK_URL_FILE, "http://paperclip:3100/hook");
      writeFileSync(env.MAINTAINER_WEBHOOK_SECRET_FILE, "s".repeat(32));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(calls).toBe(1);
      expect(log.infoLines.at(-1)!.m).toBe("maintainer issue watcher on");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a refused webhook holds the cursor and is retried, without delivering the earlier ones again", async () => {
    const fired: number[] = [], store = kv();
    let refuse = true;
    const issues = server([{ issues: [issue(3), issue(4)], cursor: "c2" }]);
    const fire = async (i: MaintainerIssue) => {
      if (refuse && i.number === 4) return false;
      fired.push(i.number);
      return true;
    };
    await maintainerTick({ issues, fire, store, log: logs() });
    refuse = false;
    await maintainerTick({ issues, fire, store, log: logs() });
    expect(fired).toEqual([3, 4]);
    expect(JSON.parse(store.meta("maintainer_issues")!).cursor).toBe("c2");
  });
});
