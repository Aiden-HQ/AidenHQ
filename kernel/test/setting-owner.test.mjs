// An agent's settings change (kernel.settings) that does what the setting's module makes the owner's is Tier 2, the owner's
// under every autonomy; the same change from the owner's own settings page stays the panel's.
import { test } from "node:test";
import assert from "node:assert/strict";
import YAML from "yaml";
import { applyParts } from "../src/apply-tier.ts";
import { highest } from "../src/tier.ts";

const RULES = [
  { path: "month_usd", raise: true }, { path: "repos.*.month_usd", raise: true, default: 50 }, { path: "repos.*.forks", to: "auto", default: "manual" },
  { path: "repos.*.drafts", to: true }, { path: "repos.*.repo", new: true, before: "/" },
  { path: "reviewers.*.model", change: true }, { path: "reviewers.*.finders", change: true }, { path: "reviewers.*.run_usd", change: true },
];
const DEFAULT = { reviewers: { quick: { model: "~m/flash", finders: 1, run_usd: 0.5 } }, repos: [], month_usd: 200 };
const defs = { code_review: { default: DEFAULT, owner: RULES }, github_comment_orgs: { default: [], owner: [{ path: "*", new: true }] } };
const BASE = { reviewers: {}, repos: [{ repo: "acme/api", month_usd: 50 }], month_usd: 200 };
const tierOf = (cr, byAgent = true, base = { code_review: BASE }) => highest(applyParts({ files: ["instance.yaml"], byAgent, settingDefs: defs,
  base: { "instance.yaml": YAML.stringify({ settings: base }) }, head: { "instance.yaml": YAML.stringify({ settings: { ...base, code_review: cr } }) } }));

test("an agent's spend raise, wider reach or reviewer change is the owner's; other edits stay the panel's", () => {
  const owner = (cr) => { const t = tierOf(cr); assert.equal(t.tier, 2, JSON.stringify(cr)); assert.equal(t.ownerOnly, true); };
  owner({ ...BASE, month_usd: 300 });
  owner({ ...BASE, repos: [{ repo: "acme/api", month_usd: 80 }] });
  owner({ ...BASE, repos: [{ repo: "acme/api", month_usd: 50, forks: "auto" }] });
  owner({ ...BASE, repos: [{ repo: "acme/api", month_usd: 50, drafts: true }] });
  owner({ ...BASE, repos: [...BASE.repos, { repo: "othercorp/web" }] });
  owner({ ...BASE, repos: [...BASE.repos, { repo: "acme/web", month_usd: 90 }] }); // a new entry above the default (50)
  owner({ reviewers: {}, repos: [{ repo: "acme/web", month_usd: 500 }], month_usd: 200 }); // the first repo too
  owner({ ...BASE, repos: [{ repo: "acme/api", month_usd: 50 }, { repo: "ACME/api", month_usd: 10 }] }); // one repo twice: ambiguous
  // A removed value is its default again: from 20 to unset (50) is a raise.
  assert.equal(tierOf({ ...BASE, repos: [{ repo: "acme/api" }] }, true, { code_review: { ...BASE, repos: [{ repo: "acme/api", month_usd: 20 }] } }).tier, 2);
  owner({ ...BASE, reviewers: { quick: { model: "~m/flash", finders: 4, run_usd: 0.5 } } });
  owner({ ...BASE, reviewers: { sec: { model: "~m/big", finders: 1, run_usd: 1 } } });
  // Within what was already allowed: the panel (Tier 1).
  for (const cr of [{ ...BASE, month_usd: 100 }, { ...BASE, repos: [...BASE.repos, { repo: "acme/web", on_open: "quick" }] }, { ...BASE, repos: [{ repo: "acme/api", month_usd: 20, on_push: "off" }] }, { ...BASE, reviewers: { quick: null } }])
    assert.equal(tierOf(cr).tier, 1, JSON.stringify(cr));
  // The owner's own change from the board: their authority already.
  assert.equal(tierOf({ ...BASE, month_usd: 900 }, false).tier, 1);
  // A new org in the github module's comment orgs.
  const orgs = (v) => highest(applyParts({ files: ["instance.yaml"], byAgent: true, settingDefs: defs, base: { "instance.yaml": YAML.stringify({ settings: { github_comment_orgs: ["acme"] } }) }, head: { "instance.yaml": YAML.stringify({ settings: { github_comment_orgs: v } }) } }));
  assert.equal(orgs(["acme", "othercorp"]).tier, 2);
  assert.equal(orgs([]).tier, 1);
});
