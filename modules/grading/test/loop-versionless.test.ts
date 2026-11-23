// The grade loop's owed moves for a versionless close: a deliverable that is present makes the close stale, one that cannot be
// read is waited out and then closed ungraded saying so, and the parent's notice is rendered from the queued fields, saved
// before the close lands.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createGradeLoop } from "../service/src/loop.ts";
import { presentNow } from "../service/src/grader/evidence.ts";

function setup(row, over = {}) {
  const kv = new Map(), calls = [], posts = [], notes = [], tells = [], logs = [], failing = { done: 1, tell: 0 };
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
    api: { get: async (p: string) => (p === "/internal/grades" ? { grades: rows.filter((r) => r.state === "pending"), resubmitted: [] } : { state: g.state, round: g.round }), post: async (path, body) => { posts.push([path, body]); g.state = row; return { state: row, round: g.round, attempts: 1, failures: 0 }; } },
    pc: {
      // A test can move the task behind the loop's back (over.status): the close's answer was lost, but its PATCH landed.
      issue: async () => ({ id: g.issueId, identifier: over.identifier ?? "T-1", title: over.title ?? "x", status: over.status ?? status, parentId: "p" }),
      agent: async () => undefined,
      setStatus: async (id, s, note) => { if (s === "done" && failing.done-- > 0) throw err(); status = s; calls.push(["setStatus", s]); notes.push(note); },
      comment: async () => calls.push(["comment"]), block: async () => {}, children: async () => over.children ?? [],
    },
    log: (...args) => logs.push(args), state,
    gather: async (_d, deps) => (over.gather ? over.gather(_d, deps) : { facts: [], version: over.version ?? "v1", ...(over.awaiting ? { awaiting: over.awaiting } : {}), ...(over.missing ? { missing: true } : {}) }), grade: async () => { if (over.gradeFails) throw new Error("the grader answered 502"); return { outcome: over.outcome ?? row, model: "m", criteria: [] }; },
    escalationFor: over.escalationFor ?? (async () => over.esc ?? {}), presentNow: over.presentNow ?? presentNow, gradeNote: (_g, _r, outcome, o) => (outcome === "ungraded" ? `ungraded: ${o?.reason}` : "note"), template: () => [], gradeDeps: over.gradeDeps ?? (() => ({})),
    tellParent: async (_i, kind, text) => { if (failing.tell-- > 0) throw err(); calls.push(["tell", kind]); tells.push(text); return true; },
    recordsOn: async () => [], graderAsk: () => undefined, stripHidden: (x) => x, graderSpeaks: () => false, rubricHash: () => "rubric", graderMarker: "<!-- aidenhq:grader -->",
  });
  return { loop, calls, posts, notes, tells, logs, failing, state };
}

/** A row minutes old: past the 5s bridge-close guard, inside the day it may wait. */
const insideTheDay = () => new Date(Date.now() - 60_000).toISOString();

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
      // The close is queued inside the day (a satisfied grade with no version), so this tests the replay's unread wait.
      updatedAt: insideTheDay(),
      gather: () => ({ facts: [], version: "" }),
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
      // The close is queued inside the day (a satisfied grade with no version), so this tests the replay's unread wait.
      updatedAt: insideTheDay(),
      gather: () => ({ facts: [], version: "" }),
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
      // The close is queued inside the day (a satisfied grade with no version), so this tests the replay's unread wait.
      updatedAt: insideTheDay(),
      gather: () => ({ facts: [], version: "" }),
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
      // The close is queued inside the day (a satisfied grade with no version), so this tests the replay's unread wait.
      updatedAt: insideTheDay(),
      gather: () => ({ facts: [], version: "" }),
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
      // The close is queued inside the day (a satisfied grade with no version), so this tests the replay's unread wait.
      updatedAt: insideTheDay(),
      gather: () => ({ facts: [], version: "" }),
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

describe("the day-long fail-open", () => {
  const dayAgo = () => new Date(Date.now() - 25 * 60 * 60_000).toISOString();
  const stillBusy = { awaiting: "the agent is still working on it", busy: true };

it("a row past its day closes done, ungraded, even while the agent still looks busy", async () => {
    // A kernel job row stuck at "running" makes busy() say the agent is working forever. The day is the guarantee that every
    // wait ends, so it must not sit behind `!ev.busy`: the row closes done, ungraded, all the same.
    const { loop, calls, notes, logs, failing } = setup("satisfied", { updatedAt: dayAgo(), gather: () => stillBusy, esc: { reason: "finished without its deliverable: no pull request yet" } });
    failing.done = 0;
    await loop.runGrades();
    assert.deepEqual(calls.filter((c) => c[0] === "setStatus" && c[1] === "done").length, 1, "the close lands once");
    assert.match(String(notes.at(-1)), /ungraded: finished without its deliverable/, "and says the task closes ungraded");
    const line = logs.map((a) => a[0]).find((m) => /deadline passed/.test(String(m)));
    assert.ok(line, "the deadline's close leaves a line in the log");
    const fields = logs.find((a) => /deadline passed/.test(String(a[0])))[1];
    assert.equal(fields.issue, "T-1", "naming the task");
    assert.equal(fields.busy, true, "and that busy was set");
    assert.ok(fields.overdue_ms >= 0, "and how far past the deadline it was");
  });

it("a row past its day whose pass throws still closes done, ungraded, saying its evidence could not be read", async () => {
    // A deterministic throw is caught at runGrades() and retried forever while the row's updatedAt never moves. Past the day
    // it must reach the same close, on this pass, with a reason naming the unreadable evidence.
    const { loop, calls, notes, failing } = setup("satisfied", { updatedAt: dayAgo(), gather: () => { throw new Error("GitHub answered 502"); } });
    failing.done = 0;
    await loop.runGrades();
    assert.deepEqual(calls.filter((c) => c[0] === "setStatus" && c[1] === "done").length, 1, "the close is attempted on that pass, not retried forever");
    assert.match(String(notes.at(-1)), /ungraded: its evidence could not be read \(GitHub answered 502\)/, "the reason names the evidence it could not read");
  });

it("a row past its day whose pass throws is not left awaiting_evidence", async () => {
    // The throw's close is a close, never a fresh wait: parking the row awaiting evidence would be the same forever-retry.
    const { loop, calls, posts, failing } = setup("satisfied", { updatedAt: dayAgo(), gather: () => { throw new Error("GitHub answered 502"); } });
    failing.done = 0;
    await loop.runGrades();
    assert.deepEqual(calls, [["setStatus", "done"], ["tell", "done"]], "it closes the task and tells its parent");
    assert.equal(posts.filter(([p, b]) => /verdict/.test(p) && b?.outcome === "awaiting_evidence").length, 0, "no wait is written");
  });

it("a deadline close the task's own close answer lost still lands on the replay, though busy and the re-read throws", async () => {
    // The close is queued, then the setStatus answer is lost (a 502), so it replays. A stuck "running" job row makes the replay's
    // gather() throw, and busy again: neither may drop the close the day decided on.
    let throwReads = 0;
    const { loop, calls, state, failing } = setup("satisfied", {
      id: "t-busy", updatedAt: dayAgo(), version: "",
      gather: () => { if (throwReads++ === 0) return stillBusy; throw new Error("GitHub answered 502"); },
      esc: { reason: "finished without its deliverable: no pull request yet" },
    });
    failing.done = 1; // the close lands on the server, but its answer is lost
    await loop.runGrades();
    assert.equal(JSON.parse(state.get("owed:t-busy") || "[]").length, 2, "the close and the notice are still owed");
    assert.equal(JSON.parse(state.get("owed:t-busy"))[0].pastDay, true, "and the close is marked as past its day");
    await loop.runGrades();
    assert.ok(calls.some((c) => c[0] === "setStatus" && c[1] === "done"), "the replay still closes the task");
  });

it("past the day a busy agent's readable report is graded, not closed ungraded over a dead run's job row", async () => {
    // busy() returning before reading any evidence is what let a stuck "running" row outlive the deadline. Past it the look
    // ignores busy, so a report that is there is graded on its own facts.
    const { loop, calls, failing } = setup("satisfied", {
      updatedAt: dayAgo(), outcome: "satisfied", version: "v-report",
      gradeDeps: () => ({ busy: () => "the agent is still working on it" }),
      // The real gather() stops at busy before reading anything: that is what would close a readable report ungraded.
      gather: (_d, deps) => (deps.busy?.() ? { awaiting: "the agent is still working on it", busy: true } : { facts: [], version: "v-report" }),
    });
    failing.done = 0;
    await loop.runGrades();
    assert.deepEqual(calls.filter((c) => c[0] === "setStatus" && c[1] === "done").length, 1, "it closes");
  });

it("past the day a readable report behind a stuck busy row closes through settlement, not back to waiting", async () => {
    // Settlement re-gathers at once. With busy restored it sees no version and drops the close it just queued, so the row
    // churns forever. A graded report must land done on that same pass.
    const { loop, calls, posts, failing } = setup("satisfied", {
      updatedAt: dayAgo(), outcome: "satisfied", version: "v-report",
      gradeDeps: () => ({ busy: () => "the agent is still working on it" }),
      // The real gather() stops at busy before reading anything: a busy look has no version.
      gather: (_d, deps) => (deps.busy?.() ? { awaiting: "the agent is still working on it", busy: true } : { facts: [], version: "v-report" }),
    });
    failing.done = 0; // settlement runs at once; it must re-read the same version, never reopen the wait
    await loop.runGrades();
    assert.ok(calls.some((c) => c[0] === "setStatus" && c[1] === "done"), "the close lands");
    assert.equal(posts.filter(([p, b]) => /verdict/.test(p) && b?.outcome === "awaiting_evidence").length, 0, "the row is never sent back to waiting");
  });

it("a grader throw past the day keeps the version the evidence read, so settlement does not call it new", async () => {
    // gather() succeeded (a readable report) and only grade() threw. Clearing the version would make settlement re-read the same
    // report as newly arrived and reopen the row, every pass.
    const { loop, calls, posts, failing } = setup("satisfied", {
      updatedAt: dayAgo(), outcome: "satisfied", version: "v-report",
      gather: (_d, deps) => (deps.busy?.() ? { awaiting: "the agent is still working on it", busy: true } : { facts: [], version: "v-report" }),
      gradeFails: true,
    });
    failing.done = 0;
    await loop.runGrades();
    const filed = posts.find(([p, b]) => /verdict/.test(p) && b?.outcome === "error");
    assert.ok(filed, "the ungraded close is filed");
    assert.equal(filed[1].version, "v-report", "with the version the read produced, so settlement sees the same deliverable");
    assert.equal(filed[1].reason, undefined, "an error verdict carries no grading_failed reason field");
    assert.ok(calls.some((c) => c[0] === "setStatus" && c[1] === "done"), "and the task closes done");
  });

it("a past-day close whose replay finds its evidence temporarily unreadable still lands", async () => {
    // The replay's gather() answers `awaiting` because a live page could not be captured, not because anything changed: that
    // must not reopen the wait and start another day.
    let reads = 0;
    const { loop, calls, failing } = setup("satisfied", {
      id: "t-outage", updatedAt: dayAgo(), version: "v-report", outcome: "satisfied",
      // The first look reads the report; the replay's look finds the page unreadable, as a transient outage would.
      gather: () => (++reads === 1 ? { facts: [], version: "v-report" } : { facts: [], awaiting: "its live page could not be captured" }),
    });
    failing.done = 1; // the close lands, its answer is lost: the next pass's replay decides
    await loop.runGrades();
    assert.deepEqual(calls, [], "the first answer is lost");
    await loop.runGrades();
    assert.ok(calls.some((c) => c[0] === "setStatus" && c[1] === "done"), "the replay still closes it");
  });

it("a day-forced close is not dropped over unrelated movement in what presence names", async () => {
    // Presence names a merged PR and every open one, so another PR's checks finishing changes the text while nothing about the
    // made close changed. Comparing that text would reopen the wait and restart the day, forever: presence is recorded as a fact.
    let present = ["acme/app#7 is merged", "acme/app#8 is open, not merged yet (checks still running: ci-required)"];
    const { loop, calls, failing } = setup("satisfied", {
      id: "t-pr", updatedAt: dayAgo(), version: "", deliverable: { kind: "pr", ref: "acme/app#7" },
      gather: () => ({ facts: [], awaiting: "acme/app#7: its evidence could not be read just now" }),
      esc: { present: true, hold: true, facts: present },
      presentNow: async () => ({ present: true, facts: present }),
    });
    failing.done = 1; // the close is queued, its answer is lost
    await loop.runGrades();
    present = ["acme/app#7 is merged", "acme/app#8 is open, not merged yet"];
    await loop.runGrades();
    assert.ok(calls.some((c) => c[0] === "setStatus" && c[1] === "done"), "the replay still closes the task");
  });

it("a day-forced close records the deliverable it saw present, so its replay does not read it as new", async () => {
    // The app is deployed but its live page cannot be captured, so the close is ungraded with no version. The replay's presence
    // check confirms the same deployment; that is the one the close already saw, not work that arrived since.
    const { loop, calls, failing } = setup("satisfied", {
      id: "t-app", updatedAt: dayAgo(), version: "", deliverable: { kind: "app", ref: "roadmap-keeper" },
      gather: () => ({ facts: [], awaiting: "roadmap-keeper: its live page could not be captured" }),
      esc: { present: true, hold: true, facts: ["app roadmap-keeper: c0ffee deployed 2026-11-22 (healthy)"] },
      presentNow: async () => ({ present: true, facts: ["app roadmap-keeper: c0ffee deployed 2026-11-22 (healthy)"] }),
    });
    failing.done = 1; // the close lands, its answer is lost: the replay decides
    await loop.runGrades();
    await loop.runGrades();
    assert.deepEqual(calls.filter((c) => c[0] === "setStatus"), [["setStatus", "done"]], "the same deployment does not drop or repeat the close");
  });

it("a past-day close whose replay finds its deliverable gone is stale, not closed on the old evidence", async () => {
    // Absence is an answer. The report was read when the close was queued; on replay the deliverable is confirmed missing, so the
    // old version cannot stand in for it.
    let reads = 0;
    const { loop, posts, failing } = setup("satisfied", {
      id: "t-gone", updatedAt: dayAgo(), version: "v-report", outcome: "satisfied",
      gather: () => (++reads === 1 ? { facts: [], version: "v-report" } : { facts: [], awaiting: "no deliverable yet", missing: true }),
    });
    failing.done = 1; // the close lands, its answer is lost: the replay decides
    await loop.runGrades();
    await loop.runGrades();
    assert.equal(posts.filter(([p, b]) => /verdict/.test(p) && b?.outcome === "awaiting_evidence").length, 1, "sent back to grading");
  });

it("a close queued inside the day still lands when its replay starts throwing after the day", async () => {
    // The close was decided inside the day; by its replay the row's day has passed and the evidence read now throws. It must not
    // rethrow forever: the day it reached is the same fail-open, carried in the queued step.
    let throws = false;
    const { loop, calls, state, failing } = setup("satisfied", {
      id: "t-late-throw", updatedAt: insideTheDay(), version: "v-report", outcome: "satisfied",
      gather: () => { if (throws) throw new Error("GitHub answered 502"); return { facts: [], version: "v-report" }; },
    });
    failing.done = 1; // the close lands, its answer is lost
    await loop.runGrades();
    const owed = JSON.parse(state.get("owed:t-late-throw"));
    assert.ok(typeof owed[0].deadlineAt === "number", "the queued close carries the row's own deadline");
    throws = true;
    owed[0].deadlineAt = Date.now() - 1_000; // the row has now been past its day for a second
    state.set("owed:t-late-throw", JSON.stringify(owed));
    await loop.runGrades();
    assert.ok(calls.some((c) => c[0] === "setStatus" && c[1] === "done"), "the close lands rather than retrying forever");
  });

it("a row still inside its day whose pass throws keeps today's behaviour: logged and retried, never closed", async () => {
    // Before the deadline a throw is a transient failure: the row is left exactly as it was for the next pass.
    const { loop, calls, posts } = setup("satisfied", { updatedAt: insideTheDay(), gather: () => { throw new Error("GitHub answered 502"); } });
    await loop.runGrades();
    assert.deepEqual(calls, [], "nothing closes");
    assert.deepEqual(posts, [], "and no verdict is written");
  });

it("a row still inside its day with a busy agent stays waiting, unwoken", async () => {
    // `busy` still holds back the nudge and the short missing-deliverable bound. Before the day, a busy task is simply waiting.
    const { loop, calls, posts, state } = setup("satisfied", { updatedAt: insideTheDay(), gather: () => stillBusy });
    await loop.runGrades();
    assert.deepEqual(calls, [], "nothing is closed or woken");
    assert.equal(posts.filter(([p, b]) => /verdict/.test(p) && b?.outcome === "awaiting_evidence").length, 1, "the row waits as awaiting_evidence");
    assert.equal(state.get("evidence-woken:t"), undefined, "no wake was written");
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
});
