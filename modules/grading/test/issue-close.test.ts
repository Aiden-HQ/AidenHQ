// A closed issue counts as resolved when GitHub's own closer is a merged PR in its repo, or an owner's comment (at any time after
// the close) cites a PR the code host reads as merged; a manual close with neither stays unresolved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { issueEvidence } from "../service/src/grader/evidence.ts";

const base = { number: 7, state: "CLOSED", stateReason: "COMPLETED", closedAt: "2026-11-19T10:05:00Z", labels: { nodes: [] } };
const merged = { state: "MERGED", mergedAt: "2026-11-19T10:00:00Z", mergeCommit: { oid: "b".repeat(40) }, headRefOid: "a".repeat(40) };
const run = (issue: object) => issueEvidence("acme/app#7", { issue: async () => ({ repository: { issue: { ...base, ...issue } } }), pr: async () => ({ repository: { pullRequest: merged } }) });
const text = (e: { facts: string[] }) => e.facts.join("\n");

test("an issue closed by a merged PR counts; so does one an owner's later comment cites a merged PR for; a bare manual close does not", async () => {
  const keyword = await run({ closedEvents: { nodes: [{ actor: { login: "github-actions" }, closer: { __typename: "PullRequest", number: 9, state: "MERGED", mergeCommit: { oid: "b".repeat(40) }, repository: { nameWithOwner: "acme/app" } } }] }, comments: { nodes: [] } });
  assert.match(text(keyword), /closed by GitHub through the closing keyword of https:\/\/github.com\/acme\/app\/pull\/9.*merged \(merge commit b{40}\)/);
  assert.doesNotMatch(text(keyword), /does not count/);

  const later = await run({ closedEvents: { nodes: [{ actor: { login: "someone" }, closer: null }] }, comments: { nodes: [{ author: { login: "owner" }, authorAssociation: "OWNER", createdAt: "2026-11-19T11:00:00Z", body: "Fixed by https://github.com/acme/app/pull/9." }] } });
  assert.match(text(later), /acme\/app\/pull\/9: merged at 2026-11-19T10:00:00Z/);
  assert.doesNotMatch(text(later), /does not count/);

  // The closer commented first without citing a PR: the owner's later citation still counts, attributed to its own author.
  const both = await run({ closedEvents: { nodes: [{ actor: { login: "someone" }, closer: null }] }, comments: { nodes: [
    { author: { login: "someone" }, authorAssociation: "OWNER", createdAt: "2026-11-19T10:04:00Z", body: "closing" },
    { author: { login: "aiden" }, authorAssociation: "OWNER", createdAt: "2026-11-19T11:00:00Z", body: "Fixed by https://github.com/acme/app/pull/9." }] } });
  assert.match(text(both), /closing comment \(by aiden, .*cites https:\/\/github.com\/acme\/app\/pull\/9/);

  const bare = await run({ closedEvents: { nodes: [{ actor: { login: "someone" }, closer: null }] }, comments: { nodes: [] } });
  assert.match(text(bare), /the close does not count/);

  // A merged PR in another repo, which GitHub records as the closer of a cross-repo `Fixes owner/repo#n`, counts.
  const cross = await run({ closedEvents: { nodes: [{ actor: { login: "github-actions" }, closer: { __typename: "PullRequest", number: 3, state: "MERGED", mergeCommit: { oid: "c".repeat(40) }, repository: { nameWithOwner: "acme/other" } } }] }, comments: { nodes: [] } });
  assert.match(text(cross), /closing keyword of https:\/\/github.com\/acme\/other\/pull\/3.*merged/);
  assert.doesNotMatch(text(cross), /does not count/);
});

test("every citation is read: an unrelated or unmerged link never masks the merged fix", async () => {
  const unmerged = { state: "OPEN" };
  const e = await issueEvidence("acme/app#7", {
    issue: async () => ({ repository: { issue: { ...base, closedEvents: { nodes: [{ actor: { login: "owner" }, closer: null }] }, comments: { nodes: [
      { author: { login: "owner" }, authorAssociation: "OWNER", createdAt: "2026-11-19T10:04:50Z", body: "Related: https://github.com/acme/app/pull/4" },
      { author: { login: "aiden" }, authorAssociation: "OWNER", createdAt: "2026-11-19T11:00:00Z", body: "See https://github.com/acme/app/pull/5 and the fix https://github.com/acme/app/pull/9." }] } } } }),
    pr: async (_repo: string, n: number) => ({ repository: { pullRequest: n === 9 ? merged : unmerged } }),
  });
  assert.match(text(e), /pull\/4: open, not merged/);
  assert.match(text(e), /pull\/9: merged at/);
  assert.match(e.version, /:b{12}\+/, "the merged fix is in the version's merges");
});
