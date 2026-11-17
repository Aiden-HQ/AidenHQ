// End to end (see flow-harness.mjs): a task whose fix already merged and whose grader still names a criterion. Its follow-up
// reads the whole request with the merged half named as already on the base, so it is not rejected for work it cannot carry; a
// follow-up that really leaves an unmerged criterion undone is still rejected, and a note the runner did not write adds nothing.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { flow, git } from "./flow-harness.mjs";
import { State } from "../src/state.ts";

const request =
  "Fix what an apply leaves on the host's disk: keep the last two generations of dumps, prune docker images older than 48h, " +
  "run the prune daily from a timer, and enable both prune units in ops/setup.sh.";
const criterion = "`ops/setup.sh` enables `prune-docker.service` as well as `prune-docker.timer`";
const mergedFiles = ["ops/lib/generations.sh", "ops/setup.sh", "ops/units/prune-docker.service", "ops/units/prune-docker.timer"];
const PR177 = "https://github.com/acme/app/pull/177";

/** The grader's note, as the runner posts it: its own words, its marker, and the runner's (so it is no instruction to the agent). */
const gradeNote = (criteria) =>
  [
    "**Graded: needs revision.** Fix the criteria below, then finish the task again; the grader checks the new version.",
    "- met: the apply keeps the last two dump generations. `GEN_KEEP=2` in ops/lib/generations.sh",
    ...criteria.map((c, i) => `- **not met**: ${c}. the follow-up has not done it yet (${i + 1})`),
    "_Grader: ~acme/test; version v1. The grader's words, not the owner's._",
    "<!-- aidenhq:grader -->",
  ].join("\n\n") + "\n\n<!-- aidenhq-runner -->";

/** The fake gateway: the reviewer's prompt is kept, and answered with the first verdict queued (approve by default). */
const gatewayFor = () => {
  const prompts = [];
  const verdicts = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    prompts.push(JSON.parse(body).messages);
    res.writeHead(200, { "content-type": "application/json" });
    const approve = { decision: "approve", reason_code: "in_scope", reason: "the one line as asked; the rest is on main", second_review: false };
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(verdicts.shift() ?? approve) } }], usage: {} }));
  });
  return { server, prompts, verdicts };
};

/** The earlier fix on GitHub's main, and the PR that merged it, as the task's own merged branch row. */
const plantMergedFix = (t) => {
  const seed = join(t.dir, "merged-fix");
  git(t.dir, "clone", "-q", join(t.dir, "github/acme/app.git"), seed);
  for (const f of mergedFiles) {
    mkdirSync(dirname(join(seed, f)), { recursive: true });
    writeFileSync(join(seed, f), "GEN_KEEP=2\n");
  }
  writeFileSync(join(seed, "ops/setup.sh"), "systemctl --user enable --now prune-docker.timer\n");
  git(seed, "add", ".");
  git(seed, "commit", "-qm", "fix(ops): bound what an apply leaves on the host's disk");
  const merge = git(seed, "rev-parse", "HEAD");
  git(seed, "push", "-q", "origin", "main");
  writeFileSync(
    join(t.dir, "github-prs.json"),
    JSON.stringify({ 177: { branch: "fix/host-disk-retention", files: mergedFiles, checks: "SUCCESS", merged: true, merge, mergedAt: "2026-11-16T16:52:13Z", title: "fix(ops): bound what an apply leaves on the host's disk" } }),
  );
  const state = new State(join(t.dir, "state"));
  state.saveBranch("part", { repo: "acme/app", branch: "fix/host-disk-retention", base: "main" });
  state.updateBranch("part", "acme/app", "fix/host-disk-retention", { pr_url: PR177, merged: 1 });
  state.db.close();
  return merge;
};

const describeFlow = (name, { note, verdict, expect }) =>
  describe(`flow-followup-scope: ${name}`, { concurrency: 1 }, () => {
    const t = flow({
      // The task the fix merged on, back in todo because its grader found a criterion unmet: the user's own part, so it runs.
      part: { createdByUserId: "user-1", createdByAgentId: null, description: request },
      grants: { autonomy: "full", agents: { "engineer-claude": { key: "fleet-engineer", roles: ["platform-engineer"] } } },
      runnerYaml: "apply:\n  repo: acme/aidenhq-instance\n",
      env: { AIDENHQ_PRODUCT_REPO: "acme/app", AIDENHQ_GITHUB_AGENTS_ORG: "acme-agents" },
    });
    const gw = gatewayFor();
    after(() => gw.server.close());

    it(expect.title, async () => {
      await t.settled();
      await new Promise((r) => gw.server.listen(0, "127.0.0.1", r));
      appendFileSync(join(t.dir, "config/runner.yaml"), `gateway:\n  url: http://127.0.0.1:${gw.server.address().port}\n`);
      writeFileSync(join(t.dir, "secrets/gateway_job_secret"), "s".repeat(64), { mode: 0o600 });
      const exited = new Promise((r) => t.runner.once("exit", r));
      t.runner.kill("SIGTERM");
      await exited;
      plantMergedFix(t);
      t.startRunner();

      // The note on the task, as the runner leaves it when it sends the version back.
      t.paperclip.comments.get("part").push({ id: "grader-1", createdAt: new Date(Date.now() - 1000).toISOString(), ...note });
      if (verdict) gw.verdicts.push(verdict);
      t.step("write fix/prune-service-enable ops/setup.sh systemctl --user enable --now prune-docker.service prune-docker.timer\naidenhq pr acme/app fix/prune-service-enable");
      await t.turn("The grader sent this back: close what it names.");
      await t.waitFor("the reviewer's card", () => gw.prompts.length > 0, 90_000);
      await expect.check(t, gw.prompts.at(-1)[1].content);
    });
  });

describeFlow("a follow-up carrying only the unmet criterion is told the rest already merged", {
  note: { authorType: "user", authorUserId: "user-1", body: gradeNote([criterion]) },
  expect: {
    title: "the prompt still reads the whole request, and says the merged part is on main",
    check(t, user) {
      assert.match(user, /acme\/app#177 at [0-9a-f]{12}, merged into main: ops\/lib\/generations\.sh, ops\/setup\.sh, ops\/units\/prune-docker\.service, ops\/units\/prune-docker\.timer/);
      assert.match(user, /That work is done, and it is not missing from this diff/);
      assert.match(user, /\n1\. `ops\/setup\.sh` enables `prune-docker\.service` as well as `prune-docker\.timer`/);
      // The request is never narrowed: a rubric holds a few criteria, not every requirement the request states.
      assert.match(user, /keep the last two generations of dumps/, "the whole request is still the scope");
      assert.match(user, /prune docker images older than 48h/, "and every requirement it states, merged or not");
      assert.match(user, /systemctl --user enable --now prune-docker\.service/, "the diff");
      t.noErrors();
    },
  },
});

describeFlow("a follow-up that really leaves an unmerged criterion undone is still rejected", {
  note: { authorType: "user", authorUserId: "user-1", body: gradeNote([criterion, "`ops/setup.sh` passes `--filter until=48h` to the image prune"]) },
  verdict: { decision: "reject", reason_code: "out_of_scope", reason: "The image prune's 48h filter is not in this change.", second_review: false },
  expect: {
    title: "both criteria are in the scope, and the reject reaches the task",
    async check(t, user) {
      assert.match(user, /\n1\. `ops\/setup\.sh` enables[\s\S]*\n2\. `ops\/setup\.sh` passes `--filter until=48h` to the image prune/, "every unmet criterion, not just the first");
      // The verdict lands just after the reviewer's call returns: wait for it rather than race the runner's next step.
      await t.waitFor("the rejection on the task", () => t.partComments().some((c) => /The image prune's 48h filter is not in this change\./.test(c)), 30_000);
    },
  },
});

describeFlow("a grader note the runner did not write adds no criteria", {
  note: { authorType: "agent", authorAgentId: "engineer-claude", body: gradeNote([criterion]) },
  expect: {
    title: "no criteria come from a note the runner did not post",
    check(t, user) {
      assert.doesNotMatch(user, /the grader named these criteria as not met/, "the runner's own note is the only source of criteria");
      assert.match(user, /keep the last two generations of dumps/, "the whole request");
    },
  },
});
