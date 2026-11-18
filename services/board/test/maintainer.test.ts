import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { maintainerIssues, maintainerTick, maintainerTriageWake, maintainerWake, startMaintainer, type MaintainerBatch, type MaintainerIssue, type MaintainerRepoBatch } from "../src/maintainer.js";

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

const R = "acme/product";
type OneRepo = Omit<MaintainerRepoBatch, "repo">;
/** A github-mcp stand-in for one repo, R: each call answers with the next batch, and `seen` records R's cursor asked for. */
function server(batches: (OneRepo | Error)[], seen: string[] = []) {
  return many(batches.map((b) => (b instanceof Error ? b : { repos: [{ repo: R, ...b }] })), (c) => seen.push(c[R] ?? ""));
}
/** A github-mcp stand-in over any repos: each call answers with the next batch. */
function many(batches: (MaintainerBatch | Error)[], saw: (cursors: Record<string, string>) => void = () => {}) {
  let i = 0;
  return async (cursors: Record<string, string>) => {
    saw(cursors);
    const next = batches[Math.min(i++, batches.length - 1)]!;
    if (next instanceof Error) throw next;
    return next;
  };
}
const stored = (store: ReturnType<typeof kv>) => JSON.parse(store.meta("maintainer_issues")!);

describe("the Maintainer's issue watcher", () => {
  it("a trusted issue fires exactly one webhook, with its number", async () => {
    const fired: MaintainerIssue[] = [];
    const count = await maintainerTick({ issues: server([{ issues: [issue(41)], cursor: "c1" }]), fire: async (_r, i) => (fired.push(i), true), store: kv(), log: logs() });
    expect(count).toBe(1);
    expect(fired.map((i) => i.number)).toEqual([41]);
  });

  it("an untrusted issue fires nothing and is logged once, across ticks", async () => {
    const log = logs(), fired: MaintainerIssue[] = [], store = kv();
    const issues = server([{ issues: [issue(41, false)], cursor: "c1" }]);
    await maintainerTick({ issues, fire: async (_r, i) => (fired.push(i), true), store, log });
    await maintainerTick({ issues, fire: async (_r, i) => (fired.push(i), true), store, log });
    expect(fired).toEqual([]);
    expect(log.infoLines).toHaveLength(1);
    expect(log.infoLines[0]!.m).toMatch(/untrusted/);
    expect(log.infoLines[0]!.o).toMatchObject({ issue: 41, actor: "stranger" });
  });

  it("the same issue twice across two polls fires once", async () => {
    const fired: number[] = [], store = kv(), seen: string[] = [];
    const issues = server([{ issues: [issue(7)], cursor: "c1" }, { issues: [issue(7)], cursor: "c2" }], seen);
    const tick = () => maintainerTick({ issues, fire: async (_r, i) => (fired.push(i.number), true), store, log: logs() });
    await tick();
    await tick();
    expect(fired).toEqual([7]);
    expect(seen).toEqual(["", "c1"]);
  });

  it("a restart with the stored cursor re-fires nothing and skips nothing", async () => {
    const fired: number[] = [], store = kv();
    // The first board delivers issue 1 and stores cursor c1.
    await maintainerTick({ issues: server([{ issues: [issue(1)], cursor: "c1" }]), fire: async (_r, i) => (fired.push(i.number), true), store, log: logs() });
    // The restarted board asks from c1; github-mcp still names the delivered issue and a new one.
    const seen: string[] = [];
    const issues = server([{ issues: [issue(1), issue(2)], cursor: "c2" }], seen);
    await maintainerTick({ issues, fire: async (_r, i) => (fired.push(i.number), true), store, log: logs() });
    expect(seen).toEqual(["c1"]);
    expect(fired).toEqual([1, 2]);
  });

  it("a github-mcp error leaves the cursor unchanged, fires nothing and says it once", async () => {
    const fired: number[] = [], store = kv(), log = logs();
    await maintainerTick({ issues: server([{ issues: [], cursor: "c1" }]), fire: async (_r, i) => (fired.push(i.number), true), store, log });
    const down = server([new Error("github-mcp is not reachable")]);
    await maintainerTick({ issues: down, fire: async (_r, i) => (fired.push(i.number), true), store, log });
    await maintainerTick({ issues: down, fire: async (_r, i) => (fired.push(i.number), true), store, log });
    expect(fired).toEqual([]);
    expect(log.warnLines).toHaveLength(1);
    expect(stored(store).repos[R].cursor).toBe("c1");
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
        return { repos: [{ repo: R, issues: [], cursor: `c${calls}` }] };
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
      const issues = async () => (calls++, { repos: [{ repo: R, issues: [], cursor: "c" }] });
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
    const fire = async (_r: string, i: MaintainerIssue) => {
      if (refuse && i.number === 4) return false;
      fired.push(i.number);
      return true;
    };
    await maintainerTick({ issues, fire, store, log: logs() });
    refuse = false;
    await maintainerTick({ issues, fire, store, log: logs() });
    expect(fired).toEqual([3, 4]);
    expect(stored(store).repos[R].cursor).toBe("c2");
  });

  it("watches every repo from its own cursor: the same number on two repos fires twice, and one repo's failure holds up no other", async () => {
    const O = "acme/widgets";
    const fired: string[] = [], store = kv(), log = logs(), asked: Record<string, string>[] = [];
    const issues = many(
      [
        { repos: [{ repo: R, issues: [issue(5)], cursor: "r1" }, { repo: O, issues: [issue(5)], cursor: "o1" }] },
        { repos: [{ repo: R, issues: [issue(6)], cursor: "r2" }, { repo: O, error: "couldn't list acme/widgets's issues" }] },
      ],
      (c) => asked.push(c),
    );
    const tick = () => maintainerTick({ issues, fire: async (r, i) => (fired.push(`${r}#${i.number}`), true), store, log });
    await tick();
    await tick();
    expect(fired).toEqual([`${R}#5`, `${O}#5`, `${R}#6`]);
    expect(asked).toEqual([{}, { [R]: "r1", [O]: "o1" }]);
    expect(stored(store).repos[R].cursor).toBe("r2");
    expect(stored(store).repos[O].cursor).toBe("o1");
    expect(log.warnLines.map((l) => l.o)).toEqual([{ repo: O, err: "couldn't list acme/widgets's issues" }]);
  });

  it("the single-repo state from before maintainer_repos is taken over by the first repo, so nothing fires again", async () => {
    const fired: number[] = [], store = kv();
    store.setMeta("maintainer_issues", JSON.stringify({ cursor: "c0", fired: [7], noted: [9] }));
    await maintainerTick({ issues: server([{ issues: [issue(7), issue(8), issue(9, false)], cursor: "c1" }]), fire: async (_r, i) => (fired.push(i.number), true), store, log: logs() });
    expect(fired).toEqual([8]);
    expect(stored(store)).toEqual({ repos: { [R]: { cursor: "c1", fired: [7, 8], noted: [9] } } });
  });

  it("the webhook names the issue's repo and number", async () => {
    const dir = mkdtempSync(join(tmpdir(), "maintainer-"));
    writeFileSync(join(dir, "url"), "http://paperclip:3100/hook");
    writeFileSync(join(dir, "secret"), "s".repeat(32));
    const sent: string[] = [];
    vi.stubGlobal("fetch", async (_u: string, init: RequestInit) => (sent.push(String(init.body)), new Response(null, { status: 202 })));
    try {
      const fire = maintainerWake({ MAINTAINER_WEBHOOK_URL_FILE: join(dir, "url"), MAINTAINER_WEBHOOK_SECRET_FILE: join(dir, "secret") })!;
      expect(await fire(R, issue(12))).toBe(true);
      expect(JSON.parse(sent[0]!)).toEqual({ repo: R, number: "12", title: "Issue 12" });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("the Maintainer's per-issue triage", () => {
  const at = (h: number) => `2026-01-01T${String(h).padStart(2, "0")}:00:00Z`;
  it("each new unlabelled issue fires one triage run, number only; a refusal resumes there; the backlog is never fired", async () => {
    const store = kv(), asked: (Record<string, string> | undefined)[] = [];
    let refuse = 0;
    const fired: number[] = [];
    const batches: MaintainerBatch[] = [
      { repos: [{ repo: R, issues: [], cursor: "c1", untriaged: [], triage_cursor: at(1) }] }, // the first look: cursor only
      { repos: [{ repo: R, issues: [], cursor: "c1", untriaged: [{ number: 5, created_at: at(2) }, { number: 6, created_at: at(3) }], triage_cursor: at(3) }] },
      { repos: [{ repo: R, issues: [], cursor: "c1", untriaged: [{ number: 6, created_at: at(3) }], triage_cursor: at(3) }] },
      { repos: [{ repo: R, issues: [], cursor: "c1" }] }, // an older github-mcp: nothing to triage, the state kept
    ];
    let i = 0;
    const issues = async (_c: Record<string, string>, triage?: Record<string, string>) => (asked.push(triage), batches[i++]!);
    const triage = async (repo: string, n: number) => (repo === R && n === 6 && refuse-- > 0 ? false : (fired.push(n), true));
    const tick = () => maintainerTick({ issues, fire: async () => true, triage, store, log: logs() });
    await tick();
    refuse = 1;
    expect(await tick()).toBe(1);
    expect(stored(store).repos[R].triage_cursor).toBe(at(2));
    await tick();
    await tick();
    expect(fired).toEqual([5, 6]);
    expect(asked).toEqual([{}, { [R]: at(1) }, { [R]: at(2) }, { [R]: at(3) }]);
    expect(stored(store).repos[R]).toMatchObject({ triage_cursor: at(3), triaged: [5, 6] });
    // Without the triage webhook the read asks for no new issues at all.
    const plain: unknown[] = [];
    await maintainerTick({ issues: async (...a: unknown[]) => (plain.push(a.length), { repos: [] }), fire: async () => true, store: kv(), log: logs() });
    expect(plain).toEqual([1]);
  });

  it("caps the runs a day per author and per repo, leaving the rest to the daily run", async () => {
    const fired: number[] = [], store = kv(), log = logs();
    const u = (number: number, author: string) => ({ number, created_at: at(number), author });
    const batch: MaintainerBatch = { repos: [{ repo: R, issues: [], cursor: "c1", untriaged: [u(1, "spam"), u(2, "Spam"), u(3, "ada"), u(4, "bob")], triage_cursor: at(4) }] };
    store.setMeta("maintainer_issues", JSON.stringify({ repos: { [R]: { triage_cursor: at(0) } } }));
    const tick = () => maintainerTick({ issues: async () => batch, fire: async () => true, triage: async (_r, n) => (fired.push(n), true), limits: { perAuthor: 1, perRepo: 2 }, store, log });
    await tick();
    await tick();
    expect(fired).toEqual([1, 3]);
    expect(log.infoLines.filter((l) => /triage limit reached/.test(l.m)).map((l) => (l.o as { issue: number }).issue)).toEqual([2, 4]);
    expect(stored(store).repos[R].triaged).toEqual([1, 2, 3, 4]);
  });

  it("is off when external triage is off, and sends the repo and number only", async () => {
    const dir = mkdtempSync(join(tmpdir(), "triage-"));
    writeFileSync(join(dir, "url"), "http://paperclip:3100/hook");
    writeFileSync(join(dir, "secret"), "s".repeat(32));
    const env = { MAINTAINER_TRIAGE_WEBHOOK_URL_FILE: join(dir, "url"), MAINTAINER_TRIAGE_WEBHOOK_SECRET_FILE: join(dir, "secret") };
    expect(maintainerTriageWake({ ...env, MAINTAINER_EXTERNAL_TRIAGE: "false" })).toBeUndefined();
    const sent: string[] = [];
    vi.stubGlobal("fetch", async (_u: string, init: RequestInit) => (sent.push(String(init.body)), new Response("", { status: 202 })));
    try {
      expect(await maintainerTriageWake({ ...env, MAINTAINER_EXTERNAL_TRIAGE: "true" })!(R, 9)).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(JSON.parse(sent[0]!)).toEqual({ repo: R, number: "9" });
  });
});
