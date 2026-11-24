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
  const g = { issueId: over.id ?? "t", state: "pending", round: 1, updatedAt: over.updatedAt ?? "2020-01-01T00:00:00Z", rubric: [], deliverable: over.deliverable ?? { kind: "report" }, attempts: 0 };
  const rows = [g];
  const err = () => Object.assign(new Error("502"), { status: 502 });
  // The task's own status, as the kernel holds it: a close that lands moves it to done, and the loop reads it back before it
  // tells the parent. A close whose answer is lost leaves it as it was (the PATCH reached the server but the caller saw 502).
  let status = over.status ?? "in_review";
  const loop = createGradeLoop({
    // The store's own hash: an amended rubric's hash is not the one a queued verdict names, which is how a stale revision move is
    // told from a live one. Here the rubric never changes, so the hash is a stable stand-in.
    api: { get: async (p: string) => (p === "/internal/grades" ? { grades: rows.filter((r) => r.state === "pending"), resubmitted: [] } : { state: g.state, round: g.round }), post: async (path, body) => { posts.push([path, body]); g.state = row; return { state: row, round: g.round, attempts: 1, failures: 0, applied: true }; } },
    pc: {
      // A test can move the task behind the loop's back (over.status): the close's answer was lost, but its PATCH landed.
      issue: async () => ({ id: g.issueId, identifier: over.identifier ?? "T-1", title: over.title ?? "x", status: over.status ?? status, parentId: "p" }),
      agent: async () => undefined,
      setStatus: async (id, s, note) => { if (s === "done" && failing.done-- > 0) throw err(); status = s; calls.push(["setStatus", s]); notes.push(note); },
      comment: async () => calls.push(["comment"]), block: async () => {}, children: async () => over.children ?? [],
    },
    log: () => {}, state,
    gather: async (...a) => (over.gather ? over.gather(...a) : { facts: [], version: over.version ?? "v1", ...(over.awaiting ? { awaiting: over.awaiting } : {}), ...(over.missing ? { missing: true } : {}) }), grade: async () => ({ outcome: over.outcome ?? row, model: "m", criteria: [] }),
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
    // stays owed and is retried; once the registry answers with no such app it lands ungraded as before. The row is fresh: a
    // versionless close is queued now, and its own day bounds the wait for the presence answer.
    let down = true;
    const over = {
      id: "t-app", updatedAt: new Date(Date.now() - 11 * 60_000).toISOString(), missing: true, outcome: "cannot_judge", version: "", deliverable: { kind: "app", ref: "roadmap-keeper" },
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
      id: "t-app", updatedAt: new Date(Date.now() - 11 * 60_000).toISOString(), missing: true, outcome: "cannot_judge", version: "", deliverable: { kind: "app", ref: "roadmap-keeper" },
      gradeDeps: () => ({ app: async () => (down ? undefined : null) }),
    };
    const { loop, calls, notes, failing, state } = setup("satisfied", over);
    failing.done = 0;
    await loop.runGrades();
    assert.deepEqual(calls, [], "the first pass waits");
    // The close's own day is spent: the same unreadable answer now ends it.
    const owed = JSON.parse(state.get("owed:t-app"));
    owed[0].closeDeadline = new Date(Date.now() - 60_000).toISOString();
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
      id: "t-app", updatedAt: new Date(Date.now() - 11 * 60_000).toISOString(), missing: true, outcome: "cannot_judge", version: "", deliverable: { kind: "app", ref: "roadmap-keeper" },
      gradeDeps: () => ({ app: async () => (down ? undefined : null) }),
    };
    const { loop, tells, notes, failing, state } = setup("satisfied", over);
    failing.done = 0;
    await loop.runGrades();
    assert.equal(tells.length, 0, "the wait tells nobody");
    const owed = JSON.parse(state.get("owed:t-app"));
    owed[0].closeDeadline = new Date(Date.now() - 60_000).toISOString();
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
      id: "t-app", title: "Verify the deployment. Its result is on TASK-99", identifier: "TASK-42", updatedAt: new Date(Date.now() - 11 * 60_000).toISOString(), missing: true,
      outcome: "cannot_judge", version: "", deliverable: { kind: "app", ref: "roadmap-keeper" },
      gradeDeps: () => ({ app: async () => (down ? undefined : null) }),
    };
    const { loop, tells, failing, state } = setup("satisfied", over);
    failing.done = 0;
    await loop.runGrades();
    const owed = JSON.parse(state.get("owed:t-app"));
    owed[0].closeDeadline = new Date(Date.now() - 60_000).toISOString();
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
      id: "t-app", updatedAt: new Date(Date.now() - 11 * 60_000).toISOString(), missing: true, outcome: "cannot_judge", version: "", deliverable: { kind: "app", ref: "roadmap-keeper" },
      gradeDeps: () => ({ app: async () => (down ? undefined : null) }),
    };
    const { loop, tells, failing, state } = setup("satisfied", over);
    failing.done = 1; // the close lands on the server, but the answer is lost
    await loop.runGrades();
    const owed = JSON.parse(state.get("owed:t-app"));
    owed[0].closeDeadline = new Date(Date.now() - 60_000).toISOString();
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


it("a versionless close returns to grading as soon as gathering finds a version, never waiting on an outage", async () => {
  // The close is queued while the app has no readable evidence (no version), then the deploy lands: on replay gather() has the
  // version, so the close is stale whatever the presence check would say. A transient outage there must not leave the old
  // close queued for another day.
  let looked = 0, deployed = false;
  const { loop, calls, posts, failing, state } = setup("satisfied", {
    id: "t-late", outcome: "cannot_judge", version: "", deliverable: { kind: "app", ref: "roadmap-keeper" },
    gather: () => ({ facts: [], version: deployed ? "roadmap-keeper@abc123" : "" }),
    presentNow: async () => { looked++; return { present: false, unknown: true, facts: ["registry did not answer"] }; },
  });
  failing.done = 1; // the close PATCH fails, so the close stays owed and is replayed on the next pass
  await loop.runGrades();
  deployed = true;
  await loop.runGrades(); // the deploy is there, and the presence check is down
  // The first pass checked presence (there was no evidence to read); the replay does not, because gather() already has the version.
  assert.equal(looked, 1, "the presence check does not run again over a version already in hand");
  assert.deepEqual(calls, [], "the close never lands");
  assert.equal(posts.filter(([p, b]) => /verdict/.test(p) && b?.outcome === "awaiting_evidence").length, 1, "sent back to grading");
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
});

describe("grade loop: the day a grade may wait is a hard bound", () => {
const long = (h) => new Date(Date.now() - h * 60 * 60_000).toISOString();

it("a busy signal that never clears does not suppress the day: the task closes done, ungraded", async () => {
  // The jobs table can hold a `running` row with no process behind it, so busy() can stay true forever. The day is the one
  // bound that holds whatever the evidence says: past it the row takes the existing fail-open close.
  const { loop, calls, notes, tells, failing } = setup("satisfied", {
    updatedAt: long(25), outcome: "cannot_judge", version: "",
    gather: () => ({ awaiting: "the agent is still working on it", busy: true }),
    escalationFor: async () => ({ reason: "still waiting for its evidence a day after it was finished: the agent is still working on it" }),
  });
  failing.done = 0;
  await loop.runGrades();
  assert.deepEqual(calls.filter((c) => c[0] === "setStatus"), [["setStatus", "done"]], "busy no longer defers the day");
  assert.match(String(notes.at(-1)), /^ungraded: still waiting for its evidence a day after it was finished/, "the note says why, ungraded");
  assert.match(String(tells.at(-1)), /is done, ungraded: still waiting for its evidence a day after it was finished/);
});

it("a gather() that throws before the deadline is retried, never closed", async () => {
  // A deterministic throw is not evidence that evidence is coming: before the day it only logs and retries (runGrades' own
  // catch), leaving the row for the next pass.
  const { loop, calls } = setup("satisfied", {
    updatedAt: long(1), outcome: "cannot_judge", version: "",
    gather: () => { throw new Error("the PR read threw"); },
  });
  await loop.runGrades();
  assert.deepEqual(calls, [], "nothing closes before the day");
});

it("a gather() that throws past the day takes the same fail-open close, naming the throw", async () => {
  const { loop, calls, notes, tells, failing } = setup("satisfied", {
    updatedAt: long(25), outcome: "cannot_judge", version: "",
    gather: () => { throw new Error("the PR read threw"); },
  });
  failing.done = 0;
  await loop.runGrades();
  assert.deepEqual(calls.filter((c) => c[0] === "setStatus"), [["setStatus", "done"]], "a throw past the day closes like any other wait");
  assert.match(String(notes.at(-1)), /^ungraded: gathering its evidence failed a day after it was finished: the PR read threw/);
  assert.match(String(tells.at(-1)), /is done, ungraded: gathering its evidence failed/);
});

it("a day-bound close is not undone by the busy signal it outlived when its close is replayed", async () => {
  // The close PATCH fails (502) and is retried on the next pass. Its replay must not re-gather the evidence and read the same
  // busy as "still moving": that would send the row back to waiting and let the stuck signal suppress the bound again.
  const { loop, calls, failing } = setup("satisfied", {
    updatedAt: long(25), outcome: "cannot_judge", version: "",
    gather: () => ({ awaiting: "the agent is still working on it", busy: true }),
    escalationFor: async () => ({ reason: "still waiting for its evidence a day after it was finished" }),
  });
  failing.done = 1;
  await loop.runGrades();
  assert.deepEqual(calls, [], "the first close's answer was lost: it stays owed");
  await loop.runGrades();
  assert.deepEqual(calls.filter((c) => c[0] === "setStatus"), [["setStatus", "done"]], "the replay lands the close, not a return to waiting");
});

it("a gather() that keeps throwing past the day does not keep its close owed forever", async () => {
  // The close is decided at the day bound from the throw; the same throw on every replay must not re-raise and hold the row.
  const { loop, calls, failing } = setup("satisfied", {
    updatedAt: long(25), outcome: "cannot_judge", version: "",
    gather: () => { throw new Error("the PR read threw"); },
  });
  failing.done = 1;
  await loop.runGrades();
  assert.deepEqual(calls, [], "the first close's answer was lost: it stays owed");
  await loop.runGrades();
  assert.deepEqual(calls.filter((c) => c[0] === "setStatus"), [["setStatus", "done"]], "the replay lands it, the throw notwithstanding");
});


it("a day-bound close reopens when the replay reads a new version, never closing over landable work", async () => {
  // The first pass closed at the day bound while gather() threw. Its PATCH was lost, and by the replay the read works and holds
  // a version: that is a deliverable which appeared since, and it is graded rather than closed ungraded on the stale close.
  let throwing = true;
  const { loop, calls, posts, failing } = setup("satisfied", {
    updatedAt: long(25), outcome: "cannot_judge", version: "",
    gather: () => { if (throwing) throw new Error("the PR read threw"); return { facts: [], version: "acme/app#7" }; },
  });
  failing.done = 1;
  await loop.runGrades();
  assert.deepEqual(calls, [], "the first close's answer was lost: it stays owed");
  throwing = false;
  await loop.runGrades();
  assert.deepEqual(calls, [], "the recovered version makes the close stale, not a close ungraded");
  assert.equal(posts.filter(([p, b]) => /verdict/.test(p) && b?.outcome === "awaiting_evidence").length, 1, "sent back to grading");
});


it("a deliverable the day-bound close already reported present does not reopen it on replay", async () => {
  // An app is deployed but the live page its rubric needs never renders: gather() has no version and the presence check finds
  // the app. The close says its evidence never settled. Replaying it must not read the same finding as "it appeared since"
  // and park the row awaiting evidence again, which would restart the day and never end the wait.
  const { loop, calls, notes, failing } = setup("satisfied", {
    updatedAt: long(25), outcome: "cannot_judge", version: "", deliverable: { kind: "app", ref: "roadmap-keeper" },
    gather: () => ({ facts: [], awaiting: "roadmap-keeper: its live page never rendered" }),
    escalationFor: async () => ({ hold: true, present: true, facts: ["app roadmap-keeper: deployed c0ffee"] }),
    presentNow: async () => ({ present: true, facts: ["app roadmap-keeper: deployed c0ffee"] }),
  });
  failing.done = 1;
  await loop.runGrades();
  assert.deepEqual(calls, [], "the first close's answer was lost: it stays owed");
  await loop.runGrades();
  assert.deepEqual(calls.filter((c) => c[0] === "setStatus"), [["setStatus", "done"]], "the replay closes instead of reopening");
  assert.match(String(notes.at(-1)), /^ungraded: its deliverable is there/, "the note says what the close found");
});

it("a stuck busy signal at the day does not hide evidence that is there: the pass reads past it", async () => {
  // A job row stuck `running` makes busy() true forever, and gather() returns on it before reading the PR. Past the day the loop
  // asks gather through a deps whose busy() is empty, so the evidence that is there is read rather than the task closed over a
  // PR the grader never looked at.
  const asked = [];
  const { loop } = setup("satisfied", {
    updatedAt: long(25), outcome: "satisfied", deliverable: { kind: "pr", ref: "acme/app#7" },
    gather: (deliverable, deps) => { asked.push(deps.busy()); return { facts: [], version: "acme/app#7@abc" }; },
    gradeDeps: () => ({ busy: () => "the agent is still working on it" }),
  });
  await loop.runGrades();
  assert.ok(asked.length > 0 && asked.every((b) => b === ""), "past the day every read (pass and close replay) is past the stuck signal");
});

it("a fresh row keeps the busy signal in the read, so it still waits", async () => {
  const asked = [];
  const { loop } = setup("satisfied", {
    updatedAt: long(1), outcome: "satisfied", deliverable: { kind: "pr", ref: "acme/app#7" },
    gather: (deliverable, deps) => { asked.push(deps.busy()); return { awaiting: "the agent is still working on it", busy: true }; },
    gradeDeps: () => ({ busy: () => "the agent is still working on it" }),
  });
  await loop.runGrades();
  assert.deepEqual(asked, ["the agent is still working on it"], "before the day the signal is still what gather sees");
});

it("a day-bound close keeps its recorded gather failure when the presence lookup is unreadable", async () => {
  // The close says its evidence could not be gathered (the throw). Its replay meets an unreadable presence lookup: it must land on
  // the recorded reason, not replace it with a vaguer "could not be read".
  const { loop, calls, notes, failing } = setup("satisfied", {
    updatedAt: long(25), outcome: "cannot_judge", version: "",
    gather: () => { throw new Error("the PR read threw"); },
    escalationFor: async () => ({ hold: true, present: false, facts: [] }),
    presentNow: async () => ({ present: false, unknown: true, facts: [] }),
  });
  failing.done = 1;
  await loop.runGrades();
  await loop.runGrades();
  assert.deepEqual(calls.filter((c) => c[0] === "setStatus"), [["setStatus", "done"]], "the replay lands");
  assert.match(String(notes.at(-1)), /gathering its evidence failed a day after it was finished: the PR read threw/, "the recorded throw, not a lookup's words");
});

it("a close queued before closes carried a deadline gets one, so its replay is still bounded", async () => {
  // Seed a close as an older release queued it (no closeDeadline), with an unreadable presence lookup behind it.
  const { loop, calls, failing, state } = setup("satisfied", { id: "t-legacy", deliverable: { kind: "app", ref: "roadmap-keeper" }, gather: () => ({ facts: [] }), presentNow: async () => ({ present: false, unknown: true, facts: [] }) });
  failing.done = 0;
  state.set("owed:t-legacy", JSON.stringify([{ do: "done", note: "note", ungraded: true, version: "", status: "in_review", round: 1, deliverable: { kind: "app", ref: "roadmap-keeper" }, rubric: [], filing: "rubric" }]));
  await loop.runGrades();
  const owed = JSON.parse(state.get("owed:t-legacy") || "[]");
  assert.equal(typeof owed[0]?.closeDeadline, "string", "a legacy close is stamped with a deadline");
  assert.deepEqual(calls, [], "a fresh stamp does not let the unreadable close land at once");
  assert.equal(JSON.parse(state.get("owed:t-legacy"))[0].closeDeadline, owed[0].closeDeadline, "the stamp is saved, not recomputed each pass");
});
it("a legacy close already decided at the day bound is stamped expired, never given a fresh day", async () => {
  // A close from the intermediate release carries `dayBound` and no deadline. Stamping it now + a day would give a close that
  // already spent its bound another 24 hours; it must land on its first replay instead.
  const { loop, calls, notes, failing, state } = setup("satisfied", {
    id: "t-daybound", deliverable: { kind: "app", ref: "roadmap-keeper" },
    gather: () => { throw new Error("the registry read threw"); },
    presentNow: async () => ({ present: false, facts: [] }),
  });
  failing.done = 0;
  state.set("owed:t-daybound", JSON.stringify([{ do: "done", note: "ungraded: its deliverable is there but its evidence never settled", ungraded: true, dayBound: true, version: "", status: "in_review", round: 1, deliverable: { kind: "app", ref: "roadmap-keeper" }, rubric: [], filing: "rubric" }]));
  await loop.runGrades();
  const owed = JSON.parse(state.get("owed:t-daybound") || "[]");
  assert.equal(owed.length, 0, "the close landed on its first replay, not after another day");
  assert.deepEqual(calls, [["setStatus", "done"]], "a dayBound legacy close closes now");
  assert.match(String(notes.at(-1)), /ungraded/, "still ungraded");
});

it("a legacy close that already confirmed its deliverable is not reopened by the replay", async () => {
  // Before closes carried `sawPresent`, the confirmed finding was kept as `sawPresentFacts`. A close that recorded the
  // deliverable was there has already compared it: the replay must not read it as one that appeared since and park the row
  // awaiting evidence again, restarting the day.
  const { loop, calls, posts, failing, state } = setup("satisfied", { id: "t-saw", deliverable: { kind: "pr", ref: "acme/app#7" }, gather: () => ({ facts: [] }), presentNow: async () => ({ present: true, facts: ["pr acme/app#7 is merged"] }) });
  failing.done = 0;
  state.set("owed:t-saw", JSON.stringify([{ do: "done", note: "ungraded: its deliverable is there but its evidence never settled", ungraded: true, sawPresentFacts: ["pr acme/app#7 is merged"], closeDeadline: new Date(Date.now() - 60_000).toISOString(), version: "", status: "in_review", round: 1, deliverable: { kind: "pr", ref: "acme/app#7" }, rubric: [], filing: "rubric" }]));
  await loop.runGrades();
  assert.deepEqual(calls, [["setStatus", "done"]], "the recorded presence does not reopen the close");
  assert.equal(posts.filter(([p, b]) => /verdict/.test(p) && b?.outcome === "awaiting_evidence").length, 0, "the row is not parked awaiting evidence again");
});

it("a busy signal on a fresh row still waits, as before", async () => {
  const { loop, calls, notes, posts } = setup("satisfied", {
    updatedAt: long(1), outcome: "cannot_judge", version: "",
    gather: () => ({ awaiting: "the agent is still working on it", busy: true }),
    escalationFor: async () => ({ reason: "not reached" }),
  });
  await loop.runGrades();
  assert.deepEqual(calls, [], "a fresh busy row is not closed");
  assert.equal(notes.length, 0);
  assert.equal(posts.filter(([p, b]) => /verdict/.test(p) && b?.outcome === "awaiting_evidence").length, 1, "it is parked awaiting evidence");
});
});
