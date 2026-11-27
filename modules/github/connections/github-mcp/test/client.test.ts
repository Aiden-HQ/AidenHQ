import { expect, it } from "bun:test";
import { createAccess, GitHubNeed, MUTATIONS, needResult, withOwnerTrace, withWriteBudget, type Actor, type AppSource, type GitHubAccess } from "../src/client.js";
import { AppError } from "../src/github-app.js";
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
/** A write's actor as the chooser picks it on acme/api (the owner, with no App): every write names one. */
const own = (a: GitHubAccess) => ({ rest: async (m: string, p: string, b?: unknown, o?: Parameters<Actor["rest"]>[3]) => (await a.actorFor({ repo: "acme/api" }, "issue")).rest(m, p, b, o) });
/** A fake App: `installs` by repo (lower case), each with its accepted permissions. */
const fakeApp = (installs: Record<string, Record<string, string>>, over: Partial<AppSource> = {}): AppSource => ({
  installed: async (repo) => (installs[repo.toLowerCase()] ? { id: 7, permissions: installs[repo.toLowerCase()]!, html_url: "https://github.com/settings/installations/7", account: repo.split("/")[0]! } : null),
  installedOn: async () => null,
  evict: () => {},
  token: async () => "ghs_app",
  identity: async () => ({ id: 3, slug: "acme-app", login: "acme-app[bot]", botId: 99 }),
  wrote: () => {},
  ...over,
});
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
    own(access).rest("POST", "/repos/acme/api/issues/1/comments", { body: "a" }),
    own(access).rest("POST", "/repos/acme/api/pulls/1/reviews", { body: "b" }),
    own(access).rest("POST", "/graphql", { query: MUTATIONS.DEQUEUE, variables: { id: "x" } }),
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
  const r = await own(access).rest("POST", "/repos/acme/api/pulls/1/reviews", { body: "x" });
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
  const first = own(access).rest("POST", "/repos/acme/api/issues/1/comments", { body: "a" });
  const second = own(access).rest("POST", "/repos/acme/api/issues/2/comments", { body: "b" });
  await first;
  const started = clock;
  const err = await second.catch((e) => e);
  expect(err).toBeInstanceOf(GitHubNeed);
  expect(err.need).toEqual({ cause: "write_busy" });
  // The queued write failed without waiting and was never sent.
  expect(clock).toBe(started);
  expect(sent.map((s) => s.path)).toEqual(["/repos/acme/api/issues/1/comments"]);
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
  const owner = await access.actorFor({ repo: "acme/api" }, "issue");
  const first = owner.rest("POST", "/repos/acme/api/issues/1/comments", { body: "a" }).catch((e) => e);
  await reached;
  const second = owner.rest("POST", "/repos/acme/api/issues/2/comments", { body: "b" }).catch((e) => e);
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
  await own(access).rest("POST", "/repos/acme/api/issues", { title: "t" }, { background: true });
  const post = sent.find((s) => s.method === "POST")!;
  // Below the reserve, a background write waited for the reset rather than failing.
  expect(post.at).toBeGreaterThan(before);
  expect(post.at).toBeGreaterThanOrEqual((reset + 60) * 1000);
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
    await own(access).rest("POST", "/repos/acme/api/issues/1/comments", { body: "note" });
    return own(access).rest("PATCH", "/repos/acme/api/issues/1", { state: "closed" }).catch((e) => e);
  }, () => clock);
  expect(err).toBeInstanceOf(GitHubNeed);
  expect(err.need).toEqual({ cause: "write_busy" });
  // Only the note was sent; the close never reached fetch and nothing ran past the shared budget.
  expect(sent).toEqual(["POST /repos/acme/api/issues/1/comments"]);
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
  const r = await own(access).rest("POST", "/repos/acme/api/issues", { title: "t" });
  // It started inside budget (it was the head of the queue, so the timer was cancelled at its turn), so its answer is kept.
  expect(r.status).toBe(201);
  expect(sent).toBe(1);
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

it("a GET answered 304 returns the kept body, is free, and is counted as a 304", async () => {
  let clock = 1_000_000;
  const seen: (string | null)[] = [];
  const logs: { msg: string; f: Record<string, unknown> }[] = [];
  const access = createAccess({
    auth: auth(), now: () => clock, log: (msg, f) => void logs.push({ msg, f }),
    fetchImpl: async (_u, init) => {
      const tag = new Headers(init?.headers).get("if-none-match");
      seen.push(tag);
      return tag === '"v1"' ? new Response(null, { status: 304, headers: { etag: '"v1"', "x-ratelimit-remaining": "4999", "x-ratelimit-limit": "5000", "x-ratelimit-reset": "2000" } }) : answer(200, { title: "first" }, { etag: '"v1"' });
    },
  });
  const a = await access.withCaller("code-review", () => access.rest("GET", "/repos/acme/api/pulls/1"));
  const b = await access.withCaller("code-review", () => access.rest("GET", "/repos/acme/api/pulls/1"));
  expect(seen).toEqual([null, '"v1"']);
  expect(a.body).toEqual({ title: "first" });
  expect(b).toMatchObject({ status: 200, body: { title: "first" } });
  expect(b.body).not.toBe(a.body); // parsed afresh: no caller shares an object
  // The feed's own ETag bypasses the cache and gets GitHub's 304 itself.
  expect((await access.rest("GET", "/repos/acme/api/pulls/1", undefined, { etag: '"v1"', caller: "feed" })).status).toBe(304);
  clock += 3_600_000;
  await access.rest("GET", "/repos/acme/api/pulls/1");
  expect(logs.find((l) => l.msg === "github calls this hour")?.f.calls).toEqual({ "code-review owner 200": 1, "code-review owner 304": 1, "feed owner 304": 1 });
});

it("repo reads go as the App where its installation holds the permission; a write goes as the actor the chooser picks", async () => {
  const sent: string[] = [];
  const access = createAccess({
    auth: auth(), app: fakeApp({ "acme/api": { metadata: "read", pull_requests: "write", issues: "read" } }),
    fetchImpl: async (u, init) => {
      sent.push(`${init?.method} ${new URL(String(u)).pathname} ${new Headers(init?.headers).get("authorization")}`);
      return answer(200, {});
    },
  });
  await access.rest("GET", "/repos/acme/api/pulls/1");
  await (await access.actorFor({ repo: "acme/api" }, "issue")).rest("POST", "/repos/acme/api/issues/1/comments", { body: "hi" }); // issues is read only
  await (await access.actorFor({ repo: "acme/api" }, "pr")).rest("POST", "/repos/acme/api/pulls/1/reviews", { body: "hi" });
  await access.rest("GET", "/repos/acme/api/actions/runs/5"); // the installation lacks actions
  await access.rest("GET", "/repos/other/repo/pulls/1"); // not installed there
  await access.rest("GET", "/orgs/acme/repos"); // not a repo read
  expect(sent).toEqual([
    "GET /repos/acme/api/pulls/1 Bearer ghs_app",
    "POST /repos/acme/api/issues/1/comments Bearer gho_owner",
    "POST /repos/acme/api/pulls/1/reviews Bearer ghs_app",
    "GET /repos/acme/api/actions/runs/5 Bearer gho_owner",
    "GET /repos/other/repo/pulls/1 Bearer gho_owner",
    "GET /orgs/acme/repos Bearer gho_owner",
  ]);
});

it("the chooser: the App only where installed with every permission the op needs, else the owner; a broken App throws", async () => {
  const sent: string[] = [];
  const fetchImpl = async (u: string | URL | Request, init?: RequestInit) => (sent.push(`${new URL(String(u)).pathname} ${new Headers(init?.headers).get("authorization")}`), answer(200, {}));
  const access = createAccess({ auth: auth(), fetchImpl, app: fakeApp({ "acme/api": { contents: "write", workflows: "write", pull_requests: "read" }, "acme/web": { contents: "write" } }) });
  const push = await access.actorFor({ repo: "acme/api" }, "push");
  expect(push).toMatchObject({ kind: "app", key: "app:7", botId: 99 });
  expect(await push.gitToken()).toBe("ghs_app");
  expect((await push.identity()).login).toBe("acme-app[bot]");
  expect((await access.actorFor({ repo: "acme/web" }, "push")).kind).toBe("owner"); // no workflows accepted there
  expect((await access.actorFor({ repo: "acme/api" }, "pr")).kind).toBe("owner"); // pull requests at read only
  expect((await access.actorFor({ repo: "acme/other" }, "push")).kind).toBe("owner"); // not installed
  expect((await access.actorFor({ org: "acme" }, "create_repo")).kind).toBe("owner"); // never the App's
  expect((await access.actorFor({ repo: "acme/api" }, "push")).key).toBe("app:7");
  // A broken App (its key, a suspension, GitHub's outage) throws, and the owner is never asked instead.
  const broken = createAccess({ auth: auth(), fetchImpl, app: fakeApp({}, { installed: async () => { throw new AppError("the GitHub App: couldn't look up its installation (GitHub said 401)"); } }) });
  const err = await broken.actorFor({ repo: "acme/api" }, "issue").catch((e) => e);
  expect(err).toBeInstanceOf(GitHubNeed);
  expect(err.need.cause).toBe("app_broken");
  expect(sent).toEqual([]);
});

it("a write names its actor; a mutation outside the registry is refused; a refused App call throws and evicts, never retried as the owner", async () => {
  const sent: string[] = [];
  const evicted: string[] = [];
  const access = createAccess({
    auth: auth(), app: fakeApp({ "acme/api": { issues: "write", checks: "read" } }, { evict: (t) => void evicted.push(t) }),
    fetchImpl: async (_u, init) => {
      const who = String(new Headers(init?.headers).get("authorization"));
      sent.push(who);
      return who === "Bearer ghs_app" ? answer(403, { message: "Resource not accessible by integration" }) : answer(200, {});
    },
  });
  await expect(access.rest("POST", "/repos/acme/api/issues/1/comments", { body: "hi" })).rejects.toThrow(/names no actor/);
  await expect(access.graphql("mutation { deleteRepository }", {})).rejects.toThrow(/names no actor/);
  const owner = await access.actorFor({ repo: "acme/other" }, "issue");
  await expect(owner.graphql("mutation { deleteRepository }", {})).rejects.toThrow(/registered/);
  const app = await access.actorFor({ repo: "acme/api" }, "issue");
  const err = await app.rest("POST", "/repos/acme/api/issues/1/comments", { body: "hi" }).catch((e) => e);
  expect(err.need).toMatchObject({ cause: "app_refused", target: "acme/api" });
  // A read the App is refused is the same error: no owner read behind it.
  expect((await access.rest("GET", "/repos/acme/api/commits/abc/check-runs").catch((e) => e)).need.cause).toBe("app_refused");
  expect(sent).toEqual(["Bearer ghs_app", "Bearer ghs_app"]);
  expect(evicted).toEqual(["acme/api", "acme/api"]);
});

it("a tool call whose reads the App served doesn't count as the owner's sign-in answering; one the owner served does", async () => {
  const app = fakeApp({ "acme/api": { pull_requests: "read" } });
  const access = createAccess({ auth: auth(), app, fetchImpl: async () => answer(200, {}) });
  expect((await withOwnerTrace(() => access.rest("GET", "/repos/acme/api/pulls/1"))).owner).toBe(false);
  expect((await withOwnerTrace(() => access.rest("GET", "/repos/acme/api/issues/1"))).owner).toBe(true);
  // GraphQL never goes as the App.
  const sent: string[] = [];
  const g = createAccess({ auth: auth(), app, fetchImpl: async (_u, init) => (sent.push(String(new Headers(init?.headers).get("authorization"))), answer(200, { data: {} })) });
  await g.rest("POST", "/graphql", { query: "query { viewer { login } }", variables: {} });
  expect(sent).toEqual(["Bearer gho_owner"]);
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
