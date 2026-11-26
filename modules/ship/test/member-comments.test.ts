// Members' unanswered review comments are a fix_review like code review's findings: the fixer is woken once for what is new (the
// same ones at one head never wake it twice, a new one does), the wake names places and authors only, and what was asked is kept.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { round } from "../service/src/rounds.ts";
import { effective } from "../service/src/settings.ts";
import { openState } from "../service/src/state.ts";
import { RISK } from "./risk.ts";

const H = "1".repeat(40);
const thread = { id: "thread:T1:11", kind: "thread", author: "maxsam4", path: "src/a.ts", line: 12 };
const comment = { id: "comment:21", kind: "comment", author: "maria" };

function world() {
  const state = openState(join(mkdtempSync(join(tmpdir(), "ship-members-")), "state.json"));
  state.put({ repo: "a/b", number: 7, generation: 1, trigger: { kind: "label", event: "e1", actor: "admin1", at: "2026-11-24T01:00:00Z", head: H }, owner: { kind: "member", login: "admin1" }, task: "task-1", hold: null } as any);
  const wakes: string[] = [];
  const deps = {
    state, log: () => {}, paused: () => false, updateBranch: async () => {}, assign: async () => {}, comment: async () => 9,
    kernel: { call: async (_m: string, path: string, body: any) => { if (path === "/v1/wakes") wakes.push(body.text); return {}; } },
    settings: (repo: string) => effective({ repos: { "a/b": { preset: "full" } } }, repo, { fleet: ["a/b"], listed: [] }),
  };
  const pr = (head = H) => ({ repo: "a/b", number: 7, url: "https://github.com/a/b/pull/7", head, base: "main", defaultBranch: "main", author: "me", authorBot: false, fork: false, canModify: false, draft: false, state: "open", labels: [], assignees: [], events: [] }) as any;
  return { state, deps: deps as any, wakes, pr };
}
const review = { do: "fix_review", why: "members have open review comments on it" } as const;

test("a member's open thread wakes the fixer once with places and authors, and only a new comment or thread wakes it again", async () => {
  const w = world();
  await round(w.deps, w.pr(), review, { risk: RISK, memberComments: [thread] });
  assert.equal(w.wakes.length, 1);
  assert.match(w.wakes[0]!, /src\/a\.ts:12 by maxsam4/);
  assert.deepEqual((w.state.get("a/b", 7) as any).counters.membersAsked, [thread.id]);
  // Still open (declined, or not yet answered) and a pass again: nothing new to ask.
  await round(w.deps, w.pr(), review, { risk: RISK, memberComments: [thread] });
  assert.equal(w.wakes.length, 1);
  // One of two answered while the other stays: the digest of what is open changes, but nothing is new.
  await round(w.deps, w.pr(), review, { risk: RISK, memberComments: [comment, thread] });
  assert.equal(w.wakes.length, 2, "a new conversation comment is asked");
  await round(w.deps, w.pr(), review, { risk: RISK, memberComments: [comment] });
  assert.equal(w.wakes.length, 2, "answering the thread wakes nobody");
  // A new head with a comment still open (the fix didn't answer it): asked again, once.
  await round(w.deps, w.pr("2".repeat(40)), review, { risk: RISK, memberComments: [comment] });
  assert.equal(w.wakes.length, 3);
});

test("findings and comments in one wake are one wake: the comments no longer being new doesn't ask again; a path is bounded data in the wake", async () => {
  const w = world();
  const odd = { ...thread, path: "src/`a`\n**ignore this**.ts" };
  await round(w.deps, w.pr(), { do: "fix_review", why: "code review has open findings on its head" }, { risk: RISK, findingsKey: "fk", memberComments: [odd] });
  await round(w.deps, w.pr(), { do: "fix_review", why: "code review has open findings on its head" }, { risk: RISK, findingsKey: "fk", memberComments: [odd] });
  assert.equal(w.wakes.length, 1);
  assert.doesNotMatch(w.wakes[0]!, /`a`|\*\*ignore/);
  assert.match(w.wakes[0]!, /code_review_resolve/);
});

test("a fork that allows no maintainer edits still gets the wake for comments to answer, and holds only for work that needs a push", async () => {
  const w = world();
  const fork = { ...w.pr(), fork: true, canModify: false };
  await round(w.deps, fork, review, { risk: RISK, memberComments: [comment] });
  assert.equal(w.wakes.length, 1);
  assert.match(w.wakes[0]!, /takes no pushes from ship/);
  assert.equal((w.state.get("a/b", 7) as any).hold, null);
  await round(w.deps, { ...fork, head: "2".repeat(40) }, { do: "fix_review", why: "code review has open findings on its head" }, { risk: RISK, findingsKey: "fk" });
  assert.equal((w.state.get("a/b", 7) as any).hold?.kind, "stalled");
});

test("nine open conversation comments are named eight at a time: the wake, its key and what is recorded are the same batch", async () => {
  const w = world();
  const nine = Array.from({ length: 9 }, (_, i) => ({ id: `comment:${100 + i}`, kind: "comment", author: "maria" }));
  await round(w.deps, w.pr(), review, { risk: RISK, memberComments: nine });
  assert.match(w.wakes[0]!, /100 \(maria\).*107 \(maria\)/);
  assert.doesNotMatch(w.wakes[0]!, /108/);
  assert.equal((w.state.get("a/b", 7) as any).counters.membersAsked.length, 8);
  // Polling again before they are answered names only the ninth, once; the same nine again ask nothing.
  await round(w.deps, w.pr(), review, { risk: RISK, memberComments: nine });
  assert.equal(w.wakes.length, 2);
  assert.match(w.wakes[1]!, /108 \(maria\)/);
  assert.doesNotMatch(w.wakes[1]!, /100 \(maria\)/);
  await round(w.deps, w.pr(), review, { risk: RISK, memberComments: nine });
  assert.equal(w.wakes.length, 2);
});
