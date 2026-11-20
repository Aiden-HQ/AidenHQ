// The config tool and the setting's shape: an owner's words through the Reviewer Manager become one whole, valid
// settings.code_review (each moment a list of combos, stored whole with its run cap), filed as the agent's settings change with
// the caller's assertion; the old shape is refused loudly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyChange, configTools } from "../service/src/config-tool.ts";
import { readConfig } from "../service/src/config.ts";

test("watching a repo files the whole setting with its combos filled in", async () => {
  const filed = [];
  const [, , read, configure] = configTools({ raw: () => ({ repos: [], month_usd: 200 }), repos: () => [], oneoff: async () => ({}), runs: () => [], file: async (changes, assertion) => (filed.push({ changes, assertion }), { record: "k-1", tier: 1 }) });
  assert.deepEqual((await read.run({}, { agent: "a", roles: ["reviewer-manager"] })).problems, []);
  const on_open = [{ engine: "codex", model: "~deepseek/deepseek-flash-latest", effort: "medium" }, { engine: "claude-code", model: "anthropic/claude-sonnet-5.5", effort: "max" }];
  const out = await configure.run({ watch: [{ repo: "othercorp/api", on_open }] }, { agent: "a", roles: ["reviewer-manager"], assertion: "sig" });
  assert.deepEqual(filed, [{ assertion: "sig", changes: [
    { kind: "setting", key: "code_review", value: { repos: [{ repo: "othercorp/api", on_open: [{ ...on_open[0], run_usd: 1 }, { ...on_open[1], run_usd: 2 }] }], month_usd: 200 } },
  ] }]);
  assert.deepEqual(out.changes, ["watch othercorp/api"]);
});

test("a change that wouldn't validate is refused whole; the old shape (named reviewers, string triggers, on_risk) is refused loudly", () => {
  assert.throws(() => applyChange({ repos: [] }, { watch: [{ repo: "acme/x", on_open: [{ engine: "codegenie", model: "~openai/gpt-luna-latest", effort: "minimal" }] }] }), /effort for codegenie/);
  assert.throws(() => applyChange({ repos: [] }, { watch: [{ repo: "acme/x", on_push: "quick" }] }), /named reviewers are gone/);
  assert.throws(() => applyChange({ repos: [] }, { unwatch: ["acme/x"] }), /isn't watched/);
  assert.throws(() => applyChange({ repos: [{ repo: "acme/x" }, { repo: "ACME/x" }] }, { month_usd: 100 }), /listed more than once/);
  const old = readConfig(JSON.stringify({ reviewers: { quick: null }, repos: [{ repo: "acme/x", on_open: "standard", on_risk: "deep" }, { repo: "acme/y" }] }));
  assert.deepEqual(old.repos.map((r) => [r.repo, r.on_open[0].effort, r.on_push[0].effort]), [["acme/y", "medium", "low"]]);
  assert.equal(old.errors.length, 2);
  assert.match(old.errors.join(" "), /reviewers are gone.*repos\[0\]: on_risk is gone/);
});

test("an agent's one-off takes an engine's offered model at its default cap, or a combo a repo runs; any other model or cap is the owner's", async () => {
  const asked = [];
  const repos = () => ({ repos: [{ repo: "acme/x", on_open: [{ engine: "codex", model: "moonshotai/kimi-k3", effort: "high", run_usd: 3 }], on_push: [] }] });
  const [run] = configTools({ raw: () => ({}), repos, oneoff: async (b) => (asked.push(b), []), runs: () => [], file: async () => ({}) });
  const who = { agent: "a", roles: ["reviewer-manager"] };
  await run.run({ pr_url: "https://github.com/acme/x/pull/1", combos: [{ engine: "claude-code", model: "anthropic/claude-opus-5.5", effort: "max" }, { engine: "codex", model: "moonshotai/kimi-k3", effort: "high", run_usd: 3 }] }, who);
  assert.equal(asked.length, 1);
  await assert.rejects(run.run({ pr_url: "https://github.com/acme/x/pull/1", combos: [{ engine: "codex", model: "anthropic/claude-fable-5.2", effort: "high" }] }, who), /owner's to choose.*board/);
  await assert.rejects(run.run({ pr_url: "https://github.com/acme/x/pull/1", combos: [{ engine: "claude-code", model: "anthropic/claude-opus-5.5", effort: "max", run_usd: 20 }] }, who), /owner's to choose/);
  assert.equal(asked.length, 1);
});
