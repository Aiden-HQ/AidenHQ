import { generateKeyPairSync } from "node:crypto";
import { expect, it, vi } from "vitest";
import { Maintainer } from "../src/maintainer.js";
import { parseRepos } from "../src/aidenhq-sdk/maintained-repos.js";
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
  // The owner's login is an admin collaborator: a label it adds counts, as any admin's does.
  const permissions: Record<string, string> = { owner1: "admin", ...(opts.permissions ?? {}) };
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

it("a comment has the owner's host and email removed before it is sent", async () => {
  const f = fake({ issues: [{ number: 1, updated_at: "2026-01-01T00:00:00Z" }], timelines: { 1: [labeled("owner1", "2026-01-01T00:00:00Z")] } });
  const m = maintainer(f, ["internal.example-host"]);
  const sent = await m.commentBody(PRODUCT, 1, "see internal.example-host and dev@acme-corp.com");
  expect(sent).toBe("see [redacted] and [redacted]");
  expect(sent).not.toContain("internal.example-host");
  expect(sent).not.toContain("dev@acme-corp.com");
  expect(await m.commentBody(PRODUCT, 1, "fixed in the next release")).toBe("fixed in the next release");
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

const OTHER = "acme/widgets";

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
