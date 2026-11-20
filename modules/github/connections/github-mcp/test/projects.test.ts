import { expect, it } from "vitest";
import { Projects, issueLink, productTarget, upstreamReport } from "../src/projects.js";
import { originIds, ownerTerms } from "../src/scrub.js";

const CODEHOST = { url: "http://codehost", key: () => "gh-key" };
/** the kernel's POST /v1/codehost/token, faked: `covers(repo, perms)` says whether the App covers that (else 422). */
function ops(url: string, init: RequestInit, token: string, covers: (repo: string, perms: Record<string, string>) => boolean = () => true) {
  if (url !== "http://codehost/v1/codehost/token") return undefined;
  const b = JSON.parse(String(init.body));
  const ok = (init.headers as Record<string, string>).authorization === "Bearer gh-key" && covers(b.repo, b.perms);
  return { status: ok ? 200 : 422, json: async () => (ok ? { token, repo: b.repo, perms: b.perms, expires_at: new Date(Date.now() + 3300_000).toISOString(), app: { slug: "acme-app" } } : { error: "GitHub said 422" }) };
}

it("design-review status: only on the PR's current head, with a token narrowed to statuses and PR reads", async () => {
  const head = "b".repeat(40);
  const calls: { method: string; url: string; body?: any }[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ method: init.method!, url, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const json = (status: number, body: unknown) => ({ status, json: async () => body });
    const t = ops(url, init, "ghs_s");
    if (t) return t;
    if (url.endsWith("/pulls/4")) return json(200, { state: "open", head: { sha: head } });
    if (url.includes("/statuses/")) return json(201, { context: "design-review", state: "success" });
    return json(404, {});
  }) as unknown as typeof fetch;
  const p = new Projects(CODEHOST, fetchFn);
  const status = { state: "success", context: "design-review", description: "ok" };

  await expect(p.commitStatus("org", "app", 4, "a".repeat(40), status)).rejects.toThrow(/isn't the current head/);
  expect(calls.some((c) => c.url.includes("/statuses/"))).toBe(false);
  expect(await p.commitStatus("org", "app", 4, head, status)).toMatchObject({ number: 4, sha: head, state: "success" });
  expect(calls.find((c) => c.url.endsWith("/v1/codehost/token"))!.body).toEqual({ repo: "org/app", perms: { statuses: "write", pull_requests: "read" } });
  expect(calls.at(-1)!.url).toBe(`https://api.github.com/repos/org/app/statuses/${head}`);
});

it("product issues: only the product-issues role, only the configured product repo", () => {
  expect(() => productTarget(["fleet-read"], "acme/product")).toThrow(/product-issues role/);
  expect(() => productTarget(undefined, "acme/product")).toThrow(/product-issues role/);
  expect(() => productTarget(["product-issues"], "")).toThrow(/no product repo/);
  expect(productTarget(["product-issues"], "acme/product")).toEqual(["acme", "product"]);
});

it("a product issue as the App: Issues: write required, a narrowed token, deduped by fingerprint, status names the fixing commit", async () => {
  let issues = "read";
  const filed: { number: number; state: string; body: string }[] = [];
  const calls: { method: string; url: string; body?: any }[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init.method!, url, body });
    const json = (status: number, b: unknown) => ({ status, json: async () => b });
    const t = ops(url, init, "ghs_i", (repo, perms) => repo === "acme/product" && (perms.issues !== "write" || issues === "write"));
    if (t) return t;
    if (url.includes("/search/issues")) {
      const q = decodeURIComponent(url.split("q=")[1]!.split("&")[0]!);
      // Search is fuzzy: a near-miss fingerprint comes back too, and must not count.
      return json(200, { items: [...filed.filter((i) => !q.includes("is:open") || i.state === "open"), { number: 3, state: "open", body: "product-bug:runner-other", html_url: "u3" }].map((i) => ({ html_url: `u${i.number}`, ...i })) });
    }
    if (url.endsWith("/repos/acme/product/labels/agent-fix")) return json(200, { name: "agent-fix" });
    if (url.endsWith("/repos/acme/product/issues") && init.method === "POST") return filed.push({ number: 12, state: "open", body: body.body }), json(201, { number: 12, html_url: "u12" });
    if (url.endsWith("/issues/12/comments")) return json(201, { id: 77, html_url: "u12#c77" });
    if (url.includes("/issues/12/events")) return json(200, [{ event: "referenced", commit_id: "a".repeat(40) }, { event: "closed", commit_id: "c".repeat(40) }]);
    return json(404, {});
  }) as unknown as typeof fetch;
  const p = new Projects(CODEHOST, fetchFn);
  const report = { fingerprint: "product-bug:runner-rebase-asks", title: "runner: rebase asks on cancelled tasks", body: "WOR-1, WOR-2" };
  await expect(p.reportIssue("acme", "product", report)).rejects.toThrow(/Issues: Read and write/);
  issues = "write";
  expect(await p.reportIssue("acme", "product", report)).toEqual({ deduplicated: false, number: 12, state: "open", url: "u12" });
  expect(filed[0]!.body).toBe("WOR-1, WOR-2\n\nproduct-bug:runner-rebase-asks");
  expect(calls.filter((c) => c.url.endsWith("/v1/codehost/token")).at(-1)!.body).toEqual({ repo: "acme/product", perms: { issues: "write" } });
  expect(await p.reportIssue("acme", "product", { ...report, body: "WOR-3" })).toEqual({ deduplicated: true, number: 12, state: "open", url: "u12#c77" });
  expect(filed).toHaveLength(1);
  filed[0]!.state = "closed";
  expect(await p.issueStatus("acme", "product", [report.fingerprint])).toEqual([{ fingerprint: report.fingerprint, number: 12, url: "u12", state: "closed", state_reason: null, fixed_in: "c".repeat(40) }]);
  // The verification after the fix lands on the closed issue, never a new one.
  expect(await p.reportIssue("acme", "product", { ...report, body: "verified live at abc" })).toMatchObject({ deduplicated: true, number: 12, state: "closed" });
  expect(filed).toHaveLength(1);
});

it("dedupe is the only limiter: every new fingerprint opens an issue (labelled agent-fix), and a repeat only comments", async () => {
  const filed: { number: number; body: string; labels?: string[] }[] = [];
  const comments: string[] = [];
  const calls: { method: string; url: string; body?: any }[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init.method!, url, body });
    const json = (status: number, b: unknown) => ({ status, json: async () => b });
    const t = ops(url, init, "ghs_c");
    if (t) return t;
    if (url.includes("/search/issues")) {
      const q = decodeURIComponent(url.split("q=")[1]!.split("&")[0]!);
      const fingerprint = /in:body "([^"]+)"/.exec(q)![1]!;
      return json(200, { items: filed.filter((i) => i.body.includes(fingerprint)).map((i) => ({ html_url: `u${i.number}`, state: "open", ...i })) });
    }
    if (url.endsWith("/repos/acme/product/labels/agent-fix")) return json(200, { name: "agent-fix" });
    if (url.endsWith("/repos/acme/product/issues") && init.method === "POST") return filed.push({ number: filed.length + 1, body: body.body, labels: body.labels }), json(201, { number: filed.length, html_url: `u${filed.length}` });
    if (url.includes("/comments")) return comments.push(body.body), json(201, { html_url: "u1#c1" });
    return json(404, {});
  }) as unknown as typeof fetch;
  const p = new Projects(CODEHOST, fetchFn);
  const report = (n: number) => ({ fingerprint: `product-bug:board-crash-${n}`, title: "board: a crash", body: "It crashes." });

  // Dedupe is the only limiter: ten distinct defects in a row all file, each labelled.
  for (let n = 1; n <= 10; n++) expect(await p.reportIssue("acme", "product", report(n))).toMatchObject({ deduplicated: false, number: n });
  expect(filed).toHaveLength(10);
  for (const i of filed) expect(i.labels).toEqual(["agent-fix"]);
  // The same fingerprint again is a comment on its issue, not a new issue.
  const before = calls.length;
  expect(await p.reportIssue("acme", "product", { ...report(1), body: "again" })).toMatchObject({ deduplicated: true, number: 1 });
  expect(comments).toEqual(["again"]);
  expect(filed).toHaveLength(10);
  // The comment adds no label to anyone's issue: no label call, and no edit of the issue it comments on.
  expect(calls.slice(before).filter((c) => c.url.includes("/labels") || (c.method === "PATCH" && c.url.includes("/issues/")))).toEqual([]);
});

it("an issue opened for a new fingerprint carries agent-fix, created when the repo has no such label", async () => {
  const calls: { method: string; url: string; body?: any }[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init.method!, url, body });
    const json = (status: number, b: unknown) => ({ status, json: async () => b });
    const t = ops(url, init, "ghs_l");
    if (t) return t;
    if (url.includes("/search/issues")) return json(200, { items: [] });
    if (url.endsWith("/labels/agent-fix") && init.method === "GET") return json(404, { message: "Not Found" });
    if (url.endsWith("/repos/acme/product/labels") && init.method === "POST") return json(201, { name: "agent-fix" });
    if (url.endsWith("/repos/acme/product/issues")) return json(201, { number: 8, html_url: "u8" });
    return json(404, {});
  }) as unknown as typeof fetch;
  const p = new Projects(CODEHOST, fetchFn);
  await p.reportIssue("acme", "product", { fingerprint: "product-bug:runner-rebase-asks", title: "runner: rebase", body: "x" });
  expect(calls.find((c) => c.url.endsWith("/repos/acme/product/labels") && c.method === "POST")!.body).toEqual({ name: "agent-fix", color: "0e8a16", description: "A product bug an agent found and can fix" });
  expect(calls.find((c) => c.url.endsWith("/repos/acme/product/issues") && c.method === "POST")!.body.labels).toEqual(["agent-fix"]);
});

it("A18: owner data in an upstream report is refused with the matches; a clean one names its module, evidence, instance and agent", () => {
  const terms = ownerTerms("Ada,ada@acme.example,acme.example,jira.acme.example,acme-co,acme,upstream-org,github.com,ab", "upstream-org/product");
  expect(terms).toEqual(["Ada", "ada@acme.example", "acme.example", "jira.acme.example", "acme-co", "acme"]);
  const evidence = { module: "kernel", version: "a".repeat(40), reproduction: "1. apply\n2. watch the log", log: "2026-11-16T10:00:00Z proxy refused 10.231.0.1:3130 (203.0.113.7)" };
  const report = { fingerprint: "product-bug:kernel-proxy-refuses", title: "kernel: proxy refuses a granted tool", body: "The proxy refuses a granted read.", evidence };
  const origin = originIds("instance-origin-key-1", "fleet-ops");
  const out = upstreamReport(report, origin, terms);
  expect(out.body).toContain("**Module:** kernel@" + "a".repeat(40));
  expect(out.body).toContain("```text\n2026-11-16T10:00:00Z proxy refused");
  // Where it came from, as opaque ids: stable for this instance and agent, never the instance's or agent's name.
  expect(origin).toEqual(originIds("instance-origin-key-1", "fleet-ops"));
  expect(origin.agent).not.toBe(originIds("instance-origin-key-1", "coach").agent);
  expect(originIds("instance-origin-key-2", "fleet-ops").instance).not.toBe(origin.instance);
  expect(out.body.endsWith(`Origin: instance=${origin.instance} agent=${origin.agent}`)).toBe(true);
  expect(out.body).not.toMatch(/acme|fleet-ops/);
  // Fail closed: with no origin key (or a stub) nothing is composed, so nothing can be filed.
  for (const key of ["", "short"]) expect(() => originIds(key, "fleet-ops")).toThrow(/no origin key/);
  const leaks: [string, Partial<typeof report>, RegExp][] = [
    ["the owner's name", { body: "Ada saw it" }, /name or host: Ada/],
    ["a hostname", { evidence: { ...evidence, log: "GET https://jira.acme.example/rest failed" } }, /jira\.acme\.example/],
    ["a company org", { title: "kernel: ACME-CO repos" }, /acme-co/],
    ["an email", { body: "mail bob@other.example" }, /an email address: bob@other\.example/],
    ["a public IP", { evidence: { ...evidence, log: "from 198.18.4.20" } }, /an IP address: 198\.18\.4\.20/],
    ["an IP at the end of a sentence", { body: "the host on 10.0.0.5." }, /an IP address: 10\.0\.0\.5/],
    ["an IPv6 address", { body: "peer fd7a:115c:a1e0::1 timed out" }, /IPv6/],
    ["a uuid", { body: "agent 3f2b1c4d-1111-4a2b-9c3d-0123456789ab" }, /uuid/],
    ["a Slack id", { body: "channel C0ABCD1234" }, /Slack id/],
    ["a chat id", { body: "chat -1001234567890" }, /chat id/],
    ["a token", { body: `key ${"gh" + "p_" + "x".repeat(36)}` }, /a GitHub token: ghp_…/],
    ["the fingerprint", { fingerprint: "product-bug:ada-sees-it" }, /Ada/],
    ["the instance name", { body: "seen on acme" }, /name or host: acme/],
    // As GitHub renders it: entities, comments, tags, zero-width and format characters, look-alikes, Markdown escapes.
    ["an entity", { body: "A&#100;a saw it" }, /Ada/],
    ["a nested entity", { body: "&amp;#65;da saw it" }, /Ada/],
    ["an HTML comment", { body: "Ad<!-- x -->a saw it" }, /Ada/],
    ["a tag", { body: "Ad<b></b>a saw it" }, /Ada/],
    ["a zero-width space", { body: "Ad\u200ba saw it" }, /Ada/],
    ["a soft hyphen", { body: "Ad\u00ada saw it" }, /Ada/],
    ["full-width letters", { body: "\uff21\uff44\uff41 saw it" }, /Ada/],
    ["a Markdown escape and emphasis", { body: "A\\*d\\*a and A**d**a" }, /Ada/],
    ["an entity in the log", { evidence: { ...evidence, log: "host jira&#46;acme.example" } }, /jira\.acme\.example/],
  ];
  for (const [what, edit, want] of leaks) expect(() => upstreamReport({ ...report, ...edit } as typeof report, origin, terms), what).toThrow(want);
});

it("A18 exit: a duplicate report becomes a comment on the open issue, never a second issue", async () => {
  const filed: { number: number; state: string; body: string }[] = [];
  const comments: string[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const json = (status: number, b: unknown) => ({ status, json: async () => b });
    const t = ops(url, init, "ghs_i");
    if (t) return t;
    if (url.includes("/search/issues")) return json(200, { items: filed.map((i) => ({ html_url: `u${i.number}`, ...i })) });
    if (url.endsWith("/labels/agent-fix")) return json(200, { name: "agent-fix" });
    if (url.endsWith("/issues") && init.method === "POST") return filed.push({ number: 5, state: "open", body: body.body }), json(201, { number: 5, html_url: "u5" });
    if (url.endsWith("/issues/5/comments")) return comments.push(body.body), json(201, { html_url: "u5#c1" });
    return json(404, {});
  }) as unknown as typeof fetch;
  const p = new Projects(CODEHOST, fetchFn);
  const evidence = { module: "board", version: "abc1234", reproduction: "1. open Settings", log: "TypeError: x is undefined" };
  const report = (agent: string) => upstreamReport({ fingerprint: "product-bug:board-settings-crash", title: "board: Settings crashes", body: "Settings crashes.", evidence }, originIds("s".repeat(32), agent), []);
  expect(await p.reportIssue("upstream-org", "product", report("fleet-ops"))).toMatchObject({ deduplicated: false, number: 5 });
  expect(filed[0]!.body).toMatch(new RegExp(`Origin: instance=${originIds("s".repeat(32), "fleet-ops").instance} agent=${originIds("s".repeat(32), "fleet-ops").agent}\\n\\nproduct-bug:board-settings-crash$`));
  expect(await p.reportIssue("upstream-org", "product", report("coach"))).toMatchObject({ deduplicated: true, number: 5, state: "open" });
  expect(filed).toHaveLength(1);
  expect(comments[0]!.endsWith(`agent=${originIds("s".repeat(32), "coach").agent}`)).toBe(true);
});

it("mints a read-only narrowed token and flattens project items", async () => {
  const calls: { method: string; url: string; body?: any; auth?: string }[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ method: init.method!, url, body: init.body ? JSON.parse(String(init.body)) : undefined, auth: (init.headers as any).authorization });
    const json = (status: number, body: unknown) => ({ status, json: async () => body });
    const t = ops(url, init, "ghs_x");
    if (t) return t;
    if (url.endsWith("/users/acme")) return json(200, { type: "Organization" });
    return json(200, { data: { organization: { projectV2: {
      title: "BPN", url: "https://github.com/orgs/acme/projects/23", closed: false,
      fields: { nodes: [{ name: "Status", dataType: "SINGLE_SELECT", options: [{ name: "Todo" }, { name: "Done" }] }, {}] },
      items: { totalCount: 1, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{
        content: { __typename: "Issue", title: "Ship it", url: "https://github.com/acme/x/issues/1", state: "OPEN", repository: { nameWithOwner: "acme/x" }, assignees: { nodes: [{ login: "ann" }] }, labels: { nodes: [{ name: "p1" }] } },
        fieldValues: { nodes: [{ __typename: "ProjectV2ItemFieldSingleSelectValue", name: "Todo", field: { name: "Status" } }, { __typename: "ProjectV2ItemFieldIterationValue", title: "Sprint 4", startDate: "2026-11-02", field: { name: "Iteration" } }, {}] },
      }] },
    } } } });
  }) as unknown as typeof fetch;

  const out = await new Projects(CODEHOST, fetchFn).read({ org: "acme", number: 23, limit: 100 });

  expect(calls.filter((c) => c.url.endsWith("/v1/codehost/token")).at(-1)!.body).toEqual({ repo: "acme/*", perms: { organization_projects: "read", issues: "read", pull_requests: "read" } });
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
  const calls: { method: string; url: string; body?: any }[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ method: init.method!, url, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const json = (status: number, body: unknown) => ({ status, json: async () => body });
    const t = ops(url, init, "ghs_o", (repo) => repo === "acme/*");
    if (t) return t;
    if (url.endsWith("/users/acme") || url.endsWith("/users/other")) return json(200, { type: "Organization" });
    return json(404, { message: "Not Found" });
  }) as unknown as typeof fetch;
  const p = new Projects(CODEHOST, fetchFn);

  expect(await p.orgToken("acme")).toBe("ghs_o");
  expect(await p.orgToken("other")).toBeUndefined();
  expect(calls.find((c) => c.url.endsWith("/v1/codehost/token"))!.body).toEqual({ repo: "acme/*", perms: { issues: "read", pull_requests: "read" } });
});

it("an org whose installation lacks Projects read still syncs issues and PRs, its boards off", async () => {
  const fetchFn = (async (url: string, init: RequestInit) => {
    const t = ops(url, init, "ghs_n", (_repo, perms) => !perms.organization_projects);
    if (t) return t;
    if (url.endsWith("/users/acme")) return { status: 200, json: async () => ({ type: "Organization" }) };
    return { status: 200, json: async () => ({ total_count: 0, items: [] }) };
  }) as unknown as typeof fetch;
  const p = new Projects(CODEHOST, fetchFn);
  expect(await p.account("acme")).toEqual({ user: false, projects: false });
  await expect(p.request("acme", "GET", "/search/issues?q=x")).resolves.toEqual({ total_count: 0, items: [] });
});

it("mints a read-only token for a repo the App covers, and reports a miss elsewhere", async () => {
  const calls: { method: string; url: string; body?: any }[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ method: init.method!, url, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const json = (status: number, body: unknown) => ({ status, json: async () => body });
    const t = ops(url, init, "ghs_r", (repo) => repo === "acme/app");
    if (t) return t;
    return json(404, { message: "Not Found" });
  }) as unknown as typeof fetch;
  const p = new Projects(CODEHOST, fetchFn);

  expect(await p.repoToken("acme", "app")).toBe("ghs_r");
  expect(await p.repoToken("acme", "app")).toBe("ghs_r");
  expect(await p.repoToken("other", "repo")).toBeUndefined();
  expect(await p.repoToken("other", "repo")).toBeUndefined();

  expect(calls.map((c) => c.body)).toEqual([ // one ask each: the token and the miss are both remembered
    { repo: "acme/app", perms: { contents: "read", issues: "read", pull_requests: "read", checks: "read", statuses: "read", actions: "read" } },
    { repo: "other/repo", perms: { contents: "read", issues: "read", pull_requests: "read", checks: "read", statuses: "read", actions: "read" } },
  ]);
});

it("a user account gets an org-wide token without Projects", async () => {
  const asked: any[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    const json = (status: number, body: unknown) => ({ status, json: async () => body });
    if (url.endsWith("/users/sam")) return json(200, { type: "User" });
    const t = ops(url, init, "ghs_y");
    if (t) return asked.push(JSON.parse(String(init.body))), t;
    return json(200, {});
  }) as unknown as typeof fetch;
  const p = new Projects(CODEHOST, fetchFn);
  expect(await p.account("sam")).toEqual({ user: true, projects: false });
  expect(await p.orgToken("sam")).toBe("ghs_y");
  expect(asked[0]).toEqual({ repo: "sam/*", perms: { issues: "read", pull_requests: "read" } });
});

it("no GitHub App: a product bug becomes a scrubbed, encoded one-click link that fits a URL, and nothing is filed", () => {
  const terms = ownerTerms("Ada,acme.example", "upstream-org/product");
  const evidence = { module: "board", version: "abc1234", reproduction: "1. open Settings & save", log: "TypeError at https://acme.example/x for ada@other.example" };
  const report = { fingerprint: "product-bug:board-settings-crash", title: "board: Settings #1 crashes", body: "Ada hit it on 10.0.0.5 twice.", evidence };
  const { url, trimmed } = issueLink("upstream-org/product", report, terms);
  const u = new URL(url);
  expect(u.origin + u.pathname).toBe("https://github.com/upstream-org/product/issues/new");
  expect(u.searchParams.get("title")).toBe("board: Settings #1 crashes");
  const body = u.searchParams.get("body")!;
  expect(body).toContain("[redacted] hit it on [redacted] twice.");
  expect(body).toContain("1. open Settings & save");
  expect(body).toContain("Fingerprint: product-bug:board-settings-crash");
  expect(body + url).not.toMatch(/Ada|ada@|acme\.example|10\.0\.0\.5/);
  expect(trimmed).toBe(false);
  const long = issueLink("upstream-org/product", { ...report, evidence: { ...evidence, log: "é😀 line\n".repeat(900) } }, terms);
  expect(long.trimmed).toBe(true);
  expect(long.url.length).toBeLessThanOrEqual(7000);
  expect(new URL(long.url).searchParams.get("body")).toMatch(/\[trimmed to fit a link\]$/);
});
