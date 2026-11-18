// End to end (see flow-harness.mjs): one runner, one conversation on the task, several things the owner does in it.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { flow, git } from "./flow-harness.mjs";

describe("flow-conversation", () => {
  const t = flow();

  // End to end (see flow-harness.mjs): the first run, from the user's own words on assignment (PEN-2713/PEN-2714's shape:
  // the user's task lists the repositories, Ada's part of it says "go ahead"), its reply, and the "pr" shortcut.
  describe("starting an Engineer on a task, end to end", () => {
    const { waitFor, reviews, starts, partComments, agentRuns, fakeLog, context, say } = t;

    it("starts from the user's own words on assignment, in every repository their task lists, without asking", async () => {
      await waitFor("the first reply", () => reviews().length > 0);
      const started = t.output.split("\n").filter((l) => l.includes('"job started"')).map((l) => JSON.parse(l));
      assert.deepEqual([...started[0].repos].sort(), ["acme/app", "acme/infra"]);
      assert.equal(started[0].engine, "codex-openrouter");
      assert.ok(!partComments().some((c) => /which repositor|Runner error|Failed/i.test(c)), `no questions or errors${context()}`);
      const { prompt, argv } = agentRuns()[0];
      assert.match(prompt, /acme\/app[\s\S]*acme\/infra|acme\/infra[\s\S]*acme\/app/);
      assert.match(prompt, /The task this is part of[\s\S]*Drop Legacy support/);
      assert.match(prompt, /<<<PARENT_CONVERSATION\n### Alfred · [^\n]*\n\n## Legacy usage — preliminary\n\nLegacy is still read by the infra alerts\./, "Alfred's report on the user's task");
      assert.match(prompt, /`aidenhq task PEN-N` prints one in full/);
      assert.match(prompt, /## Instructions from Dana \(authoritative\)[\s\S]*Ada, go ahead and start this on dev please/);
      assert.match(prompt, /The engineering agents, by name: Ada \(codex-openrouter\), Grace \(codex-openrouter\)/);
      assert.doesNotMatch(prompt, /Mode: \*\*|## Summary/, "no modes, no report template");
      // The job ran in its computer: Codex on the box's own key, in /workspace, never on the host.
      assert.ok(argv.includes('sandbox_mode="danger-full-access"') && argv.join(" ").includes('env_key="AIDENHQ_RUN_TOKEN"'), argv.join(" "));
      assert.match(prompt, /\/workspace\/app/);
      assert.equal(t.launcher.calls.filter((c) => c.route === "/job").length, 1);
    });

    it("posts the agent's reply as its own, with no start notes around it", () => {
      const reply = reviews()[0].comment;
      assert.match(reply, /^<!-- aidenhq-reply -->Checked every repository/);
      assert.match(reply, /fix\/remove-legacy/, "the branch it committed, in the footer");
      assert.ok(starts().length && !starts()[0].comment, "the board shows the work; no \"On it\" comment");
    });

    it("keeps the exact word pr as a shortcut, shown on the board while it publishes", async () => {
      const reported = t.paperclip.activity.length;
      const n = partComments().length;
      say("pr");
      await waitFor("the results", () => partComments().slice(n).some((c) => c.includes("| Branch | Result |")));
      const publishing = () => t.paperclip.activity.slice(reported).find((a) => a.running.some((r) => r.identifier === "PEN-2"));
      await waitFor("the board's view of it", () => publishing() && t.paperclip.activity.at(-1).running.length === 0);
      assert.equal(publishing().running.find((r) => r.identifier === "PEN-2").mode, "opening PRs");
      assert.ok(git(t.dir, "--git-dir", join(t.dir, "github/acme/app.git"), "branch", "--list", "fix/remove-legacy"), "pushed");
      assert.equal(agentRuns().length, 1, "no agent turn for the shortcut");
    });

    it("never errors or asks for a repository along the way", () => t.noErrors());
  });

  // End to end (see flow-harness.mjs): what an agent can read of other tasks and chats, and a comment that needs no answer.
  describe("reading around the task, end to end", () => {
    const { partComments, agentRuns, toolRuns, step, turn, settled } = t;

    it("reads another task's whole conversation, and finds tasks by agent or words", async () => {
      await settled();
      step("none\naidenhq task pen-1\naidenhq tasks --agent Ada\naidenhq tasks legacy\naidenhq tasks --agent Nobody");
      await turn("Take over Alfred's report.");
      const [task, byAgent, byWords, nobody] = toolRuns().slice(-4);
      assert.equal(task.code, 0, task.out);
      assert.match(task.out, /^PEN-1: Drop Legacy support\nStatus: todo · with Dana[^\n]*\nParts: PEN-2 \(Ada, in_progress\)/);
      assert.match(task.out, /<<<TASK\nDescription:\n\nRemove Legacy from these repos[\s\S]*### Alfred · [^\n]*\n\n## Legacy usage — preliminary[\s\S]*TASK>>>/);
      assert.match(byAgent.out, /^PEN-2 · in_progress · with Ada · /);
      assert.match(byWords.out, /PEN-1 · todo · with Dana/);
      assert.equal(nobody.code, 1);
      assert.match(nobody.out, /No agent is called Nobody: Ada, Grace, Alfred/);
    });

    it("reads Alfred's chat when the user wrote to Ada from there", async () => {
      step("none");
      await turn("@Ada put this into the release notes too\n\n_Written in Alfred's chat on PEN-3._\n\n<!-- aidenhq-from:PEN-3 -->");
      const { prompt } = agentRuns().at(-1);
      assert.match(prompt, /## Alfred's chat, where Dana wrote to you from[\s\S]*<<<SOURCE_CHAT\n[\s\S]*Draft: Legacy support is removed from the app and the alerts\.[\s\S]*SOURCE_CHAT>>>/);
      assert.match(prompt, /@Ada put this into the release notes too/);
    });

    it("says nothing to a comment that needs no answer", async () => {
      step("silent");
      const n = partComments().length;
      const done = await turn("Thanks!");
      assert.equal(done.comment, undefined);
      assert.equal(partComments().length, n + 1, "only the user's comment");
    });

    it("never errors or asks for a repository along the way", () => t.noErrors());
  });

  // End to end (see flow-harness.mjs): --help, files the agent made, and a message passed on to Alfred.
  describe("sharing and passing on, end to end", () => {
    const { agentRuns, toolRuns, step, turn, settled } = t;

    it("answers --help itself, shares what it made on the task, and passes a message on to Alfred", async () => {
      await settled();
      step("report\naidenhq primer --help\naidenhq pass Alfred");
      const done = await turn("Alfred should publish this once it's written up.");
      const [help, pass] = toolRuns().slice(-2);
      assert.equal(help.code, 0);
      assert.match(help.out, /^usage: aidenhq status/);
      assert.ok(!t.output.includes('"action":"primer"'), "asking for help isn't a publish request");
      assert.equal(pass.code, 0, pass.out);
      assert.match(pass.out, /Passed on to Alfred \(PEN-3\)/);
      const asked = t.paperclip.comments.get("part").findLast((c) => c.body === "Alfred should publish this once it's written up.");
      assert.deepEqual(t.paperclip.passed.at(-1), { path: "/internal/issues/PEN-2/pass", comment: asked.id, to: "Alfred", by: "Ada" });
      assert.deepEqual(t.paperclip.attached.map((a) => a.name), ["Wallet copy, mapped to the app.md", "move-page.png"]);
      assert.ok(t.paperclip.attached.every((a) => a.issue === "part"));
      assert.match(done.comment, /_Attached to the task: `Wallet copy, mapped to the app.md`, `move-page.png`\._/);
      // Unchanged next time: not attached again, and never copied back in as the user's files.
      step("report");
      await turn("Anything else?");
      assert.equal(t.paperclip.attached.length, 2);
      assert.doesNotMatch(agentRuns().at(-1).prompt, /## Files from Dana/);
    });

    it("never errors or asks for a repository along the way", () => t.noErrors());
  });

  it("never errors or asks for a repository along the way", () => t.noErrors());
});
