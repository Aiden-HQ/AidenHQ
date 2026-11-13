import { describe, expect, it } from "vitest";
import { agentsView, roster, workingOn, type RunContext } from "../src/activity.js";
import type { Agent, LiveRun, PastRun, Routine } from "../src/paperclip.js";

const NOW = Date.parse("2026-10-12T15:00:00Z");
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const agents = [{ id: "a-assistant", name: "Assistant" }, { id: "a-slack", name: "Slack Scout" }] as Agent[];


describe("agentsView", () => {
  const contexts: Record<string, RunContext> = {
    "i-replies": { run: { identifier: "PEN-873", title: "Process task replies" }, tasks: [{ identifier: "PEN-864", title: "Check RPC states" }] },
    "i-scan": { run: { identifier: "PEN-871", title: "Slack scan" }, tasks: [] },
  };
  const resolve = async (id: string | null) => (id && contexts[id]) || { run: null, tasks: [] };
  const live = [
    { id: "r1", status: "running", agentId: "a-assistant", issueId: "i-replies", startedAt: ago(3), createdAt: ago(3), currentStatusMessage: "Receiving agent output", outputSilence: { level: "ok" } },
    { id: "r2", status: "running", agentId: "a-slack", issueId: "i-scan", startedAt: ago(1), createdAt: ago(1), outputSilence: { level: "suspicious" } },
  ] as LiveRun[];
  const past = [
    { id: "p1", status: "succeeded", agentId: "a-assistant", issueId: "i-replies", startedAt: ago(30), finishedAt: ago(28), error: null },
    { id: "p2", status: "failed", agentId: "a-slack", issueId: "i-scan", startedAt: ago(60 * 20), finishedAt: ago(60 * 19), error: null },
    { id: "r1", status: "running", agentId: "a-assistant", issueId: "i-replies", startedAt: ago(3), finishedAt: null, error: null },
  ] as PastRun[];
  const runner = {
    at: ago(1),
    running: [{ issueId: "11111111-1111-1111-1111-111111111111", identifier: "PEN-900", engine: "Codex (gpt-5.5)", mode: "implement", repo: "org/repo", startedAt: ago(10) }],
    queued: [{ issueId: "22222222-2222-2222-2222-222222222222", identifier: "PEN-901" }],
    recent: [{ issueId: "33333333-3333-3333-3333-333333333333", identifier: "PEN-899", engine: "Claude Code", status: "done", startedAt: ago(50), finishedAt: ago(40) }],
  };

  it("lists Paperclip runs and runner jobs with their tasks, and what finished in the last 12 hours", async () => {
    const view = await agentsView({ live, past, runner, agents, resolve, now: NOW });
    expect(view.sessions.map((s) => [s.agent, s.state, s.tasks.map((t) => t.identifier)])).toEqual([
      ["Assistant", "working", ["PEN-864"]],
      ["Slack Scout", "working", []],
      ["Engineer · Codex (gpt-5.5)", "working", ["PEN-900"]],
      ["Engineer", "queued", ["PEN-901"]],
    ]);
    expect(view.sessions[1]!.quiet).toBe(true);
    expect(view.sessions[2]!.doing).toBe("Implement in org/repo");
    expect(view.finished.map((f) => [f.agent, f.status])).toEqual([
      ["Assistant", "succeeded"],
      ["Engineer · Claude Code", "done"],
    ]);
    expect(view.runner).toEqual({ reportedAt: runner.at, stale: false });
  });

  it("drops a silent runner's jobs from the live list and says so", async () => {
    const view = await agentsView({ live: [], past: [], runner: { ...runner, at: ago(10) }, agents, resolve, now: NOW });
    expect(view.sessions).toEqual([]);
    expect(view.runner.stale).toBe(true);
    expect(view.finished).toHaveLength(1);
  });

  it("marks the tasks being worked on, preferring a running agent over a queue", async () => {
    const view = await agentsView({ live, past: [], runner: { ...runner, queued: [{ issueId: runner.running[0]!.issueId, identifier: "PEN-864" }] }, agents, resolve, now: NOW });
    const map = workingOn(view.sessions);
    expect(map.get("PEN-864")).toEqual({ agent: "Assistant", since: ago(3), queued: false });
    expect(map.get("PEN-900")?.queued).toBe(false);
    expect(map.has("PEN-871")).toBe(false);
  });

});

describe("who is behind a session", () => {
  const crew = [
    ...agents,
    { id: "e-codex", name: "Engineer · Codex", status: "idle", adapterType: "codex_local", metadata: { setupKey: "aidenhq:engineer" } },
    { id: "e-claude", name: "Engineer · Claude", status: "idle", adapterType: "claude_local", metadata: { setupKey: "aidenhq:engineer-claude" } },
  ] as Agent[];
  const runner = {
    at: ago(1),
    running: [{ issueId: "11111111-1111-1111-1111-111111111111", identifier: "PEN-900", engine: "Codex (gpt-5.5, high effort)", startedAt: ago(10) }],
    queued: [{ issueId: "22222222-2222-2222-2222-222222222222", identifier: "PEN-901" }],
    recent: [
      { issueId: "33333333-3333-3333-3333-333333333333", identifier: "PEN-899", engine: "Claude Code (opus)", status: "done", startedAt: ago(50), finishedAt: ago(40) },
      { issueId: "44444444-4444-4444-4444-444444444444", identifier: "PEN-898", engine: "OpenRouter deepseek/x", status: "done", startedAt: ago(50), finishedAt: ago(45) },
    ],
  };
  it("maps runner jobs onto their Engineer, a queued one by its task's assignee", async () => {
    const resolve = async (id: string | null) => ({ run: null, tasks: [], assigneeAgentId: id === "22222222-2222-2222-2222-222222222222" ? "e-claude" : null });
    const live = [{ id: "r1", status: "running", agentId: "a-assistant", issueId: null, startedAt: ago(3), createdAt: ago(3) }] as LiveRun[];
    const view = await agentsView({ live, past: [], runner, agents: crew, resolve, now: NOW });
    expect(view.sessions.map((s) => [s.agent, s.agentId])).toEqual([
      ["Assistant", "a-assistant"],
      ["Engineer · Codex (gpt-5.5, high effort)", "e-codex"],
      ["Engineer · Claude", "e-claude"],
    ]);
    // No OpenRouter Engineer here: the job keeps its name, without an agent.
    expect(view.finished.map((f) => f.agentId)).toEqual(["e-claude", null]);
    expect(view.sessions[0]).not.toHaveProperty("assigneeAgentId");
  });
});


describe("roster", () => {
  it("groups live agents by what setup wrote, with model, schedules and newest run; terminated agents never show", () => {
    const fleet = [
      { id: "cos", name: "Aiden", title: "Your chief of staff", status: "idle", adapterType: "codex_local", adapterConfig: { model: "~deepseek/deepseek-flash-latest" }, metadata: { module: "core" } },
      { id: "eng", name: "Engineer", status: "idle", adapterType: "claude_local", adapterConfig: {}, metadata: { module: "engineering", runnerEngine: true } },
      { id: "scout", name: "Slack Scout", status: "paused", adapterType: "codex_local", metadata: { module: "slack" } },
      { id: "keeper", name: "Roadmap Keeper", status: "idle", adapterType: "codex_local", metadata: { module: "instance", trial: true } },
      { id: "ui", name: "UI Designer", status: "idle", adapterType: "codex_local", metadata: { setupKey: "aidenhq:ui-designer", module: "design", department: { id: "engineering", name: "Engineering", order: 3 }, avatar: "ui-designer" } },
      { id: "old", name: "Old Scout", status: "terminated", adapterType: "codex_local", metadata: { module: "slack" } },
    ] as Agent[];
    const routines = [
      { id: "r1", title: "Prepare daily brief", status: "active", assigneeAgentId: "cos", triggers: [{ kind: "schedule", enabled: true, nextRunAt: "2026-10-13T04:45:00Z" }] },
      { id: "r2", title: "App incident", status: "active", assigneeAgentId: "cos", triggers: [{ kind: "webhook", enabled: true }] },
    ] as Routine[];
    const out = roster(fleet, routines, new Map([["cos", { at: ago(5), status: "succeeded" }]]));
    expect(out.map((a) => [a.name, a.system, a.department.id])).toEqual([["Aiden", true, "general"], ["Engineer", true, "general"], ["Slack Scout", true, "general"], ["Roadmap Keeper", false, "general"], ["UI Designer", true, "engineering"]]);
    expect(out[4]).toMatchObject({ key: "ui-designer", avatar: "ui-designer" });
    expect(out[0]).toMatchObject({ title: "Your chief of staff", model: "deepseek-flash-latest", schedules: [{ title: "Prepare daily brief", paused: false, nextRunAt: "2026-10-13T04:45:00Z" }], lastRunAt: ago(5), lastRunStatus: "succeeded" });
    expect(out[1]!.model).toBe("Claude Code");
    expect(out[3]!.trial).toBe(true);
  });
});
