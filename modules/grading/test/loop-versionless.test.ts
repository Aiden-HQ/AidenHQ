// The grade loop's owed moves for a versionless close: a deliverable that is present makes the close stale, one that cannot be
// read is waited out and then closed ungraded saying so, and the parent's notice is rendered from the queued fields, saved
// before the close lands.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createGradeLoop } from "../service/src/loop.ts";
import { presentNow } from "../service/src/grader/evidence.ts";

function setup(row, over = {}) {
  const kv = new Map(), calls = [], posts = [], notes = [], tells = [], failing = { done: 1, tell: 0 };
  const state = { get: (k) => kv.get(k), set: (k, v) => kv.set(k, v), list: (p) => [...kv].filter(([k, v]) => k.startsWith(p) && v), lastJob: () => undefined };
  const g = { issueId: over.id ?? "t", state: "pending", updatedAt: over.updatedAt ?? "2020-01-01T00:00:00Z", rubric: [], deliverable: over.deliverable ?? { kind: "report" }, attempts: 0 };
  const rows = [g];
  const err = () => Object.assign(new Error("502"), { status: 502 });
  const loop = createGradeLoop({
    // The store's own hash: an amended rubric's hash is not the one a queued verdict names, which is how a stale revision move is
    // told from a live one. Here the rubric never changes, so the hash is a stable stand-in.
    api: { get: async (p: string) => (p === "/internal/grades" ? { grades: rows.filter((r) => r.state === "pending"), resubmitted: [] } : { state: "pending" }), post: async (path, body) => { posts.push([path, body]); g.state = row; return { state: row, attempts: 1, failures: 0 }; } },
    pc: {
      issue: async () => ({ id: g.issueId, identifier: over.identifier ?? "T-1", title: over.title ?? "x", status: over.status ?? "in_review", parentId: "p" }),
      agent: async () => undefined,
      setStatus: async (id, s, note) => { if (s === "done" && failing.done-- > 0) throw err(); calls.push(["setStatus", s]); notes.push(note); },
      comment: async () => calls.push(["comment"]), block: async () => {}, children: async () => over.children ?? [],
    },
    log: () => {}, state,
    gather: async () => (over.gather ? over.gather() : { facts: [], version: over.version ?? "v1", ...(over.awaiting ? { awaiting: over.awaiting } : {}), ...(over.missing ? { missing: true } : {}) }), grade: async () => ({ outcome: over.outcome ?? row, model: "m", criteria: [] }),
    escalationFor: over.escalationFor ?? (async () => over.esc ?? {}), presentNow: over.presentNow ?? presentNow, gradeNote: (_g, _r, outcome, o) => (outcome === "ungraded" ? `ungraded: ${o?.reason}` : "note"), template: () => [], gradeDeps: over.gradeDeps ?? (() => ({})),
    tellParent: async (_i, kind, text) => { if (failing.tell-- > 0) throw err(); calls.push(["tell", kind]); tells.push(text); return true; },
    recordsOn: async () => [], graderAsk: () => undefined, stripHidden: (x) => x, graderSpeaks: () => false, rubricHash: () => "rubric", graderMarker: "<!-- aidenhq:grader -->",
  });
  return { loop, calls, posts, notes, tells, failing, state };
}

describe("grade loop verdicts without a version", () => {
it("a versionless close is stale once the deliverable is present, even when its evidence can't be captured", async () => {
    // The app is deployed but its live page is down: gather() has no version and no busy work, so a versionless close would
    // otherwise look like "nothing was ever there" and land done/ungraded. presentNow tells them apart.
    const deps = { app: async () => ({ name: "roadmap-keeper", sha: "c0ffee", deploys: [{ sha: "c0ffee", at: "2026-11-20T10:00:00Z", status: "healthy" }] }) };
    const over = {
      id: "t-app", outcome: "cannot_judge", version: "", deliverable: { kind: "app", ref: "roadmap-keeper" },
      gather: () => ({ facts: [], awaiting: "roadmap-keeper: deployed commit c0ffee has no healthy deploy" }),
      gradeDeps: () => deps,
    };
    const { loop, calls, posts, failing } = setup("satisfied", over);
    failing.done = 0; // the close would land on the first pass if it weren't stale
    await loop.runGrades();
    // The close is dropped (never sent to the task), the row is sent back to waiting, and the parent is not told it is done.
    assert.deepEqual(calls, []);
    assert.equal(posts.filter(([p, b]) => /verdict/.test(p) && b?.outcome === "awaiting_evidence").length, 1);
  });

it("a presence check that can't answer leaves a versionless close waiting, never counts as absent", async () => {
    // The real presentNow: the apps registry read fails (app: undefined), which is "unknown", never "no deliverable". The close
    // stays owed and is retried; once the registry answers with no such app it lands ungraded as before.
    let down = true;
    const over = {
      id: "t-app", outcome: "cannot_judge", version: "", deliverable: { kind: "app", ref: "roadmap-keeper" },
      gather: () => ({ facts: [], awaiting: "roadmap-keeper: could not be read just now" }),
      gradeDeps: () => ({ app: async () => (down ? undefined : null) }),
    };
    const { loop, calls, failing } = setup("satisfied", over);
    failing.done = 0;
    await loop.runGrades();
    assert.deepEqual(calls, [], "an unanswerable presence check must not let the close land");
    down = false;
    await loop.runGrades();
    assert.deepEqual(calls, [["setStatus", "done"], ["tell", "done"]], "once it answers absent, the ungraded close lands as before");
  });

it("an unreadable presence check is waited out for a day and then closes ungraded, saying it could not be read", async () => {
    // A registry or GitHub that never answers must not replay the close forever, and must not close as if the deliverable were
    // absent either: after the day a grade waits, the close lands ungraded with the reason naming the unreadable lookup.
    let down = true;
    const over = {
      id: "t-app", outcome: "cannot_judge", version: "", deliverable: { kind: "app", ref: "roadmap-keeper" },
      gather: () => ({ facts: [], awaiting: "roadmap-keeper: could not be read just now" }),
      gradeDeps: () => ({ app: async () => (down ? undefined : null) }),
    };
    const { loop, calls, notes, failing, state } = setup("satisfied", over);
    failing.done = 0;
    await loop.runGrades();
    assert.deepEqual(calls, [], "the first pass waits");
    // The wait started a day and a bit ago: the same unreadable answer now ends it.
    const owed = JSON.parse(state.get("owed:t-app"));
    owed[0].unreadSince = new Date(Date.now() - 25 * 60 * 60_000).toISOString();
    state.set("owed:t-app", JSON.stringify(owed));
    await loop.runGrades();
    assert.deepEqual(calls, [["setStatus", "done"], ["tell", "done"]], "an answer that never comes does not hold the close forever");
    assert.match(String(notes.at(-1)), /could not be read just now[\s\S]*closed ungraded/, "the close says the deliverable could not be read, not that it was there");
    assert.match(String(notes.at(-1)), /<!-- aidenhq:grader -->$/, "and keeps the grader's marker: an unmarked close would be read as the task's own evidence if it were reopened");
    assert.equal(JSON.parse(state.get("owed:t-app") || "[]").length, 0, "the unread marker is dropped once the close lands");
  });

it("an unreadable-deliverable close rewrites the queued parent notice to say ungraded too", async () => {
    // The notice was queued with the close's first wording ("its deliverable could not be read" was not known yet). A parent
    // told the task "is done, ungraded: <reason>" must not keep a notice saying it finished graded, and a missing deliverable
    // must not be told as the same thing.
    let down = true;
    const over = {
      id: "t-app", outcome: "cannot_judge", version: "", deliverable: { kind: "app", ref: "roadmap-keeper" },
      gather: () => ({ facts: [], awaiting: "roadmap-keeper: could not be read just now" }),
      gradeDeps: () => ({ app: async () => (down ? undefined : null) }),
    };
    const { loop, tells, notes, failing, state } = setup("satisfied", over);
    failing.done = 0;
    await loop.runGrades();
    assert.equal(tells.length, 0, "the wait tells nobody");
    const owed = JSON.parse(state.get("owed:t-app"));
    owed[0].unreadSince = new Date(Date.now() - 25 * 60 * 60_000).toISOString();
    state.set("owed:t-app", JSON.stringify(owed));
    await loop.runGrades();
    assert.match(String(notes.at(-1)), /could not be read just now/, "the close says it was unreadable");
    assert.match(String(tells.at(-1)), /is done, ungraded: its deliverable could not be read just now/, "and the parent is told the same, not that it finished graded");
    assert.doesNotMatch(String(tells.at(-1)), /graded against its rubric/);
  });

it("a title that contains 'Its result is on' never moves the parent's pointer", async () => {
    // The notice is rendered from the queued fields now, never parsed back out of its own sentence: a free-text title can carry
    // the very phrase a parser would split on, which would send the parent to the wrong task.
    let down = true;
    const over = {
      id: "t-app", title: "Verify the deployment. Its result is on TASK-99", identifier: "TASK-42",
      outcome: "cannot_judge", version: "", deliverable: { kind: "app", ref: "roadmap-keeper" },
      gather: () => ({ facts: [], awaiting: "roadmap-keeper: could not be read just now" }),
      gradeDeps: () => ({ app: async () => (down ? undefined : null) }),
    };
    const { loop, tells, failing, state } = setup("satisfied", over);
    failing.done = 0;
    await loop.runGrades();
    const owed = JSON.parse(state.get("owed:t-app"));
    owed[0].unreadSince = new Date(Date.now() - 25 * 60 * 60_000).toISOString();
    state.set("owed:t-app", JSON.stringify(owed));
    await loop.runGrades();
    // The title itself carries that phrase, so it shows up in the notice as the title does; the pointer at the end must be the
    // task's own identifier, which is what the parent follows.
    assert.match(String(tells.at(-1)), /Its result is on TASK-42\.$/, "the real task identifier, not the one in the title");
  });

it("the revised parent notice is saved before the close, so a lost answer still sends it", async () => {
    // The close PATCH can land and its answer be lost. The next pass then sees the task done and never rewrites anything, so it
    // must read the ungraded notice from the owed row already, not the "graded against its rubric" one queued with the close.
    let down = true;
    const over = {
      id: "t-app", outcome: "cannot_judge", version: "", deliverable: { kind: "app", ref: "roadmap-keeper" },
      gather: () => ({ facts: [], awaiting: "roadmap-keeper: could not be read just now" }),
      gradeDeps: () => ({ app: async () => (down ? undefined : null) }),
    };
    const { loop, tells, failing, state } = setup("satisfied", over);
    failing.done = 1; // the close lands on the server, but the answer is lost
    await loop.runGrades();
    const owed = JSON.parse(state.get("owed:t-app"));
    owed[0].unreadSince = new Date(Date.now() - 25 * 60 * 60_000).toISOString();
    state.set("owed:t-app", JSON.stringify(owed));
    await loop.runGrades(); // the close is filed; its answer is lost, so the row stays owed
    assert.equal(tells.length, 0, "the close did not report success");
    // The stored tell is already the ungraded one, so the retry that sees the task done sends it.
    const saved = JSON.parse(state.get("owed:t-app")).find((x) => x.do === "tell");
    assert.equal(saved.ungraded, "its deliverable could not be read just now (app)");
    over.status = "done";
    await loop.runGrades();
    assert.match(String(tells.at(-1)), /is done, ungraded: its deliverable could not be read just now/);
    assert.doesNotMatch(String(tells.at(-1)), /graded against its rubric/);
  });

it("a held close whose deliverable was unreadable says so, never that the deliverable is there", async () => {
    const { loop, calls, notes, failing } = setup("satisfied", { awaiting: "checks still running", version: "", esc: { hold: true, present: false, facts: ["registry did not answer"] } });
    failing.done = 0;
    await loop.runGrades();
    const ungraded = calls.filter((c) => c[0] === "setStatus" && c[1] === "done");
    assert.equal(ungraded.length, 1);
    assert.match(String(notes.at(-1)), /could not be read just now \(registry did not answer\), so its close was not checked/);
    assert.doesNotMatch(String(notes.at(-1)), /deliverable is there/);
  });

});

describe("grade loop presence with several recorded PRs", () => {
it("a confirmed merged PR makes a versionless close stale even when another PR's read failed", async () => {
  // presentNow answers both present and unknown here (one PR merged, another unreadable). Presence is proof the close is
  // stale; waiting out the uncertainty would leave an old close queued over work that already landed.
  const { loop, calls, posts, failing } = setup("satisfied", {
    id: "t-mixed", outcome: "cannot_judge", version: "", deliverable: { kind: "pr", ref: "" },
    gather: () => ({ facts: [], awaiting: "one of its PRs could not be read just now" }),
    presentNow: async () => ({ present: true, unknown: true, facts: [`its PR 1 is merged`, `its PR 2 could not be read just now`] }),
  });
  failing.done = 0;
  await loop.runGrades();
  assert.deepEqual(calls, [], "the close never lands over a merged PR");
  assert.equal(posts.filter(([p, b]) => /verdict/.test(p) && b?.outcome === "awaiting_evidence").length, 1, "sent back to grading");
  // Its grade's own answer was recorded first (the row was satisfied); the stale change then sends it back to grading. What it
  // must not do is write the gave-up "error" outcome the unreadable wait would have produced.
  const errors = posts.filter(([p, b]) => /verdict/.test(p) && b?.outcome === "error");
  assert.ok(errors.every(([, b]) => b.version !== "" || b.reason !== "gaveUp"), "and never the gave-up close on the unreadable one");
  assert.ok(!errors.some(([, b]) => String(b.reason ?? "").includes("could not be read")), "no unreadable-close reason is written");
});
});
