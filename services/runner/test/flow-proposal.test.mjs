// End to end (see flow-harness.mjs): a rule proposal an agent filed straight to the Platform Engineer with task_create (a root task,
// no parent, no owner behind it) runs without the owner's go-ahead. The same text mid-description, or on another assignee, waits.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { flow } from "./flow-harness.mjs";

const grants = (assigneeKey) => ({ agents: { "roadmap-keeper": { key: "roadmap-keeper", tools: { paperclip_tasks: ["task_create"] } }, "engineer-claude": { key: assigneeKey } } });
const marker = "<!-- source:rule:roadmap-keeper:slug -->";
const part = (description) => ({ parentId: null, createdByUserId: null, createdByAgentId: "roadmap-keeper", description });
const body = "Filed by Roadmap Keeper (agent). This is an agent request, not the owner's words.\n\nChange the rule in acme/app.";

describe("flow-proposal", () => {
  const t = flow({ part: part(`${body}\n\n${marker}`), grants: grants("fleet-engineer") });
  it("runs unasked and takes its description as the request", async () => {
    await t.waitFor("the proposal's run", () => t.reviews().length > 0);
    assert.match(t.claudeRuns()[0].prompt, /Change the rule in acme\/app/);
  });
});

describe("flow-proposal, marker mid-description", () => {
  const t = flow({ part: part(`${body}\n${marker}\nand then some more text`), grants: grants("fleet-engineer") });
  it("waits for the owner", async () => {
    await t.waitFor("the greeting", () => t.partComments().some((c) => /What would you like me to do/.test(c)));
    assert.equal(t.claudeRuns().length, 0);
  });
});

describe("flow-proposal, another assignee", () => {
  const t = flow({ part: part(`${body}\n\n${marker}`), grants: grants("software-engineer") });
  it("waits for the owner", async () => {
    await t.waitFor("the greeting", () => t.partComments().some((c) => /What would you like me to do/.test(c)));
    assert.equal(t.claudeRuns().length, 0);
  });
});
