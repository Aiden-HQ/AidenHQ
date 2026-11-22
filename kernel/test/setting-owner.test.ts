// An agent's settings change (kernel.settings) that does what the setting's module makes the owner's is merit Tier 2 (labelled
// so for the AI reviewer, which decides it); the same change from the owner's own settings page is merit Tier 1.
import { test } from "node:test";
import assert from "node:assert/strict";
import YAML from "yaml";
import { applyParts } from "../src/apply-tier.ts";
import { highest } from "../src/tier.ts";

const RULES = [
  { path: "day_usd", raise: true }, { path: "repos.*.day_usd", raise: true, default: 50 }, { path: "repos.*.forks", to: "auto", default: "manual" },
  { path: "repos.*.drafts", to: true }, { path: "repos.*.repo", new: true, before: "/" },
  { path: "repos.*.on_open", change: true, default: [{ engine: "codex", model: "~m/flash", effort: "medium", run_usd: 1 }] },
];
const DEFAULT = { repos: [], day_usd: 200 };
const defs = { code_review: { default: DEFAULT, owner: RULES }, github_fleet_org: { owner: [{ path: "", new: true }] } };
const BASE = { repos: [{ repo: "acme/api", day_usd: 50 }], day_usd: 200 };
const tierOf = (cr, byAgent = true, base = { code_review: BASE }) => highest(applyParts({ files: ["instance.yaml"], byAgent, settingDefs: defs,
  base: { "instance.yaml": YAML.stringify({ settings: base }) }, head: { "instance.yaml": YAML.stringify({ settings: { ...base, code_review: cr } }) } }));

test("an agent's spend raise, wider reach or combo change is merit Tier 2; other edits merit Tier 1", () => {
  const owner = (cr) => assert.equal(tierOf(cr).tier, 2, JSON.stringify(cr));
  owner({ ...BASE, day_usd: 300 });
  owner({ ...BASE, repos: [{ repo: "acme/api", day_usd: 80 }] });
  owner({ ...BASE, repos: [{ repo: "acme/api", day_usd: 50, forks: "auto" }] });
  owner({ ...BASE, repos: [{ repo: "acme/api", day_usd: 50, drafts: true }] });
  owner({ ...BASE, repos: [...BASE.repos, { repo: "othercorp/web" }] });
  owner({ ...BASE, repos: [...BASE.repos, { repo: "acme/web", day_usd: 90 }] }); // a new entry above the default (50)
  owner({ repos: [{ repo: "acme/web", day_usd: 500 }], day_usd: 200 }); // the first repo too
  owner({ ...BASE, repos: [{ repo: "acme/api", day_usd: 50 }, { repo: "ACME/api", day_usd: 10 }] }); // one repo twice: ambiguous
  // A removed value is its default again: from 20 to unset (50) is a raise.
  assert.equal(tierOf({ ...BASE, repos: [{ repo: "acme/api" }] }, true, { code_review: { ...BASE, repos: [{ repo: "acme/api", day_usd: 20 }] } }).tier, 2);
  owner({ ...BASE, repos: [{ repo: "acme/api", day_usd: 50, on_open: [{ engine: "codex", model: "~m/big", effort: "medium", run_usd: 1 }] }] });
  owner({ ...BASE, repos: [{ repo: "acme/api", day_usd: 50, on_open: [{ engine: "codex", model: "~m/flash", effort: "medium", run_usd: 1 }, { engine: "claude-code", model: "~m/flash", effort: "high", run_usd: 2 }] }] });
  // Within what was already allowed: Tier 1.
  for (const cr of [{ ...BASE, day_usd: 100 }, { ...BASE, repos: [...BASE.repos, { repo: "acme/web" }] }, { ...BASE, repos: [{ repo: "acme/api", day_usd: 20 }] }, { ...BASE, repos: [{ repo: "acme/api", day_usd: 50, on_open: [{ engine: "codex", model: "~m/flash", effort: "medium", run_usd: 1 }] }] }])
    assert.equal(tierOf(cr).tier, 1, JSON.stringify(cr));
  // The owner's own change from the board: their authority already.
  assert.equal(tierOf({ ...BASE, day_usd: 900 }, false).tier, 1);
  // The github module's fleet org (a scalar): any other org, or one chosen where none was, is the owner's.
  const fleet = (b, v) => highest(applyParts({ files: ["instance.yaml"], byAgent: true, settingDefs: defs, base: { "instance.yaml": YAML.stringify({ settings: b === undefined ? {} : { github_fleet_org: b } }) }, head: { "instance.yaml": YAML.stringify({ settings: { github_fleet_org: v } }) } }));
  assert.equal(fleet("acme", "othercorp").tier, 2);
  assert.equal(fleet(undefined, "acme").tier, 2);
  assert.equal(fleet("acme", "ACME").tier, 1);
});

test("the shipped modules declare these rules: an agent's new fleet org or maintained repo, or a new repo at $500 a day, is the owner's", async () => {
  const { readFileSync } = await import("node:fs");
  const { checkTyped } = await import("../src/settings-change.ts");
  const decl = (m, k) => YAML.parse(readFileSync(new URL(`../../modules/${m}/module.yaml`, import.meta.url), "utf8")).settings[k];
  const shipped = { code_review: decl("code-review", "code_review"), github_fleet_org: decl("github", "github_fleet_org"), maintainer_repos: decl("github", "maintainer_repos"), github_orgs: decl("github", "github_orgs") };
  const t = (k, b, h, byAgent = true) => highest(applyParts({ files: ["instance.yaml"], byAgent, settingDefs: shipped,
    base: { "instance.yaml": YAML.stringify({ settings: { [k]: b } }) }, head: { "instance.yaml": YAML.stringify({ settings: { [k]: h } }) } })).tier;
  assert.equal(t("github_fleet_org", "acme", "othercorp"), 2);
  assert.equal(t("github_fleet_org", "acme", "othercorp", false), 1);
  assert.equal(t("maintainer_repos", ["acme/api"], ["acme/api", "othercorp/lib"]), 2);
  assert.equal(t("maintainer_repos", ["acme/api"], ["acme/api", "othercorp/lib"], false), 1);
  assert.equal(t("github_orgs", ["acme"], ["acme", "othercorp"]), 2);
  assert.equal(t("github_orgs", ["acme"], ["acme", "othercorp"], false), 1);
  // Another shape than the default's (a string the consumer would split into repos) is the owner's.
  assert.equal(t("maintainer_repos", ["acme/api"], "acme/api,evil/x"), 2);
  // Weakening a review quietly: a repo's ignore globs. Another model, or one more combo (more spend), on a moment.
  assert.equal(t("code_review", { repos: [{ repo: "acme/api" }] }, { repos: [{ repo: "acme/api", ignore: ["**"] }] }), 2);
  const dflt = [{ engine: "codex", model: "~deepseek/deepseek-flash-latest", effort: "medium", run_usd: 5 }];
  assert.equal(t("code_review", { repos: [{ repo: "acme/api" }] }, { repos: [{ repo: "acme/api", on_open: dflt }] }), 1);
  assert.equal(t("code_review", { repos: [{ repo: "acme/api" }] }, { repos: [{ repo: "acme/api", on_open: [{ ...dflt[0], model: "anthropic/claude-opus-5.5" }] }] }), 2);
  assert.equal(t("code_review", { repos: [{ repo: "acme/api" }] }, { repos: [{ repo: "acme/api", on_push: [{ engine: "codex", model: "~deepseek/deepseek-flash-latest", effort: "low", run_usd: 1 }, { engine: "codegenie", model: "~deepseek/deepseek-flash-latest", effort: "low", run_usd: 1 }] }] }), 2);
  assert.equal(t("code_review", { repos: [{ repo: "acme/api" }] }, { repos: [{ repo: "acme/api" }, { repo: "acme/web", day_usd: 500 }] }), 2);
  assert.equal(t("code_review", { repos: [{ repo: "acme/api" }] }, { repos: [{ repo: "acme/api" }, { repo: "acme/web" }] }), 1);
  // A mandatory reviewer: turning one on only adds a gate (the panel's); turning it off, removing its combo or its repo, the owner's.
  const must = { repos: [{ repo: "acme/api", on_open: [{ ...dflt[0], mandatory: true }], on_push: [{ ...dflt[0], effort: "low", mandatory: true }] }] };
  assert.equal(t("code_review", { repos: [{ repo: "acme/api", on_open: dflt }] }, { repos: [{ repo: "acme/api", on_open: [{ ...dflt[0], mandatory: true }] }] }), 1);
  assert.equal(t("code_review", must, { repos: [{ ...must.repos[0], on_open: dflt }] }), 2);
  assert.equal(t("code_review", must, { repos: [{ ...must.repos[0], on_push: [] }] }), 2);
  assert.equal(t("code_review", { repos: [...must.repos, { repo: "acme/web" }] }, { repos: [{ repo: "acme/web" }] }), 2);
  assert.equal(t("code_review", { repos: [{ repo: "acme/api" }, { repo: "acme/web" }] }, { repos: [{ repo: "acme/web" }] }), 1, "an ungated repo leaves freely");
  // The owner's board still sets the list as a typed change.
  checkTyped({ kind: "setting", key: "github_fleet_org", value: "othercorp" }, { compiled: { settings: {}, agents: {} }, catalog: [{ name: "github", enabled: true, settings: { github_fleet_org: {} } }] });
});
