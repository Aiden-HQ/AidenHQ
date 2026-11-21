import { expect, it } from "vitest";
import { CodeReviewReader, codeReviewRoute } from "../src/code-review-read.js";
import { GitHub } from "../src/github.js";
import { accessFor } from "./fake-access.js";
import { isModule } from "../src/module-caller.js";

const pr = (number: number, headRepo: string | null) => ({
  number, state: "open", draft: false, html_url: `https://github.com/Acme/App/pull/${number}`, user: { login: "dev" },
  head: { sha: "h".repeat(40), repo: headRepo ? { full_name: headRepo } : null }, base: { sha: "b".repeat(40), ref: "main", repo: { full_name: "Acme/App" } },
});
const gh = (async (input: URL | string) => {
  const u = new URL(String(input));
  if (u.pathname === "/repos/Acme/App/pulls") return Response.json([pr(1, "Acme/App"), pr(2, "stranger/App"), pr(3, null)]);
  if (u.pathname === "/repos/Acme/App/pulls/4") return Response.json({ ...pr(4, "Acme/App"), state: "closed", merged_at: "2026-01-04T00:00:00Z" });
  if (u.pathname === "/repos/Acme/App/issues/comments") return Response.json([
    { id: 9, body: "hi", created_at: "2026-01-02T00:00:00Z", html_url: "https://github.com/Acme/App/pull/1#issuecomment-9", issue_url: "https://api.github.com/repos/Acme/App/issues/1", user: { login: "dev" } },
    { id: 10, body: "an issue", created_at: "2026-01-03T00:00:00Z", html_url: "https://github.com/Acme/App/issues/5#issuecomment-10", issue_url: "https://api.github.com/repos/Acme/App/issues/5", user: { login: "dev" } },
  ]);
  if (u.pathname === `/repos/Acme/App/compare/${"a".repeat(40)}...${"b".repeat(40)}`) return Response.json({ status: "ahead", merge_base_commit: { sha: "a".repeat(40) } });
  if (u.pathname === "/repos/Acme/App/pulls/1") return Response.json(pr(1, "Acme/App"));
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

it("a comment flood returns what was read with a cursor that moves on", async () => {
  let page = 0;
  const flood = (async () => Response.json(Array.from({ length: 100 }, (_, i) => {
    const n = page * 100 + i;
    if (i === 99) page++;
    return { id: n + 1, body: "x", created_at: new Date(Date.UTC(2026, 0, 1) + (n + 1) * 1000).toISOString(), html_url: "https://github.com/Acme/App/pull/1#c", issue_url: "https://api.github.com/repos/Acme/App/issues/1", user: { login: "dev" } };
  }))) as typeof fetch;
  const r = await new CodeReviewReader(new GitHub(accessFor(flood, "t"), flood)).comments("Acme/App", "2026-01-01T00:00:00Z");
  expect(r.comments).toHaveLength(3000);
  expect(r.cursor).toBe(r.comments.at(-1)!.created_at);
});

it("a PR's merge base is taken from its base branch (open) or its merge commit's first parent (merged), never its recorded base sha", async () => {
  const q = (n: number) => new URLSearchParams({ repo: "Acme/App", number: String(n), head: "b".repeat(40) });
  expect((await codeReviewRoute(reader, "merge-base", q(5))).body).toEqual({ merge_base: "e".repeat(40) });
  expect((await codeReviewRoute(reader, "merge-base", q(1))).body).toEqual({ merge_base: "f".repeat(40) });
});
