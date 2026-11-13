// The board's loading primitives (web/src): default agent avatars and the stale-while-revalidate cache.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { faceOf, initials, tone } from "../web/src/avatar.js";

describe("agent avatars", () => {
  it("draws the same monogram for a name on every load, and the portrait until it fails", () => {
    expect(initials("Slack Scout")).toBe("SS");
    expect(initials("Aiden")).toBe("Ai");
    expect(initials("Engineer · Linus")).toBe("Li");
    expect(initials("  ")).toBe("?");
    expect(tone("Fleet Ops")).toBe(tone("Fleet Ops"));
    expect(tone("Engineer · Linus")).toBe(tone("Linus"));
    expect(new Set(["Aiden", "Alfred", "Slack Scout", "Fleet Ops", "Coach", "Librarian", "Meeting Librarian", "Architect"].map(tone)).size).toBeGreaterThan(3);
    expect(faceOf("Alfred", "alfred")).toEqual({ kind: "portrait", src: "/crew/alfred.svg" });
    expect(faceOf("Alfred", "alfred", true)).toEqual({ kind: "monogram", text: "Al", tone: tone("Alfred") });
    expect(faceOf("Fleet Ops", undefined)).toMatchObject({ kind: "monogram", text: "FO" });
    expect(faceOf("X", "../etc")).toMatchObject({ kind: "monogram" });
  });
});

/** A page load: a fresh copy of the cache module over the same localStorage. */
const pageLoad = async () => {
  vi.resetModules();
  return import("../web/src/cache.js");
};

describe("cache (stale while revalidate)", () => {
  beforeEach(() => {
    const items = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      get length() {
        return items.size;
      },
      key: (i: number) => [...items.keys()][i] ?? null,
      getItem: (k: string) => items.get(k) ?? null,
      setItem: (k: string, v: string) => void items.set(k, v),
      removeItem: (k: string) => void items.delete(k),
    });
  });

  it("shows the last good response after a reload, then the fresh one", async () => {
    let c = await pageLoad();
    c.setAccount("acct-1");
    await c.load("apps", async () => ({ apps: ["old"] }));
    expect(c.peek("apps")?.data).toEqual({ apps: ["old"] });

    c = await pageLoad();
    expect(c.peek("apps")).toBeUndefined(); // nobody signed in yet: nothing shown
    c.setAccount("acct-1");
    const cached = c.peek<{ apps: string[] }>("apps")!;
    expect(cached.data).toEqual({ apps: ["old"] });
    await c.load("apps", async () => ({ apps: ["new"] }));
    expect(c.peek("apps")?.data).toEqual({ apps: ["new"] });
    expect(c.peek("apps")!.at).toBeGreaterThanOrEqual(cached.at);
  });

  it("paints the device's last data at boot, before the session answers; a different account then drops it", async () => {
    let c = await pageLoad();
    c.setAccount("acct-1");
    await c.load("board", async () => ({ cards: 3 }));
    c = await pageLoad();
    c.adoptStoredAccount();
    expect(c.peek("board")?.data).toEqual({ cards: 3 });
    c.setAccount("acct-2");
    expect(c.peek("board")).toBeUndefined();
  });

  it("keeps unchanged parts of a refetch the same objects, so rows that didn't change don't re-render", async () => {
    const c = await pageLoad();
    const first = await c.load("chats.W-1", async () => ({ messages: [{ id: "a", text: "hi" }, { id: "b", text: "yo" }], state: "idle" }), false);
    const same = await c.load("chats.W-1", async () => ({ messages: [{ id: "a", text: "hi" }, { id: "b", text: "yo" }], state: "idle" }), false);
    expect(same).toBe(first);
    const next = await c.load("chats.W-1", async () => ({ messages: [{ id: "a", text: "hi" }, { id: "b", text: "yo" }, { id: "c", text: "new" }], state: "working" }), false);
    expect(next).not.toBe(first);
    expect(next.messages[0]).toBe(first.messages[0]);
    expect(next.messages[1]).toBe(first.messages[1]);
    expect(c.peek("chats.W-1")?.data).toBe(next);
  });

  it("never shows another account's data, keeps memory-only keys off the device, and forgets everything on a 401", async () => {
    let c = await pageLoad();
    c.setAccount("acct-1");
    await c.load("apps", async () => ({ apps: ["mine"] }));
    await c.load("approvals", async () => ({ approvals: [1] }), false);
    expect(localStorage.getItem("aidenhq.cache.approvals")).toBeNull();

    c = await pageLoad();
    c.setAccount("acct-2");
    expect(c.peek("apps")).toBeUndefined();

    c.setAccount("acct-2");
    await c.load("apps", async () => ({ apps: ["two"] }));
    // api.ts's SignInRequired (a 401) is an Error with this message.
    await expect(c.load("activity", async () => Promise.reject(new Error("sign in")))).rejects.toThrow("sign in");
    expect(c.peek("apps")).toBeUndefined();
    expect(localStorage.getItem("aidenhq.cache.apps")).toBeNull();
  });
});
