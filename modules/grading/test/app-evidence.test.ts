// An app deliverable's evidence (WOR-882): an app ref the apps registry says is absent is not a deploy still to come, and a
// registry read that failed is unavailable evidence, never "this ref is not an app". A registered app with no healthy deploy
// keeps the deploy wait it always had.
import { test } from "node:test";
import assert from "node:assert/strict";
import { appsEvidence } from "../service/src/apps-evidence.ts";
import { appEvidence, presentNow } from "../service/src/grader/evidence.ts";

const APP = { name: "roadmap-keeper", sha: "", state: "running", healthy: false };
const HEALTHY = { name: "roadmap-keeper", sha: "a".repeat(40), state: "running", healthy: true, deployed_at: "2026-11-19T10:00:00Z", deploys: [] };

/** appsEvidence over a fake apps-mcp: `rows` a list, or a promise that rejects (a timeout or a 500). */
const evidenceOver = (rows) => appsEvidence(async (method, path) => {
  if (path !== "/internal/status") throw new Error(`unexpected ${method} ${path}`);
  if (rows instanceof Error) throw rows;
  return rows;
});

test("a successful read with no such row answers null; a failed read answers undefined", async () => {
  assert.equal(await evidenceOver([]).app("apps-mcp"), null, "no such app: a known absence");
  assert.equal(await evidenceOver([APP]).app("apps-mcp"), null, "the registry answered and has no apps-mcp");
  assert.deepEqual(await evidenceOver([APP]).app("roadmap-keeper"), APP, "the row itself");
  assert.equal(await evidenceOver(new Error("apps-mcp GET /internal/status → 500")).app("apps-mcp"), undefined, "a failed read is not an absence");
  assert.equal(await evidenceOver(new Error("The operation was aborted due to timeout")).app("roadmap-keeper"), undefined);
});

test("a ref the registry says is absent reports the not-an-app fact, as a missing deliverable, not a pending deploy", async () => {
  const ev = appEvidence(null, "apps-mcp");
  assert.equal(ev.missing, true, "a ref that can never exist is missing, not a deploy still to come");
  assert.match(ev.awaiting, /apps-mcp is not an app this instance runs/);
  assert.match(ev.awaiting, /cannot be satisfied as filed/);
  assert.doesNotMatch(ev.awaiting, /is not deployed yet/);

  // The escalation's other path (presentNow, the resubmit check) says the same and never reports the ref as present.
  const now = await presentNow({ kind: "app", ref: "apps-mcp" }, { app: async () => null });
  assert.equal(now.present, false);
  assert.match(now.facts.join("; "), /apps-mcp is not an app this instance runs/);
  assert.doesNotMatch(now.facts.join("; "), /is not deployed yet/);
});

test("a registry read that fails reports unavailable evidence on both paths, never the not-an-app fact", async () => {
  const ev = appEvidence(undefined, "apps-mcp");
  assert.equal(ev.missing, undefined, "unavailable evidence is not a missing deliverable");
  assert.match(ev.awaiting, /registry could not be read just now \(unavailable evidence\)/);
  assert.doesNotMatch(ev.awaiting, /is not an app/);
  assert.doesNotMatch(ev.awaiting, /is not deployed yet/);

  const now = await presentNow({ kind: "app", ref: "apps-mcp" }, { app: async () => undefined });
  assert.equal(now.present, false);
  assert.match(now.facts.join("; "), /could not be read just now/);
  assert.doesNotMatch(now.facts.join("; "), /is not an app/);
});

test("a registered app with no healthy deploy keeps today's wording", async () => {
  // No sha yet: not deployed, not "no such app".
  const undeployed = appEvidence({ name: "roadmap-keeper", sha: "" }, "roadmap-keeper");
  assert.equal(undeployed.awaiting, "roadmap-keeper is not deployed yet");
  assert.equal(undeployed.missing, undefined);

  // A deployed commit with no healthy deploy: the wait names the commit.
  const now = await presentNow({ kind: "app", ref: "roadmap-keeper" }, {
    app: async () => ({ ...HEALTHY, sha: "b".repeat(40) }),
    deployHistory: async () => [{ sha: "b".repeat(40), status: "failed", at: "2026-11-19T10:00:00Z", by: "agent" }],
  });
  assert.equal(now.present, false);
  assert.match(now.facts.join("; "), /has no healthy deploy/);
  assert.doesNotMatch(now.facts.join("; "), /is not an app/);

  // A healthy deploy is present.
  const healthy = await presentNow({ kind: "app", ref: "roadmap-keeper" }, {
    app: async () => HEALTHY,
    deployHistory: async () => [{ sha: HEALTHY.sha, status: "healthy", at: "2026-11-19T10:00:00Z", by: "agent" }],
  });
  assert.equal(healthy.present, true);
});

test("a registered but undeployed app is still a deploy wait when read through appsEvidence", async () => {
  const deps = { app: evidenceOver([APP]).app, deployHistory: async () => [] };
  const row = await deps.app("roadmap-keeper");
  assert.deepEqual(row, APP);
  assert.equal(appEvidence(row, "roadmap-keeper").awaiting, "roadmap-keeper is not deployed yet");
});

test("gather() surfaces the not-an-app ref as missing and a failed read as a plain wait, over the same deps", async () => {
  const { gather } = await import("../service/src/grader/grade.ts");
  const deps = (app) => ({
    approvals: async () => [],
    app,
    appOfRepo: async () => null,
    taskPrs: async () => [],
    comments: async () => [],
    attachments: async () => [],
    identifier: "WOR-1",
  });
  const gone = await gather({ kind: "app", ref: "apps-mcp" }, deps(async () => null), []);
  assert.equal(gone.missing, true);
  assert.match(gone.awaiting, /not an app this instance runs/);

  const down = await gather({ kind: "app", ref: "apps-mcp" }, deps(async () => undefined), []);
  assert.equal(down.missing, undefined, "a failed read is not a missing deliverable");
  assert.match(down.awaiting, /could not be read just now/);
  assert.doesNotMatch(down.awaiting, /is not an app/);
});
