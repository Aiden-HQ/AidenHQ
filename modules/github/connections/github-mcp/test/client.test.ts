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

it("rate_limited stays a plain error", () => {
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

it("a write queued past its budget fails fast as a typed need without ever calling fetch", async () => {
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
  let readDone = false;
  const access = createAccess({
    auth: auth(),
    now: () => clock,
    sleep: async (ms) => void (clock += ms),
    fetchImpl: async (u, init) => {
      if (init?.method === "POST") {
        await new Promise<void>((r) => (release = r));
        return answer(201, {});
      }
      expect(new URL(String(u)).pathname).toBe("/repos/acme/api");
      readDone = true;
      return answer(200, {});
    },
  });
  const write = access.rest("POST", "/repos/acme/api/issues", { title: "t" });
  await access.rest("GET", "/repos/acme/api");
  expect(readDone).toBe(true);
  release();
  await write;
});

it("a write that stays refused past the patience fails as a transient rate_limited need", async () => {
  let clock = 1_000_000;
  const access = createAccess({
    auth: auth(),
    now: () => clock,
    sleep: async (ms) => void (clock += ms),
    fetchImpl: async () => answer(403, { message: "secondary rate limit" }, { "retry-after": "400" }),
  });
  const err = await access.rest("POST", "/repos/acme/api/issues", { title: "t" }).catch((e) => e);
  expect(err).toBeInstanceOf(GitHubNeed);
  expect(err.need.cause).toBe("rate_limited");
});

it("a call that works marks the sign-in ok (its state starts unknown after a restart)", async () => {
  const marked: string[] = [];
  const a = { ...auth(), mark: (s: "ok" | "expired") => void marked.push(s) };
  await createAccess({ auth: a, fetchImpl: async () => answer(200, {}) }).rest("GET", "/repos/acme/api");
  expect(marked).toEqual(["ok"]);
});
