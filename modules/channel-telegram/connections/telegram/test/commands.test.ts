import { describe, expect, it } from "bun:test";
import { quickCommand } from "../src/commands.js";

describe("quick commands", () => {
  const api = async (_m: string, path: string): Promise<any> => {
    if (path.includes("/agents")) return [{ name: "Aiden", status: "running" }, { name: "Grace", status: "idle", lifecycleHolds: ["manual"] }, { name: "Devops", status: "paused" }, { name: "Ada", status: "error" }];
    if (path.includes("/issues")) return [{ identifier: "WOR-8812", title: "Reply to <Sam>" }, { identifier: "WOR-8859", title: "Move brief to 08:45" }];
    return [];
  };
  const owner = [{ who: "owner" }];
  const state = async () => ({
    tasks: [
      { identifier: "WOR-8812", kind: "waiting", since: "2026-11-20T10:00:00Z", attention: owner },
      { identifier: "WOR-8859", kind: "idle", since: "2026-11-20T08:00:00Z", attention: owner },
      { identifier: "WOR-1", kind: "working", since: "2026-11-20T09:00:00Z", attention: [] },
    ],
    counts: { needs_you: 2, failed: 1, unexplained_idle: 0 },
  });

  it("/status counts agents, names agents in error and counts tasks from the kernel", async () => {
    const r = await quickCommand("/status", api, "co", state);
    expect(r?.text).toMatch(/1 running, 0 idle, 1 paused/);
    expect(r?.text).toMatch(/Ada/);
    expect(r?.text).toMatch(/3 open: 1 working, 1 waiting, 1 idle \(failed 1, unexplained 0\), needs you 2/);
  });
});
