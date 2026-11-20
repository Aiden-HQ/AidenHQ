// The one-time holder fix (fix-task-holders.ts): who each open task with no agent goes to.
import { test } from "node:test";
import assert from "node:assert/strict";
import { holderPlan } from "../fix-task-holders.ts";

test("unheld tasks go to their creator (a person's to the owner), setup's log tasks to the next apply, Security Watch's owner tasks to the fleet-audit agent", () => {
  const agents = [{ id: "a-sw", key: "security-watch", roles: [] }, { id: "a-fs", key: "fleet-steward", roles: ["fleet-audit"] }, { id: "a-cos", key: "chief-of-staff", roles: [] }];
  const t = (identifier, f) => ({ id: identifier, identifier, title: identifier, status: "todo", assigneeAgentId: null, assigneeUserId: null, createdByAgentId: null, ...f });
  const plan = holderPlan([
    t("WOR-1", { assigneeUserId: "owner", createdByAgentId: "a-cos", title: "Chasing: the vendor" }), // the owner's to-do: stays
    t("WOR-2", { assigneeUserId: "owner", createdByAgentId: "a-sw" }), // a Security Watch fix task
    t("WOR-3", { createdByAgentId: "a-cos" }), // an agent's follow-up nobody holds
    t("WOR-4", { status: "backlog", description: "Facts…\n\n<!-- source:memory-inbox:chief-of-staff -->" }),
    t("WOR-5", { title: "Fleet issues" }),
    t("WOR-6", { createdByAgentId: "a-gone" }),
    t("WOR-7", {}),
    t("WOR-8", { assigneeAgentId: "a-cos" }),
  ], agents, "u-owner");
  assert.deepEqual(plan.moves.map((m) => [m.task.identifier, m.to.key]), [["WOR-2", "fleet-steward"], ["WOR-3", "chief-of-staff"], ["WOR-7", "the owner"]]);
  assert.deepEqual(plan.setup.map((s) => [s.task.identifier, s.why]), [["WOR-4", "memory-inbox: the next apply hands it to chief-of-staff"], ["WOR-5", "Fleet issues: the next apply hands it to fleet-steward"]]);
  assert.deepEqual(plan.undecided.map((u) => u.task.identifier), ["WOR-6"]);
});
