import { expect, it } from "vitest";
import { createAccess, GitHubNeed, needResult } from "../src/client.js";
import { readNeed } from "../src/vendor/needs.js";
import type { Auth } from "../src/vendor/oauth.js";

const auth = (): Auth => {
  let state: "ok" | "expired" = "ok";
  return {
    headers: async () => ({ authorization: "Bearer gho_owner" }),
    refresh: async () => {},
    status: () => ({ state, since: "" }),
    mark: (s) => void (state = s),
    signedIn: () => true,
  };
};
const answer = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });
/** A timer on a fake clock: `advance` sleeps and fires whatever came due, in order of due time. */
const fakeTime = () => {
  let clock = 1_000_000;
  const pending: { at: number; fire: () => void; cancelled: boolean }[] = [];
  return {
    now: () => clock,
    get at() { return clock; },
    timer: (ms: number, fire: () => void) => {
      const t = { at: clock + ms, fire, cancelled: false };
      pending.push(t);
      return () => void (t.cancelled = true);
    },
    async sleep(ms: number) {
      clock += ms;
      for (;;) {
        const due = pending.filter((t) => !t.cancelled && t.at <= clock).sort((a, b) => a.at - b.at)[0];
        if (!due) return;
        due.cancelled = true;
        // A real timer never throws into the caller that happens to be sleeping; a rejection goes through its promise.
        try { due.fire(); } catch { /* delivered by the promise the timer rejects */ }
      }
    },
  };
};

it("maps 403 X-GitHub-SSO to sso need", async () => {
  const url = "https://github.com/orgs/acme/sso?authorization_request=x";
  const access = createAccess({ auth: auth(), fetchImpl: async () => answer(403, { message: "Resource protected by organization SAML enforcement." }, { "x-github-sso": `required; url=${url}` }) });
  const err = await access.rest("GET", "/repos/acme/api/issues/1").catch((e) => e);
  expect(err).toBeInstanceOf(GitHubNeed);
  expect(err.need).toEqual({ cause: "sso", org: "acme", url });
  expect(err.ownerFixable).toBe(true);
  expect(access.status().problems).toEqual([{ org: "acme", cause: "sso", url }]);
});

it("background calls wait below the 20% reserve", async () => {
  let clock = 1_000_000;
  const reset = Math.floor(clock / 1000) + 60;
  const sent: { at: number; path: string }[] = [];
  const access = createAccess({
    auth: auth(),
    now: () => clock,
    sleep: async (ms) => void (clock += ms),
    fetchImpl: async (u) => {
      sent.push({ at: clock, path: new URL(String(u)).pathname });
      return answer(200, {}, { "x-ratelimit-remaining": "999", "x-ratelimit-limit": "5000", "x-ratelimit-reset": String(reset), "x-ratelimit-resource": "core" });
    },
  });
  await access.rest("GET", "/repos/acme/api");
  await access.rest("GET", "/repos/acme/api/pulls", undefined, { background: true });
  expect(sent[1]!.at).toBeGreaterThanOrEqual(reset * 1000);
  const before = clock;
  // Below the reserve again (the fake always answers 999), but interactive: sent at once.
  await access.rest("GET", "/repos/acme/api/issues/1");
  expect(sent[2]!.at).toBe(before);
});

it("a refused token is an expired need; the client sends nothing to the owner itself", async () => {
  const access = createAccess({ auth: auth(), fetchImpl: async () => answer(401, { message: "Bad credentials" }) });
  const err = await access.rest("GET", "/user").catch((e) => e);
  expect(err).toBeInstanceOf(GitHubNeed);
  expect(err.need).toEqual({ cause: "expired" });
  expect(access.connected()).toBe(false);
});

it("rate_limited and write_busy stay plain errors with their codes", () => {
  const busy = needResult(new GitHubNeed({ cause: "write_busy" }));
  expect(busy.isError).toBe(true);
  expect(JSON.parse(busy.content[0]!.text)).toEqual({ error: "github_write_busy", need: { cause: "write_busy" }, detail: "GitHub's writes are backed up right now: try again in a minute" });
  expect("structuredContent" in busy).toBe(false);
  const r = needResult(new GitHubNeed({ cause: "rate_limited", until: "2026-11-20T10:00:00Z" }));
  expect(r).toMatchObject({ isError: true });
  expect("structuredContent" in r).toBe(false);
  expect(readNeed(r)).toBeUndefined();
});

it("status lines say what works and the one fix", () => {
  const a = createAccess({ auth: auth(), env: { GITHUB_FLEET_ORG: "aidenhq-alpha", GITHUB_CI: "1" } });
  const lines = a.status().lines;
  expect(lines.map((l) => [l.label, l.value, l.action?.label])).toEqual([
    ["Reads, issues, comments", "needs permission", "Reconnect"],
    ["Pull requests and merges", "needs permission", "Reconnect"],
    ["Fleet repos", "in aidenhq-alpha", "Change"],
    ["CI runners", "needs permission", "Reconnect"],
    ["Projects boards", "needs permission", "Reconnect"],
  ]);
});

it("content-creating writes go one at a time, a second apart; reads are not paced", async () => {
  let clock = 1_000_000;
  const sent: { at: number; method: string }[] = [];
  const access = createAccess({
    auth: auth(),
    now: () => clock,
    sleep: async (ms) => void (clock += ms),
    fetchImpl: async (_u, init) => {
      sent.push({ at: clock, method: String(init?.method) });
      clock += 50;
      return answer(201, {});
    },
  });
  await Promise.all([
    access.rest("POST", "/repos/acme/api/issues/1/comments", { body: "a" }),
    access.rest("POST", "/repos/acme/api/pulls/1/reviews", { body: "b" }),
    access.graphql("mutation { x }", {}),
    access.rest("GET", "/repos/acme/api"),
  ]);
  const writes = sent.filter((s) => s.method === "POST");
  expect(writes).toHaveLength(3);
  expect(writes[1]!.at - (writes[0]!.at + 50)).toBeGreaterThanOrEqual(1000);
  expect(writes[2]!.at - (writes[1]!.at + 50)).toBeGreaterThanOrEqual(1000);
  // The read went out without waiting for the write queue's gaps.
  expect(sent.find((s) => s.method === "GET")!.at).toBeLessThan(writes[1]!.at);
});

it("a secondary-limit 403 pauses the queue (reads keep working), then retries the write", async () => {
  let clock = 1_000_000;
  const sent: { at: number; method: string }[] = [];
  let refused = 0;
  const access = createAccess({
    auth: auth(),
    now: () => clock,
    sleep: async (ms) => void (clock += ms),
    fetchImpl: async (_u, init) => {
      sent.push({ at: clock, method: String(init?.method) });
      if (init?.method === "POST" && refused++ < 2) {
        return answer(403, { message: "You have exceeded a secondary rate limit and have been temporarily blocked from content creation." }, refused === 1 ? {} : { "retry-after": "10" });
      }
      return answer(200, {});
    },
  });
  const start = clock;
  const r = await access.rest("POST", "/repos/acme/api/pulls/1/reviews", { body: "x" });
  expect(r.status).toBe(200);
  const posts = sent.filter((s) => s.method === "POST");
  expect(posts).toHaveLength(3);
  expect(posts[1]!.at - start).toBeGreaterThanOrEqual(60_000);
  expect(posts[2]!.at - posts[1]!.at).toBeGreaterThanOrEqual(10_000);
  // A read during a block is not refused.
  await access.rest("GET", "/repos/acme/api");
});

it("a write whose queue cannot clear in budget fails at its deadline without ever calling fetch", async () => {
  let clock = 1_000_000;
  const sent: { at: number; path: string }[] = [];
  const access = createAccess({
    auth: auth(),
    now: () => clock,
    sleep: async (ms) => void (clock += ms),
    fetchImpl: async (u) => {
      sent.push({ at: clock, path: new URL(String(u)).pathname });
      // The first write holds the queue for longer than the whole write budget.
      clock += 250_000;
      return answer(201, {});
    },
  });
  const first = access.rest("POST", "/repos/acme/api/issues/1/comments", { body: "a" });
  const second = access.rest("POST", "/repos/acme/api/issues/2/comments", { body: "b" });
  await first;
  const started = clock;
  const err = await second.catch((e) => e);
  expect(err).toBeInstanceOf(GitHubNeed);
  expect(err.need).toEqual({ cause: "write_busy" });
  // The queued write failed without waiting and was never sent.
  expect(clock).toBe(started);
  expect(sent.map((s) => s.path)).toEqual(["/repos/acme/api/issues/1/comments"]);
});

it("a secondary-limit refusal past the deadline fails at once as rate_limited with that until", async () => {
  let clock = 1_000_000;
  let calls = 0;
  const access = createAccess({
    auth: auth(),
    now: () => clock,
    sleep: async (ms) => void (clock += ms),
    fetchImpl: async () => {
      calls++;
      return answer(403, { message: "You have exceeded a secondary rate limit." }, { "retry-after": "600" });
    },
  });
  const refusalUntil = new Date(clock + 600_000).toISOString();
  const start = clock;
  const err = await access.rest("POST", "/repos/acme/api/issues", { title: "t" }).catch((e) => e);
  expect(err).toBeInstanceOf(GitHubNeed);
  expect(err.need).toEqual({ cause: "rate_limited", until: refusalUntil });
  // It neither slept towards the refusal nor sent again.
  expect(clock).toBe(start);
  expect(calls).toBe(1);
});

it("a read issued while a write is blocked still returns without waiting", async () => {
  let clock = 1_000_000;
  let release!: () => void;
  let arrived!: () => void;
  const reached = new Promise<void>((r) => (arrived = r));
  let readDone = false;
  const access = createAccess({
    auth: auth(),
    now: () => clock,
    sleep: async (ms) => void (clock += ms),
    fetchImpl: async (u, init) => {
      if (init?.method === "POST") {
        arrived();
        await new Promise<void>((r) => (release = r));
        return answer(201, {});
      }
      expect(new URL(String(u)).pathname).toBe("/repos/acme/api");
      readDone = true;
      return answer(200, {});
    },
  });
  const write = access.rest("POST", "/repos/acme/api/issues", { title: "t" });
  // The write has reached fetch and is holding the queue; only then is the read issued.
  await reached;
  await access.rest("GET", "/repos/acme/api");
  expect(readDone).toBe(true);
  release();
  await write;
});

it("a write still queued at its deadline fails by that deadline, not when the queue head finishes, and sends nothing", async () => {
  const time = fakeTime();
  let release!: () => void;
  let arrived!: () => void;
  const reached = new Promise<void>((r) => (arrived = r));
  const sent: string[] = [];
  const access = createAccess({
    auth: auth(),
    now: time.now,
    sleep: time.sleep,
    timer: time.timer,
    fetchImpl: async (u, init) => {
      sent.push(new URL(String(u)).pathname);
      if (init?.method === "POST") {
        arrived();
        await new Promise<void>((r) => (release = r));
        return answer(201, {});
      }
      return answer(200, {});
    },
  });
  // Both writes share the queue, so the head's own deadline passes too; the test only cares about the queued entry.
  const first = access.rest("POST", "/repos/acme/api/issues/1/comments", { body: "a" }).catch((e) => e);
  await reached;
  const second = access.rest("POST", "/repos/acme/api/issues/2/comments", { body: "b" }).catch((e) => e);
  // The first write holds the queue while the clock passes the second's deadline.
  await time.sleep(241_000);
  const err = await second;
  expect(err).toBeInstanceOf(GitHubNeed);
  expect(err.need).toEqual({ cause: "write_busy" });
  // The expired entry was never sent, even once the head finishes.
  release();
  await first;
  expect(sent).toEqual(["/repos/acme/api/issues/1/comments"]);
});

it("a background write still sleeps out the reserve instead of failing", async () => {
  let clock = 1_000_000;
  const reset = Math.floor(clock / 1000) + 60;
  const sent: { at: number; method: string }[] = [];
  const access = createAccess({
    auth: auth(),
    now: () => clock,
    sleep: async (ms) => void (clock += ms),
    fetchImpl: async (_u, init) => {
      sent.push({ at: clock, method: String(init?.method) });
      return answer(200, {}, { "x-ratelimit-remaining": "1", "x-ratelimit-limit": "5000", "x-ratelimit-reset": String(reset + 60), "x-ratelimit-resource": "core" });
    },
  });
  await access.rest("GET", "/repos/acme/api");
  const before = clock;
  await access.rest("POST", "/repos/acme/api/issues", { title: "t" }, { background: true });
  const post = sent.find((s) => s.method === "POST")!;
  // Below the reserve, a background write waited for the reset rather than failing.
  expect(post.at).toBeGreaterThan(before);
  expect(post.at).toBeGreaterThanOrEqual((reset + 60) * 1000);
});

it("a write retried inside the budget that meets the budget edge fails there as rate_limited, sending nothing again", async () => {
  let clock = 1_000_000;
  let calls = 0;
  const access = createAccess({
    auth: auth(),
    now: () => clock,
    sleep: async (ms) => void (clock += ms),
    // The first refusal (120 s + a 30 s attempt) fits the 240 s budget, so it is retried; the retry's own refusal lands
    // 120 s later, where another wait plus a 30 s attempt would pass the budget, so it must fail rather than sleep.
    fetchImpl: async () => {
      calls++;
      return answer(403, { message: "secondary rate limit" }, calls === 1 ? { "retry-after": "120" } : { "retry-after": "120" });
    },
  });
  const err = await access.rest("POST", "/repos/acme/api/issues", { title: "t" }).catch((e) => e);
  expect(err).toBeInstanceOf(GitHubNeed);
  expect(err.need.cause).toBe("rate_limited");
  // Two sends, never a third: the second refusal's until is past the budget.
  expect(calls).toBe(2);
  expect(clock).toBeLessThan(1_000_000 + 240_000);
});

it("a call that works marks the sign-in ok (its state starts unknown after a restart)", async () => {
  const marked: string[] = [];
  const a = { ...auth(), mark: (s: "ok" | "expired") => void marked.push(s) };
  await createAccess({ auth: a, fetchImpl: async () => answer(200, {}) }).rest("GET", "/repos/acme/api");
  expect(marked).toEqual(["ok"]);
});
