// Which tasks an agent filed straight to the Platform Engineer run without the owner's go-ahead (isRuleProposal decides; the
// runner's handleIssue only acts on its answer, as it does for runsUnasked). Three checks, none typeable in free text: the
// marker is the tool's own last line, the assignee is the Platform Engineer, the creator's grants let it file tasks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isRuleProposal } from "../src/agents.mjs";

const grants = (assigneeKey) => ({ agents: { "roadmap-keeper": { key: "roadmap-keeper", tools: { paperclip_tasks: ["task_create"] } }, "engineer-claude": { key: assigneeKey } } });
const body = "Filed by Roadmap Keeper (agent). This is an agent request, not the owner's words.\n\nChange the rule in acme/app.";
const task = (description) => ({ parentId: null, createdByUserId: null, createdByAgentId: "roadmap-keeper", assigneeAgentId: "engineer-claude", description });

test("a rule proposal, or a product bug, an agent filed to the Platform Engineer runs unasked; the same text anywhere else waits", () => {
  const rule = "<!-- source:rule:roadmap-keeper:slug -->";
  assert.equal(isRuleProposal(task(`${body}\n\n${rule}`), grants("fleet-engineer")), true, "the marker is the last line");
  assert.equal(isRuleProposal(task(`${body}\n\n<!-- source:product-bug:flaky-runner-db -->`), grants("fleet-engineer")), true, "a product-bug marker runs the same way");
  assert.equal(isRuleProposal(task(`${body}\n${rule}\nand then some more text`), grants("fleet-engineer")), false, "mid-description: waits for the owner");
  assert.equal(isRuleProposal(task(`${body}\n\n${rule}`), grants("software-engineer")), false, "another assignee: waits for the owner");
  assert.equal(isRuleProposal({ ...task(`${body}\n\n${rule}`), createdByUserId: "user-1" }, grants("fleet-engineer")), false, "a user's own task is never one");
  assert.equal(isRuleProposal(task(`${body}\n\n${rule}`), undefined), false, "no grants table: fails closed");
});
