import { test } from "node:test";
import assert from "node:assert/strict";
import { effective, loosens, oldShape, validate, type Scope } from "../service/src/settings.ts";

const scope: Scope = { fleet: ["acme-agents/*", "acme/product"] };

test("a fleet repo is worked with no entry; any other repo only once it has its own entry (Ship's own list)", () => {
  assert.ok(effective({}, "acme-agents/anything", scope));
  assert.equal(effective({}, "a/b", scope), null);
  assert.ok(effective({ repos: { "a/b": "cautious" } }, "a/b", scope));
  assert.equal(effective({}, "z/z", scope), null);
});

test("loosens names each loosened field by repo, and the same policy spelled differently is no change", () => {
  const l = loosens({ repos: { "a/b": "cautious" } }, { repos: { "a/b": { preset: "full" } } });
  assert.ok(l.includes("a/b.by_tier.standard.approve") && l.includes("a/b.by_tier.sensitive.approve") && !l.includes("a/b.by_tier.standard.merge") && l.includes("a/b.caps.usd") && l.includes("a/b.handoff"));
  assert.deepEqual(loosens({ repos: { "a/b": "full" } }, { repos: { "a/b": { preset: "full" } } }), []);
  assert.deepEqual(loosens({ repos: { "a/b": "full" } }, { repos: { "a/b": "cautious" } }), []);
  // Per tier: approve raised, merge raised, the unwatched merge; lowering is free.
  const off = { repos: { "a/b": { preset: "cautious", by_tier: { trivial: { approve: "observe" }, sensitive: { merge: "off" } }, unwatched: { merge: "off" } } } };
  assert.deepEqual(loosens(off, { repos: { "a/b": "cautious" } }), ["a/b.by_tier.trivial.approve", "a/b.by_tier.sensitive.merge", "a/b.unwatched.merge"]);
  assert.deepEqual(loosens({ repos: { "a/b": "cautious" } }, off), []);
  // A new step of the repo's own is the owner's; dropping one isn't.
  const step = { repos: { "a/b": { preset: "cautious", actions: { before_merge: [{ workflow: "deploy.yml", inputs: { pr: "{pr}" } }] } } } };
  assert.ok(loosens({ repos: { "a/b": "cautious" } }, step).some((x) => /actions\.before_merge/.test(x)));
  assert.deepEqual(loosens(step, { repos: { "a/b": "cautious" } }), []);
  assert.deepEqual(loosens({ repos: { "a/b": "cautious" } }, { repos: { "a/b": { rebase: "behind" } } }), ["a/b.rebase"]);
  assert.deepEqual(loosens({}, { repos: { "a/b": "cautious" } }, scope), ["a/b.enabled"]);
  assert.deepEqual(loosens({ paused: true }, { paused: false }), ["paused"]);
  // A new generated glob widens what the repair may write; the command alone is an ordinary change.
  const gen = (globs: string[], command = "make gen") => ({ repos: { "a/b": { preset: "cautious", generated: { globs, command } } } });
  assert.deepEqual(loosens(gen(["gen/**"]), gen(["gen/**", "src/**"])), ["a/b.generated.globs"]);
  assert.deepEqual(loosens(gen(["gen/**"]), gen(["gen/**"], "npm run gen")), []);
  // The repo's CI regenerating (a ci workflow) runs nothing and writes only the base's blobs: an ordinary change.
  assert.deepEqual(loosens(gen(["gen/**"]), { repos: { "a/b": { preset: "cautious", generated: { globs: ["gen/**"], ci: "schema-generate.yml" } } } }), []);
  // Ignored accounts: adding one (its comments stop gating a merge) is the owner's; the same login in another case, or dropping one, isn't.
  const ign = (l: string[]) => ({ repos: { "a/b": { preset: "cautious", ignore_authors: l } } });
  assert.deepEqual(loosens(ign([]), ign(["acme-bot"])), ["a/b.ignore_authors"]);
  assert.deepEqual(loosens(ign(["acme-bot"]), ign(["ACME-bot"])), []);
  assert.deepEqual(loosens(ign(["acme-bot"]), ign([])), []);
});

test("repo hooks are workflows naming the PR with {pr}; comment steps and bad logins are refused", () => {
  const scope = { fleet: ["a/*"], listed: [] };
  const v = (e: unknown) => validate({ repos: { "a/b": e } }, scope);
  assert.deepEqual(v({ actions: { conflict: [{ workflow: "pr-rebase.yml", inputs: { pr: "{pr}" } }] }, generated: { globs: ["gen/**"], ci: "schema-generate.yml" }, ignore_authors: ["acme-bot", "renovate[bot]"] }), []);
  assert.match(v({ actions: { conflict: [{ comment: "/rebase" }] } }).join(), /comment steps are gone/);
  assert.match(v({ actions: { conflict: [{ workflow: "pr-rebase.yml" }] } }).join(), /name the PR with \{pr\}/);
  assert.match(v({ actions: { conflict: [{ workflow: "x.yml", inputs: { pr: "{pr}", ref: "{head}" } }] } }).join(), /only placeholder is \{pr\}/);
  assert.match(v({ ignore_authors: ["not a login"] }).join(), /ignore_authors/);
  assert.match(v({ generated: { globs: ["gen/**"], command: "make gen", ci: "schema-generate.yml" } }).join(), /a command or a ci workflow, not both/);
  assert.match(v({ generated: { globs: ["gen/**"], ci: "generate" } }).join(), /generated\.ci: the file name in \.github\/workflows/);
  assert.match(v({ generated: { globs: ["gen/**"], command: null } }).join(), /generated\.command: text/);
});

test("the pull-request duties are fields of a repo's entry: validated, and switching dependabot to all or quiet-PR closing on is the owner's", () => {
  assert.deepEqual(validate({ repos: { "a/b": { dependabot: "failing", quiet_pr_days: 7 } } }), []);
  assert.match(validate({ repos: { "a/b": { dependabot: true, quiet_pr_days: 0 } } }).join("|"), /dependabot: one of off, failing, all.*quiet_pr_days: a whole number/);
  const e = effective({ repos: { "a/b": { dependabot: "failing" } } }, "a/b", scope)!;
  assert.deepEqual([e.dependabot, e.quiet_pr_days, effective({}, "acme/product", scope)!.dependabot], ["failing", null, "off"]);
  assert.deepEqual(loosens({ repos: { "a/b": {} } }, { repos: { "a/b": { dependabot: "failing", quiet_pr_days: 7 } } }, scope), ["a/b.quiet_pr_days"]);
  assert.deepEqual(loosens({ repos: { "a/b": { dependabot: "failing", quiet_pr_days: 7 } } }, { repos: { "a/b": { dependabot: "all", quiet_pr_days: 3 } } }, scope), ["a/b.dependabot", "a/b.quiet_pr_days"], "a shorter window closes sooner: the owner's");
  assert.deepEqual(loosens({ repos: { "a/b": { quiet_pr_days: 7 } } }, { repos: { "a/b": { quiet_pr_days: 14 } } }, scope), [], "a longer window is a tightening");
  assert.deepEqual(loosens({ defaults: { quiet_pr_days: 30 } }, { defaults: { quiet_pr_days: 10 } }, scope), ["defaults.quiet_pr_days"]);
  assert.deepEqual(loosens({ repos: { "a/b": { dependabot: "all", quiet_pr_days: 7 } } }, { repos: { "a/b": { dependabot: "off", quiet_pr_days: null } } }, scope), []);
});
