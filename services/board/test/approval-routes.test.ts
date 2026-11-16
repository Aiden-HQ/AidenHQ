import { request } from "node:http";
import type { AddressInfo } from "node:net";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { raiseCapRequest } from "../src/approvals.js";
import { createApp } from "../src/app.js";
import type { Paperclip } from "../src/paperclip.js";
import { Store } from "../src/store.js";

const TOKEN = "t".repeat(64);
const DECIDE_KEY = "k".repeat(48);
const RUNNER_KEY = "r".repeat(48);
const issue = { id: "11111111-1111-1111-1111-111111111111", identifier: "WOR-184", title: "T", description: "", status: "in_review", assigneeUserId: null, assigneeAgentId: "fe", createdAt: "", updatedAt: "" };
const aidens = { ...issue, id: "22222222-2222-2222-2222-222222222222", identifier: "WOR-1", assigneeAgentId: "cos" };
const engineer = { id: "fe", name: "Fleet Engineer", status: "idle", adapterType: "codex_local", metadata: { setupKey: "aidenhq:engineer-fleet" } };
const posted: { id: string; body: string }[] = [];
const pc = { addComment: async (id: string, body: string) => void posted.push({ id, body }), me: async () => "me-1", agents: async () => [engineer], labels: async () => [], company: async () => ({ issuePrefix: "WOR" }), issue: async (ref: string) => (ref === "WOR-1" ? aidens : issue) } as unknown as Paperclip;
const log = pino({ level: "silent" });

function listen(app: ReturnType<typeof createApp>) {
  let port = 0;
  beforeAll(async () => {
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    port = (app.address() as AddressInfo).port;
  });
  afterAll(() => app.close());
  return (method: string, path: string, body: unknown, headers: Record<string, string>) =>
    new Promise<{ status: number; json: any }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode!, json: text ? JSON.parse(text) : undefined }));
      });
      req.on("error", reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
}

const args = (sha = "a") => ({ repo: "acme/instance", branch: "fleet/x", sha: sha.repeat(40), files: ["instance.yaml"] });
const ask = (sha = "a") => ({ issue: "WOR-184", action: "apply", args: args(sha), diff: "+schedule: daily" });

describe("approval routes", () => {
  const store = new Store(":memory:");
  const internal = listen(createApp({ paperclip: pc, store, log, allowedHosts: ["board:3122"], staticDir: "/nonexistent", timezone: "UTC", mode: "internal", internalToken: TOKEN, decideKey: DECIDE_KEY, reviewerKey: RUNNER_KEY }));
  // The runner's calls: the internal token plus its own key.
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => internal("POST", path, body, { host: "board:3122", "content-type": "application/json", authorization: `Bearer ${TOKEN}`, "x-reviewer-key": RUNNER_KEY, ...headers });
  const get = (path: string, headers: Record<string, string> = {}) => internal("GET", path, undefined, { host: "board:3122", authorization: `Bearer ${TOKEN}`, ...headers });

  it("the runner files and claims, but never approves; the owner channel's decide key does, once; only the claimer reports", async () => {
    const filed = await post("/internal/approvals", { ...ask(), baseTier: 1 });
    expect(filed.status).toBe(200);
    const id = filed.json.id;
    // Stamped for batching: the runner's classify() tier on the merits, and the task's agent (looked up, never the caller's).
    expect(filed.json).toMatchObject({ baseTier: 1, requesterId: "fe" });
    // The card is the board's, from the args: the sha and the diff the runner rechecks before landing.
    expect(filed.json).toMatchObject({ state: "pending", identifier: "WOR-184", issueId: issue.id, sentence: "Apply a change to the fleet's configuration (commit aaaaaaaaaaaa).", details: "+schedule: daily" });
    expect((await post(`/internal/approvals/${id}/claim`, {})).status).toBe(409); // not approved
    const decide = { id, decision: "approve", via: "telegram" };
    expect((await post("/internal/owner/approvals/decide", decide)).status).toBe(403); // the internal token alone
    expect((await post("/internal/owner/approvals/decide", decide, { "x-owner-key": "nope" })).status).toBe(403);
    expect((await post("/internal/owner/approvals/decide", decide, { "x-owner-key": DECIDE_KEY })).json).toMatchObject({ state: "approved", decidedBy: "owner:telegram" });
    expect((await post("/internal/owner/approvals/decide", decide, { "x-owner-key": DECIDE_KEY })).status).toBe(409);
    // The internal token alone (agents can read it) files, claims and reads nothing.
    const tokenOnly = { "x-reviewer-key": "" };
    expect((await post(`/internal/approvals/${id}/claim`, {}, tokenOnly)).json).toEqual({ error: "only the runner claims approved work" });
    expect((await get("/internal/approvals?state=approved")).status).toBe(403);
    expect((await get("/internal/approvals?state=pending")).status).toBe(403);
    expect((await post("/internal/approvals", ask("d"), tokenOnly)).status).toBe(403);
    const claimed = await post(`/internal/approvals/${id}/claim`, {});
    expect(claimed.json).toMatchObject({ state: "used", args: args(), details: "+schedule: daily" });
    expect((await post(`/internal/approvals/${id}/claim`, {})).status).toBe(409); // consumed once
    expect((await post(`/internal/approvals/${id}/outcome`, { nonce: "f".repeat(32), ok: false, text: "forged" })).status).toBe(409);
    expect((await post(`/internal/approvals/${id}/outcome`, { nonce: claimed.json.nonce, ok: false, text: "forged" }, tokenOnly)).json).toEqual({ error: "only the runner reports outcomes" });
    expect((await post(`/internal/approvals/${id}/outcome`, { nonce: claimed.json.nonce, ok: true, text: "Applied." })).status).toBe(200);
    expect(store.approvals.get(id)).toMatchObject({ outcome: "applied", outcomeText: "Applied." });
    // The owner channel learns the outcome, to tell him under the card he tapped.
    const done = await get("/internal/approvals?state=finished", { "x-owner-key": DECIDE_KEY });
    expect(done.json.approvals.find((a: any) => a.id === id)).toMatchObject({ outcome: "applied", outcomeText: "Applied." });
    // The runner reads the cards on one task, any state (agents do too, with their own credential and task_approvals).
    expect((await get("/internal/approvals?issue=WOR-184")).status).toBe(403);
    const onTask = await get("/internal/approvals?issue=WOR-184", { "x-reviewer-key": RUNNER_KEY });
    expect(onTask.json.approvals.map((a: any) => a.id)).toContain(id);
  });

  it("refuses a card on a cancelled or done task", async () => {
    const was = issue.status;
    for (const status of ["cancelled", "done"]) {
      issue.status = status;
      expect((await post("/internal/approvals", ask("c"))).status).toBe(409);
    }
    issue.status = was;
  });

  it("refuses caller-written card text, and requests on tasks that aren't an engineer's", async () => {
    expect((await post("/internal/approvals", { ...ask("b"), sentence: "Harmless" })).status).toBe(400);
    expect((await post("/internal/approvals", { ...ask("b"), args: { ...args("b"), extra: 1 } })).status).toBe(400);
    expect((await post("/internal/approvals", { ...ask("b"), issue: "WOR-1" })).status).toBe(403);
  });

  it("a rejected request is never claimable; a board-applied one is never claimed or reported by the runner", async () => {
    const id = (await post("/internal/approvals", ask("c"))).json.id;
    expect((await post("/internal/owner/approvals/decide", { task: "wor-184", decision: "reject", via: "telegram" }, { "x-owner-key": DECIDE_KEY })).json).toMatchObject({ id, state: "rejected" });
    // The asking task hears it, so its agent doesn't wait on a card that will never run.
    await new Promise((r) => setTimeout(r, 20));
    expect(posted.find((c) => c.id === issue.id && c.body.includes(`approval ${id}`))?.body).toMatch(/^\*\*Rejected\*\*/);
    expect((await post(`/internal/approvals/${id}/claim`, {})).status).toBe(409);
    const deploy = store.approvals.request({ issueId: aidens.id, identifier: "WOR-1", action: "deploy_app", target: "x", digest: "d".repeat(40), args: {}, sentence: "s", reads: "", changes: "c", cost: "", details: "", requestedBy: "Aiden" });
    expect((await post(`/internal/approvals/${deploy.id}/claim`, {})).status).toBe(404);
    expect((await post(`/internal/approvals/${deploy.id}/outcome`, { nonce: "f".repeat(32), ok: true, text: "x" })).status).toBe(404);
  });

  // A `pr` card's head is on no GitHub branch before approval, so a rejection names the runner-cache ref that holds it:
  // the next task on the work resolves the reviewed commit instead of rebuilding the change from prose.
  it("a rejected pr card names the cache ref holding its reviewed heads; a push card does not", async () => {
    const only = [
      { repo: "acme/aidenhq", branch: "fix/x", sha: "e".repeat(40) },
      { repo: "acme/infra", branch: "reviewed/y", sha: "f".repeat(40) },
    ];
    const pr = (await post("/internal/approvals", { issue: "WOR-184", action: "pr", args: { only } })).json;
    const push = (await post("/internal/approvals", { issue: "WOR-184", action: "push", args: { only } })).json;
    const reject = (id: string) => post("/internal/owner/approvals/decide", { id, decision: "reject", via: "telegram" }, { "x-owner-key": DECIDE_KEY });
    expect((await reject(pr.id)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    const text = posted.find((c) => c.body.includes(`approval ${pr.id}`))?.body ?? "";
    expect(text).toContain(`\`refs/reviewed/${pr.id}/fix/x\``);
    expect(text).toContain(`\`refs/reviewed/${pr.id}/reviewed/y\``);
    expect(text).toMatch(/never pushed, so GitHub has no branch and no PR for it/);
    expect((await reject(push.id)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    expect(posted.find((c) => c.body.includes(`approval ${push.id}`))?.body).not.toContain("refs/reviewed");
  });

  it("a product PR card that also merges says so, and the runner's per-task read carries its args (sticky rejects)", async () => {
    const only = [{ repo: "acme/aidenhq", branch: "fleet/x", sha: "d".repeat(40) }];
    const filed = await post("/internal/approvals", { issue: "WOR-184", action: "pr", args: { only, merge: true } });
    expect(filed.json.sentence).toBe("Push and open (or update) a PR for 1 branch, then merge each PR once its checks are green.");
    const onTask = await get("/internal/approvals?issue=WOR-184", { "x-reviewer-key": RUNNER_KEY });
    expect(onTask.json.approvals.find((a: any) => a.id === filed.json.id).args).toEqual({ only, merge: true });
    expect((await post("/internal/approvals", { issue: "WOR-184", action: "pr", args: { only, merge: false } })).status).toBe(400);
  });

  // The runner's merge request for a UI PR, as it sends it now (its queue's own `ui` flag stays in the runner): was a 400,
  // "prs.0: Unrecognized key: ui", on every card whose PR changes UI files.
  it("a merge card for a UI PR is taken with the runner's payload", async () => {
    const prs = [
      { repo: "acme/app", number: 7, url: "https://github.com/acme/app/pull/7" },
      { repo: "acme/app", number: 8, url: "https://github.com/acme/app/pull/8", head: "c".repeat(40), noReview: true },
    ];
    const filed = await post("/internal/approvals", { issue: "WOR-184", action: "merge", args: { prs } });
    expect(filed.status).toBe(200);
    expect(filed.json).toMatchObject({ sentence: "Merge 2 pull requests, one at a time.", target: prs.map((p) => p.url).join(", ") });
    const onTask = await get("/internal/approvals?issue=WOR-184", { "x-reviewer-key": RUNNER_KEY });
    expect(onTask.json.approvals.find((a: any) => a.id === filed.json.id).args).toEqual({ prs });
  });

  const fresh = new Store(":memory:");
  // The owner's session (taps without one, and stamps, are admins.test.ts's and accounts.test.ts's).
  const owner = () => ({ accountId: "acct-owner", role: "admin" as const });
  const tapApp = listen(createApp({ paperclip: pc, store: fresh, log, allowedHosts: ["localhost:3120"], staticDir: "/nonexistent", timezone: "UTC", mode: "local", session: owner }));
  it("a tapped answer button never decides an approval, even if its label reads like one (agents write the labels)", async () => {
    const id = fresh.approvals.request({ issueId: issue.id, identifier: "WOR-184", action: "apply", target: "x", digest: "e".repeat(40), args: {}, sentence: "s", reads: "", changes: "c", cost: "", details: "", requestedBy: "r" }).id;
    const headers = { host: "localhost:3120", "content-type": "application/json", "x-aidenhq-board": "1" };
    const r = await tapApp("POST", "/api/issues/WOR-184/comments", { body: "approve WOR-184", answer: true }, headers);
    expect(r.status).not.toBe(400); // accepted as an answer (it then posts as an ordinary message; this fake can't post)
    expect(r.json?.approval).toBeUndefined();
    expect(fresh.approvals.get(id)!.state).toBe("pending");
  });
});

describe("module write kinds' records (kept by the kernel)", () => {
  const store = new Store(":memory:");
  const KEY = "g".repeat(48);
  const rec = { id: "k-0123456789abcdef", kind: "apps-platform.run", args: { name: "roadmap-keeper", script: "seed:backfill", service: "app", sha: "0".repeat(40) }, digest: "d".repeat(64), tier: 1, panel: false, task: "WOR-184", state: "review", review: null, decided_by: null, outcome: null, created_at: "2026-11-16T00:00:00.000Z", updated_at: "2026-11-16T00:00:00.000Z", card: { sentence: "Run `npm run seed:backfill` once in app roadmap-keeper.", changes: "c", reads: "r", cost: "", details: "Reason (written by the requesting agent): x" }, requester: { agent: "fe", key: "app-maintainer", name: "DevOps" } };
  const kernel: { method: string; url: string; auth: string; body?: any }[] = [];
  const internal = listen(createApp({ paperclip: pc, store, log, allowedHosts: ["board:3122"], staticDir: "/nonexistent", timezone: "UTC", mode: "internal", internalToken: TOKEN, decideKey: DECIDE_KEY, reviewerKey: RUNNER_KEY, kernel: { url: "http://kernel.test", token: KEY } }));
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => internal(method, path, body, { host: "board:3122", "content-type": "application/json", authorization: `Bearer ${TOKEN}`, ...headers });
  beforeAll(() => vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    kernel.push({ method: init.method ?? "GET", url, auth: String((init.headers as Record<string, string>).authorization), body });
    if (url.endsWith("/decide")) return new Response(JSON.stringify({ ...rec, state: "approved", decided_by: body.by }));
    if (url.endsWith("/review")) return new Response(JSON.stringify({ ...rec, state: "owner", tier: 2, review: body.reason }));
    if (url.includes("/v1/writes?state=")) return new Response(JSON.stringify({ records: url.endsWith("review") ? [rec] : url.endsWith("owner") ? [{ ...rec, state: "owner", tier: 2 }] : [] }));
    return new Response(JSON.stringify({ ...rec, state: "owner", tier: 2 }));
  }));
  afterAll(() => vi.unstubAllGlobals());

  it("lists them with the board's cards, under the kinds' card names, and forwards each verdict and decision by digest", async () => {
    // The reviewer's queue (the runner) and the owner's (the owner channel) carry them, the ported kinds under their old names.
    const queue = (await call("GET", "/internal/approvals?state=review", undefined, { "x-reviewer-key": RUNNER_KEY })).json.approvals;
    expect(queue).toEqual([expect.objectContaining({ id: rec.id, action: "app_run", tier: 1, state: "pending", digest: rec.digest, args: rec.args, identifier: "WOR-184" })]);
    expect((await call("GET", "/internal/approvals?state=pending", undefined, { "x-owner-key": DECIDE_KEY })).json.approvals).toEqual([expect.objectContaining({ id: rec.id, tier: 2 })]);
    // The reviewer's verdict goes to the kernel with the board's key; autonomy off still refuses an approve here first.
    const verdict = { digest: rec.digest, decision: "escalate", reason: "fine", model: "~openai/gpt-luna-latest" };
    expect((await call("POST", `/internal/approvals/${rec.id}/review`, { ...verdict, decision: "approve" }, { "x-reviewer-key": RUNNER_KEY })).status).toBe(409);
    expect((await call("POST", `/internal/approvals/${rec.id}/review`, verdict, { "x-reviewer-key": RUNNER_KEY })).json).toMatchObject({ id: rec.id, tier: 2 });
    expect(kernel.at(-1)).toEqual({ method: "POST", url: `http://kernel.test/v1/writes/${rec.id}/review`, auth: `Bearer ${KEY}`, body: verdict });
    // The owner's tap in Telegram: stamped by the board from its key, the digest read from the kernel's record.
    expect((await call("POST", "/internal/owner/approvals/decide", { id: rec.id, decision: "approve", via: "telegram" })).status).toBe(403);
    const r = await call("POST", "/internal/owner/approvals/decide", { id: rec.id, decision: "approve", via: "telegram" }, { "x-owner-key": DECIDE_KEY });
    expect(r.json).toMatchObject({ id: rec.id, state: "approved", decidedBy: "owner:telegram" });
    expect(kernel.at(-1)).toEqual({ method: "POST", url: `http://kernel.test/v1/writes/${rec.id}/decide`, auth: `Bearer ${KEY}`, body: { digest: rec.digest, decision: "approve", by: "owner:telegram", via: "telegram" } });
    // A batch never takes them (each is the kernel's, decided on its own).
    expect((await call("POST", "/internal/owner/approvals/batch", { items: [{ id: rec.id, digest: rec.digest }] }, { "x-owner-key": DECIDE_KEY })).status).toBe(400);
  });
});

describe("raise_cap from the model gateway", () => {
  const GATEWAY_KEY = "g".repeat(48);
  const store = new Store(":memory:");
  const internal = listen(createApp({ paperclip: pc, store, log, allowedHosts: ["board:3122"], staticDir: "/nonexistent", timezone: "UTC", mode: "internal", internalToken: TOKEN, reviewerKey: RUNNER_KEY, decideKey: DECIDE_KEY, gatewayKey: GATEWAY_KEY, gateway: { url: "http://gateway:8201", token: GATEWAY_KEY } }));
  const post = (body: unknown, key: string) => internal("POST", "/internal/approvals/raise-cap", body, { host: "board:3122", "content-type": "application/json", authorization: `Bearer ${TOKEN}`, "x-gateway-key": key });
  const ask = { issue: issue.id, scope: "task", agentId: "fe", subject: issue.id, cap: 10, spent: 10.02 };

  it("files one Tier 2 card with the gateway's key only, named for the agent", async () => {
    expect((await post(ask, RUNNER_KEY)).status).toBe(403);
    const a = await post(ask, GATEWAY_KEY);
    expect(a.json).toMatchObject({ action: "raise_cap", tier: 2, state: "pending", identifier: "WOR-184", sentence: "Double Fleet Engineer's task spend cap from $10.00 to $20.00." });
    expect((await post({ ...ask, spent: 10.5 }, GATEWAY_KEY)).json.id).toBe(a.json.id);
    expect((await post({ ...ask, to: 500 }, GATEWAY_KEY)).status).toBe(400);
  });

  it("an approved raise_cap sets the doubled cap on the gateway and tells the task to carry on", async () => {
    const calls: { url: string; auth: string; body: any }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, auth: String((init.headers as Record<string, string>).authorization), body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const id = (await post({ ...ask, cap: 20, spent: 20.4 }, GATEWAY_KEY)).json.id;
    const decided = await internal("POST", "/internal/owner/approvals/decide", { id, decision: "approve", via: "telegram" }, { host: "board:3122", "content-type": "application/json", authorization: `Bearer ${TOKEN}`, "x-owner-key": DECIDE_KEY });
    expect(decided.json).toMatchObject({ state: "approved" });
    await vi.waitFor(() => expect(store.approvals.get(id)!.outcome).toBe("applied"));
    vi.unstubAllGlobals();
    expect(calls).toEqual([{ url: "http://gateway:8201/internal/caps", auth: `Bearer ${GATEWAY_KEY}`, body: { scope: "task", agentId: "fe", subject: issue.id, cap: 40 } }]);
    expect(store.approvals.get(id)!.outcomeText).toBe("Raised the task spend cap from $20.00 to $40.00 ($20.40 spent). Carry on where the cap stopped you.");
    await vi.waitFor(() => expect(posted.at(-1)!.body).toContain("Carry on where the cap stopped you."));
  });
});

// A task closed since its card was filed acts on nothing: a leftover card runs nothing, and a rejection decided on it
// posts nothing and patches nothing. Done and cancelled alike: a finished task isn't reopened by either.
describe("cards on a closed task", () => {
  const GATEWAY_KEY = "g".repeat(48);
  const closed = { ...issue, status: "in_review", labels: [] as { id: string; name: string }[], parentId: null as string | null };
  const closedPosted: { id: string; body: string }[] = [];
  const closedPatches: Record<string, unknown>[] = [];
  const closedPc = {
    ...pc,
    addComment: async (id: string, body: string) => void closedPosted.push({ id, body }),
    updateIssue: async (id: string, body: Record<string, unknown>) => void closedPatches.push({ id, ...body }),
    issue: async (ref: string) => (ref === "WOR-1" ? aidens : closed),
  } as unknown as Paperclip;
  const store = new Store(":memory:");
  const internal = listen(createApp({ paperclip: closedPc, store, log, allowedHosts: ["board:3122"], staticDir: "/nonexistent", timezone: "UTC", mode: "internal", internalToken: TOKEN, decideKey: DECIDE_KEY, gatewayKey: GATEWAY_KEY, gateway: { url: "http://gateway:8201", token: GATEWAY_KEY } }));
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => internal("POST", path, body, { host: "board:3122", "content-type": "application/json", authorization: `Bearer ${TOKEN}`, ...headers });
  const decide = (id: string, decision: string) => post("/internal/owner/approvals/decide", { id, decision, via: "telegram" }, { "x-owner-key": DECIDE_KEY });

  for (const status of ["done", "cancelled"]) {
    it(`an approved raise_cap on a ${status} task runs nothing, and the task keeps its status, labels and comments`, async () => {
      const calls: string[] = [];
      vi.stubGlobal("fetch", async (url: string) => (calls.push(String(url)), new Response("{}", { status: 200 })));
      try {
        const id = store.approvals.request(raiseCapRequest({ id: closed.id, identifier: closed.identifier }, { scope: "task", agentId: "fe", subject: closed.id, cap: 10, spent: 10.02 }, "Fleet Engineer")).id;
        Object.assign(closed, { status, labels: [{ id: "lbl-grading", name: "grading" }] });
        expect((await decide(id, "approve")).status).toBe(200);
        await vi.waitFor(() => expect(store.approvals.get(id)!.outcome).toBe("failed"));
        await new Promise((r) => setTimeout(r, 50));
        expect(calls).toEqual([]); // the gateway's cap is untouched
        expect(store.approvals.get(id)!.outcomeText).toBe(`Not run: the task is ${status}: a leftover request runs nothing.`);
        expect(closedPosted).toEqual([]); // no outcome comment on the task
        expect(closedPatches).toEqual([]); // no label or status change
        expect(closed).toMatchObject({ status, labels: [{ id: "lbl-grading", name: "grading" }] });
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it(`a rejection decided on a ${status} task posts nothing and patches nothing`, async () => {
      const id = store.approvals.request({ issueId: closed.id, identifier: closed.identifier, action: "apply", target: "x", digest: "f".repeat(40), args: {}, sentence: "s", reads: "", changes: "c", cost: "", details: "", requestedBy: "r" }).id;
      Object.assign(closed, { status, labels: [{ id: "lbl-grading", name: "grading" }], parentId: "parent-1" });
      expect((await decide(id, "reject")).json).toMatchObject({ state: "rejected" });
      await new Promise((r) => setTimeout(r, 50));
      expect(closedPosted).toEqual([]); // neither the task nor its parent hears of it
      expect(closedPatches).toEqual([]);
      expect(closed).toMatchObject({ status, labels: [{ id: "lbl-grading", name: "grading" }] });
    });
  }

  it("an open task still hears both: the refusal is a closed task's alone", async () => {
    Object.assign(closed, { status: "in_review", labels: [], parentId: null });
    const id = store.approvals.request({ issueId: closed.id, identifier: closed.identifier, action: "apply", target: "x", digest: "e".repeat(40), args: {}, sentence: "s", reads: "", changes: "c", cost: "", details: "", requestedBy: "r" }).id;
    expect((await decide(id, "reject")).json).toMatchObject({ state: "rejected" });
    await vi.waitFor(() => expect(closedPosted.some((c) => c.id === closed.id && /^\*\*Rejected\*\*/.test(c.body))).toBe(true));
  });
});
