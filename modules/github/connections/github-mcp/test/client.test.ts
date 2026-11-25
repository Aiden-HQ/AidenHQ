import { expect, it } from "vitest";
import { createAccess, GitHubNeed, needResult, withWriteBudget } from "../src/client.js";
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

it("a stray 401 on a token GitHub still accepts is an answer: the sign-in stays ok", async () => {
  const a = { ...auth(), refused: async () => false };
  const access = createAccess({ auth: a, fetchImpl: async () => answer(401, { message: "Requires authentication" }) });
  const r = await access.rest("GET", "/orgs/acme/projects").catch((e) => e);
  expect(r).not.toBeInstanceOf(GitHubNeed);
  expect(a.status().state).toBe("ok");
  expect(access.connected()).toBe(true);
});

it("a 401 for a token another call already replaced is sent again with the new one", async () => {
  let n = 0;
  const a = { ...auth(), refused: async () => false, headers: async () => ({ authorization: `Bearer ${n++ === 0 ? "gho_old" : "gho_new"}` }) };
  const access = createAccess({ auth: a, fetchImpl: async (_u, init) => ((init?.headers as Record<string, string>).authorization!.endsWith("gho_old") ? answer(401, { message: "Bad credentials" }) : answer(200, { ok: true })) });
  expect((await access.rest("GET", "/repos/acme/api")).status).toBe(200);
  expect(a.status().state).toBe("ok");
});

it("a retried 401 whose token another call replaced never marks the saved sign-in expired", async () => {
  // The first attempt's token is refused, so the client refreshes and retries once. While the retry's refusal probe is out, the
  // owner's sign-in is replaced again: the probe's verdict is on the token that was just replaced, not the saved one.
  let saved = "gho_old";
  let probes = 0;
  const a = {
    ...auth(),
    headers: async () => ({ authorization: `Bearer ${saved}` }),
    refresh: async () => void (saved = "gho_mid"),
    refused: async () => {
      probes += 1;
      if (probes === 2) saved = "gho_new"; // replaced while the retry's probe was out
      return true;
    },
  };
  let sent = 0;
  const access = createAccess({
    auth: a,
    fetchImpl: async () => {
      sent += 1;
      return answer(401, { message: "Bad credentials" });
    },
  });
  const r = await access.rest("GET", "/repos/acme/api").catch((e) => e);
  expect(r).not.toBeInstanceOf(GitHubNeed);
  expect(a.status().state).toBe("ok");
  expect(access.connected()).toBe(true);
  expect(sent).toBe(2); // the original attempt and its one retry
});

it("a 401 after a different account signs in is not retried under the new account", async () => {
  // A private read goes out on the old account's token; a new account signs in while it is in flight, and the old token's 401 comes
  // back. Resending would return the new account's private data to the caller who asked under the old one.
  let n = 0;
  const a = {
    ...auth(),
    headers: async () => ({ authorization: `Bearer ${n === 0 ? "gho_old" : "gho_new"}` }),
    signInCount: () => n,
    refused: async () => false,
  };
  const sent: string[] = [];
  const access = createAccess({
    auth: a,
    fetchImpl: async (_u, init) => {
      const authz = String((init?.headers as Record<string, string>).authorization);
      sent.push(authz);
      if (authz.endsWith("gho_old")) { n = 1; return answer(401, { message: "Bad credentials" }); } // the new sign-in landed
      return answer(200, { private: true });
    },
  });
  const r = await access.rest("GET", "/repos/acme/private").catch((e) => e);
  // It fails with the old token's answer and sends nothing under the new account; the saved sign-in is not marked expired.
  expect(r.status).toBe(401);
  expect(sent.filter((t) => t.endsWith("gho_new"))).toHaveLength(0);
  expect(a.status().state).toBe("ok");
});

it("a 401 whose refresh races a new sign-in is not retried under the new account", async () => {
  // The 401 starts a refresh; a different account signs in while it runs. The retry would carry the new account's token, and its
  // answer (private data included) would reach the caller who asked under the old one, so the 401 stays the answer.
  let n = 0;
  const a = {
    ...auth(),
    headers: async () => ({ authorization: `Bearer ${n === 0 ? "gho_old" : "gho_new"}` }),
    refresh: async () => void (n = 1),
    signInCount: () => n,
    refused: async () => true,
  };
  const sent: string[] = [];
  const access = createAccess({
    auth: a,
    fetchImpl: async (_u, init) => {
      sent.push(String((init?.headers as Record<string, string>).authorization));
      return answer(401, { message: "Bad credentials" });
    },
  });
  const r = await access.rest("GET", "/repos/acme/private").catch((e) => e);
  expect(r.status).toBe(401);
  expect(sent.filter((t) => t.endsWith("gho_new"))).toHaveLength(0);
});

it("a 401 a refresh answers within the same sign-in is retried once", async () => {
  let token = "gho_old";
  const sent: string[] = [];
  const a = {
    ...auth(),
    headers: async () => ({ authorization: `Bearer ${token}` }),
    refresh: async () => void (token = "gho_new"),
    signInCount: () => 0,
    refused: async () => true,
  };
  const access = createAccess({
    auth: a,
    fetchImpl: async (_u, init) => {
      const authz = String((init?.headers as Record<string, string>).authorization);
      sent.push(authz);
      return authz.endsWith("gho_old") ? answer(401, { message: "Bad credentials" }) : answer(200, { ok: true });
    },
  });
  expect((await access.rest("GET", "/repos/acme/api")).status).toBe(200);
  expect(sent.map((t) => t.replace("Bearer ", ""))).toEqual(["gho_old", "gho_new"]);
});

it("rate_limited and write_busy stay plain errors with their codes", () => {
  const busy = needResult(new GitHubNeed({ cause: "write_busy" }));
  expect(busy.isError).toBe(true);
  expect(JSON.parse(busy.content[0]!.text)).toEqual({ error: "github_write_busy", need: { cause: "write_busy" }, detail: "This GitHub write can't finish in time right now: run the call again in a minute" });
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
    ["Workflow files", "needs permission", "Reconnect"],
    ["Fleet repos", "in aidenhq-alpha", "Change"],
    ["CI runners", "needs permission", "Reconnect"],
    ["Projects boards", "needs permission", "Reconnect"],
  ]);
});

// A grant made before the sign-in asked for `workflow` (or with its box unticked) keeps its old scopes, so a push that touches
// `.github/workflows/` is refused outright: the board names the gap on its own row, with the one fix, before any push.
it("the workflow row reads working only when the sign-in's scopes cover workflow", () => {
  const scoped = (scope: string): Auth => ({ ...auth(), status: () => ({ state: "ok", since: "", scope }) });
  const row = (scope: string) => {
    const line = createAccess({ auth: scoped(scope) }).status().lines.find((l) => l.label === "Workflow files");
    return [line?.value, line?.state, line?.action?.label];
  };
  expect(row("repo, read:org, project")).toEqual(["needs permission", "warn", "Reconnect"]);
  expect(row("repo, read:org, workflow, project")).toEqual(["working", "ok", undefined]);
});

// GitHub fixes an OAuth grant at sign-in, so the `x-oauth-scopes` header of an older call names the old grant after a reconnect.
// The board must show the current sign-in, or the row keeps saying "needs permission" once the owner has fixed it.
it("the workflow row follows a reconnect rather than the scopes an older call saw", async () => {
  let scope = "repo, read:org, project";
  const auth2: Auth = {
    ...auth(),
    status: () => ({ state: "ok", since: "", scope }),
    headers: async () => ({ authorization: "Bearer gho_owner" }),
  };
  const access = createAccess({
    auth: auth2,
    fetchImpl: async () => answer(200, { login: "owner" }, { "x-oauth-scopes": "repo, read:org, project" }),
  });
  const row = () => {
    const line = access.status().lines.find((l) => l.label === "Workflow files");
    return [line?.value, line?.state];
  };
  await access.rest("GET", "/user");
  expect(row()).toEqual(["needs permission", "warn"]);
  // The owner reconnects with `workflow` ticked: no new API answer, only the sign-in's scopes change.
  scope = "repo, read:org, workflow, project";
  expect(row()).toEqual(["working", "ok"]);
  // A call answered under the new grant caches the new header as usual.
  expect(access.scopes()).toEqual(["repo", "read:org", "workflow", "project"]);
});

// A request that started under the old grant and answered after the reconnect carries the old grant's header. It must not be
// read as the new grant's scopes, or the board would go back to "needs permission" and the queue could replay a fixed notice.
it("a late answer from the old grant is not read as the new sign-in's scopes", async () => {
  let scope = "repo, read:org, project";
  const auth2: Auth = { ...auth(), status: () => ({ state: "ok", since: "", scope }) };
  let settle: (r: Response) => void = () => {};
  let sent: () => void = () => {};
  const out = new Promise<void>((r) => (sent = r));
  const access = createAccess({
    auth: auth2,
    fetchImpl: () => new Promise<Response>((resolve) => {
      settle = resolve;
      sent();
    }),
  });
  const row = () => access.status().lines.find((l) => l.label === "Workflow files")?.value;
  const call = access.rest("GET", "/user");
  await out; // the request is out, under the old grant
  // The owner reconnects while the request is in flight, then the old answer arrives.
  scope = "repo, read:org, workflow, project";
  settle(answer(200, { login: "owner" }, { "x-oauth-scopes": "repo, read:org, project" }));
  await call;
  expect(row(), "the old grant's header did not overwrite the new one").toBe("working");
  expect(access.scopes()).toEqual(["repo", "read:org", "workflow", "project"]);
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

it("a read whose deadline is shorter than an attempt still sends: the deadline bounds the quota wait, not the request", async () => {
  let clock = 1_000_000;
  const sent: string[] = [];
  const access = createAccess({
    auth: auth(),
    now: () => clock,
    sleep: async (ms) => void (clock += ms),
    fetchImpl: async (u) => {
      sent.push(new URL(String(u)).pathname);
      return answer(200, { steps: [] });
    },
  });
  // Five seconds of budget: far less than the 30 s an attempt may take, and still enough to send at once.
  const r = await access.rest("GET", "/repos/acme/api/actions/jobs/1", undefined, { background: true, deadline: clock + 5_000 });
  expect(r.status).toBe(200);
  expect(sent).toEqual(["/repos/acme/api/actions/jobs/1"]);
});

it("a read that would sleep out a quota window past its deadline refuses at once", async () => {
  let clock = 1_000_000;
  let calls = 0;
  const access = createAccess({
    auth: auth(),
    now: () => clock,
    sleep: async (ms) => void (clock += ms),
    fetchImpl: async () => {
      calls++;
      return answer(200, { steps: [], rate: {} }, { "x-ratelimit-remaining": "0", "x-ratelimit-limit": "5000", "x-ratelimit-reset": String(Math.floor(clock / 1000) + 600), "x-ratelimit-resource": "core" });
    },
  });
  await access.rest("GET", "/repos/acme/api");
  const start = clock;
  const err = await access.rest("GET", "/repos/acme/api/actions/jobs/1", undefined, { background: true, deadline: clock + 5_000 }).catch((e) => e);
  expect(err).toBeInstanceOf(GitHubNeed);
  expect(err.need.cause).toBe("rate_limited");
  expect(clock).toBe(start);
  expect(calls).toBe(1);
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

it("a background write retries a limit that outlasts the tool budget instead of failing", async () => {
  let clock = 1_000_000;
  let calls = 0;
  const access = createAccess({
    auth: auth(),
    now: () => clock,
    sleep: async (ms) => void (clock += ms),
    // A 300 s secondary-limit refusal: past the tool invocation's 240 s budget, but a background job has no such clock.
    fetchImpl: async () => {
      calls++;
      return calls === 1 ? answer(403, { message: "secondary rate limit" }, { "retry-after": "300" }) : answer(201, {});
    },
  });
  expect(await access.rest("POST", "/repos/acme/api/issues", { title: "t" }, { background: true })).toMatchObject({ status: 201 });
  expect(calls).toBe(2);
  expect(clock).toBeGreaterThanOrEqual(1_300_000);
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

it("two writes in one tool invocation share one budget: the second fails fast at the shared deadline, unsent", async () => {
  let clock = 1_000_000;
  const sent: string[] = [];
  const access = createAccess({
    auth: auth(),
    now: () => clock,
    sleep: async (ms) => void (clock += ms),
    fetchImpl: async (u, init) => {
      sent.push(`${String(init?.method)} ${new URL(String(u)).pathname}`);
      // The note spends most of the shared budget; the close then has no room for its 30 s attempt.
      clock += 215_000;
      return answer(201, {});
    },
  });
  const start = clock;
  const err = await withWriteBudget(async () => {
    await access.rest("POST", "/repos/acme/api/issues/1/comments", { body: "note" });
    return access.rest("PATCH", "/repos/acme/api/issues/1", { state: "closed" }).catch((e) => e);
  }, () => clock);
  expect(err).toBeInstanceOf(GitHubNeed);
  expect(err.need).toEqual({ cause: "write_busy" });
  // Only the note was sent; the close never reached fetch and nothing ran past the shared budget.
  expect(sent).toEqual(["POST /repos/acme/api/issues/1/comments"]);
  expect(clock - start).toBeLessThanOrEqual(240_000);
});

it("a tool invocation's budget is fixed at its entry, so its preflight reads spend it", async () => {
  let clock = 1_000_000;
  const time = fakeTime();
  const access = createAccess({
    auth: auth(),
    now: () => clock,
    sleep: async (ms) => void (clock += ms),
    timer: time.timer,
    fetchImpl: async () => answer(200, {}),
  });
  const start = clock;
  // The tool enters, then spends 100 s on a read before its first write.
  await withWriteBudget(async () => {
    clock += 100_000;
    return access.rest("GET", "/repos/acme/api");
  }, () => clock);
  expect(clock - start).toBe(100_000);
  // A write-only tool whose entry is followed by a long preflight: 215 s in, 25 s is left, so nothing can start.
  clock = start;
  const err = await withWriteBudget(async () => {
    clock += 215_000;
    return access.rest("POST", "/repos/acme/api/issues", { title: "t" }).catch((e) => e);
  }, () => clock);
  expect(err).toBeInstanceOf(GitHubNeed);
  expect(err.need).toEqual({ cause: "write_busy" });
});

it("a tool invocation's later writes never start a fresh budget beyond the first", async () => {
  // The budget is fixed at entry, so a fake clock without any preflight starts at 0 s spent.
  let clock = 1_000_000;
  const sent: { at: number; method: string }[] = [];
  const access = createAccess({
    auth: auth(),
    now: () => clock,
    sleep: async (ms) => void (clock += ms),
    fetchImpl: async (_u, init) => {
      sent.push({ at: clock, method: String(init?.method) });
      clock += 110_000;
      return answer(200, {});
    },
  });
  const start = clock;
  const err = await withWriteBudget(async () => {
    await access.rest("POST", "/repos/acme/api/issues/1/comments", { body: "a" });
    await access.rest("PATCH", "/repos/acme/api/issues/1", { state: "closed" });
    return access.rest("POST", "/repos/acme/api/issues/1/comments", { body: "b" }).catch((e) => e);
  }, () => clock);
  expect(err).toBeInstanceOf(GitHubNeed);
  expect(err.need).toEqual({ cause: "write_busy" });
  // Under a fresh per-write budget the third write would have started at 222 s and sent; the shared one refuses it.
  expect(sent.map((s) => s.method)).toEqual(["POST", "PATCH"]);
  expect(clock - start).toBeLessThanOrEqual(240_000);
});

it("a write already running when the clock passes the deadline is not reported busy, so a slow write is never duplicated", async () => {
  const time = fakeTime();
  let sent = 0;
  const access = createAccess({
    auth: auth(),
    now: time.now,
    sleep: time.sleep,
    timer: time.timer,
    fetchImpl: async () => {
      sent++;
      // GitHub is slow: the request is in flight when the clock passes the queue deadline.
      await time.sleep(245_000);
      return answer(201, {});
    },
  });
  const r = await access.rest("POST", "/repos/acme/api/issues", { title: "t" });
  // It started inside budget (it was the head of the queue, so the timer was cancelled at its turn), so its answer is kept.
  expect(r.status).toBe(201);
  expect(sent).toBe(1);
});

it("outside a tool invocation each write still gets its own budget", async () => {
  let clock = 1_000_000;
  let calls = 0;
  const access = createAccess({
    auth: auth(),
    now: () => clock,
    sleep: async (ms) => void (clock += ms),
    fetchImpl: async () => {
      calls++;
      clock += 150_000;
      return answer(200, {});
    },
  });
  await access.rest("POST", "/repos/acme/api/issues/1/comments", { body: "a" });
  await access.rest("POST", "/repos/acme/api/issues/2/comments", { body: "b" });
  expect(calls).toBe(2);
});

it("a call that works marks the sign-in ok (its state starts unknown after a restart)", async () => {
  const marked: string[] = [];
  const a = { ...auth(), mark: (s: "ok" | "expired") => void marked.push(s) };
  await createAccess({ auth: a, fetchImpl: async () => answer(200, {}) }).rest("GET", "/repos/acme/api");
  expect(marked).toEqual(["ok"]);
});

const forbidden = (extensions: Record<string, unknown>, message: string) => answer(200, { data: { organization: { projectsV2: { nodes: [null] } } }, errors: [{ type: "FORBIDDEN", path: ["organization", "projectsV2", "nodes", 0], extensions, message }] });

it("maps a GraphQL FORBIDDEN from an OAuth-restricted org to a restricted need that keeps GitHub's full words", async () => {
  const message = `Although you appear to have the correct authorization credentials, the \`acme\` organization has enabled OAuth App access restrictions, meaning that data access to third-parties is limited. ${"x".repeat(300)}`;
  const access = createAccess({ auth: auth(), clientId: "cid", fetchImpl: async () => forbidden({ saml_failure: false, ip_allow_list_failure: false }, message) });
  const err = await access.graphql("query", { org: "acme" }, { background: true }).catch((e) => e);
  expect(err).toBeInstanceOf(GitHubNeed);
  expect(err.need).toEqual({ cause: "restricted", org: "acme", url: "https://github.com/settings/connections/applications/cid", message });
  expect(err.message).toContain(message);
  expect(access.status().problems).toEqual([{ org: "acme", cause: "restricted", url: "https://github.com/settings/connections/applications/cid", message }]);
});

it("maps a GraphQL FORBIDDEN flagged saml_failure to an sso need, and leaves an IP allow list failure an ordinary error", async () => {
  const sso = createAccess({ auth: auth(), fetchImpl: async () => forbidden({ saml_failure: true }, "Resource protected by organization SAML enforcement.") });
  expect((await sso.graphql("q", { org: "acme" }).catch((e) => e)).need).toMatchObject({ cause: "sso", org: "acme", url: "https://github.com/orgs/acme/sso" });
  const ip = createAccess({ auth: auth(), fetchImpl: async () => forbidden({ ip_allow_list_failure: true }, "Although you appear to have the correct authorization credentials, the org has an IP allow list") });
  const body = await ip.graphql("q", { org: "acme" });
  expect(body.errors).toHaveLength(1);
  expect(ip.status().problems).toEqual([]);
});

it("attributes a restriction to the org GitHub names, keeps a refusal inside one item's content non-fatal, and rejects a failed answer", async () => {
  const msg = "Although you appear to have the correct authorization credentials, the `other` organization has enabled OAuth App access restrictions.";
  const inContent = answer(200, { data: { organization: { projectV2: { items: { nodes: [{ id: "1", content: null }] } } } }, errors: [{ type: "FORBIDDEN", path: ["organization", "projectV2", "items", "nodes", 0, "content"], extensions: { saml_failure: false }, message: msg }] });
  const a = createAccess({ auth: auth(), clientId: "cid", fetchImpl: async () => inContent });
  const body = await a.graphql("items", { org: "acme" });
  expect(body.data.organization.projectV2.items.nodes).toHaveLength(1);
  expect(a.status().problems).toMatchObject([{ org: "other", cause: "restricted" }]);
  expect(a.status().lines.find((l) => l.label === "other")?.value).toContain("the `other` organization");
  const bad = createAccess({ auth: auth(), fetchImpl: async () => new Response("<html>", { status: 502 }) });
  await expect(bad.graphql("q", { org: "acme" })).rejects.toThrow(/answered 502/);
});

it("a GraphQL refusal's warning stays while refusals keep coming, expires two hours after the last, and a working answer clears it", async () => {
  const msg = "Although you appear to have the correct authorization credentials, the `acme` organization has enabled OAuth App access restrictions.";
  const t = fakeTime();
  let refuse = true;
  const a = createAccess({ auth: auth(), now: t.now, sleep: (ms) => t.sleep(ms), timer: t.timer, fetchImpl: async () => (refuse ? forbidden({ saml_failure: false }, msg) : answer(200, { data: { organization: { id: "1" } } })) });
  await a.graphql("q", { org: "acme" }).catch(() => undefined);
  expect(a.status().problems).toHaveLength(1);
  await t.sleep(119 * 60_000);
  await a.graphql("q", { org: "acme" }).catch(() => undefined); // another refusal restarts the clock
  await t.sleep(60 * 60_000);
  expect(a.status().problems, "an hour after the last refusal: still the owner's to fix").toHaveLength(1);
  await t.sleep(61 * 60_000);
  expect(a.status().problems, "two hours after the last refusal: the warning expires").toHaveLength(0);
  // A refusal with no success after it expires; an org answer that works clears it at once.
  await a.graphql("q", { org: "acme" }).catch(() => undefined);
  expect(a.status().problems).toHaveLength(1);
  refuse = false;
  await a.graphql("q", { org: "acme" });
  expect(a.status().problems).toEqual([]);
});

// A REST read or a search answers even while the org's restriction stands (the restriction blocks its GraphQL org query),
// so neither is proof the org is reachable: only a GraphQL answer for the org is, and only that one is reported.
it("reports nothing for a successful REST read or search that names an org", async () => {
  const seen: string[] = [];
  const access = createAccess({ auth: auth(), onOrgOk: (org) => void seen.push(org), fetchImpl: async () => answer(200, { login: "owner", items: [] }) });
  await access.rest("GET", "/orgs/Acme/repos");
  await access.rest("GET", "/repos/acme/api/issues/1");
  await access.rest("GET", "/search/issues?q=org%3AAcme%20is%3Aissue");
  await access.rest("GET", "/search/issues?q=user%3Aacme%20is%3Aissue");
  await access.rest("GET", "/user");
  await access.rest("GET", "/orgs/Acme/repos", undefined, { etag: "W/\"x\"" });
  expect(seen, "a public read or a search is not evidence the org's restriction is lifted").toEqual([]);
});

it("clears the card's warning only on a GraphQL org answer that works", async () => {
  const msg = "Although you appear to have the correct authorization credentials, the `acme` organization has enabled OAuth App access restrictions.";
  let refuse = true;
  const access = createAccess({ auth: auth(), fetchImpl: async () => (refuse ? forbidden({ saml_failure: false }, msg) : answer(200, { data: { organization: { id: "1" } } })) });
  await access.graphql("q", { org: "acme" }).catch(() => undefined);
  expect(access.status().problems).toHaveLength(1);
  // A REST read of the org succeeds under the restriction: the warning stays, so the card matches the kernel's row.
  await access.rest("GET", "/orgs/Acme/repos");
  expect(access.status().problems).toHaveLength(1);
  refuse = false;
  await access.graphql("q", { org: "acme" });
  expect(access.status().problems).toEqual([]);
});

it("reports variables.org on a GraphQL answer without errors, never one with errors or no org", async () => {
  const seen: string[] = [];
  let body: unknown = { data: { organization: { projectsV2: { nodes: [] } } } };
  let partial = "";
  const access = createAccess({ auth: auth(), onOrgOk: (org) => void seen.push(org), fetchImpl: async () => answer(200, body, partial ? { "x-github-sso": partial } : {}) });
  await access.graphql("query($org: String!) { organization(login: $org) { id } }", { org: "acme" });
  expect(seen).toEqual(["acme"]);
  body = { data: {}, errors: [{ message: "Something went wrong" }] };
  await access.graphql("query($org: String!) { organization(login: $org) { id } }", { org: "acme" });
  expect(seen, "a GraphQL answer with errors is not a success").toEqual(["acme"]);
  body = { data: {} };
  await access.graphql("query { viewer { login } }", {});
  expect(seen).toEqual(["acme"]);
  // An answer the org's SSO filtered (`partial-results`) leaves part of it unread: the org did not answer for everything asked.
  partial = "partial-results; organizations=acme";
  await access.graphql("query($org: String!) { organization(login: $org) { id } }", { org: "acme" });
  expect(seen, "an SSO-filtered org answer is not a clear").toEqual(["acme"]);
  partial = "";
  // The App's answer is not the owner's.
  body = { data: {} };
  await access.graphql("query($org: String!) { organization(login: $org) { id } }", { org: "acme" }, { as: { key: "app:1", token: async () => "ghs_app" } });
  expect(seen).toEqual(["acme"]);
});

it("a background write's caller deadline still leaves room for a whole attempt, and one that does not refuses before sending", async () => {
  let clock = 1_000_000;
  const sent: string[] = [];
  const access = createAccess({
    auth: auth(),
    now: () => clock,
    sleep: async (ms) => void (clock += ms),
    fetchImpl: async (u) => {
      sent.push(new URL(String(u)).pathname);
      return answer(201, {});
    },
  });
  // 35 s: five seconds of tolerated wait plus the 30 s a write's attempt may take, so the POST goes out.
  const ok = await access.rest("POST", "/repos/acme/api/actions/jobs/1/rerun", {}, { background: true, deadline: clock + 35_000 });
  expect(ok.status).toBe(201);
  // 5 s cannot see an attempt through: the client refuses it before it is sent, so a caller's tight bound never sends unsent work.
  const err = await access.rest("POST", "/repos/acme/api/actions/jobs/1/rerun", {}, { background: true, deadline: clock + 5_000 }).catch((e) => e);
  expect(err).toBeInstanceOf(GitHubNeed);
  expect(sent).toEqual(["/repos/acme/api/actions/jobs/1/rerun"]);
});
