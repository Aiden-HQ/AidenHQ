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

it("a GraphQL refusal's warning stays while refusals keep coming and expires two hours after the last", async () => {
  const msg = "Although you appear to have the correct authorization credentials, the `acme` organization has enabled OAuth App access restrictions.";
  const t = fakeTime();
  let refuse = true;
  const a = createAccess({ auth: auth(), now: t.now, sleep: (ms) => t.sleep(ms), timer: t.timer, fetchImpl: async () => (refuse ? forbidden({ saml_failure: false }, msg) : answer(200, { data: { ok: 1 } })) });
  await a.graphql("q", { org: "acme" }).catch(() => undefined);
  expect(a.status().problems).toHaveLength(1);
  refuse = false;
  await t.sleep(119 * 60_000);
  await a.graphql("q", { org: "acme" });
  expect(a.status().problems).toHaveLength(1);
  await t.sleep(2 * 60_000);
  expect(a.status().problems).toHaveLength(0);
  refuse = true;
  await a.graphql("q", { org: "acme" }).catch(() => undefined);
  await t.sleep(60 * 60_000);
  await a.graphql("q", { org: "acme" }).catch(() => undefined); // another refusal restarts the clock
  await t.sleep(60 * 60_000);
  expect(a.status().problems).toHaveLength(1);
});

// A success that names an org is the owner's fix already made: the org is reported so the kernel clears its sso/restricted need.
it("reports the org on a successful owner call that names one, and only then", async () => {
  const seen: string[] = [];
  let answerWith = () => answer(200, { login: "owner", data: {} });
  const access = createAccess({ auth: auth(), onOrgOk: (org) => void seen.push(org), fetchImpl: async (u) => answerWith() });
  await access.rest("GET", "/orgs/Acme/repos");
  await access.rest("GET", "/repos/acme/api/issues/1");
  await access.rest("GET", "/search/issues?q=org%3AAcme%20is%3Aissue");
  await access.rest("GET", "/search/issues?q=user%3Aacme%20is%3Aissue");
  await access.rest("GET", "/search/issues?q=org%3Aacme%20org%3Aother%20is%3Aissue");
  await access.rest("GET", "/user");
  expect(seen).toEqual(["Acme", "acme", "Acme", "acme", "acme", "other"]);
  seen.length = 0;

  // A 304 (a conditional read that found nothing new) is a success too.
  answerWith = () => new Response(null, { status: 304 });
  await access.rest("GET", "/orgs/Acme/repos", undefined, { etag: "W/\"x\"" });
  expect(seen).toEqual(["Acme"]);
  seen.length = 0;

  // A failed call reports nothing (no need to clear, and nothing succeeded) and keeps the card's warning.
  answerWith = () => answer(403, { message: "Resource not accessible by integration", url: "http://board.example/connect/github" });
  await access.rest("GET", "/orgs/Acme/repos").catch(() => {});
  expect(seen).toEqual([]);
  // The owner grants it: the same call working clears the warning the refusal recorded, not only the kernel's row.
  answerWith = () => answer(200, {});
  await access.rest("GET", "/orgs/Acme/repos");
  expect(access.status().problems).toEqual([]);
  seen.length = 0;

  // An App's call is another identity: its success says nothing about the owner's sign-in.
  answerWith = () => answer(200, {});
  const as = { key: "app:1", token: async () => "ghs_app" };
  await access.rest("GET", "/orgs/Acme/repos", undefined, { as });
  expect(seen).toEqual([]);
});

it("reports variables.org on a GraphQL answer without errors, never one with errors or no org", async () => {
  const seen: string[] = [];
  let body: unknown = { data: { organization: { projectsV2: { nodes: [] } } } };
  const access = createAccess({ auth: auth(), onOrgOk: (org) => void seen.push(org), fetchImpl: async () => answer(200, body) });
  await access.graphql("query($org: String!) { organization(login: $org) { id } }", { org: "acme" });
  expect(seen).toEqual(["acme"]);
  body = { data: {}, errors: [{ message: "Something went wrong" }] };
  await access.graphql("query($org: String!) { organization(login: $org) { id } }", { org: "acme" });
  expect(seen, "a GraphQL answer with errors is not a success").toEqual(["acme"]);
  body = { data: {} };
  await access.graphql("query { viewer { login } }", {});
  expect(seen).toEqual(["acme"]);
  // The App's answer is not the owner's.
  body = { data: {} };
  await access.graphql("query($org: String!) { organization(login: $org) { id } }", { org: "acme" }, { as: { key: "app:1", token: async () => "ghs_app" } });
  expect(seen).toEqual(["acme"]);
});
