// Quality per approval tier (services/shared/quality.ts): reverts and incidents linked to the change they name, by PR number or
// sha only; anything ambiguous is unknown, and the counts are per approver.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { report } from "../../services/board/src/quality.ts";
import { openRecords } from "../../kernel/src/records.ts";

const NOW = Date.parse("2026-11-17T00:00:00Z");
const day = (n) => new Date(NOW - n * 864e5).toISOString();
const SHA = (c) => `${c}1`.repeat(20);
const row = (id, kind, args, by, at, extra = {}) => ({ id, kind, args, tier: by ? 1 : 0, panel: false, by, state: "done", at, ...extra });
const merge = (id, n, by, ago, repo = "acme-agents/api") => row(id, "runner.merge", { prs: [{ repo, number: n, url: `https://github.com/${repo}/pull/${n}` }] }, by, day(ago));
const rows = [
  merge("a", 10, "reviewer:glm", 1),
  merge("b", 11, "reviewer:glm+deepseek", 2),
  merge("c", 12, "account:owner-1", 3),
  merge("d", 13, null, 4),
  merge("e", 14, "reviewer:glm", 20),
  // the same PR filed twice (retry) counts once; a failed record and a rejected one never count
  merge("a2", 10, "reviewer:glm", 1),
  { ...merge("f", 15, "reviewer:glm", 1), state: "failed" },
  row("ap", "kernel.apply", { repo: "acme-agents/instance", branch: "main", sha: SHA("a"), files: ["x"] }, "reviewer:glm", day(2)),
];
const revert = (id, title, extra = {}) => ({ id, title, repo: "acme-agents/api", ...extra });
const tiers = (r, d = 7) => Object.fromEntries(Object.entries(r.windows.find((w) => w.days === d).tiers).map(([t, c]) => [t, [c.changes, c.reverted, c.incidents]]));

test("a revert is matched to its original by PR number, by URL and by sha", () => {
  const r = report(rows, { reverts: [
    revert("r1", 'Revert "feat(api): add acme export (#10)" (#40)', { number: 40 }),
    revert("r2", "Revert the owner change", { body: "Reverts https://github.com/acme-agents/api/pull/12" }),
    revert("r3", "Revert instance change", { repo: "acme-agents/instance", body: `This reverts commit ${SHA("a")}.` }),
  ] }, NOW);
  assert.deepEqual(tiers(r), { ran: [1, 0, 0], reviewer: [2, 2, 0], panel: [1, 0, 0], owner: [1, 1, 0] });
  assert.deepEqual(r.reverted.map((x) => x.revert).sort(), ["r1", "r2", "r3"]);
  assert.deepEqual(r.unknown, []);
});

test("an ambiguous revert is unknown, never guessed; a revert of a revert and a non-agent PR are skipped", () => {
  const r = report(rows, { reverts: [
    revert("two", 'Revert "#10 and #11"'),
    revert("bare", 'Revert "export (#10)"', { repo: undefined }),
    revert("none", 'Revert "tidy"'),
    revert("again", 'Revert "Revert "feat (#12)" (#40)" (#41)', { number: 41 }),
    revert("other", 'Revert "human change (#99)"'),
  ] }, NOW);
  assert.deepEqual(r.unknown.sort(), ["bare", "none", "two"]);
  assert.equal(r.reverted.length, 0);
});

test("changes are counted per approver and window; incidents link by PR number", () => {
  const r = report(rows, { incidents: [{ id: "i1", url: "https://github.com/acme-agents/aidenhq/issues/5", title: "api: export crashes", body: "after acme-agents/api#13" }] }, NOW);
  assert.deepEqual(tiers(r, 7), { ran: [1, 0, 1], reviewer: [2, 0, 0], panel: [1, 0, 0], owner: [1, 0, 0] });
  assert.deepEqual(tiers(r, 30), { ran: [1, 0, 1], reviewer: [3, 0, 0], panel: [1, 0, 0], owner: [1, 0, 0] });
});

test("the CLI reads kernel.db read-only and the GitHub export", () => {
  const dir = mkdtempSync(join(tmpdir(), "quality-"));
  const recs = openRecords(join(dir, "kernel.db"), () => new Date(NOW - 864e5));
  const rec = recs.file({ kind: "runner.merge", module: "runner", args: { prs: [{ repo: "acme-agents/api", number: 7, url: "https://github.com/acme-agents/api/pull/7" }] }, targets: {}, executor: { module: "runner" }, policy: "p", tier: 1, panel: false, card: { sentence: "s", changes: "c", reads: "r", cost: "0", details: "" }, requester: { agent: "", key: "", name: "", roles: [], kind: "agent" }, task: "t", state: "review" });
  recs.db.prepare("UPDATE records SET state='done', decided_by='reviewer:glm', outcome='{\"ok\":true,\"text\":\"merged\"}' WHERE id=?").run(rec.id);
  const gh = join(dir, "gh.json");
  writeFileSync(gh, JSON.stringify({ reverts: [{ id: "u", title: 'Revert "x (#7)"', repo: "acme-agents/api" }], incidents: [] }));
  const out = JSON.parse(execFileSync("node", ["--disable-warning=ExperimentalWarning", fileURLToPath(new URL("../quality.mjs", import.meta.url)), "--db", join(dir, "kernel.db"), "--github", gh, "--json"], { encoding: "utf8" }));
  assert.deepEqual(out.windows[0].tiers.reviewer, { changes: 1, reverted: 1, incidents: 0 });
  assert.match(out.line, /reviewer 1\/1 \(100%\)/);
});
