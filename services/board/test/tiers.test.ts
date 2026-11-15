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
const posted: string[] = [];
const pc = { addComment: async (_id: string, body: string) => void posted.push(body), me: async () => "me-1", agents: async () => [engineer], labels: async () => [], company: async () => ({ issuePrefix: "WOR" }), issue: async (ref: string) => (ref === "WOR-9" || ref === "WOR-10" ? { ...issue, id: `00000000-0000-0000-0000-${ref.slice(4).padStart(12, "0")}`, identifier: ref } : issue) } as unknown as Paperclip;
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
    (await call("POST", "/internal/approvals", { issue: "WOR-7", action, tier, reason: "r", args: { only: [{ repo: "org/app", branch: `b${++n}`, sha: "a".repeat(40), patch: n.toString(16).padStart(64, "0") }] } }, headers)).json;
  const verdict = (id: string, body: object, key = REVIEWER) => call("POST", `/internal/approvals/${id}/review`, { model: "~openai/gpt-luna-latest", reason: "fine", ...body }, { "x-reviewer-key": key });
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
    expect((await verdict(one.id, { digest: one.digest, decision: "approve" })).json).toMatchObject({ state: "approved", decidedBy: "reviewer:~openai/gpt-luna-latest" });
  });

  it("tier0 (shadow): the reviewer may only escalate, which makes it the owner's card; the owner's reject is their veto", async () => {
    setAutonomy("tier0");
    const one = await file(1);
    expect((await verdict(one.id, { digest: one.digest, decision: "approve" })).status).toBe(409);
    expect((await verdict(one.id, { digest: one.digest, decision: "escalate", reason: "shadow: would approve" })).json).toMatchObject({ tier: 2, review: "shadow: would approve" });
    expect(await pendingIds()).toContain(one.id);
    expect((await decide({ id: one.id, decision: "reject" }, OWNER)).json).toMatchObject({ state: "rejected", decidedBy: "owner:telegram" });
    expect((await file(1)).tier).toBe(2); // the owner's veto on (task, push)
    setAutonomy("full");
    const lifted = await file(2);
    expect((await decide({ id: lifted.id, decision: "approve" }, OWNER)).json).toMatchObject({ state: "approved" });
    expect((await file(1)).tier).toBe(1); // their later yes lifts it
  });

  it("an authority-expanding (panel) card takes the reviewer's approval only with a second reviewer of another model", async () => {
    setAutonomy("full");
    const panel = (await call("POST", "/internal/approvals", { issue: "WOR-7", action: "pr", tier: 1, panel: true, reason: "gate core", args: { only: [{ repo: "org/app", branch: `p${++n}`, sha: "c".repeat(40) }] } }, { "x-reviewer-key": REVIEWER })).json;
    expect(panel).toMatchObject({ tier: 1, panel: true });
    expect((await verdict(panel.id, { digest: panel.digest, decision: "approve" })).status).toBe(409); // one reviewer
    expect((await verdict(panel.id, { digest: panel.digest, decision: "approve", second: "~openai/gpt-luna-latest" })).status).toBe(409); // the same model twice
    expect((await verdict(panel.id, { digest: panel.digest, decision: "approve", second: "~z-ai/glm-flash-latest" })).json).toMatchObject({ state: "approved", decidedBy: "reviewer:~openai/gpt-luna-latest+~z-ai/glm-flash-latest" });
    // A card the first reviewer flagged (marked before the second reviewer is asked): one reviewer's yes is refused after it.
    const flaggedCard = (await call("POST", "/internal/approvals", { issue: "WOR-7", action: "pr", tier: 1, reason: "r", args: { only: [{ repo: "org/app", branch: `p${++n}`, sha: "9".repeat(40) }] } }, { "x-reviewer-key": REVIEWER })).json;
    expect(flaggedCard.panel).toBe(false);
    expect((await call("POST", `/internal/approvals/${flaggedCard.id}/panel`, { digest: flaggedCard.digest }, { "x-reviewer-key": TOKEN })).status).toBe(403);
    expect((await call("POST", `/internal/approvals/${flaggedCard.id}/panel`, { digest: "0".repeat(40) }, { "x-reviewer-key": REVIEWER })).status).toBe(409);
    expect((await call("POST", `/internal/approvals/${flaggedCard.id}/panel`, { digest: flaggedCard.digest }, { "x-reviewer-key": REVIEWER })).json.panel).toBe(true);
    expect((await verdict(flaggedCard.id, { digest: flaggedCard.digest, decision: "approve" })).status).toBe(409);
    const reject = (await call("POST", "/internal/approvals", { issue: "WOR-7", action: "pr", tier: 1, panel: true, reason: "gate core", args: { only: [{ repo: "org/app", branch: `p${++n}`, sha: "d".repeat(40) }] } }, { "x-reviewer-key": REVIEWER })).json;
    expect((await verdict(reject.id, { digest: reject.digest, decision: "reject" })).json).toMatchObject({ state: "rejected" }); // a no needs one reviewer
    // Its notice (posted with the board key) names the reviewer, so no agent reads it as the owner's no.
    await new Promise((r) => setTimeout(r, 20));
    expect(posted.find((b) => b.includes(`approval ${reject.id}`))).toMatch(/^\*\*Rejected by the AI reviewer\*\*.*not the owner's decision/);
    // A reviewer's no never makes the next request the owner's.
    expect((await call("POST", "/internal/approvals", { issue: "WOR-7", action: "pr", tier: 1, reason: "r", args: { only: [{ repo: "org/app", branch: `p${++n}`, sha: "e".repeat(40) }] } }, { "x-reviewer-key": REVIEWER })).json.tier).toBe(1);
  });

  it("the owner's no on content X holds after a yes on Y, until they approve X itself", async () => {
    setAutonomy("full");
    const fileArgs = async (sha: string, tier: 1 | 2 = 1) => (await call("POST", "/internal/approvals", { issue: "WOR-7", action: "merge", tier, reason: "r", args: { prs: [{ repo: "org/app", number: 9, url: "https://github.com/org/app/pull/9", head: sha.repeat(40), patch: sha.repeat(64) }] } }, { "x-reviewer-key": REVIEWER })).json;
    const x = await fileArgs("1", 2);
    expect((await decide({ id: x.id, decision: "reject" }, WATCHER)).json).toMatchObject({ state: "rejected" });
    const y = await fileArgs("2", 2);
    expect((await decide({ id: y.id, decision: "approve" }, WATCHER)).json).toMatchObject({ state: "approved" });
    expect((await fileArgs("3")).tier).toBe(1); // other content: the reviewer's again
    expect((await fileArgs("1")).tier).toBe(2); // X resubmitted: still the owner's
  });

  it("a watcher's stale or duplicate no (stale: true) never vetoes the action on the task; a plain watcher no does", async () => {
    setAutonomy("full");
    const fileM = async (sha: string, tier: 1 | 2 = 1, issue = "WOR-9") => (await call("POST", "/internal/approvals", { issue, action: "merge", tier, reason: "r", args: { prs: [{ repo: "org/app", number: 4, url: "https://github.com/org/app/pull/4", head: sha.repeat(40), patch: sha.repeat(64) }] } }, { "x-reviewer-key": REVIEWER })).json;
    const dup = await fileM("1", 2);
    expect((await decide({ id: dup.id, decision: "reject", stale: true }, OWNER)).status).toBe(400); // the watcher's only
    expect((await decide({ id: dup.id, decision: "approve", stale: true }, WATCHER)).status).toBe(400);
    expect((await decide({ id: dup.id, decision: "reject", stale: true }, WATCHER)).json).toMatchObject({ state: "rejected", decidedBy: "stale:watcher" });
    expect((await fileM("1")).tier).toBe(1); // even the same content: the reviewer's
    const no = await fileM("2", 2, "WOR-10");
    expect((await decide({ id: no.id, decision: "reject" }, WATCHER)).json).toMatchObject({ state: "rejected", decidedBy: "watcher" });
    expect((await fileM("3", 1, "WOR-10")).tier).toBe(2);
  });

  it("the owner's veto binds to the patch: a rebased X (new commits) is still theirs; no patch key fails closed", async () => {
    setAutonomy("full");
    const P = (c: string) => c.repeat(64);
    const pushArgs = (sha: string, patch?: string) => ({ only: [{ repo: "org/app", branch: `rb${sha}`, sha: sha.repeat(40), ...(patch ? { patch } : {}) }] });
    const fileP = async (args: object, tier: 1 | 2 = 1) => (await call("POST", "/internal/approvals", { issue: "WOR-8", action: "pr", tier, reason: "r", args }, { "x-reviewer-key": REVIEWER })).json;
    const x = await fileP(pushArgs("1", P("a")), 2);
    expect((await decide({ id: x.id, decision: "reject" }, OWNER)).json).toMatchObject({ state: "rejected" });
    const y = await fileP(pushArgs("2", P("b")), 2);
    expect((await decide({ id: y.id, decision: "approve" }, OWNER)).json).toMatchObject({ state: "approved" });
    expect((await fileP(pushArgs("3", P("a")))).tier).toBe(2); // X rebased: new commit, same patch
    expect((await fileP(pushArgs("4", P("c")))).tier).toBe(1); // other content
    expect((await fileP(pushArgs("5"))).tier).toBe(2); // no patch key: fails closed
  });

  // A content key is lossy: it may only restrict (an owner veto), never grant. A rebased card asks again (owner, 2026-11-14).
  it("an approved card replaced by the same change rebased never inherits its approval", async () => {
    setAutonomy("full");
    const P = (c: string) => c.repeat(64);
    const pr = (sha: string, patch: string, title = "t") => call("POST", "/internal/approvals", { issue: "WOR-9", action: "pr", tier: 1, reason: "r", args: { only: [{ repo: "org/app", branch: "carry", sha: sha.repeat(40), patch }], text: { title, body: "" } } }, { "x-reviewer-key": REVIEWER }).then((r) => r.json);
    const a = await pr("1", P("e"));
    expect((await verdict(a.id, { digest: a.digest, decision: "approve" })).json).toMatchObject({ state: "approved" });
    const b = await pr("2", P("e")); // rebased: new commit, same patch
    expect(b).toMatchObject({ state: "pending", decidedBy: null });
    expect(b.id).not.toBe(a.id);
    const c = await pr("3", P("e"), "another title"); // the same patch, but the PR text changed: a new request
    expect(c.state).toBe("pending");
    const d = await pr("4", P("f"));
    expect(d.state).toBe("pending");
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
