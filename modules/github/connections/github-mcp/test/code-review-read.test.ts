import { expect, it } from "vitest";
import { CodeReviewReader, codeReviewRoute } from "../src/code-review-read.js";
import { GitHub } from "../src/github.js";
import { isModule } from "../src/module-caller.js";

const pr = (number: number, headRepo: string | null) => ({
  number, state: "open", draft: false, html_url: `https://github.com/Acme/App/pull/${number}`, user: { login: "dev" },
  head: { sha: "h".repeat(40), repo: headRepo ? { full_name: headRepo } : null }, base: { sha: "b".repeat(40), ref: "main", repo: { full_name: "Acme/App" } },
});
const gh = (async (input: URL | string) => {
  const u = new URL(String(input));
  if (u.pathname === "/repos/Acme/App/pulls") return Response.json([pr(1, "Acme/App"), pr(2, "stranger/App"), pr(3, null)]);
  if (u.pathname === "/repos/Acme/App/issues/comments") return Response.json([
    { id: 9, body: "hi", created_at: "2026-01-02T00:00:00Z", html_url: "https://github.com/Acme/App/pull/1#issuecomment-9", issue_url: "https://api.github.com/repos/Acme/App/issues/1", user: { login: "dev" } },
    { id: 10, body: "an issue", created_at: "2026-01-03T00:00:00Z", html_url: "https://github.com/Acme/App/issues/5#issuecomment-10", issue_url: "https://api.github.com/repos/Acme/App/issues/5", user: { login: "dev" } },
  ]);
  if (u.pathname === `/repos/Acme/App/compare/${"a".repeat(40)}...${"b".repeat(40)}`) return Response.json({ status: "ahead", merge_base_commit: { sha: "a".repeat(40) } });
  if (u.pathname === "/user/repos") return Response.json([{ full_name: "Acme/App", private: true, html_url: "https://github.com/Acme/App" }, { full_name: "Acme/Other", html_url: "https://github.com/Acme/Other" }]);
  return new Response("{}", { status: 404 });
}) as typeof fetch;
const reader = new CodeReviewReader(new GitHub({ get: async () => "t", signedIn: () => true }, new Set(), gh));

it("only the code-review module may call; PRs, PR comments and permission come back in the seam's shape", async () => {
  const kernel = (module: string) => (async () => Response.json({ kind: "module", module })) as typeof fetch;
  expect(await isModule("http://k", "Bearer x", "code-review", kernel("code-review"))).toBe(true);
  expect(await isModule("http://k", "Bearer x", "code-review", kernel("maintainer"))).toBe(false);

  const prs = (await codeReviewRoute(reader, "prs", new URLSearchParams({ repo: "Acme/App" }))).body as { prs: { repo: string; fork: boolean; base_ref: string }[] };
  expect(prs.prs.map((p) => [p.repo, p.fork, p.base_ref])).toEqual([["acme/app", false, "main"], ["acme/app", true, "main"], ["acme/app", true, "main"]]);

  const c = (await codeReviewRoute(reader, "comments", new URLSearchParams({ repo: "Acme/App", since: "2026-01-01T00:00:00Z" }))).body as { comments: { number: number }[]; cursor: string };
  expect(c.comments.map((x) => x.number)).toEqual([1]);
  expect(c.cursor).toBe("2026-01-02T00:00:00Z");

  const perm = await codeReviewRoute(reader, "permission", new URLSearchParams({ repo: "Acme/App", login: "ghost" }));
  expect(perm).toEqual({ status: 200, body: { permission: "none" } });
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
  const r = await new CodeReviewReader(new GitHub({ get: async () => "t", signedIn: () => true }, new Set(), flood)).comments("Acme/App", "2026-01-01T00:00:00Z");
  expect(r.comments).toHaveLength(3000);
  expect(r.cursor).toBe(r.comments.at(-1)!.created_at);
});
