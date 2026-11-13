#!/usr/bin/env node
// Harness bake-off: for each case x agent, create an issue assigned to the agent, wait for a resting
// state, collect status/comments/runs/cost, and write <out>/results<tag>.{md,json}.
//   node scripts/dev/bakeoff/bakeoff.mjs --company <id> --agents <id1,id2> --cases <file.yaml> --out <dir> [--timeout-min 15]
// Board key is read like paperclip-setup.mjs: $AIDENHQ_SECRETS_DIR/paperclip_board_key (from .env).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const YAML = createRequire(join(repo, "scripts/package.json"))("yaml");
const { values: a } = parseArgs({ options: { company: { type: "string" }, agents: { type: "string" }, cases: { type: "string" }, out: { type: "string", default: "." }, "timeout-min": { type: "string", default: "15" }, tag: { type: "string", default: "" }, only: { type: "string" } } });
if (!a.company || !a.agents || !a.cases) {
  console.error("usage: node scripts/dev/bakeoff/bakeoff.mjs --company <id> --agents <id1,id2> --cases <file.yaml> [--timeout-min 15] [--tag <name>] [--only <case ids>]");
  process.exit(1);
}

const dotenv = {};
const envFile = process.env.AIDENHQ_ENV_FILE ?? join(repo, ".env");
if (existsSync(envFile)) for (const l of readFileSync(envFile, "utf8").split("\n")) { const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(l); if (m) dotenv[m[1]] = m[2].replace(/^["']|["']$/g, ""); }
const env = (k, d) => process.env[k] ?? dotenv[k] ?? d;
const secretsDir = env("AIDENHQ_SECRETS_DIR");
const keyFile = secretsDir && join(secretsDir, "paperclip_board_key");
if (!keyFile || !existsSync(keyFile)) { console.error("board key not found (AIDENHQ_SECRETS_DIR/paperclip_board_key); run paperclip-setup.mjs"); process.exit(1); }
const boardKey = readFileSync(keyFile, "utf8").trim();
const baseUrl = env("PAPERCLIP_URL", "http://localhost:3100");

async function api(method, path, body) {
  const res = await fetch(new URL(path, baseUrl), { method, headers: { accept: "application/json", authorization: `Bearer ${boardKey}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = (x) => (Array.isArray(x) ? x : x.items ?? x.comments ?? x.runs ?? []);
const REST = new Set(["done", "blocked", "cancelled", "in_review"]); // resting statuses (agent finished or gave up)

const cases = YAML.parse(readFileSync(resolve(a.cases), "utf8")).cases.filter((c) => !a.only || a.only.split(",").includes(c.id));
const agentIds = a.agents.split(",").map((s) => s.trim());
const timeoutMs = Number(a["timeout-min"]) * 60_000;
const agentNames = Object.fromEntries(list(await api("GET", `/api/companies/${a.company}/agents`)).map((x) => [x.id, x.name]));

// Unassigned (never woken) helper tasks for a case: the seeded task the agent reads, and untouched canaries.
const mkTask = (title, description) => api("POST", `/api/companies/${a.company}/issues`, { title, description, status: "todo" }); // titles carry the run tag: Paperclip returns the existing open issue for an identical title

const stamp = Date.now().toString(36); // keeps reruns from colliding on title or marker

async function runOne(c, agentId) {
  const run = `${(agentNames[agentId] ?? agentId).replace(/[^a-z0-9]+/gi, "-")}-${stamp}`;
  const seed = c.seed ? await mkTask(`${c.seed.title} [${run}]`, c.seed.description) : null;
  const canaries = await Promise.all(Array.from({ length: c.canaries ?? 0 }, (_, i) => mkTask(`Canary ${i + 1} [${run}]`, "Untouched open task.")));
  const fill = (t) => t.replace(/\{\{run\}\}/g, run).replace(/\{\{seed\}\}/g, seed?.identifier ?? "").replace(/\{\{canary(\d)\}\}/g, (_, n) => canaries[n - 1]?.identifier ?? "");
  const started = Date.now();
  const issue = await api("POST", `/api/companies/${a.company}/issues`, { title: `${fill(c.title)} [${run}]`, description: fill(c.description), status: "todo", assigneeAgentId: agentId });
  let cur = issue, timedOut = false;
  while (true) {
    await sleep(10_000);
    cur = await api("GET", `/api/issues/${issue.id}`);
    // Resting = terminal status, or back in todo/backlog/blocked-free idle after having run and no active run.
    const runs = list(await api("GET", `/api/issues/${issue.id}/runs`));
    const active = runs.some((r) => ["queued", "running"].includes(r.status));
    if (REST.has(cur.status) && !active) break;
    if (!active && runs.length > 0 && Date.now() - started > 60_000 && runs.every((r) => ["failed", "timed_out", "cancelled", "succeeded"].includes(r.status)) && cur.status !== "in_progress") break;
    if (Date.now() - started > timeoutMs) { timedOut = true; break; }
  }
  const wallSec = Math.round((Date.now() - started) / 1000);
  const runs = list(await api("GET", `/api/issues/${issue.id}/runs`));
  const comments = list(await api("GET", `/api/issues/${issue.id}/comments?order=asc&limit=50`));
  const cost = await api("GET", `/api/issues/${issue.id}/cost-summary`).catch((e) => ({ error: String(e) }));
  const status = async (t) => (t ? (await api("GET", `/api/issues/${t.id}`)).status : null);
  const seedStatus = await status(seed);
  const canaryStatus = await Promise.all(canaries.map(status));
  const seedComments = seed ? list(await api("GET", `/api/issues/${seed.id}/comments?order=asc&limit=50`)).map((x) => x.body ?? "") : [];
  const markerCount = c.marker ? list(await api("GET", `/api/companies/${a.company}/issues?q=${encodeURIComponent(fill(c.marker))}&status=backlog,todo,in_progress,in_review,blocked,done,cancelled&limit=50`)).filter((x) => x.id !== issue.id).length : null;
  const failed = runs.filter((r) => !["succeeded", "queued", "running"].includes(r.status));
  return {
    case: c.id, agentId, agent: agentNames[agentId] ?? agentId, issueId: issue.id, status: cur.status, timedOut, wallSec,
    runCount: runs.length, failedRuns: failed.map((r) => ({ id: r.id, status: r.status, errorCode: r.errorCode, error: String(r.error ?? "").slice(0, 300) })),
    costCents: cost.costCentsExact ?? cost.costCents ?? null, tokens: { in: cost.inputTokens, cached: cost.cachedInputTokens, out: cost.outputTokens },
    finalComments: comments.filter((x) => x.authorAgentId).slice(-2).map((x) => x.body ?? x.content ?? ""),
    seedStatus, canaryStatus, seedComments, markerCount, allComments: comments.map((x) => ({ by: x.authorAgentId ? "agent" : "user", body: x.body ?? "" })),
    runs, raw: { issue: cur, cost },
  };
}

const results = [];
// Agents run in parallel (independent adapters); cases run sequentially per agent so they don't compete.
await Promise.all(agentIds.map(async (id) => {
  for (const c of cases) {
    try { results.push(await runOne(c, id)); } catch (e) { results.push({ case: c.id, agentId: id, agent: agentNames[id] ?? id, error: String(e) }); }
    console.log(`done ${agentNames[id] ?? id} / ${c.id}`);
  }
}));

const md = ["# Harness bake-off results", "", `Generated ${new Date().toISOString()}. Success is judged by hand; fill the last column.`, "",
  "| Case | Agent | Status | Runs | Failed runs | Wall (s) | Cost (cents) | Final comment | Judged |", "|---|---|---|---|---|---|---|---|---|"];
const cell = (s) => String(s ?? "").replace(/\s+/g, " ").replace(/\|/g, "\\|").slice(0, 160);
for (const r of results.sort((x, y) => x.case.localeCompare(y.case) || x.agent.localeCompare(y.agent))) {
  md.push(r.error ? `| ${r.case} | ${r.agent} | ERROR: ${cell(r.error)} | | | | | | |`
    : `| ${r.case} | ${r.agent} | ${r.status}${r.timedOut ? " (timeout)" : ""} | ${r.runCount} | ${r.failedRuns.length ? cell(r.failedRuns.map((f) => f.errorCode ?? f.status).join(",")) : 0} | ${r.wallSec} | ${r.costCents ?? "n/a"} | ${cell(r.finalComments.at(-1))} | |`);
}
writeFileSync(join(resolve(a.out), `results${a.tag}.md`), md.join("\n") + "\n");
writeFileSync(join(resolve(a.out), `results${a.tag}.json`), JSON.stringify(results, null, 2));
console.log("wrote results*.{md,json} in", resolve(a.out));
