import { generateKeyPairSync } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { Maintainer } from "../src/maintainer.js";
import { GitHubRefused } from "../src/github.js";
import { GitHubNeed, withWriteBudget } from "../src/client.js";
import { inMaintained, parseRepos } from "../src/aidenhq-sdk/maintained-repos.js";
import { accessFor } from "./fake-access.js";

const PRODUCT = "acme/product";
const COMMIT = "c".repeat(40);

interface Call { method: string; url: string; body?: any }

/** A mocked GitHub API: issues, their timelines, the collaborator list, commits, contents and trees. */
function fake(opts: {
  issues?: { number: number; updated_at: string; labels?: string[]; created_at?: string; user?: string; pr?: boolean }[];
  timelines?: Record<number, any[]>;
  permissions?: Record<string, string>;
  files?: Record<string, string>;
  tree?: { path: string; type: string }[];
  failTimeline?: number[];
  /** Issues whose single-issue read fails (a 500), so a state read can't be trusted. */
  failIssue?: number[];
  /** Each issue's state as GitHub has it before this fake's writes; unset is open. */
  states?: Record<number, string>;
  /** Each issue's close reason as GitHub has it; unset is null (no reason recorded). */
  reasons?: Record<number, string>;
  /** The ordinal of the first single-issue GET answered 200 with no issue body (`null`), as an intermediary might. */
  emptyIssueFrom?: number;
  /** The ordinal of the first single-issue GET that fails (1 is assertTrusted's, 2 an issue-state re-read). */
  failIssueFrom?: number;
  longTimeline?: number;
  /** A status the permission route answers with instead of a role (e.g. 403 when the token can't read it). */
  failPermission?: number;
  /** Repos whose issue list answers 500. */
  failList?: string[];
  /** A status the commit lookup answers with instead of a commit (e.g. 404 for an unknown ref). */
  failCommit?: number;
  /** Issues' lastEditedAt (GraphQL), by number; unset is never edited. */
  edited?: Record<number, string>;
  /** Issue comments that already exist (a note an earlier call posted). */
  comments?: { id: number; html_url: string; body: string; created_at?: string }[];
  /** A test's own answer to a state PATCH, consulted at each call (so one Maintainer can meet a failure, then succeed). */
  patch?: (body: any) => Response | { status: number; json: () => Promise<unknown>; headers?: Record<string, string> } | undefined;
  /** Creates the comment, then loses the answer (GitHub may have it; the caller never heard). */
  loseCommentPost?: boolean;
  /** Creates the comment, then answers 502 (a gateway failed after GitHub saved it). */
  failCommentPost?: boolean;
  /** Applies the state change, then loses the answer. */
  losePatchAnswer?: boolean;
  /** Holds each state PATCH until this resolves (a close that is in flight while another waits). */
  holdPatch?: () => Promise<void>;
  /** Pages of 100 an issue's comment list answers before it looks truncated (more than the page cap is refused). */
  commentPages?: number;
  /** The comment list answers 200 with a non-array body (a gateway answering something else). */
  malformedComments?: boolean;
  /** The comment list answers a secondary rate limit instead (a typed need on the reconciliation read). */
  rateLimitComments?: boolean;
}) {
  const calls: Call[] = [];
  const posted: { path: string; body: any }[] = [];
  /** The issue comments a reader sees; `seedComments` starts with some (a note an earlier call posted). */
  const comments: { id: number; html_url: string; body: string; created_at?: string }[] = [...(opts.comments ?? [])];
  // The owner's login is an admin collaborator: a label it adds counts, as any admin's does.
  const permissions: Record<string, string> = { owner1: "admin", ...(opts.permissions ?? {}) };
  // Each issue's state, as a reader sees it after the writes so far; `stamp` orders the timeline's events as GitHub does.
  const stateOf: Record<number, string> = {};
  // Each issue's close reason, as a reader sees it after the writes so far.
  const reasonOf: Record<number, string> = {};
  let singleReads = 0;
  let emptyReads = 0;
  let stamp = 0;
  const nextAt = () => new Date(Date.parse("2026-01-02T00:00:00Z") + stamp++ * 1000).toISOString();
  const fetchFn = (async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    const json = (status: number, b: unknown) => ({ status, json: async () => b });
    // The signed-in owner: the fleet acts as this login.
    if (url === "https://api.github.com/user") return json(200, { login: "owner1", id: 1 });
    if (url === "https://api.github.com/graphql") return json(200, { data: { repository: { issue: { lastEditedAt: opts.edited?.[body.variables.i] ?? null } } } });
    const perm = u.pathname.match(/^\/repos\/[^/]+\/[^/]+\/collaborators\/([^/]+)\/permission$/);
    if (perm && opts.failPermission) return json(opts.failPermission, { message: "Forbidden" });
    if (perm) {
      const p = permissions[decodeURIComponent(perm[1]!)];
      return p ? json(200, { permission: p, role_name: p }) : json(404, { message: "Not Found" });
    }
    const list = u.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/issues$/);
    if (list && opts.failList?.includes(list[1]!)) return json(500, { message: "boom" });
    if (list && method === "GET") {
      const label = u.searchParams.get("labels");
      const items = (opts.issues ?? []).filter((i) => !label || (i.labels ?? ["agent-fix"]).includes(label));
      const per = Number(u.searchParams.get("per_page") ?? "30");
      const page = Number(u.searchParams.get("page") ?? "1");
      return json(200, items.slice((page - 1) * per, page * per).map((i) => ({ number: i.number, title: `issue ${i.number}`, html_url: `https://github.com/${list[1]}/issues/${i.number}`, updated_at: i.updated_at, created_at: i.created_at ?? i.updated_at, user: { login: i.user ?? "someone" }, ...(i.pr ? { pull_request: {} } : {}), labels: (i.labels ?? ["agent-fix"]).map((name) => ({ name })) })));
    }
    const tl = u.pathname.match(/^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)\/timeline$/);
    if (tl) {
      const n = Number(tl[1]);
      if (opts.failTimeline?.includes(n)) return json(500, { message: "boom" });
      if (opts.longTimeline === n) return json(200, Array.from({ length: 100 }, (_, k) => ({ event: "commented", created_at: `2026-01-01T00:00:${String(k % 60).padStart(2, "0")}Z` })));
      return json(200, opts.timelines?.[n] ?? []);
    }
    const one = u.pathname.match(/^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)$/);
    if (one && method === "GET") {
      const n = Number(one[1]);
      if (opts.failIssue?.includes(n) || (opts.failIssueFrom !== undefined && ++singleReads >= opts.failIssueFrom)) return json(500, { message: "boom" });
      const i = (opts.issues ?? []).find((x) => x.number === n);
      if (opts.emptyIssueFrom !== undefined && ++emptyReads >= opts.emptyIssueFrom) return json(200, null);
      // The issue's state is what the real API keeps: a landed PATCH changes it, and edits (reopen/close) land in the timeline.
      return i
        ? json(200, {
            number: n,
            state: stateOf[n] ?? opts.states?.[n] ?? "open",
            state_reason: reasonOf[n] ?? opts.reasons?.[n] ?? null,
            labels: (i.labels ?? ["agent-fix"]).map((name) => ({ name })),
            ...(i.pr ? { pull_request: {} } : {}),
          })
        : json(404, {});
    }
    if (one && method === "PATCH") {
      if (opts.holdPatch) await opts.holdPatch();
      const fail = opts.patch?.(body);
      if (fail) return fail;
      posted.push({ path: u.pathname, body });
      const n = Number(one[1]);
      if (body.state && stateOf[n] !== body.state) {
        stateOf[n] = body.state;
        const at = nextAt();
        const events = (opts.timelines ??= {});
        (events[n] ??= []).push({ event: body.state === "closed" ? "closed" : "reopened", created_at: at });
      }
      if (body.state_reason) reasonOf[n] = body.state_reason;
      if (opts.losePatchAnswer) throw new TypeError("fetch failed");
      return json(200, { state: body.state ?? stateOf[n] ?? "open", state_reason: reasonOf[n] ?? null });
    }
    if (u.pathname.endsWith("/comments") && method === "POST") {
      const n = Number(u.pathname.match(/issues\/(\d+)\/comments$/)![1]);
      if (opts.loseCommentPost || opts.failCommentPost) {
        const id = comments.length + 1;
        const at = nextAt();
        comments.push({ id, html_url: `https://github.com/x#c${id}`, body: body.body, created_at: at });
        ((opts.timelines ??= {})[n] ??= []).push({ event: "commented", id, created_at: at });
        if (opts.failCommentPost) return json(502, { message: "Bad Gateway" });
        throw new TypeError("fetch failed");
      }
      posted.push({ path: u.pathname, body });
      const id = comments.length + 1;
      const at = nextAt();
      comments.push({ id, html_url: `https://github.com/x#c${id}`, body: body.body, created_at: at });
      ((opts.timelines ??= {})[n] ??= []).push({ event: "commented", id, created_at: at });
      return json(201, { id, html_url: `https://github.com/x#c${id}`, created_at: at });
    }
    // The comments an earlier call posted: what a retry reads to see whether its note is already there. A test can make the
    // list longer than the page cap, so a scan stops at the cap instead of reaching every comment.
    if (u.pathname.endsWith("/comments") && method === "GET") {
      if (opts.rateLimitComments) return json(403, { message: "You have exceeded a secondary rate limit." });
      if (opts.malformedComments) return json(200, { message: "not a list" } as never);
      if (opts.commentPages !== undefined) return json(200, Array.from({ length: 100 }, (_, k) => ({ id: 10000 * Number(u.searchParams.get("page")) + k, html_url: `https://github.com/x#f${k}`, body: "filler", created_at: "2026-01-01T00:00:00Z" })).slice(0, opts.commentPages > 0 ? 100 : 0));
      return json(200, comments);
    }
    if (u.pathname.endsWith("/labels") && method === "POST") {
      posted.push({ path: u.pathname, body });
      return json(200, [{ name: "agent-fix" }]);
    }
    if (/\/labels\/[^/]+$/.test(u.pathname) && method === "DELETE") {
      posted.push({ path: u.pathname, body });
      return json(200, []);
    }
    const commit = u.pathname.match(/^\/repos\/[^/]+\/[^/]+\/commits\/(.+)$/);
    if (commit && method === "GET") return opts.failCommit ? json(opts.failCommit, { message: "No commit found" }) : json(200, { sha: COMMIT });
    const contents = u.pathname.match(/^\/repos\/[^/]+\/[^/]+\/contents\/(.+)$/);
    if (contents) {
      const path = decodeURIComponent(contents[1]!);
      const text = opts.files?.[path];
      if (text === undefined) return json(404, {});
      return json(200, { encoding: "base64", content: Buffer.from(text).toString("base64"), sha: "abc" });
    }
    if (/^\/repos\/[^/]+\/[^/]+\/git\/trees\//.test(u.pathname)) return json(200, { tree: opts.tree ?? [], truncated: false });
    return json(404, { message: "Not Found" });
  }) as unknown as typeof fetch;
  return { fetchFn, calls, posted, comments, permissions, stateOf, opts };
}

/** AidenHQ's records, faked: every label write the owner's login made is the fleet's own, and the issues and PRs `ours` names. */
const records = (ours: number[] = []) => async (ref: string) => ours.some((n) => ref.endsWith(`#${n}`));
function maintainer(f: ReturnType<typeof fake>, terms: string[] = [], repos: unknown[] = [{ repo: PRODUCT }], ours: number[] = []) {
  return new Maintainer(accessFor(f.fetchFn), parseRepos(JSON.stringify(repos)), terms, records(ours));
}

const labeled = (login: string, at: string, app?: { id: number; slug: string }) => ({
  event: "labeled",
  label: { name: "agent-fix" },
  actor: { login },
  performed_via_github_app: app ?? null,
  created_at: at,
});

it("labels by the owner's login trusted, as today", async () => {
  const f = fake({
    issues: [{ number: 1, updated_at: "2026-01-01T00:00:00Z" }],
    timelines: {
      1: [
        labeled("owner1", "2026-01-01T00:00:00Z"),
        labeled("admin-user", "2026-01-01T00:00:01Z"),
        labeled("taylan", "2026-01-01T00:00:02Z"),
        labeled("writer-user", "2026-01-01T00:00:03Z"),
        labeled("triage-user", "2026-01-01T00:00:04Z"),
        labeled("random-user", "2026-01-01T00:00:05Z"),
        labeled("reader", "2026-01-01T00:00:06Z"),
      ],
    },
    permissions: { "admin-user": "admin", taylan: "maintain", "writer-user": "write", "triage-user": "triage", reader: "read" },
  });
  const m = maintainer(f);
  const { events } = await m.labelEvents(PRODUCT, 1);
  const trust = Object.fromEntries(events.map((e) => [e.actor, e.trusted]));
  expect(trust).toEqual({ owner1: true, "admin-user": true, taylan: true, "writer-user": false, "triage-user": false, "random-user": false, reader: false });
});

it("a collaborator's permission is re-read, so a revoked admin stops being trusted", async () => {
  vi.useFakeTimers();
  try {
    const f = fake({
      issues: [{ number: 1, updated_at: "2026-01-01T00:00:00Z" }],
      timelines: { 1: [labeled("admin-user", "2026-01-01T00:00:00Z")] },
      permissions: { "admin-user": "admin" },
      });
    const m = maintainer(f);
    expect((await m.labelEvents(PRODUCT, 1)).events[0]!.trusted).toBe(true);
    // Within the TTL the cached collaborator list is reused: one read for repeated label events.
    expect((await m.labelEvents(PRODUCT, 1)).events[0]!.trusted).toBe(true);
    expect(f.calls.filter((c) => c.url.includes("/collaborators"))).toHaveLength(1);
    // Demoted to write: after the TTL the same label event is no longer trusted.
    f.permissions["admin-user"] = "write";
    vi.advanceTimersByTime(61_000);
    expect((await m.labelEvents(PRODUCT, 1)).events[0]!.trusted).toBe(false);
    expect(f.calls.filter((c) => c.url.includes("/collaborators"))).toHaveLength(2);
  } finally {
    vi.useRealTimers();
  }
});

it("a collaborator's role is looked up once, and read, a 404, a 403 or a 500 never trusts a label", async () => {
  const f = fake({
    issues: [{ number: 1, updated_at: "2026-01-01T00:00:00Z" }],
    timelines: { 1: [labeled("admin-user", "2026-01-01T00:00:00Z")] },
    permissions: { "admin-user": "admin" },
  });
  expect((await maintainer(f).labelEvents(PRODUCT, 1)).events[0]!.trusted).toBe(true);
  expect(f.calls.filter((c) => c.url.endsWith("/collaborators/admin-user/permission"))).toHaveLength(1);
  // A stranger's answer under the same token is their own role: read is untrusted, and a 404 means not a user.
  const stranger = fake({
    issues: [
      { number: 1, updated_at: "2026-01-01T00:00:00Z" },
      { number: 2, updated_at: "2026-01-01T00:00:01Z" },
    ],
    timelines: {
      1: [labeled("reader-user", "2026-01-01T00:00:00Z")],
      2: [labeled("nobody-user", "2026-01-01T00:00:01Z")],
    },
    permissions: { "reader-user": "read" },
  });
  expect((await maintainer(stranger).labelEvents(PRODUCT, 1)).events[0]!.trusted).toBe(false);
  expect((await maintainer(stranger).labelEvents(PRODUCT, 2)).events[0]!.trusted).toBe(false);
  // Any other answer throws, so the caller fails closed instead of reading it as untrusted and carrying on.
  for (const status of [403, 500]) {
    const f2 = fake({
      issues: [{ number: 1, updated_at: "2026-01-01T00:00:00Z" }],
      timelines: { 1: [labeled("admin-user", "2026-01-01T00:00:00Z")] },
      permissions: { "admin-user": "admin" },
      failPermission: status,
    });
    await expect(maintainer(f2).labelEvents(PRODUCT, 1)).rejects.toThrow(`GitHub said ${status}`);
    const out = await maintainer(f2).repoSince(PRODUCT);
    expect(out.issues).toEqual([]);
    expect(out.skipped[0]!.reason).toMatch(new RegExp(`could not read its label events.*${status}`));
  }
});

it("an untrusted agent-fix label is skipped, never in issues, and every write refuses it", async () => {
  const f = fake({
    issues: [
      { number: 1, updated_at: "2026-01-01T00:00:00Z" },
      { number: 2, updated_at: "2026-01-01T00:00:01Z" },
    ],
    timelines: {
      1: [labeled("owner1", "2026-01-01T00:00:00Z")],
      2: [labeled("random-user", "2026-01-01T00:00:01Z")],
    },
  });
  const m = maintainer(f);
  const out = await m.repoSince(PRODUCT);
  expect(out.issues.map((i) => i.number)).toEqual([1]);
  expect(out.skipped.map((s) => s.number)).toEqual([2]);
  expect(out.skipped[0]!.reason).toMatch(/random-user/);
  await expect(m.commentBody(PRODUCT, 2, "hello")).rejects.toThrow(/untrusted/);
  await expect(m.label(PRODUCT, 2, "remove")).rejects.toThrow(/untrusted/);
  await expect(m.state(PRODUCT, 2, "closed", "completed")).rejects.toThrow(/untrusted/);
  expect(f.posted).toHaveLength(0);
});

it("a timeline longer than the page cap is refused, never read as if its tail were the end", async () => {
  const f = fake({
    issues: [
      { number: 1, updated_at: "2026-01-01T00:00:00Z" },
      { number: 2, updated_at: "2026-01-01T00:00:01Z" },
    ],
    timelines: { 1: [labeled("owner1", "2026-01-01T00:00:00Z")] },
    longTimeline: 2,
  });
  const m = maintainer(f);
  await expect(m.labelEvents(PRODUCT, 2)).rejects.toThrow(/longer than/);
  // The watcher skips it rather than trusting the older event it could read.
  const out = await m.repoSince(PRODUCT);
  expect(out.issues.map((i) => i.number)).toEqual([1]);
  expect(out.skipped).toEqual([{ number: 2, reason: expect.stringMatching(/longer than/) }]);
});

it("a comment has the owner's host and email removed before it is sent", async () => {
  const f = fake({ issues: [{ number: 1, updated_at: "2026-01-01T00:00:00Z" }], timelines: { 1: [labeled("owner1", "2026-01-01T00:00:00Z")] } });
  const m = maintainer(f, ["internal.example-host"]);
  const sent = await m.commentBody(PRODUCT, 1, "see internal.example-host and dev@acme-corp.com");
  expect(sent).toBe("see [redacted] and [redacted]");
  expect(sent).not.toContain("internal.example-host");
  expect(sent).not.toContain("dev@acme-corp.com");
  expect(await m.commentBody(PRODUCT, 1, "fixed in the next release")).toBe("fixed in the next release");
});

it("a comment whose owner data is hidden behind entities or tags is refused, not sent half-redacted", async () => {
  const f = fake({ issues: [{ number: 1, updated_at: "2026-01-01T00:00:00Z" }], timelines: { 1: [labeled("owner1", "2026-01-01T00:00:00Z")] } });
  const m = maintainer(f, ["internal.example-host"]);
  for (const body of ["dev&#64;acme-corp.com", "dev<b>@</b>acme-corp.com", "internal.example&#45;host"]) {
    await expect(m.commentBody(PRODUCT, 1, body)).rejects.toThrow(/owner data/);
  }
  expect(f.posted).toHaveLength(0);
  // Documentation addresses and the product's own backplane are public, so they pass untouched.
  expect(await m.commentBody(PRODUCT, 1, "dev@example.com on 10.231.0.7")).toBe("dev@example.com on 10.231.0.7");
});

it("a comment carrying a private key has the whole block removed, not just its header", async () => {
  const key = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const f = fake({ issues: [{ number: 1, updated_at: "2026-01-01T00:00:00Z" }], timelines: { 1: [labeled("owner1", "2026-01-01T00:00:00Z")] } });
  const m = maintainer(f);
  const sent = await m.commentBody(PRODUCT, 1, `here it is:\n${key}\nthanks`);
  expect(sent).toBe("here it is:\n[redacted]\nthanks");
  expect(sent).not.toContain("PRIVATE KEY");
  for (const line of key.split("\n").slice(1, -2)) expect(sent).not.toContain(line);
});

it("a comment carrying an unterminated private key has everything from the header on removed", async () => {
  const key = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const f = fake({ issues: [{ number: 1, updated_at: "2026-01-01T00:00:00Z" }], timelines: { 1: [labeled("owner1", "2026-01-01T00:00:00Z")] } });
  const m = maintainer(f);
  const truncated = key.slice(0, key.indexOf("-----END"));
  const sent = await m.commentBody(PRODUCT, 1, `before\n${truncated}`);
  expect(sent).toBe("before\n[redacted]");
  expect(sent).not.toContain("PRIVATE KEY");
  for (const line of truncated.split("\n").slice(1, -1)) expect(sent).not.toContain(line);
});

it("a close with a note posts the note as one comment first, then closes with the requested reason", async () => {
  const f = fake({ issues: [{ number: 1, updated_at: "2026-01-01T00:00:00Z" }], timelines: { 1: [labeled("owner1", "2026-01-01T00:00:00Z")] } });
  const note = "Fixed by acme/product#7, merge 0ba0db1, carried by generation 42.";
  expect(await maintainer(f).state(PRODUCT, 1, "closed", "not_planned", note, "Maintainer")).toMatchObject({ number: 1, state: "closed", state_reason: "not_planned" });
  expect(f.posted.map((p) => p.path)).toEqual([`/repos/${PRODUCT}/issues/1/comments`, `/repos/${PRODUCT}/issues/1`]);
  // The note carries a hidden marker naming it, so a retry whose answer was lost can find it rather than post a second one.
  expect(f.posted[0]!.body.body).toMatch(new RegExp(`^<!-- aidenhq-note:[0-9a-f]{32} -->\\n\\n${note.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n\\n🤖 Generated by Maintainer with \\[AidenHQ\\]\\(https://aidenhq\\.ai\\)$`));
  expect(f.posted[1]!.body).toEqual({ state: "closed", state_reason: "not_planned" });
});

it("a close with a note on an already-closed PR posts the note once and sends no state PATCH", async () => {
  // GitHub closes a PR itself (a merge, or a superseding PR); a close of it with a note must not PATCH it. GitHub refuses that
  // PATCH with a 403 on state_reason, which the caller reads as a failure after the note is on the issue.
  const f = fake({
    issues: [{ number: 1, updated_at: "2026-01-01T00:00:00Z", labels: [], pr: true }],
    states: { 1: "closed" },
  });
  const note = "Superseded by acme/product#7.";
  const m = maintainer(f);
  const out = await m.state(PRODUCT, 1, "closed", "not_planned", note);
  // The note is the whole write: it went once, and the call reports it with the state unchanged.
  expect(out).toMatchObject({ state: "closed", note: { id: 1 } });
  expect(f.posted.map((p) => p.path)).toEqual([`/repos/${PRODUCT}/issues/1/comments`]);
  expect(f.calls.some((c) => c.method === "PATCH")).toBe(false);
  // A second identical call reuses the note and sends neither a comment nor a PATCH.
  const again = await m.state(PRODUCT, 1, "closed", "not_planned", note);
  expect(again).toMatchObject({ state: "closed", note: { id: 1 } });
  expect(f.posted.map((p) => p.path)).toEqual([`/repos/${PRODUCT}/issues/1/comments`]);
  expect(f.calls.some((c) => c.method === "PATCH")).toBe(false);
});

it("a reopen of an issue that is already open sends no state PATCH", async () => {
  const f = fake({ issues: [{ number: 1, updated_at: "2026-01-01T00:00:00Z" }], timelines: { 1: [labeled("owner1", "2026-01-01T00:00:00Z")] } });
  expect(await maintainer(f).state(PRODUCT, 1, "open")).toMatchObject({ number: 1, state: "open" });
  expect(f.calls.some((c) => c.method === "PATCH")).toBe(false);
});

it("a close of an issue already closed with another reason still sends the PATCH, so the reason is recorded", async () => {
  // A not_planned issue whose fix shipped: the caller asks for completed. GitHub accepts that reason change on an issue, so
  // skipping it would report a resolution GitHub never recorded.
  const f = fake({
    issues: [{ number: 1, updated_at: "2026-01-01T00:00:00Z" }],
    timelines: { 1: [labeled("owner1", "2026-01-01T00:00:00Z")] },
    states: { 1: "closed" },
    reasons: { 1: "not_planned" },
  });
  expect(await maintainer(f).state(PRODUCT, 1, "closed", "completed")).toMatchObject({ state: "closed", state_reason: "completed" });
  expect(f.posted.filter((p) => p.path.endsWith("/issues/1")).map((p) => p.body)).toEqual([{ state: "closed", state_reason: "completed" }]);
});

it("a close of an issue already closed with the same reason sends no state PATCH", async () => {
  const f = fake({
    issues: [{ number: 1, updated_at: "2026-01-01T00:00:00Z" }],
    timelines: { 1: [labeled("owner1", "2026-01-01T00:00:00Z")] },
    states: { 1: "closed" },
    reasons: { 1: "completed" },
  });
  expect(await maintainer(f).state(PRODUCT, 1, "closed", "completed")).toMatchObject({ state: "closed", state_reason: "completed" });
  expect(f.calls.some((c) => c.method === "PATCH")).toBe(false);
});

it("a closed PR with a different reason is still settled: its reason cannot be changed and the PATCH is the 403", async () => {
  const f = fake({ issues: [{ number: 1, updated_at: "2026-01-01T00:00:00Z", labels: [], pr: true }], states: { 1: "closed" }, reasons: { 1: "completed" } });
  expect(await maintainer(f).state(PRODUCT, 1, "closed", "not_planned")).toMatchObject({ state: "closed", state_reason: "completed" });
  expect(f.calls.some((c) => c.method === "PATCH")).toBe(false);
});

it("a 200 with no issue state is refused, not read as open, so the PATCH is not sent", async () => {
  // The label read is the first single-issue GET; the pre-PATCH state read is the second.
  const f = fake({ issues: [{ number: 1, updated_at: "2026-01-01T00:00:00Z", labels: [] }], emptyIssueFrom: 2 });
  await expect(maintainer(f).state(PRODUCT, 1, "closed", "completed")).rejects.toThrow(/couldn't read acme\/product#1's state \(GitHub answered 200 without a state\)/);
  expect(f.calls.some((c) => c.method === "PATCH")).toBe(false);
});

it("a state read before the PATCH that fails throws and sends no PATCH", async () => {
  // The label read is the first single-issue GET; the state read is the second. It cannot say whether a PATCH is needed, so the
  // call fails rather than guess (which could PATCH a closed PR into the 403 this change avoids).
  const f = fake({ issues: [{ number: 1, updated_at: "2026-01-01T00:00:00Z", labels: [] }], failIssueFrom: 2 });
  await expect(maintainer(f).state(PRODUCT, 1, "closed", "completed")).rejects.toThrow(/couldn't read acme\/product#1's state/);
  expect(f.calls.some((c) => c.method === "PATCH")).toBe(false);
});

it("a close whose note posted but whose state change is rate limited says the note is done, so a retry only closes", async () => {
  const f = fake({ issues: [{ number: 1, updated_at: "2026-01-01T00:00:00Z" }], timelines: { 1: [labeled("owner1", "2026-01-01T00:00:00Z")] } });
  // The PATCH meets a rate limit after the note is posted.
  const original = f.fetchFn;
  f.fetchFn = (async (url: string, init: RequestInit) => {
    if ((init.method ?? "GET") === "PATCH") return new Response(JSON.stringify({ message: "You have exceeded a secondary rate limit." }), { status: 403, headers: { "retry-after": "600" } });
    return original(url, init);
  }) as typeof fetch;
  const note = "Fixed by acme/product#7, merge 0ba0db1.";
  const err = await maintainer(f).state(PRODUCT, 1, "closed", "completed", note).catch((e) => e);
  // The typed need survives, so the kernel still routes an owner-fixable cause and the caller still sees the real `until`.
  expect(err).toBeInstanceOf(GitHubNeed);
  expect(err.need.cause).toBe("rate_limited");
  expect((err as Error).message).toMatch(/the note was posted .*the state change to closed did not complete.*call this again with the same state and no note after /i);
  expect((err as Error).message).not.toMatch(/still open/);
  // The note went once; the retry the message asks for (no note) only sends the state change.
  f.fetchFn = original;
  expect(await maintainer(f).state(PRODUCT, 1, "closed", "completed")).toMatchObject({ state: "closed" });
  expect(f.posted.filter((p) => p.path.endsWith("/comments"))).toHaveLength(1);
});

it("a close whose note posted and whose state change then needs the owner still posts the note only once", async () => {
  // The first PATCH meets a missing scope after the note is posted: an owner-fixable need, whose words the kernel replaces.
  let failPatch = true;
  const f = fake({
    issues: [{ number: 1, updated_at: "2026-01-01T00:00:00Z" }],
    timelines: { 1: [labeled("owner1", "2026-01-01T00:00:00Z")] },
    patch: () => (failPatch ? new Response(JSON.stringify({ message: "Resource not accessible" }), { status: 403, headers: { "x-accepted-oauth-scopes": "repo" } }) : undefined),
  });
  const note = "Fixed by acme/product#7, merge 0ba0db1.";
  const m = maintainer(f);
  const err = await m.state(PRODUCT, 1, "closed", "completed", note).catch((e) => e);
  expect(err).toBeInstanceOf(GitHubNeed);
  expect(err.need.cause).toBe("scope");
  expect((err as Error).message).toMatch(/the note was posted .*call this again with the same state and no note/i);
  expect(f.posted.map((p) => p.path)).toEqual([`/repos/${PRODUCT}/issues/1/comments`]);
  // Reconnected, the same call finds its own record of the note and only changes the state, so the note posts once even
  // though the warning above was replaced on its way to the agent.
  failPatch = false;
  expect(await m.state(PRODUCT, 1, "closed", "completed", note)).toMatchObject({ state: "closed" });
  expect(f.posted.map((p) => p.path)).toEqual([`/repos/${PRODUCT}/issues/1/comments`, `/repos/${PRODUCT}/issues/1`]);
});

it("a close refused without a typed need after its note posted still says the note is on the issue", async () => {
  const f = fake({
    issues: [{ number: 1, updated_at: "2026-01-01T00:00:00Z" }],
    timelines: { 1: [labeled("owner1", "2026-01-01T00:00:00Z")] },
    patch: () => new Response(JSON.stringify({ message: "Validation Failed" }), { status: 422 }),
  });
  const note = "Fixed by acme/product#7, merge 0ba0db1.";
  const err = await maintainer(f).state(PRODUCT, 1, "closed", "completed", note).catch((e) => e);
  expect(err).not.toBeInstanceOf(GitHubNeed);
  expect((err as Error).message).toMatch(/GitHub refused the state change \(422.*\)\. the note was posted .*call this again with the same state and no note/i);
  expect(f.posted.filter((p) => p.path.endsWith("/comments"))).toHaveLength(1);
});

it("a new close after a reopen posts its note again: the record is this process's, not any comment on the issue", async () => {
  // An identical-looking note already on the issue that this process never posted must not suppress this call's note.
  const f = fake({
    issues: [{ number: 1, updated_at: "2026-01-01T00:00:00Z" }],
    timelines: { 1: [labeled("owner1", "2026-01-01T00:00:00Z")] },
    comments: [{ id: 9, html_url: "https://github.com/x#c9", body: "Fixed by acme/product#7, merge 0ba0db1.\n\n🤖 Generated by Maintenance with [AidenHQ](https://aidenhq.ai)" }],
  });
  const note = "Fixed by acme/product#7, merge 0ba0db1.";
  const m = maintainer(f);
  expect(await m.state(PRODUCT, 1, "closed", "completed", note)).toMatchObject({ state: "closed" });
  expect(f.posted.filter((p) => p.path.endsWith("/comments"))).toHaveLength(1);
  // Reopened and closed again: the issue is no longer in the state that call confirmed, so this close posts its note.
  expect(await m.state(PRODUCT, 1, "open")).toMatchObject({ state: "open" });
  expect(await m.state(PRODUCT, 1, "closed", "completed", note)).toMatchObject({ state: "closed" });
  expect(f.posted.filter((p) => p.path.endsWith("/comments"))).toHaveLength(2);
});

it("a repeated close whose state change did not land posts its note only once", async () => {
  const f = fake({ issues: [{ number: 1, updated_at: "2026-01-01T00:00:00Z" }], timelines: { 1: [labeled("owner1", "2026-01-01T00:00:00Z")] } });
  const note = "Fixed by acme/product#7, merge 0ba0db1.";
  const m = maintainer(f);
  expect(await m.state(PRODUCT, 1, "closed", "completed", note)).toMatchObject({ state: "closed" });
  // A repeat while the issue is already closed posts nothing: the note is on the issue and the state is what was asked.
  expect(await m.state(PRODUCT, 1, "closed", "completed", note)).toMatchObject({ state: "closed" });
  expect(f.posted.filter((p) => p.path.endsWith("/comments"))).toHaveLength(1);
});

it("a retry that reuses a posted note still reports that comment as this call's object", async () => {
  let failPatch = true;
  const f = fake({
    issues: [{ number: 1, updated_at: "2026-01-01T00:00:00Z" }],
    timelines: { 1: [labeled("owner1", "2026-01-01T00:00:00Z")] },
    patch: () => (failPatch ? new Response(JSON.stringify({ message: "Validation Failed" }), { status: 422 }) : undefined),
  });
  const note = "Fixed by acme/product#7, merge 0ba0db1.";
  const m = maintainer(f);
  expect(await m.state(PRODUCT, 1, "closed", "completed", note).catch((e) => e)).not.toBeInstanceOf(GitHubNeed);
  failPatch = false;
  // Posted by the first call, reused by the retry: it is still this call's own comment, so the kernel records its provenance.
  const out = await m.state(PRODUCT, 1, "closed", "completed", note);
  expect(out.objects).toEqual([`github:${PRODUCT}#1/comment/1`]);
  expect(f.posted.filter((p) => p.path.endsWith("/comments"))).toHaveLength(1);
});

it("two overlapping closes of the same note post it once", async () => {
  const f = fake({ issues: [{ number: 1, updated_at: "2026-01-01T00:00:00Z" }], timelines: { 1: [labeled("owner1", "2026-01-01T00:00:00Z")] } });
  const note = "Fixed by acme/product#7, merge 0ba0db1.";
  const m = maintainer(f);
  const [a, b] = await Promise.all([m.state(PRODUCT, 1, "closed", "completed", note), m.state(PRODUCT, 1, "closed", "completed", note)]);
  expect(a).toMatchObject({ state: "closed" });
  expect(b).toMatchObject({ state: "closed" });
  expect(f.posted.filter((p) => p.path.endsWith("/comments"))).toHaveLength(1);
});

it("a close after a reopen that follows a landed close posts its own note, not the first one", async () => {
  const f = fake({ issues: [{ number: 1, updated_at: "2026-01-01T00:00:00Z" }], timelines: { 1: [labeled("owner1", "2026-01-01T00:00:00Z")] } });
  const note = "Fixed by acme/product#7, merge 0ba0db1.";
  const m = maintainer(f);
  expect(await m.state(PRODUCT, 1, "closed", "completed", note)).toMatchObject({ state: "closed" });
  expect(await m.state(PRODUCT, 1, "open")).toMatchObject({ state: "open" });
  const out = await m.state(PRODUCT, 1, "closed", "completed", note);
  expect(out).toMatchObject({ state: "closed" });
  // The second close posted its own comment (a new object), not the one the first call left behind.
  expect(f.posted.filter((p) => p.path.endsWith("/comments"))).toHaveLength(2);
  expect(out.objects).toEqual([`github:${PRODUCT}#1/comment/2`]);
});

it("a state read that fails is not treated as proof, so a retry does not post the note twice", async () => {
  let failPatch = true;
  const f = fake({
    issues: [{ number: 1, updated_at: "2026-01-01T00:00:00Z" }],
    timelines: { 1: [labeled("owner1", "2026-01-01T00:00:00Z")] },
    patch: () => (failPatch ? new Response(JSON.stringify({ message: "Validation Failed" }), { status: 422 }) : undefined),
  });
  const note = "Fixed by acme/product#7, merge 0ba0db1.";
  const m = maintainer(f);
  expect(await m.state(PRODUCT, 1, "closed", "completed", note).catch((e) => e)).not.toBeInstanceOf(GitHubNeed);
  // The retry can read the label (assertTrusted) but not the issue's state (noteApplies): it fails rather than assume
  // "not closed, so post the note again".
  failPatch = false;
  f.opts.failIssueFrom = 2;
  await expect(m.state(PRODUCT, 1, "closed", "completed", note)).rejects.toThrow(/couldn't read acme\/product#1's state \(GitHub said 500\)/);
  expect(f.posted.filter((p) => p.path.endsWith("/comments"))).toHaveLength(1);
  // Once the state can be read, the retry reuses the posted note and only changes the state.
  f.opts.failIssueFrom = undefined;
  expect(await m.state(PRODUCT, 1, "closed", "completed", note)).toMatchObject({ state: "closed" });
  expect(f.posted.filter((p) => p.path.endsWith("/comments"))).toHaveLength(1);
});

it("a timeline read that fails is not read as no close since, so a new close after a reopen posts its note", async () => {
  const f = fake({ issues: [{ number: 1, updated_at: "2026-01-01T00:00:00Z" }], timelines: { 1: [labeled("owner1", "2026-01-01T00:00:00Z")] } });
  const note = "Fixed by acme/product#7, merge 0ba0db1.";
  const m = maintainer(f);
  expect(await m.state(PRODUCT, 1, "closed", "completed", note)).toMatchObject({ state: "closed" });
  expect(await m.state(PRODUCT, 1, "open")).toMatchObject({ state: "open" });
  // A close after the reopen must post its own note; an unreadable timeline can never be read as "no reopen".
  f.opts.failTimeline = [1];
  await expect(m.state(PRODUCT, 1, "closed", "completed", note)).rejects.toThrow(/couldn't read/);
  expect(f.posted.filter((p) => p.path.endsWith("/comments"))).toHaveLength(1);
  f.opts.failTimeline = undefined;
  const out = await m.state(PRODUCT, 1, "closed", "completed", note);
  expect(out).toMatchObject({ state: "closed" });
  expect(f.posted.filter((p) => p.path.endsWith("/comments"))).toHaveLength(2);
  expect(out.objects).toEqual([`github:${PRODUCT}#1/comment/2`]);
});

it("a timeline longer than the page cap is refused, never read as if its tail were the end", async () => {
  const f = fake({ issues: [{ number: 1, updated_at: "2026-01-01T00:00:00Z" }], timelines: { 1: [labeled("owner1", "2026-01-01T00:00:00Z")] } });
  const note = "Fixed by acme/product#7, merge 0ba0db1.";
  const m = maintainer(f);
  expect(await m.state(PRODUCT, 1, "closed", "completed", note)).toMatchObject({ state: "closed" });
  expect(await m.state(PRODUCT, 1, "open")).toMatchObject({ state: "open" });
  // A reopen may sit past the cap: the retry refuses rather than reuse the note for what may be a new close.
  f.opts.longTimeline = 1;
  await expect(m.state(PRODUCT, 1, "closed", "completed", note)).rejects.toThrow(/longer than 1000 events/);
  expect(f.posted.filter((p) => p.path.endsWith("/comments"))).toHaveLength(1);
});

it("a retry orders the note and a reopen by GitHub's event order, not by a shared second", async () => {
  // The reopen and the note land in the same second, with the reopen listed first: a time-only comparison ("a reopen at or
  // after the note") would call this retry a new close and post the note twice. GitHub's own order says nothing happened
  // after the note, so the retry reuses it.
  let failPatch = true;
  const f = fake({
    issues: [{ number: 1, updated_at: "2026-01-01T00:00:00Z" }],
    timelines: { 1: [labeled("owner1", "2026-01-01T00:00:00Z")] },
    patch: () => (failPatch ? new Response(JSON.stringify({ message: "Validation Failed" }), { status: 422 }) : undefined),
  });
  const note = "Fixed by acme/product#7, merge 0ba0db1.";
  const m = maintainer(f);
  expect(await m.state(PRODUCT, 1, "closed", "completed", note).catch((e) => e)).not.toBeInstanceOf(GitHubNeed);
  expect(f.posted.filter((p) => p.path.endsWith("/comments"))).toHaveLength(1);
  // The reopen is listed before this call's own comment at the same second: it is not a close that came after the note.
  f.opts.timelines![1] = [
    labeled("owner1", "2026-01-01T00:00:00Z"),
    { event: "reopened", created_at: "2026-01-02T00:00:00Z" },
    { event: "commented", id: 1, created_at: "2026-01-02T00:00:00Z" },
  ];
  failPatch = false;
  expect(await m.state(PRODUCT, 1, "closed", "completed", note)).toMatchObject({ state: "closed" });
  expect(f.posted.filter((p) => p.path.endsWith("/comments"))).toHaveLength(1);
});

it("an overlapping close waits for the first one's state change, so it neither duplicates the note nor loses provenance", async () => {
  const f = fake({ issues: [{ number: 1, updated_at: "2026-01-01T00:00:00Z" }], timelines: { 1: [labeled("owner1", "2026-01-01T00:00:00Z")] } });
  const note = "Fixed by acme/product#7, merge 0ba0db1.";
  const m = maintainer(f);
  const [a, b] = await Promise.all([m.state(PRODUCT, 1, "closed", "completed", note), m.state(PRODUCT, 1, "closed", "completed", note)]);
  // Each answer carries the one comment: the second close waited and reused it.
  expect(a.objects).toEqual([`github:${PRODUCT}#1/comment/1`]);
  expect(b.objects).toEqual([`github:${PRODUCT}#1/comment/1`]);
  expect(f.posted.filter((p) => p.path.endsWith("/comments"))).toHaveLength(1);
  // The first close's PATCH landed before the second read the issue, so the second finds it closed and skips its PATCH.
  expect(f.posted.filter((p) => p.path.endsWith("/issues/1"))).toHaveLength(1);
});

it("an overlapping close whose budget runs out while it waits for the lock fails fast and sends nothing", async () => {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let began!: () => void;
  const started = new Promise<void>((r) => (began = r));
  const f = fake({
    issues: [{ number: 1, updated_at: "2026-01-01T00:00:00Z" }],
    timelines: { 1: [labeled("owner1", "2026-01-01T00:00:00Z")] },
    holdPatch: () => {
      began();
      return held;
    },
  });
  const note = "Fixed by acme/product#7, merge 0ba0db1.";
  const m = maintainer(f);
  // The first close holds the key's lock at its PATCH. The second belongs to a tool invocation with less than one attempt left:
  // it must fail at once rather than wait out the first and then run its reads after its caller was told it failed.
  const first = m.state(PRODUCT, 1, "closed", "completed", note);
  await started;
  const second = await withWriteBudget(() => m.state(PRODUCT, 1, "closed", "completed", note), () => Date.now() - 239_000).catch((e) => e);
  expect(second).toBeInstanceOf(GitHubNeed);
  expect(second.need).toEqual({ cause: "write_busy" });
  release();
  await first;
  // Only the first call posted the note; the second never reached even its reads.
  expect(f.posted.filter((p) => p.path.endsWith("/comments"))).toHaveLength(1);
  // The trusted-label gate now runs inside the lock too, so the second call makes no read at all: the first call's label read
  // and the state read before its PATCH.
  expect(f.calls.filter((c) => c.method === "GET" && c.url.endsWith("/issues/1"))).toHaveLength(2);
});

it("a pending note is kept through the refusal's advertised reset and the eviction cap, unlike a confirmed one", async () => {
  // A rate limit whose reset is 90 minutes out: past the one-hour TTL a confirmed record gets. The pending note must survive
  // both that TTL and cap pressure, so the caller retrying at the advertised reset still finds it instead of posting again.
  const f = fake({
    issues: [{ number: 1, updated_at: "2026-01-01T00:00:00Z" }, { number: 2, updated_at: "2026-01-01T00:00:00Z" }],
    timelines: { 1: [labeled("owner1", "2026-01-01T00:00:00Z")], 2: [labeled("owner1", "2026-01-01T00:00:00Z")] },
    patch: (body) => (body.state === "closed" && !closedOnce ? (closedOnce = true, new Response(JSON.stringify({ message: "You have exceeded a secondary rate limit." }), { status: 403, headers: { "retry-after": String(90 * 60) } })) : undefined),
  });
  let closedOnce = false;
  const note = "Fixed by acme/product#7, merge 0ba0db1.";
  const m = maintainer(f);
  const err = await m.state(PRODUCT, 1, "closed", "completed", note).catch((e) => e);
  expect(err).toBeInstanceOf(GitHubNeed);
  expect(err.need.cause).toBe("rate_limited");
  const noted = (m as unknown as { noted: Map<string, { at: number; confirmed: boolean; retainUntil: number }> }).noted;
  const key = [...noted.keys()].find((k) => !noted.get(k)!.confirmed)!;
  // The refusal extended the record past the reset; age it past the short TTL and fill the map past its cap with confirmed notes.
  expect(noted.get(key)!.retainUntil).toBeGreaterThan(Date.parse(err.need.until));
  for (const v of noted.values()) v.at = Date.now() - 61 * 60_000;
  for (let i = 0; i < 250; i++) noted.set(`filler#${i}:closed:x`, { at: Date.now(), confirmed: true, retainUntil: Date.now() } as never);
  // Another close records its note (and prunes the map): the aged pending one must still be there, the fillers must not.
  await m.state(PRODUCT, 2, "closed", "completed", "Fixed by acme/product#8, merge 1cd2e3f.").catch(() => {});
  expect(noted.has(key)).toBe(true);
  expect(noted.size).toBeLessThanOrEqual(201);
});

it("a note whose POST answer was lost is reconciled on the retry instead of posted again", async () => {
  const f = fake({ issues: [{ number: 1, updated_at: "2026-01-01T00:00:00Z" }], timelines: { 1: [labeled("owner1", "2026-01-01T00:00:00Z")] } });
  const note = "Fixed by acme/product#7, merge 0ba0db1.";
  const m = maintainer(f);
  // GitHub creates the comment, then the answer is lost: the caller is told the outcome is unknown.
  f.opts.loseCommentPost = true;
  const err = await m.state(PRODUCT, 1, "closed", "completed", note).catch((e) => e);
  expect((err as Error).message).toMatch(/whether the note posted is unknown/);
  expect(f.comments).toHaveLength(1);
  // The retry finds that note by its marker and sends only the state change.
  f.opts.loseCommentPost = false;
  expect(await m.state(PRODUCT, 1, "closed", "completed", note)).toMatchObject({ state: "closed" });
  expect(f.comments).toHaveLength(1);
  expect(f.posted.filter((p) => p.path.endsWith("/comments"))).toHaveLength(0);
  expect(f.posted.filter((p) => p.path.endsWith("/issues/1"))).toHaveLength(1);
});

it("a new close after a reopen gets a fresh marker, so it never takes the earlier close's comment for its own", async () => {
  // The first close lands, then a reopen, then a later identical close. That later attempt's POST creates nothing and loses its
  // answer. Its marker must be its own: the earlier close's comment matches the same note text, state and agent, but not this
  // attempt, so reusing that marker would close the issue without the new note ever being posted.
  const f = fake({ issues: [{ number: 1, updated_at: "2026-01-01T00:00:00Z" }], timelines: { 1: [labeled("owner1", "2026-01-01T00:00:00Z")] } });
  const note = "Fixed by acme/product#7, merge 0ba0db1.";
  const m = maintainer(f);
  expect(await m.state(PRODUCT, 1, "closed", "completed", note)).toMatchObject({ state: "closed" });
  expect(await m.state(PRODUCT, 1, "open")).toMatchObject({ state: "open" });
  // Reach into the instance to fail the later attempt's POST with a lost answer (the comment is never created).
  const inner = m as unknown as { postComment: (r: any, n: number, t: string) => Promise<unknown> };
  const real = inner.postComment.bind(inner);
  inner.postComment = async () => {
    throw new TypeError("fetch failed");
  };
  const err = await m.state(PRODUCT, 1, "closed", "completed", note).catch((e) => e);
  expect((err as Error).message).toMatch(/whether the note posted is unknown/);
  expect(f.comments).toHaveLength(1);
  // The retry reconciles by that fresh marker, finds nothing, and posts its own note: not the first close's comment.
  inner.postComment = real;
  const out = await m.state(PRODUCT, 1, "closed", "completed", note);
  expect(out).toMatchObject({ state: "closed" });
  expect(f.comments).toHaveLength(2);
  expect(out.objects).toEqual([`github:${PRODUCT}#1/comment/2`]);
});

it("a note the POST answered 502 for is reconciled on the retry, not posted again", async () => {
  // GitHub saved the comment and a gateway answered 502: the POST's outcome is unknown, not a refusal, so the pending record
  // must survive and the retry must look for its marker before sending another comment.
  const f = fake({ issues: [{ number: 1, updated_at: "2026-01-01T00:00:00Z" }], timelines: { 1: [labeled("owner1", "2026-01-01T00:00:00Z")] } });
  const note = "Fixed by acme/product#7, merge 0ba0db1.";
  const m = maintainer(f);
  f.opts.failCommentPost = true;
  const err = await m.state(PRODUCT, 1, "closed", "completed", note).catch((e) => e);
  expect((err as Error).message).toMatch(/whether the note posted is unknown/);
  expect(f.comments).toHaveLength(1);
  f.opts.failCommentPost = false;
  expect(await m.state(PRODUCT, 1, "closed", "completed", note)).toMatchObject({ state: "closed" });
  // The one comment GitHub saved is reused; no second POST, and the state change went once.
  expect(f.comments).toHaveLength(1);
  expect(f.posted.filter((p) => p.path.endsWith("/comments"))).toHaveLength(0);
  expect(f.posted.filter((p) => p.path.endsWith("/issues/1"))).toHaveLength(1);
});

it("a state PATCH answered 5xx says the close's outcome is unknown and never tells the caller to PATCH again", async () => {
  const f = fake({
    issues: [{ number: 1, updated_at: "2026-01-01T00:00:00Z" }],
    timelines: { 1: [labeled("owner1", "2026-01-01T00:00:00Z")] },
    patch: () => new Response(JSON.stringify({ message: "Bad Gateway" }), { status: 504 }),
  });
  const note = "Fixed by acme/product#7, merge 0ba0db1.";
  const err = await maintainer(f).state(PRODUCT, 1, "closed", "completed", note).catch((e) => e);
  // A maintainer may have reopened it since: the caller must read the issue's state, not re-send the PATCH.
  expect((err as Error).message).toMatch(/answered the state change to closed with 504: whether the state change to closed landed is unknown/);
  expect((err as Error).message).toMatch(/read the issue's state before retrying/);
  expect((err as Error).message).not.toMatch(/did not complete/);
  expect(f.posted.filter((p) => p.path.endsWith("/comments"))).toHaveLength(1);
});

it("a close rechecks the trusted label once it has the lock, so a label untrusted while it queued stops it", async () => {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let began!: () => void;
  const started = new Promise<void>((r) => (began = r));
  const f = fake({
    issues: [{ number: 1, updated_at: "2026-01-01T00:00:00Z" }],
    timelines: { 1: [labeled("owner1", "2026-01-01T00:00:00Z")] },
    holdPatch: () => {
      began();
      return held;
    },
  });
  const note = "Fixed by acme/product#7, merge 0ba0db1.";
  const m = maintainer(f);
  const first = m.state(PRODUCT, 1, "closed", "completed", note);
  await started;
  const second = m.state(PRODUCT, 1, "closed", "completed", note);
  // While the second close waits for the lock, a stranger replaces the label with their own: it is no longer trusted.
  f.opts.timelines![1]!.push(labeled("random-user", "2026-01-01T00:05:00Z"));
  release();
  await first;
  await expect(second).rejects.toThrow(/untrusted/);
  // Only the first close acted: one note, one state change.
  expect(f.posted.filter((p) => p.path.endsWith("/comments"))).toHaveLength(1);
  expect(f.posted.filter((p) => p.path.endsWith("/issues/1"))).toHaveLength(1);
});

it("a lost POST whose comment scan hits the page cap stays unresolved instead of posting a duplicate", async () => {
  const f = fake({ issues: [{ number: 1, updated_at: "2026-01-01T00:00:00Z" }], timelines: { 1: [labeled("owner1", "2026-01-01T00:00:00Z")] } });
  const note = "Fixed by acme/product#7, merge 0ba0db1.";
  const m = maintainer(f);
  // GitHub creates the note, then the answer is lost.
  f.opts.loseCommentPost = true;
  expect(await m.state(PRODUCT, 1, "closed", "completed", note).catch((e) => e)).toBeInstanceOf(Error);
  expect(f.comments).toHaveLength(1);
  // The issue now looks longer than the page cap, so the scan cannot prove the marker absent: the retry must not post again.
  f.opts.commentPages = 11;
  const err = await m.state(PRODUCT, 1, "closed", "completed", note).catch((e) => e);
  expect((err as Error).message).toMatch(/still unknown, and it can't be checked/);
  expect(f.comments).toHaveLength(1);
});

it("a reconciliation read that a rate limit blocks keeps its typed need, so the caller still gets the reset", async () => {
  const f = fake({ issues: [{ number: 1, updated_at: "2026-01-01T00:00:00Z" }], timelines: { 1: [labeled("owner1", "2026-01-01T00:00:00Z")] } });
  const note = "Fixed by acme/product#7, merge 0ba0db1.";
  const m = maintainer(f);
  // The note posts, then the answer is lost: the pending record stays and the retry reconciles by marker.
  f.opts.loseCommentPost = true;
  await m.state(PRODUCT, 1, "closed", "completed", note).catch(() => {});
  expect(f.comments).toHaveLength(1);
  // That reconciliation read now meets a secondary limit: the need must stay typed (cause and `until`), not become plain text.
  f.opts.rateLimitComments = true;
  const err = await m.state(PRODUCT, 1, "closed", "completed", note).catch((e) => e);
  expect(err).toBeInstanceOf(GitHubNeed);
  expect(err.need.cause).toBe("rate_limited");
  expect(typeof err.need.until).toBe("string");
  expect((err as Error).message).toMatch(/still unknown/);
  // The note is never posted a second time while its outcome is unresolved.
  expect(f.comments).toHaveLength(1);
});

it("a comment page that isn't a list is refused, not read as \"no note\", so the note is not posted again", async () => {
  const f = fake({ issues: [{ number: 1, updated_at: "2026-01-01T00:00:00Z" }], timelines: { 1: [labeled("owner1", "2026-01-01T00:00:00Z")] } });
  const note = "Fixed by acme/product#7, merge 0ba0db1.";
  const m = maintainer(f);
  // GitHub saved the note and the POST answered 502, so the retry must reconcile.
  f.opts.failCommentPost = true;
  await m.state(PRODUCT, 1, "closed", "completed", note).catch(() => {});
  expect(f.comments).toHaveLength(1);
  // A gateway now answers 200 with something that isn't a list: treating it as an empty page would post a duplicate.
  f.opts.failCommentPost = false;
  f.opts.malformedComments = true;
  const err = await m.state(PRODUCT, 1, "closed", "completed", note).catch((e) => e);
  expect((err as Error).message).toMatch(/still unknown, and it can't be checked/);
  expect(f.comments).toHaveLength(1);
  // Once the read is honest again the retry finds the note and sends only the state change.
  f.opts.malformedComments = false;
  expect(await m.state(PRODUCT, 1, "closed", "completed", note)).toMatchObject({ state: "closed" });
  expect(f.comments).toHaveLength(1);
  expect(f.posted.filter((p) => p.path.endsWith("/comments"))).toHaveLength(0);
});

it("a close PATCH whose answer was lost says the outcome is unknown, not that the state did not change", async () => {
  const f = fake({
    issues: [{ number: 1, updated_at: "2026-01-01T00:00:00Z" }],
    timelines: { 1: [labeled("owner1", "2026-01-01T00:00:00Z")] },
    losePatchAnswer: true,
  });
  const note = "Fixed by acme/product#7, merge 0ba0db1.";
  const m = maintainer(f);
  const err = await m.state(PRODUCT, 1, "closed", "completed", note).catch((e) => e);
  // GitHub applied the close but the answer was lost: the message must not claim it did not complete, nor tell the caller to
  // re-send a PATCH blindly (a reopen in between would be undone).
  expect((err as Error).message).toMatch(/whether the state change to closed landed is unknown/);
  expect((err as Error).message).toMatch(/read the issue's state before retrying/);
  expect((err as Error).message).not.toMatch(/did not complete/);
  expect(f.comments).toHaveLength(1);
});

it("a close whose note carries owner data rejects at the comment step, before the state is changed", async () => {
  const f = fake({ issues: [{ number: 1, updated_at: "2026-01-01T00:00:00Z" }], timelines: { 1: [labeled("owner1", "2026-01-01T00:00:00Z")] } });
  // Hidden behind an entity, so the rewrite can't reach it and the whole note refuses rather than being sent half-redacted.
  await expect(maintainer(f, ["internal.example-host"]).state(PRODUCT, 1, "closed", "completed", "fixed on internal.example&#45;host")).rejects.toThrow(/owner data/);
  expect(f.posted).toHaveLength(0);
  expect(f.calls.some((c) => c.method === "PATCH")).toBe(false);
});

it("a close whose note cites a PR only as a bare PR #N is refused before anything is written", async () => {
  const f = fake({ issues: [{ number: 1, updated_at: "2026-01-01T00:00:00Z" }], timelines: { 1: [labeled("owner1", "2026-01-01T00:00:00Z")] } });
  const m = maintainer(f);
  // The exact shape WOR-8689 failed on: PRs merged and live, cited as "PR #722" and "PR #733".
  await expect(m.state(PRODUCT, 1, "closed", "completed", "Fixed by PR #722 (merge 0ba0db1) and PR #733 (merge 1cd2e3f).")).rejects.toThrow(
    /cite the PR as owner\/name#number or its full \/pull\/ URL; a bare 'PR #N' is not read as a citation/,
  );
  await expect(m.state(PRODUCT, 1, "closed", "not_planned", "duplicate of the PR #9 fix")).rejects.toThrow(/bare 'PR #N'/);
  await expect(m.state(PRODUCT, 1, "closed", "completed", "Fixed by PR#12, merge 0ba0db1.")).rejects.toThrow(/bare 'PR #N'/);
  // A bare form is still bare when something is prefixed to it: nothing before "PR" makes "PR #12" a citation the
  // parser reads (`abc/PR #12` reads as no PR at all), so the prefix must not buy it a pass.
  for (const note of [
    "Fixed by abc/PR #12, merge 0ba0db1.",
    "see acme/product/PR #12",
    "(PR #12)",
    "x-PR #12",
    "PR  #12",
    "closed the pr#12 one",
    "Acme/PR #12 (spaced, so not owner/name#N)",
    "merged in https://github.com/acme/product/pull/811; supersedes PR #700",
    // Malformed: a space between the slash and PR is not owner/name#N, and findPrs reads no PR in these.
    "Fixed by acme/ PR#12, merge 0ba0db1.",
    "Fixed by acme/  PR#12, merge 0ba0db1.",
    // A real citation beside a bare one does not launder the bare one.
    "acme/product#1 and PR #2",
  ]) {
    await expect(m.state(PRODUCT, 1, "closed", "completed", note)).rejects.toThrow(/bare 'PR #N'/);
  }
  expect(f.posted).toHaveLength(0);
  expect(f.calls.some((c) => c.method === "PATCH")).toBe(false);
});

it("a close's note citing a PR as owner/name#number or its /pull/ URL is accepted", async () => {
  const f = fake({ issues: [{ number: 1, updated_at: "2026-01-01T00:00:00Z" }], timelines: { 1: [labeled("owner1", "2026-01-01T00:00:00Z")] } });
  const m = maintainer(f);
  for (const note of [
    "Fixed by acme/product#722, merge 0ba0db1.",
    "Fixed by https://github.com/acme/product/pull/722, merge 0ba0db1.",
    "Fixed by https://github.com/acme/product/pull/722 and acme/product#733.",
    // A repo actually named PR: owner/PR#N is the owner/name#N form the parser reads, so it is not the bare form.
    "Fixed by acme/PR#12, merge 0ba0db1.",
    "acme/product#1 and abc/PR#2.",
    // The same holds when the repo's name merely ends in PR: findPrs reads one citation in each of these, so the word
    // PR inside it is the citation's own name, not a bare "PR #N".
    "Fixed by acme/foo-PR#12, merge 0ba0db1.",
    "Fixed by acme/foo.PR#12, merge 0ba0db1.",
    "Fixed by acme/myPR#12.",
    "Fixed by acme/a-PR#1 and abc/PR#2.",
    // No PR cited at all (a not_planned close names the line or path that disproves it): nothing to refuse.
    "Not a bug: the PRs are only read, never written, so `PRs #1` is not a citation and none is needed here.",
  ]) {
    expect(await m.state(PRODUCT, 1, "closed", "completed", note)).toMatchObject({ state: "closed" });
  }
  expect(f.posted.filter((p) => p.path.endsWith("/comments"))).toHaveLength(10);
});

it("a quiet PR (no fix label) closes as not_planned with the close note, through the issues endpoint", async () => {
  const f = fake({ issues: [{ number: 9, updated_at: "2026-01-01T00:00:00Z", labels: [], pr: true }] });
  const note = "Closed for inactivity. Reopen it if you pick it back up. If the change is still wanted, [file an issue](https://github.com/acme/product/issues/new) describing it, and the Maintainer will triage it like any report.";
  expect(await maintainer(f).state(PRODUCT, 9, "closed", "not_planned", note)).toMatchObject({ number: 9, state: "closed", state_reason: "not_planned" });
  expect(f.posted.map((p) => p.path)).toEqual([`/repos/${PRODUCT}/issues/9/comments`, `/repos/${PRODUCT}/issues/9`]);
});

it("a reopen carrying a note is refused, since a note is posted only when closing", async () => {
  const f = fake({ issues: [{ number: 1, updated_at: "2026-01-01T00:00:00Z" }], timelines: { 1: [labeled("owner1", "2026-01-01T00:00:00Z")] } });
  await expect(maintainer(f).state(PRODUCT, 1, "open", undefined, "reopened after the revert")).rejects.toThrow(/only when closing/);
  expect(f.posted).toHaveLength(0);
});

it("the bootstrap read lists each labelled issue once, and a failed label-event read is flagged unread, never read as done", async () => {
  const f = fake({
    issues: [
      { number: 1, updated_at: "2026-01-01T00:00:00Z" },
      { number: 2, updated_at: "2026-01-02T00:00:00Z" },
    ],
    timelines: {
      1: [labeled("owner1", "2026-01-01T00:00:00Z")],
      2: [labeled("owner1", "2026-01-02T00:00:00Z")],
    },
    failTimeline: [2],
  });
  const m = maintainer(f);
  const first = await m.repoSince(PRODUCT);
  expect(first.issues.map((i) => i.number)).toEqual([1]);
  expect(first.skipped).toEqual([{ number: 2, reason: expect.stringMatching(/could not read its label events/), unread: true }]);
  f.opts.failTimeline = undefined;
  expect((await m.repoSince(PRODUCT)).issues.map((i) => i.number)).toEqual([1, 2]);
});

it("an issue past the first page is read", async () => {
  const issues = Array.from({ length: 101 }, (_, k) => ({ number: k + 1, updated_at: `2026-01-01T00:00:00.${String(k).padStart(3, "0")}Z` }));
  issues[100]!.updated_at = "2026-02-01T00:00:00Z";
  const timelines = Object.fromEntries(issues.map((i) => [i.number, [labeled("owner1", i.updated_at)]]));
  const f = fake({ issues, timelines });
  const out = await maintainer(f).repoSince(PRODUCT);
  expect(out.issues).toHaveLength(101);
  expect(out.issues.at(-1)!.number).toBe(101);
  expect(f.calls.filter((c) => c.url.includes("/issues?state=open"))).toHaveLength(2);
});

it("every tool and the endpoint refuse a repository the list doesn't name", async () => {
  const f = fake({ issues: [{ number: 1, updated_at: "2026-01-01T00:00:00Z" }], timelines: { 1: [labeled("owner1", "2026-01-01T00:00:00Z")] } });
  const m = maintainer(f);
  for (const call of [
    () => m.issueList("other/repo"),
    () => m.labelEvents("other/repo", 1),
    () => m.repoTree("other/repo"),
    () => m.repoFile("other/repo", "README.md"),
    () => m.label("other/repo", 1, "add"),
    () => m.state("other/repo", 1, "closed"),
    () => m.repoSince("other/repo"),
  ]) await expect(call()).rejects.toThrow(/other\/repo is not a maintained repo/);
  expect(f.calls.some((c) => c.url.includes("other/repo"))).toBe(false);
});

it("reads the tree and one file, and errors rather than truncating an oversized file", async () => {
  const f = fake({ tree: [{ path: "src/a.ts", type: "blob" }, { path: "README.md", type: "blob" }], files: { "README.md": "hello" } });
  const m = maintainer(f);
  expect((await m.repoTree(PRODUCT)).entries.map((e) => e.path)).toEqual(["src/a.ts", "README.md"]);
  expect(await m.repoFile(PRODUCT, "README.md")).toMatchObject({ path: "README.md", text: "hello", size: 5 });
  // `ref` is the commit the text came from; the contents API's own sha is the blob, kept apart.
  expect(await m.repoFile(PRODUCT, "README.md", "main")).toMatchObject({ ref: COMMIT, blob_sha: "abc" });
  expect(f.calls.some((c) => c.url.endsWith(`/contents/README.md?ref=${COMMIT}`))).toBe(true);
  // An unknown ref rejects rather than handing back the blob sha in `ref`.
  await expect(maintainer(fake({ files: { "README.md": "hello" }, failCommit: 404 })).repoFile(PRODUCT, "README.md", "nope")).rejects.toThrow(/couldn't resolve .* at nope to a commit \(GitHub said 404: No commit found\)/);
  const big = fake({ files: { "big.txt": "x".repeat(300 * 1024) } });
  await expect(maintainer(big).repoFile(PRODUCT, "big.txt")).rejects.toThrow(/over the/);
});

it("the label tool changes only agent-fix", async () => {
  const f = fake({ issues: [{ number: 1, updated_at: "2026-01-01T00:00:00Z" }], timelines: { 1: [labeled("owner1", "2026-01-01T00:00:00Z")] } });
  const m = maintainer(f);
  await expect(m.label(PRODUCT, 1, "add", "bug")).rejects.toThrow(/only the agent-fix and feature-request labels may be changed/);
  expect(await m.label(PRODUCT, 1, "remove")).toMatchObject({ changed: true });
  expect(f.posted[0]!.path).toBe(`/repos/${PRODUCT}/issues/1/labels/agent-fix`);
});

const OTHER = "acme/widgets";

it("maintainer_repos: defaults, bare repos, and a role outside admin, maintain or write refuses the list", () => {
  expect(parseRepos("")).toEqual([]);
  expect(parseRepos(`${PRODUCT},${OTHER}`).map((r) => [r.repo, r.fix_label, r.trusted])).toEqual([
    [PRODUCT, "agent-fix", ["admin", "maintain"]],
    [OTHER, "agent-fix", ["admin", "maintain"]],
  ]);
  expect(parseRepos(JSON.stringify([{ repo: PRODUCT }, { repo: OTHER, fix_label: "fix-me", trusted: ["write"] }])).map((r) => [r.repo, r.fix_label, r.trusted])).toEqual([
    [PRODUCT, "agent-fix", ["admin", "maintain"]],
    [OTHER, "fix-me", ["write"]],
  ]);
  // Duties are opt-in (issues aside), and a quiet PR waits a week.
  expect(parseRepos(PRODUCT)[0]).toMatchObject({ fixes: true, features: false, dependabot: "failing", contributor_prs: false, stale_days: 7, preset: "quiet", triage: "off", triage_cap_per_author_day: 5, triage_labels: true, close: ["duplicate"], needs_info_close_days: null, stale_issues: null, resolved_check: { max_closes: 10, exempt_labels: ["roadmap", "wip", "blocked"] } });
  expect(parseRepos(JSON.stringify([{ repo: PRODUCT, features: true, fixes: false, stale_days: 14 }]))[0]).toMatchObject({ fixes: false, features: true, stale_days: 14 });
  expect(() => parseRepos(JSON.stringify([{ repo: PRODUCT, contributor_pr: true }]))).toThrow("maintainer_repos[0]: unknown key contributor_pr");
  for (const bad of [
    [{ repo: PRODUCT, stale_days: 0 }],
    [{ repo: PRODUCT, dependabot: true }],
    [{ repo: PRODUCT, issues: true }],
    [{ repo: PRODUCT, label: "x" }],
    [{ repo: PRODUCT, preset: "loud" }],
    [{ repo: PRODUCT, close: ["spam"] }],
    [{ repo: PRODUCT, needs_info_close_days: 0 }],
    [{ repo: PRODUCT, stale_issues: { days: 0 } }],
    [{ repo: PRODUCT, stale_issues: { days: 30, nope: 1 } }],
    [{ repo: PRODUCT, stale_days: "x" }],
    [{ repo: PRODUCT, features: "yes" }],
    [{ repo: PRODUCT, trusted: ["triage"] }],
    [{ repo: PRODUCT, trusted: ["read"] }],
    [{ repo: PRODUCT, trusted: [] }],
    [{ repo: PRODUCT, after_merge: "done" }],
    [{ repo: "not-a-repo" }],
    [{ repo: PRODUCT }, { repo: PRODUCT.toUpperCase() }],
    [{ repo: PRODUCT, extra: 1 }],
  ]) expect(() => parseRepos(JSON.stringify(bad))).toThrow(/maintainer_repos\[\d\]/);
});

it("a preset sets features and triage unless the entry says; settings have no upper limit; stale_issues fills its own defaults", () => {
  const at = (e: object) => parseRepos(JSON.stringify([{ repo: PRODUCT, ...e }]))[0]!;
  expect(at({ dependabot: "all" }).dependabot).toBe("all");
  expect(at({ dependabot: "off" }).dependabot).toBe("off");
  expect(at({ preset: "triage" })).toMatchObject({ features: false, triage: "new" });
  expect(at({ preset: "full" })).toMatchObject({ features: true, triage: "new+backlog" });
  expect(at({ preset: "full", features: false, triage: "off" })).toMatchObject({ features: false, triage: "off" });
  expect(at({ stale_days: 365, needs_info_close_days: 400 })).toMatchObject({ stale_days: 365, needs_info_close_days: 400 });
  expect(at({ stale_issues: {} }).stale_issues).toEqual({ days: 60, grace_days: 14, exempt_labels: ["roadmap", "wip", "blocked"] });
  expect(at({ stale_issues: { days: 30, exempt_labels: ["pinned"] } }).stale_issues).toEqual({ days: 30, grace_days: 14, exempt_labels: ["pinned"] });
  expect(at({ resolved_check: { max_closes: 0 } }).resolved_check.max_closes).toBe(0);
  expect(at({ stale_issues: { exempt_labels: ["🚧 in progress"] } }).stale_issues!.exempt_labels).toEqual(["🚧 in progress"]);
});

it("inMaintained matches a listed repo in any case", () => {
  const repos = parseRepos(PRODUCT);
  expect(inMaintained(repos, PRODUCT.toUpperCase())).toBe(true);
  expect(inMaintained(repos, OTHER)).toBe(false);
});

it("a list that doesn't parse refuses every tool and the watcher's read, naming why", async () => {
  const f = fake({});
  const m = new Maintainer(accessFor(f.fetchFn), new Error("maintainer_repos[0]: trusted must be one or more of admin, maintain, write"));
  await expect(m.issueList(PRODUCT)).rejects.toThrow(/maintainer_repos is invalid: .*trusted/);
  await expect(m.bootstrap()).rejects.toThrow(/maintainer_repos is invalid/);
  expect(f.calls).toHaveLength(0);
});

it("a list that doesn't parse sends no comment on any repo, scrubbed or not", async () => {
  const m = new Maintainer(accessFor(fake({}).fetchFn), new Error("maintainer_repos[0]: dependabot must be one of off, failing, all"));
  await expect(m.commentBody("acme/other", 1, "see internal.example-host")).rejects.toThrow(/maintainer_repos is invalid/);
});

it("trust is per repo: a write collaborator vouches only where the repo trusts write", async () => {
  const f = fake({ issues: [{ number: 1, updated_at: "2026-01-01T00:00:00Z" }], timelines: { 1: [labeled("writer-user", "2026-01-01T00:00:00Z")] }, permissions: { "writer-user": "write" } });
  const m = maintainer(f, [], [{ repo: PRODUCT }, { repo: OTHER, trusted: ["maintain", "write"] }]);
  expect((await m.labelEvents(PRODUCT, 1)).events[0]!.trusted).toBe(false);
  expect((await m.labelEvents(OTHER, 1)).events[0]!.trusted).toBe(true);
  await expect(m.commentBody(PRODUCT, 1, "hi")).rejects.toThrow(/untrusted/);
  expect(await m.commentBody(OTHER, 1, "hi")).toBe("hi");
});

it("a repo's own label is the one listed, trusted and the only one changed", async () => {
  const fixMe = (login: string, at: string, app?: { id: number; slug: string }) => ({ ...labeled(login, at, app), label: { name: "fix-me" } });
  const f = fake({ issues: [{ number: 3, updated_at: "2026-01-01T00:00:00Z", labels: ["fix-me"] }], timelines: { 3: [fixMe("owner1", "2026-01-01T00:00:00Z")] } });
  const m = maintainer(f, [], [{ repo: OTHER, fix_label: "fix-me" }]);
  expect((await m.repoSince(OTHER)).issues.map((i) => i.number)).toEqual([3]);
  expect(f.calls.some((c) => c.url.includes(`/repos/${OTHER}/issues?state=open&labels=fix-me`))).toBe(true);
  await expect(m.label(OTHER, 3, "add", "agent-fix")).rejects.toThrow(/only the fix-me and feature-request labels/);
  expect(await m.label(OTHER, 3, "remove")).toMatchObject({ label: "fix-me", changed: true });
  expect(f.posted[0]!.path).toBe(`/repos/${OTHER}/issues/3/labels/fix-me`);
});

it("the bootstrap covers every listed repo, and one repo's failure holds up no other or its own unread issues", async () => {
  const f = fake({
    issues: [
      { number: 1, updated_at: "2026-01-01T00:00:00Z" },
      { number: 2, updated_at: "2026-01-02T00:00:00Z" },
    ],
    timelines: { 1: [labeled("owner1", "2026-01-01T00:00:00Z")], 2: [labeled("owner1", "2026-01-02T00:00:00Z")] },
  });
  const m = maintainer(f, [], [{ repo: PRODUCT }, { repo: OTHER, fixes: false }]);
  expect((await m.bootstrap()).repos).toEqual([{ repo: PRODUCT, issues: [expect.objectContaining({ number: 1 }), expect.objectContaining({ number: 2 })] }, { repo: OTHER }]);
  f.opts.failList = [PRODUCT];
  expect((await m.bootstrap()).repos[0]).toEqual({ repo: PRODUCT, incomplete: expect.stringMatching(/couldn't list acme\/product's issues/) });
  f.opts.failList = undefined;
  f.opts.failTimeline = [2];
  expect((await m.bootstrap()).repos[0]).toEqual({ repo: PRODUCT, issues: [expect.objectContaining({ number: 1 })], incomplete: expect.stringMatching(/1 issue\(s\) whose label events couldn't be read/) });
});
it("a comment on a maintained repo keeps that repo's own org, while other owner terms are still redacted", async () => {
  const f = fake({ issues: [{ number: 1, updated_at: "2026-01-01T00:00:00Z" }], timelines: { 1: [labeled("owner1", "2026-01-01T00:00:00Z")] } });
  const m = maintainer(f, ["acme", "internal.example-host"], [{ repo: OTHER }]);
  expect(await m.commentBody(OTHER, 1, "fixed by https://github.com/acme/widgets/pull/7 on internal.example-host")).toBe("fixed by https://github.com/acme/widgets/pull/7 on [redacted]");
});

const labeledAs = (label: string, login: string, at: string, app?: { id: number; slug: string }) => ({ ...labeled(login, at, app), label: { name: label } });
const BUILD = "agent-build";
const FEATURES = [{ repo: PRODUCT, features: true }];

it("agent-build is trusted from an admin (the owner's login included) and a maintain collaborator, not from a write collaborator under the default roles", async () => {
  const f = fake({
    issues: [1, 2, 3].map((n) => ({ number: n, updated_at: `2026-01-01T00:00:0${n}Z`, labels: [BUILD] })),
    timelines: {
      1: [labeledAs(BUILD, "owner1", "2026-01-01T00:00:01Z")],
      2: [labeledAs(BUILD, "writer-user", "2026-01-01T00:00:02Z")],
      3: [labeledAs(BUILD, "admin-user", "2026-01-01T00:00:03Z")],
    },
    permissions: { "writer-user": "write", "admin-user": "admin" },
  });
  const out = await maintainer(f, [], FEATURES).repoSince(PRODUCT, BUILD);
  expect(out.issues.map((i) => i.number)).toEqual([1, 3]);
  expect(out.skipped.map((s) => s.number)).toEqual([2]);
  // A repo trusting write lets a write collaborator vouch for it.
  const w = fake({ issues: [{ number: 1, updated_at: "2026-01-01T00:00:00Z", labels: [BUILD] }], timelines: { 1: [labeledAs(BUILD, "writer-user", "2026-01-01T00:00:00Z")] }, permissions: { "writer-user": "write" } });
  expect((await maintainer(w, [], [{ repo: PRODUCT, features: true, trusted: ["write"] }]).issueList(PRODUCT, BUILD)).issues[0]).toMatchObject({ trusted: true });
});

it("trust is computed on the label asked for, and AGENT-BUILD is not agent-build", async () => {
  const f = fake({
    issues: [{ number: 1, updated_at: "2026-01-01T00:00:00Z", labels: ["agent-fix", BUILD] }],
    timelines: { 1: [labeledAs("agent-fix", "admin-user", "2026-01-01T00:00:00Z"), labeledAs(BUILD, "random-user", "2026-01-01T00:00:01Z"), labeledAs("AGENT-BUILD", "admin-user", "2026-01-01T00:00:02Z")] },
    permissions: { "admin-user": "admin" },
  });
  const m = maintainer(f, [], FEATURES);
  expect((await m.issueList(PRODUCT)).issues[0]).toMatchObject({ trusted: true });
  expect((await m.issueList(PRODUCT, BUILD)).issues[0]).toMatchObject({ trusted: false, actor: "random-user" });
  expect((await m.labelEvents(PRODUCT, 1, BUILD)).events.map((e) => e.label)).toEqual([BUILD]);
});

it("the label tool adds and removes feature-request, and refuses agent-build", async () => {
  const f = fake({ issues: [{ number: 1, updated_at: "2026-01-01T00:00:00Z", labels: [] }] });
  const m = maintainer(f);
  await expect(m.label(PRODUCT, 1, "add", BUILD)).rejects.toThrow("agent-build is the owner's label");
  await expect(m.label(PRODUCT, 1, "remove", "AGENT-BUILD")).rejects.toThrow("agent-build is the owner's label");
  expect(await m.label(PRODUCT, 1, "add", "feature-request")).toMatchObject({ label: "feature-request", changed: true });
  expect(f.posted[0]).toMatchObject({ body: { labels: ["feature-request"] } });
});

it("a features repo's bootstrap reads its trusted agent-build issues and its trusted feature requests, a repo without features neither", async () => {
  const f = fake({
    issues: [
      { number: 1, updated_at: "2026-02-01T00:00:00Z", created_at: "2026-02-01T00:00:00Z", labels: ["feature-request"] },
      { number: 2, updated_at: "2026-02-01T00:00:01Z", created_at: "2026-02-01T00:00:01Z", labels: [BUILD] },
      { number: 4, updated_at: "2026-02-01T00:00:03Z", created_at: "2026-02-01T00:00:03Z", labels: ["feature-request"] },
    ],
    timelines: { 1: [labeledAs("feature-request", "owner1", "2026-02-01T00:00:01Z")], 2: [labeledAs(BUILD, "admin-user", "2026-02-01T00:00:03Z")], 4: [labeledAs("feature-request", "stranger", "2026-02-01T00:00:04Z")] },
    permissions: { "admin-user": "admin" },
  });
  const row = (await maintainer(f, [], [{ repo: PRODUCT, features: true, fixes: false }]).bootstrap()).repos[0]! as any;
  expect(row.builds.map((i: any) => [i.number, i.trusted])).toEqual([[2, true]]);
  expect(row.featured).toEqual([1]);
  expect(row.issues).toBeUndefined();
  const plain = (await maintainer(f).bootstrap()).repos[0]! as any;
  expect([plain.builds, plain.featured]).toEqual([undefined, undefined]);
});

it("oneIssue reads the issue as it stands with its label's trust verdict, and null when it is closed, a PR or no longer labelled", async () => {
  const f = fake({
    issues: [{ number: 1, updated_at: "2026-01-01T00:00:00Z" }, { number: 2, updated_at: "2026-01-01T00:00:00Z" }, { number: 3, updated_at: "2026-01-01T00:00:00Z", pr: true }, { number: 4, updated_at: "2026-01-01T00:00:00Z", labels: ["bug"] }],
    timelines: { 1: [labeled("owner1", "2026-01-01T00:00:00Z")], 2: [labeled("random-user", "2026-01-01T00:00:00Z")] },
    states: { 5: "closed" },
  });
  const m = maintainer(f);
  expect((await m.oneIssue(PRODUCT, 1)).issue).toMatchObject({ number: 1, trusted: true, labeled_at: "2026-01-01T00:00:00Z", labels: ["agent-fix"] });
  expect((await m.oneIssue(PRODUCT, 2)).issue).toMatchObject({ number: 2, trusted: false, actor: "random-user" });
  for (const n of [3, 4, 99]) expect((await m.oneIssue(PRODUCT, n)).issue).toBeNull(); // 99 was deleted: a 404 is a no, not a retry
  f.opts.failTimeline = [1];
  await expect(m.oneIssue(PRODUCT, 1)).rejects.toThrow(/timeline/);
  f.opts.failTimeline = undefined;
  f.opts.longTimeline = 2;
  expect(await m.oneIssue(PRODUCT, 2)).toMatchObject({ issue: null, refused: expect.stringMatching(/longer than/) });
  expect((await maintainer(f).bootstrap([OTHER])).repos).toEqual([]);
});

it("pr_list tells bot, fleet and human PRs apart, and reads a human author's latest activity and what waits on them", async () => {
  const f = fake({});
  const pr = (number: number, login: string, extra: object = {}) => ({ number, user: { login, type: login.endsWith("[bot]") ? "Bot" : "User" }, draft: false, labels: [{ name: "x" }], requested_reviewers: [], requested_teams: [], head: { sha: `s${number}` }, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-03-01T00:00:00Z", ...extra });
  const answers: Record<string, unknown> = {
    [`/repos/${PRODUCT}/pulls`]: [pr(1, "dependabot[bot]"), pr(2, "owner1"), pr(3, "carol", { draft: true, requested_reviewers: [{ login: "dave" }] }), pr(4, "erin")],
    [`/repos/${PRODUCT}/pulls/3`]: { mergeable_state: "clean" },
    [`/repos/${PRODUCT}/pulls/4`]: { mergeable_state: "dirty" },
    [`/repos/${PRODUCT}/commits/s3`]: { commit: { committer: { date: "2026-01-05T00:00:00Z" } } },
    [`/repos/${PRODUCT}/commits/s4`]: { commit: { committer: { date: "2026-01-02T00:00:00Z" } } },
    [`/repos/${PRODUCT}/commits/s3/check-runs`]: { check_runs: [{ name: "ci", conclusion: "success" }] },
    [`/repos/${PRODUCT}/commits/s4/check-runs`]: { check_runs: [{ name: "lint", conclusion: "failure" }] },
    [`/repos/${PRODUCT}/issues/3/comments`]: [{ user: { login: "carol" }, created_at: "2026-02-01T00:00:00Z" }, { user: { login: "dave" }, created_at: "2026-02-20T00:00:00Z" }],
    [`/repos/${PRODUCT}/issues/4/comments`]: [],
    [`/repos/${PRODUCT}/pulls/3/reviews`]: [],
    [`/repos/${PRODUCT}/pulls/4/reviews`]: [{ user: { login: "dave" }, state: "CHANGES_REQUESTED", submitted_at: "2026-01-03T00:00:00Z" }],
    [`/repos/${PRODUCT}/pulls/3/comments`]: [],
    [`/repos/${PRODUCT}/pulls/4/comments`]: [{ user: { login: "erin" }, created_at: "2026-01-10T00:00:00Z" }],
  };
  const fetchFn = (async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const hit = u.hostname === "api.github.com" ? answers[u.pathname] : undefined;
    return hit !== undefined ? { status: 200, json: async () => hit } : f.fetchFn(url, init);
  }) as unknown as typeof fetch;
  const m = new Maintainer(accessFor(fetchFn), parseRepos(JSON.stringify([{ repo: PRODUCT }])), [], records([2])); // #2 is the fleet's
  const { prs } = await m.prList(PRODUCT);
  expect(prs.map((p) => [p.number, p.author_kind])).toEqual([[1, "bot"], [2, "fleet"], [3, "human"], [4, "human"]]);
  // Dave's comment is not the author's: Carol's latest word is her own comment, and a review is asked of someone.
  expect(prs[2]).toMatchObject({ draft: true, review_requested: true, last_author_activity: "2026-02-01T00:00:00Z", waiting_on_author: "still a draft" });
  expect(prs[3]).toMatchObject({ review_requested: false, last_author_activity: "2026-01-10T00:00:00Z", waiting_on_author: "failing checks (1); requested changes; a merge conflict" });
});

it("an issue edited after its trusted agent-build label is untrusted until the owner relabels it", async () => {
  const f = fake({
    issues: [1, 2].map((n) => ({ number: n, updated_at: "2026-01-01T00:00:09Z", labels: [BUILD] })),
    timelines: { 1: [labeledAs(BUILD, "admin-user", "2026-01-01T00:00:01Z")], 2: [labeledAs(BUILD, "admin-user", "2026-01-01T00:00:01Z")] },
    permissions: { "admin-user": "admin" },
    edited: { 1: "2026-01-01T00:00:05Z", 2: "2025-12-31T00:00:00Z" },
  });
  const out = await maintainer(f, [], FEATURES).repoSince(PRODUCT, BUILD);
  expect(out.issues.map((i) => i.number)).toEqual([2]);
  expect(out.skipped).toEqual([{ number: 1, reason: expect.stringMatching(/edited after agent-build was added/) }]);
  expect((await maintainer(f, [], FEATURES).labelEvents(PRODUCT, 1, BUILD)).events[0]).toMatchObject({ trusted: false, stale: true });
});

it("repo file refuses .. escape", async () => {
  const f = fake({ files: { "README.md": "hi" } });
  const m = maintainer(f);
  await expect(m.repoFile(PRODUCT, "../../../user/keys")).rejects.toThrow(/\.\. segment/);
  await expect(m.repoFile(PRODUCT, "README.md", "../x")).rejects.toThrow(/\.\. segment/);
  await expect(m.repoTree(PRODUCT, "..")).rejects.toThrow(/\.\. segment/);
  expect(f.calls).toHaveLength(0);
  // The client itself refuses any path that resolves elsewhere, whoever builds it.
  await expect(accessFor(f.fetchFn).rest("GET", `/repos/${PRODUCT}/contents/../../../user`)).rejects.toThrow(/resolves elsewhere/);
  expect(f.calls).toHaveLength(0);
});

it("comment merges scrub on maintained repos: the product repo is scrubbed too, any other repo goes as written", async () => {
  const f = fake({ issues: [{ number: 1, updated_at: "2026-01-01T00:00:00Z" }], timelines: { 1: [labeled("owner1", "2026-01-01T00:00:00Z")] } });
  const m = maintainer(f, ["internal.example-host"], [{ repo: PRODUCT }]);
  expect(await m.commentBody(PRODUCT, 1, "on internal.example-host")).toBe("on [redacted]");
  expect(await m.commentBody("elsewhere/repo", 1, "on internal.example-host")).toBe("on internal.example-host");
  expect(await m.commentBody("elsewhere/repo", 1, "on internal.example-host", "elsewhere/repo")).toBe("on [redacted]");
  expect(f.posted).toHaveLength(0);
});

it("labelling or closing an issue never makes it ours: only the note comment the fleet posted is recorded", async () => {
  const f = fake({ issues: [{ number: 1, updated_at: "2026-01-01T00:00:00Z", labels: ["agent-fix"] }], timelines: { 1: [labeled("owner1", "2026-01-01T00:00:00Z")] } });
  const m = maintainer(f);
  const labelled = await m.label(PRODUCT, 1, "remove");
  expect(labelled).toMatchObject({ changed: true });
  expect(labelled).not.toHaveProperty("objects");
  expect(await m.state(PRODUCT, 1, "closed", "completed")).not.toHaveProperty("objects");
  const noted = (await m.state(PRODUCT, 1, "closed", "completed", "fixed by acme/product#7")) as { objects?: string[] };
  expect(noted.objects).toEqual([expect.stringMatching(new RegExp(`^github:${PRODUCT}#1/comment/\\d+$`))]);
});
