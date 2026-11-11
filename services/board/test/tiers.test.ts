// Tiered approvals: who decided is stamped from the key used, the reviewer's verdict is taken only on a pending
// Tier 1 record with a matching digest, and the owner channel is pinged only for Tier 2.
import { mkdtempSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { touchesMigrations } from "../src/approvals.js";
import type { Paperclip } from "../src/paperclip.js";
import { Store } from "../src/store.js";

const TOKEN = "t".repeat(64);
const OWNER = "o".repeat(48);
const WATCHER = "w".repeat(48);
const REVIEWER = "r".repeat(48);
const issue = { id: "11111111-1111-1111-1111-111111111111", identifier: "WOR-7", title: "T", description: "", status: "in_review", assigneeUserId: null, assigneeAgentId: "fe", createdAt: "", updatedAt: "" };
const engineer = { id: "fe", name: "Fleet Engineer", status: "idle", adapterType: "codex_local", metadata: { setupKey: "aidenhq:engineer-fleet" } };
const pc = { addComment: async () => {}, me: async () => "me-1", agents: async () => [engineer], labels: async () => [], company: async () => ({ issuePrefix: "WOR" }), issue: async () => issue } as unknown as Paperclip;
const grants = join(mkdtempSync(join(tmpdir(), "tiers-")), "grants.json");
const setAutonomy = (a: string) => writeFileSync(grants, JSON.stringify({ autonomy: a, agents: {} }));

describe("tiered approvals", () => {
  const store = new Store(":memory:");
  const app = createApp({ paperclip: pc, store, log: pino({ level: "silent" }), allowedHosts: ["board:3122"], staticDir: "/nonexistent", timezone: "UTC", mode: "internal", internalToken: TOKEN, decideKey: OWNER, watcherKey: WATCHER, reviewerKey: REVIEWER });
  let port = 0;
  beforeAll(async () => {
    process.env.AIDENHQ_GRANTS_FILE = grants;
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    port = (app.address() as AddressInfo).port;
  });
  afterAll(() => app.close());
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; json: any }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, method, path, headers: { host: "board:3122", "content-type": "application/json", authorization: `Bearer ${TOKEN}`, ...headers } }, (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode!, json: text ? JSON.parse(text) : undefined }));
      });
      req.on("error", reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  let n = 0;
  // The runner files with its key; the internal token alone (agents can reach it) files nothing.
  const file = async (tier: 1 | 2, action = "push", headers: Record<string, string> = { "x-reviewer-key": REVIEWER }) =>
    (await call("POST", "/internal/approvals", { issue: "WOR-7", action, tier, reason: "r", args: { only: [{ repo: "org/app", branch: `b${++n}`, sha: "a".repeat(40) }] } }, headers)).json;
  const verdict = (id: string, body: object, key = REVIEWER) => call("POST", `/internal/approvals/${id}/review`, { model: "moonshotai/kimi-k3.1-pro", reason: "fine", ...body }, { "x-reviewer-key": key });
  const decide = (body: object, key: string) => call("POST", "/internal/owner/approvals/decide", body, { "x-owner-key": key });
  const pendingIds = async () => (await call("GET", "/internal/approvals?state=pending", undefined, { "x-owner-key": OWNER })).json.approvals.map((a: any) => a.id);

  it("off: every card is the owner's, whatever tier the runner asks for", async () => {
    setAutonomy("off");
    expect((await file(1)).tier).toBe(2);
  });

  it("only the runner's key files a card or records a Tier 0 run; the internal token alone does neither", async () => {
    setAutonomy("full");
    expect(await file(1, "pr", {})).toEqual({ error: "only the runner files approval requests" });
    expect((await file(1, "pr")).tier).toBe(1);
    const auto = { issue: "WOR-7", action: "push", args: { only: [{ repo: "org/app", branch: "x", sha: "b".repeat(40) }] }, rule: "agents-org-branch", reason: "ordinary branch", ok: true, text: "Pushed" };
    expect((await call("POST", "/internal/approvals/auto", auto)).status).toBe(403);
  });

  it("stamps decided_by from the key, never from the body", async () => {
    setAutonomy("full");
    const a = await file(2, "pr");
    expect((await decide({ id: a.id, decision: "approve", via: "slack" }, OWNER)).json).toMatchObject({ state: "approved", decidedBy: "owner:telegram" });
    const c = await file(2, "push");
    expect((await decide({ id: c.id, decision: "approve" }, WATCHER)).json).toMatchObject({ state: "approved", decidedBy: "watcher" });
    expect((await decide({ id: c.id, decision: "approve" }, REVIEWER)).status).toBe(403); // the reviewer key never decides as the owner
    expect((await call("GET", "/internal/owner/reset-links", undefined, { "x-owner-key": WATCHER })).status).toBe(403);
  });

  it("the reviewer decides only a pending Tier 1 record with its digest; Tier 1 never pings the owner", async () => {
    setAutonomy("full");
    const one = await file(1);
    expect(one.tier).toBe(1);
    expect(await pendingIds()).not.toContain(one.id);
    expect((await call("GET", "/internal/approvals?state=review")).status).toBe(403);
    expect((await call("GET", "/internal/approvals?state=review", undefined, { "x-reviewer-key": REVIEWER })).json.approvals.map((a: any) => a.id)).toContain(one.id);
    expect((await verdict(one.id, { digest: one.digest, decision: "approve" }, TOKEN)).status).toBe(403); // the internal token
    expect((await verdict(one.id, { digest: "0".repeat(40), decision: "approve" })).status).toBe(409); // digest mismatch
    expect((await verdict(one.id, { digest: one.digest, decision: "approve", model: "openai/gpt-x" })).status).toBe(400);
    const two = await file(2, "pr"); // another action: a new push would replace `one`
    expect((await verdict(two.id, { digest: two.digest, decision: "approve" })).status).toBe(409); // Tier 2 is the owner's
    expect((await verdict(one.id, { digest: one.digest, decision: "approve" })).json).toMatchObject({ state: "approved", decidedBy: "reviewer:moonshotai/kimi-k3.1-pro" });
  });

  it("tier0 (shadow): the reviewer may only escalate, which makes it the owner's card; a reject makes the action sticky", async () => {
    setAutonomy("tier0");
    const one = await file(1);
    expect((await verdict(one.id, { digest: one.digest, decision: "approve" })).status).toBe(409);
    expect((await verdict(one.id, { digest: one.digest, decision: "escalate", reason: "shadow: would approve" })).json).toMatchObject({ tier: 2, review: "shadow: would approve" });
    expect(await pendingIds()).toContain(one.id);
    expect((await decide({ id: one.id, decision: "reject" }, OWNER)).json).toMatchObject({ state: "rejected", decidedBy: "owner:telegram" });
    expect((await file(1)).tier).toBe(2); // sticky after a reject on (task, push)
  });

  it("a Tier 0 run is an audit row only: never claimable", async () => {
    const a = (await call("POST", "/internal/approvals/auto", { issue: "WOR-7", action: "push", args: { only: [{ repo: "org/app", branch: "x", sha: "b".repeat(40) }] }, rule: "agents-org-branch", reason: "ordinary branch", ok: true, text: "Pushed" }, { "x-reviewer-key": REVIEWER })).json;
    expect(a).toMatchObject({ state: "auto", tier: 0, decidedBy: "auto:agents-org-branch", outcome: "applied" });
    expect((await call("POST", `/internal/approvals/${a.id}/claim`, {}, { "x-reviewer-key": REVIEWER })).status).toBe(409);
  });

  it("a deploy that touches a migration or schema file is the owner's, whatever the SQL says (fail closed)", () => {
    const d = (file: string, line: string) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -0,0 +1 @@\n+${line}\n`;
    expect(touchesMigrations(d("migrations/005.sql", "CREATE TABLE t (id int);"))).toBe(true);
    expect(touchesMigrations(d("db/schema.prisma", "model X {}"))).toBe(true);
    expect(touchesMigrations(d("src/app.ts", "// migrations later"))).toBe(false);
    // A hunk line can't pose as a file header.
    expect(touchesMigrations(d("src/app.ts", "+++ b/migrations/1.sql"))).toBe(false);
  });
});
