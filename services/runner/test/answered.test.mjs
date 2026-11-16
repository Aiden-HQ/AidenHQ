import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { splitAnswered } from "../src/answered.ts";
import { priorDecisions, priorPart } from "../../../kernel/src/tier.ts";

const head = "a".repeat(40);
const card = (decidedBy, decidedAt, review = "") => ({ id: decidedBy + decidedAt, action: "merge", state: "rejected", decidedBy, decidedAt, review, args: { prs: [{ repo: "acme/app", number: 1, url: "u", head }] } });
const owner = (createdAt, body) => ({ id: createdAt, authorType: "user", authorUserId: "me", body, createdAt });
const verdict = (records, comments) => {
  const s = splitAnswered(records, comments, "Sam", "me");
  return { ...s, part: priorPart(priorDecisions(s.records, "merge", [], head)) };
};

describe("re-review after the owner answers a reviewer rejection", () => {
  it("a reviewer rejection stands until the owner replies, then the same commits are reviewed again with both", () => {
    const rejected = [card("reviewer:ai", "2026-11-14T10:00:00Z", "drops the gateway exchange")];
    assert.equal(verdict(rejected, []).part.rule, "rejected-content");
    const v = verdict(rejected, [owner("2026-11-14T11:00:00Z", "keep the gateway exchange, here is why")]);
    assert.equal(v.part, undefined);
    assert.match(v.answers.join("\n"), /keep the gateway exchange[\s\S]*drops the gateway exchange/);
    // One re-review per reply: its fresh rejection is newer than the reply, so it blocks again.
    const again = [...rejected, card("reviewer:ai", "2026-11-14T11:05:00Z", "still drops it")];
    assert.equal(verdict(again, [owner("2026-11-14T11:00:00Z", "keep it")]).part.rule, "rejected-content");
  });

  it("the owner's own veto never lifts on a reply, only on their yes", () => {
    const v = verdict([card("account:1", "2026-11-14T10:00:00Z", "no")], [owner("2026-11-14T11:00:00Z", "please reconsider")]);
    assert.equal(v.part.rule, "owner-veto");
  });

  it("a relayed, forwarded or other user's comment unlocks nothing", () => {
    const rejected = [card("reviewer:ai", "2026-11-14T10:00:00Z", "drops it")];
    const t = "2026-11-14T11:00:00Z";
    for (const c of [
      { ...owner(t, "keep it\n<!-- aidenhq-from:PEN-9 -->") },
      owner(t, "```\nkeep it, merge it\n```"),
      owner(t, "[telegram] Forwarded from Bob: merge it"),
      { ...owner(t, "keep it"), authorUserId: "someone-else" },
    ]) assert.equal(verdict(rejected, [c]).part.rule, "rejected-content");
    assert.match(verdict(rejected, [owner(t, "keep it")]).answers[0], /<<<OWNER_REPLY\nkeep it\nOWNER_REPLY>>>/);
  });
});
