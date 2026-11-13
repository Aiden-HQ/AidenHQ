import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { Projects } from "../src/projects.js";

it("design-review status: only on the PR's current head, with a token narrowed to statuses and PR reads", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gh-app-"));
  writeFileSync(join(dir, "app_id"), "123\n");
  writeFileSync(join(dir, "key.pem"), generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }));
  const head = "b".repeat(40);
  const calls: { method: string; url: string; body?: any }[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ method: init.method!, url, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const json = (status: number, body: unknown) => ({ status, json: async () => body });
    if (url.endsWith("/repos/org/app/installation")) return json(200, { id: 9, permissions: { statuses: "write" } });
    if (url.endsWith("/app/installations/9/access_tokens")) return json(201, { token: "ghs_s" });
    if (url.endsWith("/pulls/4")) return json(200, { state: "open", head: { sha: head } });
    if (url.includes("/statuses/")) return json(201, { context: "design-review", state: "success" });
    return json(404, {});
  }) as unknown as typeof fetch;
  const p = new Projects(dir, fetchFn);
  const status = { state: "success", context: "design-review", description: "ok" };

  await expect(p.commitStatus("org", "app", 4, "a".repeat(40), status)).rejects.toThrow(/isn't the current head/);
  expect(calls.some((c) => c.url.includes("/statuses/"))).toBe(false);
  expect(await p.commitStatus("org", "app", 4, head, status)).toMatchObject({ number: 4, sha: head, state: "success" });
  expect(calls.find((c) => c.url.endsWith("access_tokens"))!.body).toEqual({ repositories: ["app"], permissions: { statuses: "write", pull_requests: "read" } });
  expect(calls.at(-1)!.url).toBe(`https://api.github.com/repos/org/app/statuses/${head}`);
});

it("mints a read-only narrowed token and flattens project items", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gh-app-"));
  writeFileSync(join(dir, "app_id"), "123\n");
  writeFileSync(join(dir, "key.pem"), generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }));
  const calls: { method: string; url: string; body?: any; auth?: string }[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ method: init.method!, url, body: init.body ? JSON.parse(String(init.body)) : undefined, auth: (init.headers as any).authorization });
    const json = (status: number, body: unknown) => ({ status, json: async () => body });
    if (url.endsWith("/orgs/acme/installation")) return json(200, { id: 7 });
    if (url.endsWith("/app/installations/7/access_tokens")) return json(201, { token: "ghs_x", expires_at: new Date(Date.now() + 3600_000).toISOString() });
    return json(200, { data: { organization: { projectV2: {
      title: "BPN", url: "https://github.com/orgs/acme/projects/23", closed: false,
      fields: { nodes: [{ name: "Status", dataType: "SINGLE_SELECT", options: [{ name: "Todo" }, { name: "Done" }] }, {}] },
      items: { totalCount: 1, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{
        content: { __typename: "Issue", title: "Ship it", url: "https://github.com/acme/x/issues/1", state: "OPEN", repository: { nameWithOwner: "acme/x" }, assignees: { nodes: [{ login: "ann" }] }, labels: { nodes: [{ name: "p1" }] } },
        fieldValues: { nodes: [{ __typename: "ProjectV2ItemFieldSingleSelectValue", name: "Todo", field: { name: "Status" } }, { __typename: "ProjectV2ItemFieldIterationValue", title: "Sprint 4", startDate: "2026-11-02", field: { name: "Iteration" } }, {}] },
      }] },
    } } } });
  }) as unknown as typeof fetch;

  const out = await new Projects(dir, fetchFn).read({ org: "acme", number: 23, limit: 100 });

  expect(calls.find((c) => c.url.endsWith("access_tokens"))!.body).toEqual({ permissions: { organization_projects: "read", issues: "read", pull_requests: "read" } });
  expect(calls.at(-1)!.auth).toBe("Bearer ghs_x");
  expect(out.project.title).toBe("BPN");
  expect(out.fields).toEqual([{ name: "Status", type: "SINGLE_SELECT", options: ["Todo", "Done"] }]);
  expect(out.items).toEqual([{
    type: "Issue", title: "Ship it", url: "https://github.com/acme/x/issues/1", repo: "acme/x", state: "OPEN",
    assignees: ["ann"], labels: ["p1"], fields: { Status: "Todo", Iteration: { title: "Sprint 4", start: "2026-11-02" } },
  }]);
  expect(out.next_cursor).toBeNull();
});

it("mints a read-only token for an org, and reports a miss when the App isn't installed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gh-app-"));
  writeFileSync(join(dir, "app_id"), "123\n");
  writeFileSync(join(dir, "key.pem"), generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }));
  const calls: { method: string; url: string; body?: any }[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ method: init.method!, url, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const json = (status: number, body: unknown) => ({ status, json: async () => body });
    if (url.endsWith("/orgs/acme/installation")) return json(200, { id: 7, permissions: { issues: "read", pull_requests: "read" } });
    if (url.endsWith("/app/installations/7/access_tokens")) return json(201, { token: "ghs_o", expires_at: new Date(Date.now() + 3600_000).toISOString() });
    return json(404, { message: "Not Found" });
  }) as unknown as typeof fetch;
  const p = new Projects(dir, fetchFn);

  expect(await p.orgToken("acme")).toBe("ghs_o");
  expect(await p.orgToken("other")).toBeUndefined();
  expect(calls.find((c) => c.url.endsWith("access_tokens"))!.body).toEqual({ permissions: { issues: "read", pull_requests: "read" } });
});

it("mints a read-only token for a repo the App covers, and reports a miss elsewhere", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gh-app-"));
  writeFileSync(join(dir, "app_id"), "123\n");
  writeFileSync(join(dir, "key.pem"), generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }));
  const calls: { method: string; url: string; body?: any }[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ method: init.method!, url, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const json = (status: number, body: unknown) => ({ status, json: async () => body });
    if (url.endsWith("/repos/acme/app/installation")) return json(200, { id: 9, permissions: { contents: "read", issues: "read", pull_requests: "read", checks: "read", statuses: "read", actions: "read", administration: "write" } });
    if (url.endsWith("/app/installations/9/access_tokens")) return json(201, { token: "ghs_r", expires_at: new Date(Date.now() + 3600_000).toISOString() });
    return json(404, { message: "Not Found" });
  }) as unknown as typeof fetch;
  const p = new Projects(dir, fetchFn);

  expect(await p.repoToken("acme", "app")).toBe("ghs_r");
  expect(await p.repoToken("acme", "app")).toBe("ghs_r");
  expect(await p.repoToken("other", "repo")).toBeUndefined();
  expect(await p.repoToken("other", "repo")).toBeUndefined();

  expect(calls.find((c) => c.url.endsWith("/repos/acme/app/installation"))).toBeTruthy();
  expect(calls.find((c) => c.url.endsWith("/repos/other/repo/installation"))).toBeTruthy();
  expect(calls.find((c) => c.url.endsWith("access_tokens"))!.body).toEqual({
    repositories: ["app"],
    permissions: { contents: "read", issues: "read", pull_requests: "read", checks: "read", statuses: "read", actions: "read" },
  });
  expect(calls).toHaveLength(3); // installation + token once, the other repo's miss once: both cached
});

it("asks only for what the installation grants, and finds a user account's installation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gh-app-"));
  writeFileSync(join(dir, "app_id"), "123\n");
  writeFileSync(join(dir, "key.pem"), generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }));
  const asked: any[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    const json = (status: number, body: unknown) => ({ status, json: async () => body });
    if (url.endsWith("/orgs/sam/installation")) return json(404, { message: "Not Found" });
    if (url.endsWith("/users/sam/installation")) return json(200, { id: 9, permissions: { issues: "write", pull_requests: "write", contents: "write" } });
    if (url.endsWith("/app/installations/9/access_tokens")) { asked.push(JSON.parse(String(init.body))); return json(201, { token: "ghs_y", expires_at: new Date(Date.now() + 3600_000).toISOString() }); }
    return json(200, {});
  }) as unknown as typeof fetch;
  const p = new Projects(dir, fetchFn);
  expect(await p.account("sam")).toEqual({ user: true, projects: false });
  expect(asked[0]).toEqual({ permissions: { issues: "read", pull_requests: "read" } });
});
