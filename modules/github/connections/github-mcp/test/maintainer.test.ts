import { generateKeyPairSync } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { Maintainer } from "../src/maintainer.js";
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
  longTimeline?: number;
  /** A status the permission route answers with instead of a role (e.g. 403 when the token can't read it). */
  failPermission?: number;
  /** Repos whose issue list answers 500. */
  failList?: string[];
  /** A status the commit lookup answers with instead of a commit (e.g. 404 for an unknown ref). */
  failCommit?: number;
  /** Issues' lastEditedAt (GraphQL), by number; unset is never edited. */
  edited?: Record<number, string>;
}) {
  const calls: Call[] = [];
  const posted: { path: string; body: any }[] = [];
  const permissions = { ...(opts.permissions ?? {}) };
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
      const i = (opts.issues ?? []).find((x) => x.number === n);
      return i ? json(200, { number: n, labels: (i.labels ?? ["agent-fix"]).map((name) => ({ name })), ...(i.pr ? { pull_request: {} } : {}) }) : json(404, {});
    }
    if (one && method === "PATCH") {
      posted.push({ path: u.pathname, body });
      return json(200, { state: body.state, state_reason: body.state_reason ?? null });
    }
    if (u.pathname.endsWith("/comments") && method === "POST") {
      posted.push({ path: u.pathname, body });
      return json(201, { id: 1, html_url: "https://github.com/x#c1" });
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
  return { fetchFn, calls, posted, permissions, opts };
}

/** AidenHQ's records, faked: every label write the owner's login made is the fleet's own, and the issues and PRs `ours` names. */
const records = (ours: number[] = []) => async (ref: string) => ref.includes("/label/") || ours.some((n) => ref.endsWith(`#${n}`));
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

it("agent-fix: recorded label trusted, owner's own not; an admin or a maintain collaborator, and nothing else", async () => {
  const f = fake({
    issues: [{ number: 1, updated_at: "2026-01-01T00:00:00Z" }],
    timelines: {
      1: [
        labeled("owner1", "2026-01-01T00:00:00Z"),
        labeled("admin-user", "2026-01-01T00:00:01Z"),
        labeled("maintainer-user", "2026-01-01T00:00:02Z"),
        labeled("writer-user", "2026-01-01T00:00:03Z"),
        labeled("triage-user", "2026-01-01T00:00:04Z"),
        labeled("random-user", "2026-01-01T00:00:05Z"),
      ],
    },
    permissions: { "admin-user": "admin", "maintainer-user": "maintain", "writer-user": "write", "triage-user": "triage" },
  });
  const m = maintainer(f);
  const { events } = await m.labelEvents(PRODUCT, 1);
  const trust = Object.fromEntries(events.map((e) => [e.actor, e.trusted]));
  expect(trust).toEqual({ "owner1": true, "admin-user": true, "maintainer-user": true, "writer-user": false, "triage-user": false, "random-user": false });
  // The same label by the owner's login, not in AidenHQ's records (the owner by hand on GitHub): untrusted, though an admin.
  const own = new Maintainer(accessFor(f.fetchFn), parseRepos(JSON.stringify([{ repo: PRODUCT }])), [], async () => false);
  f.permissions["owner1"] = "admin";
  expect((await own.labelEvents(PRODUCT, 1)).events.find((e) => e.actor === "owner1")!.trusted).toBe(false);
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
  await expect(m.comment(PRODUCT, 2, "hello")).rejects.toThrow(/untrusted/);
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
  expect(await m.comment(PRODUCT, 1, "see internal.example-host and dev@acme-corp.com")).toMatchObject({ number: 1 });
  const sent = f.posted[0]!.body.body as string;
  expect(sent).toBe("see [redacted] and [redacted]");
  expect(sent).not.toContain("internal.example-host");
  expect(sent).not.toContain("dev@acme-corp.com");
  expect(await m.comment(PRODUCT, 1, "fixed in the next release")).toMatchObject({ number: 1 });
  expect(f.posted[1]!.body).toEqual({ body: "fixed in the next release" });
});

it("a comment whose owner data is hidden behind entities or tags is refused, not sent half-redacted", async () => {
  const f = fake({ issues: [{ number: 1, updated_at: "2026-01-01T00:00:00Z" }], timelines: { 1: [labeled("owner1", "2026-01-01T00:00:00Z")] } });
  const m = maintainer(f, ["internal.example-host"]);
  for (const body of ["dev&#64;acme-corp.com", "dev<b>@</b>acme-corp.com", "internal.example&#45;host"]) {
    await expect(m.comment(PRODUCT, 1, body)).rejects.toThrow(/owner data/);
  }
  expect(f.posted).toHaveLength(0);
  // Documentation addresses and the product's own backplane are public, so they pass untouched.
  expect(await m.comment(PRODUCT, 1, "dev@example.com on 10.231.0.7")).toMatchObject({ number: 1 });
  expect(f.posted[0]!.body).toEqual({ body: "dev@example.com on 10.231.0.7" });
});

it("a comment carrying a private key has the whole block removed, not just its header", async () => {
  const key = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const f = fake({ issues: [{ number: 1, updated_at: "2026-01-01T00:00:00Z" }], timelines: { 1: [labeled("owner1", "2026-01-01T00:00:00Z")] } });
  const m = maintainer(f);
  expect(await m.comment(PRODUCT, 1, `here it is:\n${key}\nthanks`)).toMatchObject({ number: 1 });
  const sent = f.posted[0]!.body.body as string;
  expect(sent).toBe("here it is:\n[redacted]\nthanks");
  expect(sent).not.toContain("PRIVATE KEY");
  for (const line of key.split("\n").slice(1, -2)) expect(sent).not.toContain(line);
});

it("a comment carrying an unterminated private key has everything from the header on removed", async () => {
  const key = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const f = fake({ issues: [{ number: 1, updated_at: "2026-01-01T00:00:00Z" }], timelines: { 1: [labeled("owner1", "2026-01-01T00:00:00Z")] } });
  const m = maintainer(f);
  const truncated = key.slice(0, key.indexOf("-----END"));
  expect(await m.comment(PRODUCT, 1, `before\n${truncated}`)).toMatchObject({ number: 1 });
  const sent = f.posted[0]!.body.body as string;
  expect(sent).toBe("before\n[redacted]");
  expect(sent).not.toContain("PRIVATE KEY");
  for (const line of truncated.split("\n").slice(1, -1)) expect(sent).not.toContain(line);
});

it("a close with a note posts the note as one comment first, then closes with the requested reason", async () => {
  const f = fake({ issues: [{ number: 1, updated_at: "2026-01-01T00:00:00Z" }], timelines: { 1: [labeled("owner1", "2026-01-01T00:00:00Z")] } });
  const note = "Fixed by acme/product#7, merge 0ba0db1, carried by generation 42.";
  expect(await maintainer(f).state(PRODUCT, 1, "closed", "not_planned", note)).toMatchObject({ number: 1, state: "closed", state_reason: "not_planned" });
  expect(f.posted.map((p) => p.path)).toEqual([`/repos/${PRODUCT}/issues/1/comments`, `/repos/${PRODUCT}/issues/1`]);
  expect(f.posted[0]!.body).toEqual({ body: note });
  expect(f.posted[1]!.body).toEqual({ state: "closed", state_reason: "not_planned" });
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
  ]) {
    expect(await m.state(PRODUCT, 1, "closed", "completed", note)).toMatchObject({ state: "closed" });
  }
  expect(f.posted.filter((p) => p.path.endsWith("/comments"))).toHaveLength(3);
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

it("since paging returns the same cursor twice without duplicating an issue", async () => {
  const f = fake({
    issues: [
      { number: 1, updated_at: "2026-01-01T00:00:00Z" },
      { number: 2, updated_at: "2026-01-02T00:00:00Z" },
    ],
    timelines: {
      1: [labeled("owner1", "2026-01-01T00:00:00Z")],
      2: [labeled("owner1", "2026-01-02T00:00:00Z")],
    },
  });
  const m = maintainer(f);
  // The board's first poll sends an empty since: from the start.
  expect((await m.repoSince(PRODUCT, "")).issues.map((i) => i.number)).toEqual([1, 2]);
  const first = await m.repoSince(PRODUCT, "2025-12-31T00:00:00Z");
  expect(first.issues.map((i) => i.number)).toEqual([1, 2]);
  expect(first.cursor).toBe("2026-01-02T00:00:00Z");
  const again = await m.repoSince(PRODUCT, first.cursor!);
  expect(again.issues).toEqual([]);
  expect(again.cursor).toBe(first.cursor);
  const later = await m.repoSince(PRODUCT, "2026-01-01T12:00:00Z");
  expect(later.issues.map((i) => i.number)).toEqual([2]);
});

it("a failed label-event read does not advance the cursor, so the next poll retries it", async () => {
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
  const first = await m.repoSince(PRODUCT, "2025-12-31T00:00:00Z");
  expect(first.issues.map((i) => i.number)).toEqual([1]);
  expect(first.skipped.map((s) => s.number)).toEqual([2]);
  // The failure is not recorded as done: the cursor stops before it, so the next poll sees issue 2 again.
  expect(first.cursor).toBe("2026-01-01T00:00:00Z");
  f.opts.failTimeline = undefined;
  const retry = await m.repoSince(PRODUCT, first.cursor!);
  expect(retry.issues.map((i) => i.number)).toEqual([2]);
  expect(retry.cursor).toBe("2026-01-02T00:00:00Z");
});

it("an issue past the first page is read and never skipped by the cursor", async () => {
  const issues = Array.from({ length: 101 }, (_, k) => ({ number: k + 1, updated_at: `2026-01-01T00:00:00.${String(k).padStart(3, "0")}Z` }));
  issues[100]!.updated_at = "2026-02-01T00:00:00Z";
  const timelines = Object.fromEntries(issues.map((i) => [i.number, [labeled("owner1", i.updated_at)]]));
  const f = fake({ issues, timelines });
  const out = await maintainer(f).repoSince(PRODUCT);
  expect(out.issues).toHaveLength(101);
  expect(out.issues.at(-1)!.number).toBe(101);
  expect(out.cursor).toBe("2026-02-01T00:00:00Z");
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
    () => m.comment("other/repo", 1, "x"),
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
  expect(parseRepos(`${PRODUCT},${OTHER}`).map((r) => [r.repo, r.label, r.trusted, r.after_merge])).toEqual([
    [PRODUCT, "agent-fix", ["admin", "maintain"], "done"],
    [OTHER, "agent-fix", ["admin", "maintain"], "done"],
  ]);
  expect(parseRepos(JSON.stringify([{ repo: PRODUCT, after_merge: "product-pin" }, { repo: OTHER, label: "fix-me", trusted: ["write"] }])).map((r) => [r.repo, r.label, r.trusted, r.after_merge])).toEqual([
    [PRODUCT, "agent-fix", ["admin", "maintain"], "product-pin"],
    [OTHER, "fix-me", ["write"], "done"],
  ]);
  // Duties are opt-in (issues aside), and a quiet PR waits a week.
  expect(parseRepos(PRODUCT)[0]).toMatchObject({ issues: true, features: false, dependabot: false, contributor_prs: false, stale_days: 7 });
  expect(parseRepos(JSON.stringify([{ repo: PRODUCT, features: true, issues: false, stale_days: 14 }]))[0]).toMatchObject({ issues: false, features: true, stale_days: 14 });
  expect(() => parseRepos(JSON.stringify([{ repo: PRODUCT, contributor_pr: true }]))).toThrow("maintainer_repos[0]: unknown key contributor_pr");
  for (const bad of [
    [{ repo: PRODUCT, stale_days: 0 }],
    [{ repo: PRODUCT, stale_days: "x" }],
    [{ repo: PRODUCT, features: "yes" }],
    [{ repo: PRODUCT, trusted: ["triage"] }],
    [{ repo: PRODUCT, trusted: ["read"] }],
    [{ repo: PRODUCT, trusted: [] }],
    [{ repo: PRODUCT, after_merge: "deploy" }],
    [{ repo: "not-a-repo" }],
    [{ repo: PRODUCT }, { repo: PRODUCT.toUpperCase() }],
    [{ repo: PRODUCT, extra: 1 }],
  ]) expect(() => parseRepos(JSON.stringify(bad))).toThrow(/maintainer_repos\[\d\]/);
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
  await expect(m.issuesSince({})).rejects.toThrow(/maintainer_repos is invalid/);
  expect(f.calls).toHaveLength(0);
});

it("trust is per repo: a write collaborator vouches only where the repo trusts write", async () => {
  const f = fake({ issues: [{ number: 1, updated_at: "2026-01-01T00:00:00Z" }], timelines: { 1: [labeled("writer-user", "2026-01-01T00:00:00Z")] }, permissions: { "writer-user": "write" } });
  const m = maintainer(f, [], [{ repo: PRODUCT }, { repo: OTHER, trusted: ["maintain", "write"] }]);
  expect((await m.labelEvents(PRODUCT, 1)).events[0]!.trusted).toBe(false);
  expect((await m.labelEvents(OTHER, 1)).events[0]!.trusted).toBe(true);
  await expect(m.comment(PRODUCT, 1, "hi")).rejects.toThrow(/untrusted/);
  expect(await m.comment(OTHER, 1, "hi")).toMatchObject({ repo: OTHER, number: 1 });
  expect(f.posted.map((p) => p.path)).toEqual([`/repos/${OTHER}/issues/1/comments`]);
});

it("a repo's own label is the one listed, trusted and the only one changed", async () => {
  const fixMe = (login: string, at: string, app?: { id: number; slug: string }) => ({ ...labeled(login, at, app), label: { name: "fix-me" } });
  const f = fake({ issues: [{ number: 3, updated_at: "2026-01-01T00:00:00Z", labels: ["fix-me"] }], timelines: { 3: [fixMe("owner1", "2026-01-01T00:00:00Z")] } });
  const m = maintainer(f, [], [{ repo: OTHER, label: "fix-me" }]);
  expect((await m.repoSince(OTHER)).issues.map((i) => i.number)).toEqual([3]);
  expect(f.calls.some((c) => c.url.includes(`/repos/${OTHER}/issues?state=open&labels=fix-me`))).toBe(true);
  await expect(m.label(OTHER, 3, "add", "agent-fix")).rejects.toThrow(/only the fix-me and feature-request labels/);
  expect(await m.label(OTHER, 3, "remove")).toMatchObject({ label: "fix-me", changed: true });
  expect(f.posted[0]!.path).toBe(`/repos/${OTHER}/issues/3/labels/fix-me`);
});

it("the watcher's read covers every listed repo from its own cursor, and one repo's failure holds up no other", async () => {
  const f = fake({
    issues: [
      { number: 1, updated_at: "2026-01-01T00:00:00Z" },
      { number: 2, updated_at: "2026-01-02T00:00:00Z" },
    ],
    timelines: { 1: [labeled("owner1", "2026-01-01T00:00:00Z")], 2: [labeled("owner1", "2026-01-02T00:00:00Z")] },
  });
  const m = maintainer(f, [], [{ repo: PRODUCT }, { repo: OTHER }]);
  const out = await m.issuesSince({ [PRODUCT]: "2026-01-01T12:00:00Z" });
  expect(out.repos.map((r) => [r.repo, "issues" in r ? r.issues.map((i) => i.number) : r.error])).toEqual([
    [PRODUCT, [2]],
    [OTHER, [1, 2]],
  ]);
  f.opts.failList = [OTHER];
  const failed = await m.issuesSince({});
  expect(failed.repos[0]).toMatchObject({ repo: PRODUCT, cursor: "2026-01-02T00:00:00Z" });
  expect(failed.repos[1]).toEqual({ repo: OTHER, error: expect.stringMatching(/couldn't list acme\/widgets's issues/) });
});

it("a comment on a maintained repo keeps that repo's own org, while other owner terms are still redacted", async () => {
  const f = fake({ issues: [{ number: 1, updated_at: "2026-01-01T00:00:00Z" }], timelines: { 1: [labeled("owner1", "2026-01-01T00:00:00Z")] } });
  const m = maintainer(f, ["acme", "internal.example-host"], [{ repo: OTHER }]);
  expect(await m.comment(OTHER, 1, "fixed by https://github.com/acme/widgets/pull/7 on internal.example-host")).toMatchObject({ number: 1 });
  expect(f.posted[0]!.body.body).toBe("fixed by https://github.com/acme/widgets/pull/7 on [redacted]");
});

it("the triage read hands over new unlabelled reports once, never the fleet's own filings, PRs or labelled ones, nor the backlog", async () => {
  const at = (h: number) => `2026-01-01T${String(h).padStart(2, "0")}:00:00Z`;
  const f = fake({
    issues: [
      { number: 1, updated_at: at(1), created_at: at(1), labels: [] }, // before the cursor: the daily triage's
      { number: 2, updated_at: at(3), created_at: at(3), labels: ["bug"] },
      { number: 3, updated_at: at(4), created_at: at(4), labels: [], user: "owner1" },
      { number: 4, updated_at: at(5), created_at: at(5) }, // labelled: the labelled-issue path's
      { number: 5, updated_at: at(6), created_at: at(6), labels: [], pr: true },
      { number: 6, updated_at: at(7), created_at: at(7), labels: [] },
    ],
  });
  const m = maintainer(f, [], [{ repo: PRODUCT }], [3]); // #3 is the fleet's own filing (in AidenHQ's records)
  const first = await m.untriaged(PRODUCT);
  expect(first.untriaged).toEqual([]);
  expect(Date.parse(first.triage_cursor)).toBeGreaterThan(Date.now() - 60_000);
  const out = await m.untriaged(PRODUCT, at(2));
  expect(out).toEqual({ untriaged: [{ number: 2, created_at: at(3), author: "someone" }, { number: 6, created_at: at(7), author: "someone" }], triage_cursor: at(7) });
  expect((await m.untriaged(PRODUCT, at(7))).untriaged).toEqual([]);
  const both = await m.issuesSince({}, { [PRODUCT]: at(2) });
  expect(both.repos[0]).toMatchObject({ repo: PRODUCT, untriaged: [{ number: 2 }, { number: 6 }] });
  expect((await m.issuesSince({})).repos[0]).not.toHaveProperty("untriaged");
});

const labeledAs = (label: string, login: string, at: string, app?: { id: number; slug: string }) => ({ ...labeled(login, at, app), label: { name: label } });
const BUILD = "agent-build";
const FEATURES = [{ repo: PRODUCT, features: true }];

it("agent-build is trusted from an admin, never from the App or a write collaborator under the default roles", async () => {
  const f = fake({
    issues: [1, 2, 3].map((n) => ({ number: n, updated_at: `2026-01-01T00:00:0${n}Z`, labels: [BUILD] })),
    timelines: {
      1: [labeledAs(BUILD, "owner1", "2026-01-01T00:00:01Z")],
      2: [labeledAs(BUILD, "writer-user", "2026-01-01T00:00:02Z")],
      3: [labeledAs(BUILD, "admin-user", "2026-01-01T00:00:03Z")],
    },
    permissions: { "writer-user": "write", "admin-user": "admin" },
  });
  const out = await maintainer(f, [], FEATURES).repoSince(PRODUCT, undefined, BUILD);
  expect(out.issues.map((i) => i.number)).toEqual([3]);
  expect(out.skipped.map((s) => s.number)).toEqual([1, 2]);
  // The App counts for no label but its own fix label: a bot login with no performed_via event is no better.
  const bot = fake({ issues: [{ number: 1, updated_at: "2026-01-01T00:00:00Z", labels: [BUILD] }], timelines: { 1: [labeledAs(BUILD, "owner1", "2026-01-01T00:00:00Z")] } });
  expect((await maintainer(bot, [], FEATURES).issueList(PRODUCT, BUILD)).issues[0]).toMatchObject({ trusted: false });
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

it("triage skips issues already labelled feature-request or agent-build, and a features repo reads its builds", async () => {
  const f = fake({
    issues: [
      { number: 1, updated_at: "2026-02-01T00:00:00Z", created_at: "2026-02-01T00:00:00Z", labels: ["feature-request"] },
      { number: 2, updated_at: "2026-02-01T00:00:01Z", created_at: "2026-02-01T00:00:01Z", labels: [BUILD] },
      { number: 3, updated_at: "2026-02-01T00:00:02Z", created_at: "2026-02-01T00:00:02Z", labels: ["bug"] },
      { number: 4, updated_at: "2026-02-01T00:00:03Z", created_at: "2026-02-01T00:00:03Z", labels: ["feature-request"] },
    ],
    timelines: { 1: [labeledAs("feature-request", "owner1", "2026-02-01T00:00:01Z")], 2: [labeledAs(BUILD, "admin-user", "2026-02-01T00:00:03Z")], 4: [labeledAs("feature-request", "stranger", "2026-02-01T00:00:04Z")] },
    permissions: { "admin-user": "admin" },
  });
  const out = await maintainer(f, [], FEATURES).issuesSince({}, { [PRODUCT]: "2026-01-01T00:00:00Z" });
  const row = out.repos[0]! as any;
  expect(row.untriaged.map((i: any) => i.number)).toEqual([3]);
  expect(row.builds.map((i: any) => [i.number, i.trusted])).toEqual([[2, true]]);
  expect(row.featured).toEqual([1]);
  // A repo without `features` reads no builds.
  expect(((await maintainer(f).issuesSince({})).repos[0]! as any).builds).toBeUndefined();
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
  const out = await maintainer(f, [], FEATURES).repoSince(PRODUCT, undefined, BUILD);
  expect(out.issues.map((i) => i.number)).toEqual([2]);
  expect(out.skipped).toEqual([{ number: 1, reason: expect.stringMatching(/edited after agent-build was added/) }]);
  expect((await maintainer(f, [], FEATURES).labelEvents(PRODUCT, 1, BUILD)).events[0]).toMatchObject({ trusted: false, stale: true });
});
