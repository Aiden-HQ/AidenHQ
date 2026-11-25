import { test } from "node:test";
import assert from "node:assert/strict";
import { authorKind, classify, DEFAULT_RULES, factsOf, parseRules, tooMany, type FileChange } from "../src/tiers.ts";

const f = (path: string, lines = 1, previous?: string): FileChange => ({ path, additions: lines, deletions: 0, ...(previous ? { previous } : {}) });
const tier = (files: FileChange[], o: Partial<Parameters<typeof factsOf>[1]> = {}) => classify(factsOf(files, { author: "member", base: "main", repo_class: "standard", ...o }), DEFAULT_RULES).tier;

test("the default rules: size, author, sensitive paths, repo class", () => {
  assert.equal(tier([f("src/a.ts", 10)]), "trivial");
  assert.equal(tier([f("src/a.ts", 11)]), "standard");
  assert.equal(tier([f("src/a.ts", 600)]), "sensitive");
  assert.equal(tier([f("src/a.ts", 3)], { author: "outsider" }), "sensitive");
  assert.equal(tier([f("src/a.ts", 3)], { author: "bot" }), "standard");
  assert.equal(tier([f(".github/workflows/ci.yml", 1)]), "sensitive");
  assert.equal(tier([f("src/auth/login.ts", 1)]), "sensitive");
  assert.equal(tier([f("src/Auth/Login.ts", 1)]), "sensitive", "the common capitalised form");
  assert.equal(tier([f(".github/.release.yml", 1)]), "sensitive", "a dot-file under a sensitive folder");
  assert.equal(tier([f("src/b.ts", 1, "src/session.ts")]), "sensitive", "a rename's old path counts");
  // A lockfile is sensitive, unless a bot's PR changes only manifests and lockfiles (Dependabot): skipped, reviewed when asked.
  assert.equal(tier([f("src/a.ts", 2), f("package-lock.json", 400)]), "sensitive");
  assert.equal(tier([f("package.json", 2), f("package-lock.json", 400)], { author: "bot" }), "skip");
  // Docs and plans are judged by what they say, not by a keyword in a path; an instruction file or an outsider's docs stay sensitive.
  assert.equal(tier([f("docs/plans/session-cookies/design.md", 80)]), "standard");
  assert.equal(tier([f("docs/token-design.md", 80), f("docs/plans/auth.md", 5)]), "standard");
  assert.equal(tier([f("docs/plans/session.md", 80), f("src/session.ts", 2)]), "sensitive");
  assert.equal(tier([f("docs/plans/session.md", 80), f("AGENTS.md", 1)]), "sensitive");
  assert.equal(tier([f("docs/token/page.mdx", 30)]), "sensitive", "mdx can run code: not prose");
  assert.equal(tier([f("docs/site/package.json", 3)]), "sensitive", "docs/ holds code too: prose is by file type");
  assert.equal(tier([f("docs/plans/session.md", 80)], { author: "outsider" }), "sensitive");
  // No substantive line (generated or binary only) is sensitive: generated files never count.
  assert.equal(tier([f("dist/app.min.js", 900)]), "sensitive");
  assert.equal(tier([f("src/a.ts", 4), f("dist/app.min.js", 900)]), "trivial");
  // Repo class: critical is always sensitive; sandbox is trivial unless a sensitive path or an outsider says otherwise.
  assert.equal(tier([f("src/a.ts", 1)], { repo_class: "critical" }), "sensitive");
  assert.equal(tier([f("src/a.ts", 5000)], { repo_class: "sandbox" }), "trivial");
  assert.equal(tier([f("src/a.ts", 1)], { repo_class: "sandbox", author: "outsider" }), "sensitive");
  assert.equal(tooMany(3001).tier, "sensitive");
});

test("authors, rule validation and a custom rule's why", () => {
  assert.equal(authorKind("aidenhq-x[bot]", "NONE", true), "member");
  assert.equal(authorKind("dependabot[bot]", "NONE"), "bot");
  assert.equal(authorKind("renovate[bot]", "NONE"), "bot");
  assert.equal(authorKind("dependabot[bot]", "NONE", false, true), "outsider", "never from a fork");
  assert.equal(authorKind("evil-dependabot[bot]", "NONE"), "outsider", "exact logins only");
  assert.equal(authorKind("alice", "COLLABORATOR"), "member");
  assert.equal(authorKind("mallory", "CONTRIBUTOR"), "outsider");
  assert.match((parseRules([{ tier: "standard" }, { tier: "trivial" }]) as { error: string }).error, /only the last rule has no when/);
  assert.match((parseRules([{ when: { lines: 3 }, tier: "trivial" }, { tier: "standard" }]) as { error: string }).error, /unknown condition lines/);
  assert.match((parseRules([{ when: { lines_max: 3 }, tier: "trivial" }]) as { error: string }).error, /last rule has no when/);
  const rules = parseRules([{ when: { base: ["release/*"], files_min: 2 }, tier: "sensitive" }, { tier: "skip" }]);
  assert.ok(Array.isArray(rules));
  const c = classify(factsOf([f("a.ts"), f("b.ts")], { author: "member", base: "release/1.2", repo_class: "standard" }), rules);
  assert.deepEqual([c.tier, c.rule, c.why], ["sensitive", 0, "2 files, into release/1.2"]);
});
