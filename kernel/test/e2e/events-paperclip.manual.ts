#!/usr/bin/env node
// V3 (manual, outside `npm test`): the event router (kernel/src/events.ts) against the pinned Paperclip image. Run once by hand
// before a PR that changes event delivery, never on a live host:
//   node kernel/test/e2e/events-paperclip.manual.ts
// It starts a throwaway Paperclip container (the image pinned in compose.yaml, its own temp volume, local_trusted on loopback),
// runs itself again inside a node:24 container that shares the Paperclip container's network, and removes both and the volume
// at the end. Needs Docker and the two pinned images (pulled if missing).
// It proves: a Slack-shaped burst becomes one run carrying its variables; the same batch key fired twice is still one run and
// one issue; the run's job reads its batch, bound to its task, agent and routine; and the refusals of the plan's Review Focus 3
// (another module's events, a paused routine, a revoked grant, a batch read by another task or agent, an oversize text).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The runner image, pinned (node 24, by digest).
const NODE = "node:24@sha256:9d266751ca3d7fdbe651c878ffd5ad0a42fed49a18c283509267c97f025b7496";
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

if (!process.env.V3_INSIDE) {
  const image = /image: (ghcr\.io\/paperclipai\/paperclip:\S+)/.exec(readFileSync(join(repo, "compose.yaml"), "utf8"))?.[1];
  if (!image) throw new Error("no Paperclip image in compose.yaml");
  const tag = `v3-${process.pid}`;
  const docker = (...a: string[]) => execFileSync("docker", a, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
  console.log(`V3: Paperclip ${image}`);
  try {
    docker("volume", "create", tag);
    docker("run", "-d", "--name", tag, "-v", `${tag}:/paperclip`, "-e", "HOST=127.0.0.1", "-e", "PORT=3100", "-e", "PAPERCLIP_HOME=/paperclip",
      "-e", "PAPERCLIP_DEPLOYMENT_MODE=local_trusted", "-e", "PAPERCLIP_DEPLOYMENT_EXPOSURE=private", "-e", "PAPERCLIP_PUBLIC_URL=http://127.0.0.1:3100",
      "-e", `BETTER_AUTH_SECRET=${tag}-secret-${Date.now()}`, "-e", `PAPERCLIP_AGENT_JWT_SECRET=${tag}-jwt-${Date.now()}`, image, "node", "server/dist-runtime/index.mjs");
    execFileSync("docker", ["run", "--rm", "--network", `container:${tag}`, "-v", `${repo}:/repo:ro`, "-w", "/repo", "-e", "V3_INSIDE=1", NODE,
      "node", "--disable-warning=ExperimentalWarning", "kernel/test/e2e/events-paperclip.manual.ts"], { stdio: "inherit" });
    console.log("V3: PASS");
  } catch (e) {
    try { console.log(docker("logs", "--tail", "40", tag)); } catch { /* gone */ }
    console.error(`V3: FAIL: ${(e as Error).message.split("\n")[0]}`);
    process.exitCode = 1;
  } finally {
    try { docker("rm", "-f", tag); } catch { /* not started */ }
    try { docker("volume", "rm", tag); } catch { /* not created */ }
  }
} else {
  const { createEvents, routineRun, EventsError, TEXT_MAX, WINDOW_MS } = await import("../../src/events.ts");
  const B = "http://127.0.0.1:3100";
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`${B}${path}`, { method, headers: { "content-type": "application/json", origin: B }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await r.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: r.status, json };
  };
  const ok = async (method: string, path: string, body?: unknown) => {
    const r = await call(method, path, body);
    if (r.status >= 300) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(r.json).slice(0, 300)}`);
    return r.json;
  };
  const step = (s: string) => console.log(`  ok  ${s}`);

  for (let i = 0; ; i++) {
    const up = await fetch(`${B}/api/health`).then((r) => r.ok, () => false);
    if (up) break;
    if (i > 120) throw new Error("Paperclip didn't start in 2 minutes");
    await new Promise((r) => setTimeout(r, 1000));
  }
  const company = await ok("POST", "/api/companies", { name: "Acme Events" });
  const agent = await ok("POST", `/api/companies/${company.id}/agents`, { name: "Intake", role: "general", adapterType: "process", adapterConfig: { command: "true" }, runtimeConfig: { heartbeat: { enabled: false } } });
  const other = await ok("POST", `/api/companies/${company.id}/agents`, { name: "Other", role: "general", adapterType: "process", adapterConfig: { command: "true" }, runtimeConfig: { heartbeat: { enabled: false } } });
  // As Task 14 compiles an event routine: batch and count declared, always_enqueue.
  const routine = (title: string) => ok("POST", `/api/companies/${company.id}/routines`, {
    title, description: "New events: batch {{batch}} ({{count}}). Read them with routine_events(batch), then close this task.", assigneeAgentId: agent.id,
    concurrencyPolicy: "always_enqueue", variables: [{ name: "batch", type: "text", required: false }, { name: "count", type: "text", required: false }],
  });
  const triage = await routine("Slack triage"), paused = await routine("Slack watch (paused)");
  await ok("PATCH", `/api/routines/${paused.id}`, { status: "paused" });
  step(`Paperclip up; company, agents and two event routines made (one paused)`);

  let t = Date.now();
  const grants = {
    agents: { [agent.id]: { key: "inbox-agent", tools: { slack: ["slack_read_channel"] } }, [other.id]: { key: "other", tools: { slack: ["slack_read_channel"] } } } as Record<string, any>,
    routine_events: {
      [triage.id]: { key: "slack-triage", agent: agent.id, connection: "slack", resource: "*", filter: { kind: "message", bot: false } },
      [paused.id]: { key: "slack-watch", agent: agent.id, connection: "slack", resource: "C0ACME", filter: { kind: "message" } },
    } as Record<string, any>,
  };
  const events = createEvents({
    db: new DatabaseSync(":memory:"), grants: () => grants,
    connections: () => ({ slack: { module: "slack", events: { reads: ["slack_read_channel"] } } as any }),
    run: routineRun((path, body) => call("POST", path, body)),
    routine: async (id) => { const r = await call("GET", `/api/routines/${id}`); if (r.status === 404) return undefined; if (r.status >= 300) throw new Error(`routine ${r.status}`); return { status: r.json.status, assignee: r.json.assigneeAgentId }; },
    now: () => t, log: (m, f) => console.log(`      log: ${m} ${JSON.stringify(f ?? {})}`),
  });
  const refused = async (f: () => unknown) => { try { await f(); } catch (e) { if (e instanceof EventsError) return e.status; throw e; } return 200; };

  // A Slack-shaped burst: four messages, one bot post, one with oversize text; and another module posting for slack.
  const msg = (n: number, o: Record<string, unknown> = {}) => ({ connection: "slack", resource: "C0ACME", id: `C0ACME:1700000000.00010${n}`, kind: "message", author: "U0ACME1", text: `ping ${n}`, url: `https://acme.slack.com/archives/C0ACME/p170000000000010${n}`, ...o });
  assert.equal(await refused(() => events.ingest("github", msg(0))), 403);
  for (let n = 1; n <= 3; n++) events.ingest("slack", msg(n));
  events.ingest("slack", msg(4, { text: "x".repeat(TEXT_MAX + 500) }));
  events.ingest("slack", msg(5, { author: "B0BOT", bot: true }));
  assert.deepEqual(events.ingest("slack", msg(1)), { queued: 0 }, "a repeated source id is dropped");
  step("ingest: another module's event refused (403); a repeated id dropped");

  t += WINDOW_MS + 1000;
  await events.drain();
  const runs = await ok("GET", `/api/routines/${triage.id}/runs`);
  assert.equal(runs.length, 1, "one run for the burst");
  const run = runs[0];
  assert.equal(run.status, "issue_created");
  const batch = run.triggerPayload?.variables?.batch ?? run.triggerPayload?.batch;
  assert.ok(batch && run.idempotencyKey === batch, "the batch id is the run's key and variable");
  assert.equal(String(run.triggerPayload?.variables?.count ?? run.triggerPayload?.count), "4", "the bot post missed the filter");
  const issue = await ok("GET", `/api/issues/${run.linkedIssueId}`);
  assert.equal(issue.originKind, "routine_execution");
  assert.equal(issue.originId, triage.id);
  assert.match(String(issue.description), new RegExp(`batch ${batch} \\(4\\)`));
  step(`burst -> one run ${run.id} (variables batch=${batch.slice(0, 8)}…, count=4), issue ${issue.identifier} from the routine`);
  assert.equal((await ok("GET", `/api/routines/${paused.id}/runs`)).length, 0, "the paused routine's batch is dropped, never run");
  step("paused routine: its batch dropped, no run");

  const again = await routineRun((path, body) => call("POST", path, body))(triage.id, batch, { batch, count: "4" });
  assert.equal(again.issue, run.linkedIssueId, "the same key is the same run and issue");
  assert.equal((await ok("GET", `/api/routines/${triage.id}/runs`)).length, 1);
  step("same batch key fired again -> the same run and issue");

  const job = { task: run.linkedIssueId, agent: agent.id, routine: "slack-triage" };
  const read = await events.batch(job, batch);
  assert.ok("events" in read && read.count === 4 && read.events.length === 4);
  assert.equal(read.events.find((e) => e.id.endsWith("4"))!.text!.length, TEXT_MAX, "oversize text clipped");
  assert.ok(read.events.every((e) => !("connection" in e)));
  step("the run's job reads its batch: 4 events, oversize text clipped to 2000");
  assert.equal(await refused(() => events.batch({ ...job, task: "another-task" }, batch)), 403);
  assert.equal(await refused(() => events.batch({ ...job, agent: other.id }, batch)), 403);
  assert.equal(await refused(() => events.batch({ ...job, routine: "slack-watch" }, batch)), 403);
  step("batch read by another task, agent or routine -> 403");
  grants.agents[agent.id].tools.slack = [];
  assert.equal(await refused(() => events.batch(job, batch)), 403);
  grants.agents[agent.id].tools.slack = ["slack_read_channel"];
  await ok("PATCH", `/api/routines/${triage.id}`, { status: "paused" });
  assert.equal(await refused(() => events.batch(job, batch)), 403);
  step("revoked read grant, then a paused routine -> 403");
  // A grant revoked before the drain: the batch is dropped, Paperclip never sees it.
  await ok("PATCH", `/api/routines/${triage.id}`, { status: "active" });
  events.ingest("slack", msg(6));
  grants.agents[agent.id].tools.slack = [];
  t += WINDOW_MS + 1000;
  await events.drain();
  assert.equal((await ok("GET", `/api/routines/${triage.id}/runs`)).length, 1, "no run once the grant is gone");
  step("a batch whose read grant was revoked before the drain -> dropped, no run");
}
