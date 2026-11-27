import { expect, it } from "vitest";
import { CodeReviewReader, codeReviewRoute } from "../src/code-review-read.js";
import { GitHub } from "../src/github.js";
import { accessFor } from "./fake-access.js";
import { isModule } from "../src/module-caller.js";

const pr = (number: number, headRepo: string | null) => ({
  number, state: "open", draft: false, html_url: `https://github.com/Acme/App/pull/${number}`, user: { login: "dev" },
  head: { sha: "h".repeat(40), repo: headRepo ? { full_name: headRepo } : null }, base: { sha: "b".repeat(40), ref: "main", repo: { full_name: "Acme/App" } },
});
let perms = 0;
const gh = (async (input: URL | string) => {
  const u = new URL(String(input));
  if (u.pathname === "/repos/Acme/App/pulls") return Response.json([pr(1, "Acme/App"), pr(2, "stranger/App"), pr(3, null)]);
  if (u.pathname === "/repos/Acme/App/pulls/6") return Response.json({ ...pr(6, "Acme/App"), user: { login: "priv" }, author_association: "CONTRIBUTOR" });
  if (u.pathname.toLowerCase() === "/repos/acme/app/collaborators/priv/permission") { perms++; return Response.json({ permission: "write", role_name: "write" }); }
  if (u.pathname === "/repos/Acme/App/pulls/4") return Response.json({ ...pr(4, "Acme/App"), state: "closed", merged_at: "2026-01-04T00:00:00Z" });
  if (u.pathname === "/repos/Acme/App/issues/comments") return Response.json([
    { id: 9, body: "hi", created_at: "2026-01-02T00:00:00Z", html_url: "https://github.com/Acme/App/pull/1#issuecomment-9", issue_url: "https://api.github.com/repos/Acme/App/issues/1", user: { login: "dev" } },
    { id: 10, body: "an issue", created_at: "2026-01-03T00:00:00Z", html_url: "https://github.com/Acme/App/issues/5#issuecomment-10", issue_url: "https://api.github.com/repos/Acme/App/issues/5", user: { login: "dev" } },
  ]);
  if (u.pathname === `/repos/Acme/App/compare/${"a".repeat(40)}...${"b".repeat(40)}`) return Response.json({ status: "ahead", merge_base_commit: { sha: "a".repeat(40) } });
  if (u.pathname === "/repos/Acme/App/pulls/1") return Response.json({ ...pr(1, "Acme/App"), changed_files: 2, author_association: "MEMBER" });
  if (u.pathname === "/repos/Acme/App/pulls/1/files") return Response.json([{ filename: "a.ts", additions: 3, deletions: 1 }, { filename: "b.ts", previous_filename: "old.ts", additions: 0, deletions: 0 }]);
  if (u.pathname === "/repos/Acme/App/pulls/5") return Response.json({ ...pr(5, "Acme/App"), state: "closed", merged_at: "2026-01-04T00:00:00Z", merge_commit_sha: "c".repeat(40) });
  if (u.pathname === `/repos/Acme/App/commits/${"c".repeat(40)}`) return Response.json({ parents: [{ sha: "d".repeat(40) }] });
  if (u.pathname === `/repos/Acme/App/compare/${"d".repeat(40)}...${"b".repeat(40)}`) return Response.json({ status: "ahead", merge_base_commit: { sha: "e".repeat(40) } });
  if (u.pathname === `/repos/Acme/App/compare/${"1".repeat(40)}...${"b".repeat(40)}`) return Response.json({ status: "ahead", merge_base_commit: { sha: "f".repeat(40) } });
  if (u.pathname === "/repos/Acme/App/branches/main") return Response.json({ commit: { sha: "1".repeat(40) } });
  if (u.pathname === "/user/repos") return Response.json([{ full_name: "Acme/App", private: true, html_url: "https://github.com/Acme/App" }, { full_name: "Acme/Other", html_url: "https://github.com/Acme/Other" }]);
  return new Response("{}", { status: 404 });
}) as typeof fetch;
const reader = new CodeReviewReader(new GitHub(accessFor(gh, "t"), gh));

it("only the code-review module may call; PRs, PR comments and permission come back in the seam's shape", async () => {
  const kernel = (module: string) => (async () => Response.json({ kind: "module", module })) as typeof fetch;
  expect(await isModule("http://k", "Bearer x", "code-review", kernel("code-review"))).toBe(true);
  expect(await isModule("http://k", "Bearer x", "code-review", kernel("maintainer"))).toBe(false);

  const prs = (await codeReviewRoute(reader, "prs", new URLSearchParams({ repo: "Acme/App" }))).body as { prs: { repo: string; fork: boolean; base_ref: string }[] };
  expect(prs.prs.map((p) => [p.repo, p.fork, p.base_ref])).toEqual([["acme/app", false, "main"], ["acme/app", true, "main"], ["acme/app", true, "main"]]);

  // A merged PR says so (the engine posts a review that finishes after the merge, and one-offs review merged PRs).
  const one = (await codeReviewRoute(reader, "pr", new URLSearchParams({ repo: "Acme/App", number: "4" }))).body as { pr: { open: boolean; merged: boolean } };
  expect([one.pr.open, one.pr.merged]).toEqual([false, true]);

  const c = (await codeReviewRoute(reader, "comments", new URLSearchParams({ repo: "Acme/App", since: "2026-01-01T00:00:00Z" }))).body as { comments: { number: number }[]; cursor: string };
  expect(c.comments.map((x) => x.number)).toEqual([1]);
  expect(c.cursor).toBe("2026-01-02T00:00:00Z");

  const perm = await codeReviewRoute(reader, "permission", new URLSearchParams({ repo: "Acme/App", login: "ghost" }));
  expect(perm).toEqual({ status: 200, body: { permission: "none" } });
  // A login that isn't a GitHub login (a bot's "x[bot]", an empty one) has no permission: an answer, not a 400 to retry.
  for (const login of ["dependabot[bot]", ""]) expect(await codeReviewRoute(reader, "permission", new URLSearchParams({ repo: "Acme/App", login }))).toEqual({ status: 200, body: { permission: "none" } });
  // Whether a review may post there, and as whom (the poster's own rule).
  const gated = new CodeReviewReader(reader["github"], async (owner) => (owner === "acme" ? "owner" : null));
  expect((await codeReviewRoute(gated, "postable", new URLSearchParams({ repo: "Acme/App" }))).body).toEqual({ identity: "owner", org: "acme" });
  expect((await codeReviewRoute(gated, "postable", new URLSearchParams({ repo: "other/x" }))).body).toEqual({ identity: null, org: "other" });
  expect((await codeReviewRoute(reader, "compare", new URLSearchParams({ repo: "Acme/App", base: "a".repeat(40), head: "b".repeat(40) }))).body).toEqual({ merge_base: "a".repeat(40), status: "ahead" });
  expect((await codeReviewRoute(reader, "repos", new URLSearchParams({ q: "app" }))).body).toEqual({ repos: [{ repo: "Acme/App", private: true, url: "https://github.com/Acme/App" }] });
  expect((await codeReviewRoute(reader, "pr", new URLSearchParams({ repo: "Acme/App", number: "x" }))).status).toBe(400);
});

it("a snapshot reads the PR, its files and the PR again: a consistent change for its risk tier; the own App's PR says so", async () => {
  const own = new CodeReviewReader(reader["github"], async () => null, async () => "dev");
  const s = (await codeReviewRoute(own, "snapshot", new URLSearchParams({ repo: "Acme/App", number: "1" }))).body as { pr: { association: string; own: boolean }; changed_files: number; files: unknown[] };
  expect([s.pr.association, s.pr.own, s.changed_files]).toEqual(["MEMBER", true, 2]);
  expect(s.files).toEqual([{ path: "a.ts", additions: 3, deletions: 1 }, { path: "b.ts", previous: "old.ts", additions: 0, deletions: 0 }]);
});

it("a PR's change fingerprint: the same files and patches over another merge base match; an edit elsewhere or a missing patch doesn't", async () => {
  const file = (patch?: string) => ({ filename: "a.ts", status: "modified", changes: 2, ...(patch === undefined ? {} : { patch }) });
  const files: Record<string, unknown[]> = {
    ["1".repeat(40)]: [file("@@ -1,2 +1,2 @@\n-a\n+b\n c")],
    ["2".repeat(40)]: [file("@@ -1,2 +1,2 @@\n-a\n+b\n c")], // rebased: a new base, the same change
    ["3".repeat(40)]: [file("@@ -7,2 +7,2 @@\n-a\n+b\n c")], // the same lines edited elsewhere
    ["4".repeat(40)]: [file()], // GitHub left the patch out (too large)
    ["5".repeat(40)]: [{ filename: "run.sh", status: "modified", changes: 0 }], // a mode-only change (or a binary): no patch
  };
  const f = (async (input: URL | string) => Response.json({ status: "ahead", files: files[String(input).split("...")[0]!.slice(-40)] })) as typeof fetch;
  const r = new CodeReviewReader(new GitHub(accessFor(f, "t"), f));
  const id = async (b: string) => ((await codeReviewRoute(r, "patch-id", new URLSearchParams({ repo: "Acme/App", base: b.repeat(40), head: "b".repeat(40) }))).body as { id: string | null }).id;
  expect(await id("1")).toMatch(/^[0-9a-f]{64}$/);
  expect(await id("2")).toBe(await id("1"));
  expect(await id("3")).not.toBe(await id("1"));
  expect(await id("4")).toBeNull();
  expect(await id("5")).toBeNull();
});

it("a same-repo CONTRIBUTOR with write access (a private org member) reads COLLABORATOR, one permission read per author; a fork or a failed read keeps the raw one", async () => {
  const r = new CodeReviewReader(reader["github"]);
  const get = async () => (await codeReviewRoute(r, "pr", new URLSearchParams({ repo: "Acme/App", number: "6" }))).body as { pr: { association: string; elevated?: boolean } };
  expect((await get()).pr).toMatchObject({ association: "COLLABORATOR", elevated: true });
  await get();
  expect(perms).toBe(1);
  // "dev" has no permission (404): the raw association stays and nothing is raised.
  const prs = (await codeReviewRoute(r, "prs", new URLSearchParams({ repo: "Acme/App" }))).body as { prs: { association: string; elevated?: boolean }[] };
  expect(prs.prs.map((p) => [p.association, p.elevated])).toEqual([["NONE", undefined], ["NONE", undefined], ["NONE", undefined]]);
});
