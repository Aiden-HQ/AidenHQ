#!/usr/bin/env node
// One-time fix (2026-11-20): every open task has a holder, an agent or the owner (kernel cp.ts leavesNoHolder). Before that
// rule, agents and setup left open tasks with no assignee, and Security Watch's fix tasks landed on the owner (issue #815).
//   node scripts/fix-task-holders.ts            prints what it would do (nothing changes)
//   node scripts/fix-task-holders.ts --apply    does it, and prints what it did
// What it decides, per open task (backlog, todo, in_progress, in_review, blocked):
// - Held by the owner: stays, except Security Watch's fix tasks (created by the agent keyed security-watch), which go to the
//   fleet-audit agent that routes fixes.
// - Held by nobody: setup's log tasks (review log, chat task, Fleet issues) are left to the next apply, whose setup
//   hands each to its agent; any other goes to the agent that created it while that agent is live, or to the owner when a person
//   made it (the board's settings changes, the install cap's card); one whose creating agent is gone is listed, undecided.
// A todo or in_progress task handed to an agent starts a job of that agent (its `assigned` wake); the count is printed.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { paperclipClient } from "../kernel/sdk/src/paperclip.ts";

interface Task { id: string; identifier?: string; title?: string; status: string; description?: string; assigneeAgentId?: string | null; assigneeUserId?: string | null; createdByAgentId?: string | null }
interface Agent { id: string; key: string; roles?: string[]; owner?: boolean }

const LOG_MARKER = /<!-- source:(review-log|chat-task):([\w-]+) -->/;

/**
 * The plan for a company's open tasks. `agents`: its live agents ({id, key, roles}); `owner`: its owner's user id. Returns
 * `moves` ({task, to: an agent, or {owner: true}}, why), `setup` (log tasks the next apply hands to their agents) and `undecided`.
 */
export function holderPlan(tasks: Task[], agents: Agent[], owner: string) {
  const byId = new Map(agents.map((a): [string, Agent] => [a.id, a]));
  const byKey = new Map(agents.map((a): [string, Agent] => [a.key, a]));
  const auditor = agents.find((a) => a.roles?.includes("fleet-audit"));
  const name = (t: Task) => t.identifier ?? t.id;
  const moves: { task: Task; to: Agent; why: string }[] = [], setup: { task: Task; why: string }[] = [], undecided: { task: Task; why: string }[] = [];
  for (const t of tasks) {
    if (t.assigneeAgentId) continue;
    if (t.assigneeUserId) {
      if (byId.get(t.createdByAgentId ?? "")?.key !== "security-watch") continue;
      if (auditor) moves.push({ task: t, to: auditor, why: "a Security Watch fix task, routed by the fleet-audit agent" });
      else undecided.push({ task: t, why: "a Security Watch fix task, and no fleet-audit agent to route it" });
      continue;
    }
    const log = LOG_MARKER.exec(t.description ?? "");
    if ((log && !t.createdByAgentId) || (t.title === "Fleet issues" && !t.createdByAgentId)) {
      const holder = log ? byKey.get(log[2]!) : auditor;
      setup.push({ task: t, why: `${log ? log[1]! : "Fleet issues"}: the next apply hands it to ${holder?.key ?? "its agent"}` });
      continue;
    }
    const creator = byId.get(t.createdByAgentId ?? "");
    if (creator) moves.push({ task: t, to: creator, why: "the agent that created it" });
    else if (!t.createdByAgentId && owner) moves.push({ task: t, to: { owner: true, key: "the owner", id: owner }, why: "a person made it" });
    else undecided.push({ task: t, why: `its creator is gone (${name(t)}): give it a holder by hand, or close it` });
  }
  return { moves, setup, undecided };
}

async function main() {
  const apply = process.argv.includes("--apply");
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const envPath = process.env.AIDENHQ_ENV_FILE ?? join(repo, ".env");
  const dotenv = existsSync(envPath)
    ? Object.fromEntries(readFileSync(envPath, "utf8").split("\n").map((l) => /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(l)).filter(Boolean).map((m): [string, string] => [m![1]!, m![2]!.replace(/^["']|["']$/g, "")]))
    : {};
  const env = (k: string, d: string) => process.env[k] ?? dotenv[k] ?? d;
  const expand = (p: string) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);
  const base = env("PAPERCLIP_URL", "http://127.0.0.1:3100");
  const key = readFileSync(join(expand(env("AIDENHQ_SECRETS_DIR", "~/.config/aidenhq")), "paperclip_board_key"), "utf8").trim();
  const grants = JSON.parse(readFileSync(join(resolve(repo, env("AIDENHQ_CONFIG_DIR", "config")), "grants", "grants.json"), "utf8")).agents ?? {};
  const paperclip = paperclipClient({ url: base, token: key, lane: "direct" });
  const api = (method: string, path: string, body?: unknown) => paperclip.request(method, path, body);
  let starts = 0;
  for (const company of await api("GET", "/api/companies")) {
    const live = (await api("GET", `/api/companies/${company.id}/agents`)).filter((a: { id: string; status: string }) => a.status !== "terminated" && grants[a.id]);
    const agents = live.map((a: { id: string }) => ({ id: a.id, key: grants[a.id].key, roles: grants[a.id].roles ?? [] }));
    const tasks = await api("GET", `/api/companies/${company.id}/issues?status=backlog,todo,in_progress,in_review,blocked&limit=500`);
    if (tasks.length >= 500) console.warn(`  ! ${company.name ?? company.id} has 500 or more open tasks: run this again after --apply for the rest`);
    const { defaultResponsibleUserId: owner } = await api("GET", `/api/companies/${company.id}`);
    const { moves, setup, undecided } = holderPlan(tasks, agents, owner);
    console.log(`${company.name ?? company.id}: ${moves.length} to move, ${setup.length} for the next apply, ${undecided.length} undecided`);
    for (const m of moves) {
      console.log(`  ${apply ? "moved" : "would move"} ${m.task.identifier} "${m.task.title}" (${m.task.status}) → ${m.to.key}: ${m.why}`);
      if (!m.to.owner && ["todo", "in_progress"].includes(m.task.status)) starts++;
      if (apply) await api("PATCH", `/api/issues/${m.task.id}`, m.to.owner ? { assigneeUserId: m.to.id } : { assigneeAgentId: m.to.id, assigneeUserId: null });
    }
    for (const s of setup) console.log(`  left ${s.task.identifier} "${s.task.title}": ${s.why}`);
    for (const u of undecided) console.log(`  undecided ${u.task.identifier} "${u.task.title}" (${u.task.status}): ${u.why}`);
  }
  console.log(`${apply ? "Started" : "Would start"} up to ${starts} job${starts === 1 ? "" : "s"} (todo or in_progress tasks handed to an agent).`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
