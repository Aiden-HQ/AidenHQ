// The grade loop in the grading module (phase 2 W7): the runner's loop (src/loop.ts) with its executor dependencies swapped for the
// kernel's. A reopened task wakes its agent through the kernel (a reopen wake), so the loop no longer dispatches an Engineer itself;
// a verdict's task move (done, todo + note) is the finish check's own resolve (POST /v1/checks/:task). Its per-task memory
// (evidence-woken) is rows in the grades database (kernel-loop.ts). Unstarted until the switch.
// The injected collaborators (the kernel's api client, Paperclip's client, the grade store) and the rows they return are loosely typed.
import { openCard } from "./grader/cards.ts";

type Json = any;
export function createGradeLoop({ api, pc, log, state, gather, grade, escalationFor, presentNow, gradeNote, template, gradeDeps, tellParent, recordsOn, graderAsk, stripHidden, graderSpeaks, rubricHash, graderMarker, emit = () => {} }: {
  api: Json;
  pc: Json;
  log: (...a: unknown[]) => void;
  state: Json;
  gather: Json;
  grade: Json;
  escalationFor: Json;
  /** The deliverable's presence check (`grader/evidence.ts`'s presentNow), injected so this loop imports nothing from the grader. */
  presentNow: Json;
  gradeNote: Json;
  template: Json;
  gradeDeps: Json;
  tellParent: Json;
  recordsOn: Json;
  graderAsk: Json;
  stripHidden: Json;
  graderSpeaks: Json;
  /** The hash a pass's verdict names (grades.ts rubricHash): the store drops a verdict from a filing since replaced. */
  rubricHash: (rubric: string[], deliverable?: Json, revision?: number) => string;
  /** The marker `gradeNote` puts on every grader note (`grader/evidence.ts`'s GRADER_MARKER), for the closes this loop words itself. */
  graderMarker: string;
  emit?: (e: Json) => void;
}) {
  const grading = new Set<string>();
  const GRADE_WAIT_MS = 24 * 60 * 60_000; // evidence still missing a day after the close: it closes done, ungraded
  const MISSING_WAIT_MS = 10 * 60_000; // finished with no deliverable at all and nothing moving: it closes done, ungraded
  const WAKE_GRACE_MS = 2 * 60_000; // a run's own follow-through (an auto-deploy, a merge) lands before its task is woken
  const MAX_WAKES = 2; // evidence wakes per task, whatever their reasons: the next stall closes it ungraded
  // A wait reason's stable code: its words without the numbers and hashes that change between looks.
  const reasonCode = (why: unknown) => String(why).toLowerCase().replace(/\b[0-9a-f]{7,40}\b|\d+/g, "#").replace(/\s+/g, " ").trim().slice(0, 200);
  // Flow facts (docs/design/flow.md): a grade attempt is one subject, its retry wait is on the task.
  const fact = (type: string, subject: string, version: unknown, task: string, data: Json = {}) => emit({ type, subject, version: String(version), at: new Date().toISOString(), task, data });
  const gradeLooked = new Map(); // issueId → when its evidence was last looked at while waiting
  /**
   * What a verdict still owes once its row is written: the task's move (done, reopen with the note, block) and its parent's notice. Each
   * is a row (`owed:<task>`) until it lands, retried at the top of every pass: the row's state alone never brings the task back
   * (due() skips needs_revision rows), so a kernel 5xx would leave the task held in review, or its parent unaware.
   * A refusal (4xx: the task closed or moved on) drops that step.
   */
  async function owe(task: string, steps: Json[]) {
    state.set(`owed:${task}`, JSON.stringify(steps));
    await settle(task, steps);
  }
  /**
   * Whether the row still holds the filing a queued step was computed on. A step saved before steps carried a filing names
   * none, and is checked against the row as it stands now rather than skipped: a close queued before an amendment must not
   * land on the amended row. "unknown" is a read that failed: the step stays queued and the next pass asks again, so a blip
   * neither drops a move that is still owed nor applies one that may be stale.
   */
  type Filing = { verdict: "ok" | "stale" | "unknown"; filing?: string };
  async function stillFiled(task: string, filing?: string, step?: Json): Promise<Filing> {
    let row: Json;
    try {
      row = await api.get(`/internal/grades/${encodeURIComponent(task)}`);
    } catch (err: Json) {
      log("a queued move waits: the grade state could not be read", { issue: task, err: String(err?.message ?? err).slice(0, 200) });
      return { verdict: "unknown" };
    }
    if (!row) return { verdict: "unknown" };
    // A close is bound to the grading round it was decided on, not only the filing: a re-filed submission leaves the filing's
    // words and hash unchanged but starts a new round, so the pass before it must not close the pass after it.
    const round = typeof step?.round === "number" && (row.round ?? 0) !== step.round;
    if (filing) return round || (row.filing && row.filing !== filing) ? { verdict: "stale" } : { verdict: "ok", filing: row.filing };
    // A step saved before steps carried a filing names none. The row it settled is the only proof it is still current, and the
    // rubric's words are not enough: a row amended A→B→A holds A again, so the pass that closed the first A would read as
    // current. The revision is what tells them apart, and a step from before filings can only be the row's first filing: a
    // satisfied row at revision 0 whose rubric and deliverable still match is that row; anything restarted or amended is not.
    if (round || row.state !== "satisfied" || (row.revision ?? 0) !== 0) return { verdict: "stale" };
    const same = JSON.stringify(row.rubric) === JSON.stringify(step?.rubric) && JSON.stringify(row.deliverable) === JSON.stringify(step?.deliverable);
    return same ? { verdict: "ok", filing: row.filing } : { verdict: "stale" };
  }
  /**
   * A parent notice from the fields it was queued with, never by parsing its rendered text: a task's title is free text and can
   * itself contain the phrase a parser would split on, which would then point the parent at the wrong task.
   */
  const tellText = (x: Json) =>
    x.who ? `${x.who} is done, ${x.ungraded ? `ungraded: ${x.ungraded}` : "graded against its rubric"}: ${x.title}. Its result is on ${x.identifier}.` : String(x.text ?? "");
  async function settle(task: string, steps: Json[]) {
    while (steps.length) {
      const s = steps[0]!;
      // The row's filing as this step was checked against, for a reset below: a legacy step names none, so the verified one
      // from the check is what the store needs (a reset naming no filing is dropped).
      let verified: string | undefined;
      try {
        if (s.do === "reopen") {
          // A revision move queued by a verdict on a rubric since amended is stale: the amendment restarted the row (open or
          // pending), so the task is graded against the new list rather than sent back for a criterion that no longer exists.
          // The row's state is read here because the store and this queue are separate: the amendment cannot drop this step.
          // A read that fails is not "no longer needs_revision": the step stays queued and the next pass asks again, so a
          // blip never reopens a task whose row was amended (and never drops a move that is still owed).
          let state: string | null;
          try {
            state = (await api.get(`/internal/grades/${encodeURIComponent(task)}`))?.state ?? null;
          } catch (err: Json) {
            log("a revision move waits: the grade state could not be read", { issue: task, err: String(err?.message ?? err).slice(0, 200) });
            return;
          }
          if (state === "needs_revision") await pc.setStatus(task, "todo", s.note);
          else log("a revision move is stale: the rubric was amended", { issue: task, state });
        }
        else if (s.do === "done") {
          // Replayed later: still the task and evidence the grader saw? Else the verdict is stale: drop the close and the notice,
          // and send the row back to waiting so the next pass grades what is there now.
          // A close queued before filings were named carries none: it is checked against the row as it stands now instead of
          // replaying blindly onto a rubric amended since.
          const filed = await stillFiled(task, s.filing, s);
          verified = filed.filing;
          // A failed read is not a stale close: the step stays queued and the next pass asks again.
          if (filed.verdict === "unknown") return;
          if (filed.verdict === "stale") {
            // The row was restarted or amended since this close was queued: neither it nor the notice worded for it is owed any
            // more (the notice says "graded against its rubric" of a filing that is gone). Both are dropped together, so the
            // task is not closed and its parent is not told of a result the amendment replaced; the restarted row is graded on
            // its own pass.
            log("a satisfied verdict is stale: the filing was replaced", { issue: task });
            steps.length = 0;
            state.set(`owed:${task}`, "");
            return;
          }
          const now = await pc.issue(task);
          // An empty recorded version (no deliverable then) is stale once one appears. `gather()` can't tell a deliverable whose
          // evidence isn't capturable (a deployed app whose live page is down) from no deliverable, so the presence check decides.
          const deps = now.status === "done" || now.status !== s.status ? undefined : gradeDeps(now);
          // A close the deadline forced was decided without readable evidence, so a replay that cannot read it again is no
          // reason to hold the close: the day already settled it. Any other close keeps today's behaviour (a throw leaves the
          // step queued for the next pass, where a version that appears still makes it stale).
          // A close decided past the day settled by the busy signal alone would drop itself at once: busy reads no version, so
          // the very deliverable the close already saw looks newly arrived. Read past it, the way gradeOne() did.
          // `deadline` marks a close the day forced; `pastDay` one graded while the row was already past it; `deadlineAt` is
          // where the row's day ended, so a close queued inside it latches past-day when the replay crosses it — a re-read that
          // started throwing must not park the close forever. All of them read past busy; the rest of the revalidation is below.
          const pastDay = Boolean(s.deadline || s.pastDay || (typeof s.deadlineAt === "number" && Date.now() >= s.deadlineAt));
          let seen: Json;
          if (deps) {
            try { seen = await gather(s.deliverable, pastDay ? { ...deps, busy: () => "" } : deps, s.rubric); }
            catch (err: Json) {
              if (!pastDay) throw err;
              log("a past-day close re-read no evidence: closing it anyway", { issue: task, err: String(err?.message ?? err).slice(0, 300) });
            }
          }
          // A read that threw or answered `awaiting` produced no version: that is not evidence the deliverable changed, and for a
          // close past the day it must not reopen the wait and start another one. A version read now that differs still makes the
          // close stale, and so does a read that says the deliverable is gone (`missing`): absence is an answer, not a blank. A
          // close inside the day keeps today's behaviour either way.
          const found = seen?.version ?? (pastDay && !seen?.missing ? s.version : "");
          // A versionless close also waits out work that has started since: an open sub-task or a card on the task, whether or
          // not the day has passed. An open approval card is not the grading wait: closing a task with one pending leaves the
          // write it asks for a leftover on a closed task (kernel/src/checks.ts, writes.ts), so it always holds the close.
          // `busy` alone is what a past-day close reads through — the signal the day overrode.
          const lookable = now.status !== "done" && !s.version;
          const openWork = lookable && ((await pc.children(now.id)).some((c: Json) => !["done", "cancelled"].includes(c.status)) || (await recordsOn(now).catch(() => [])).some(openCard));
          const active = openWork || (lookable && !pastDay && Boolean(seen?.busy));
          // A deliverable whose evidence can't be captured has no version either: the presence check (escalationFor's) tells it
          // from no deliverable at all, so a deployed-but-down app's close is stale instead of done/ungraded. A presence check
          // that could not answer (GitHub or the apps registry unreachable) is not "absent": it waits for the next pass, but
          // only so long. After the day a grade waits, an answer that never comes closes the task ungraded, saying the
          // deliverable could not be read, rather than letting the close replay forever.
          // A gathered version is itself proof the close is stale, and it is the answer already in hand: the presence check is
          // only for a deliverable whose evidence could not be captured (no version), so it never runs — and never waits on an
          // outage — over a deliverable `gather()` has already read.
          // The presence check runs for every close: a deliverable that appears after it was queued makes it stale, and that is
          // still the rule. A close past the day recorded whether it saw one (`present`), so a present answer is not news and
          // does not reopen the wait — otherwise unrelated movement in the facts (another PR's checks finishing, a newer deploy)
          // would drop the close on every replay and restart the day, forever. A deliverable that was absent and is present now
          // is news, and makes the close stale as for any other close. The cost is that a newer deploy of an app whose page
          // cannot be captured closes ungraded at its deadline: the fail-open wins over re-grading work it cannot read.
          let presence: Json;
          if (!active && Boolean(deps) && !s.version && !found) {
            try { presence = await presentNow(s.deliverable, deps); }
            catch (err: Json) {
              // A read that throws is no answer; a close past the day does not wait another day for one.
              if (!pastDay) throw err;
              log("a past-day close's presence check threw: closing it anyway", { issue: task, err: String(err?.message ?? err).slice(0, 300) });
            }
          }
          // Confirmed presence first: one recorded PR merged is proof the close is stale even when another PR's lookup failed
          // (`present` and `unknown` are both true then), so the row goes back to grading instead of waiting on the uncertain one.
          // For a close past the day, the presence it recorded is the baseline: the deliverable still there is not news, but one
          // the check now confirms is gone is — absence is a change, and closing over the old note would say it was still there.
          const gone = pastDay && Boolean(s.present) && presence && !presence.present && !presence.unknown;
          const present = (Boolean(presence?.present) && !(pastDay && Boolean(s.present))) || Boolean(gone);
          const { unreadSince, ...plain } = s; // carried only while the wait is unread
          let gaveUp = false;
          if (presence?.unknown && !present) {
            const since = typeof unreadSince === "string" ? unreadSince : new Date().toISOString();
            if (!pastDay && Date.now() - Date.parse(since) < GRADE_WAIT_MS) {
              steps[0] = { ...plain, unreadSince: since };
              state.set(`owed:${task}`, JSON.stringify(steps));
              throw new Error(`${s.deliverable?.kind ?? "the deliverable"} could not be read just now: waiting for the next pass`);
            }
            gaveUp = true;
            steps[0] = plain;
          }
          if (now.status !== "done" && (now.status !== s.status || active || present || (s.version ? found !== s.version : Boolean(found)))) {
            log("a satisfied verdict is stale: not closed", { issue: task });
            // The reset names the row's filing as it was just read: a legacy step carries none, and a reset without one is
            // dropped by the store, which would leave the row satisfied and never picked up again.
            await api.post(`/internal/grades/${encodeURIComponent(task)}/verdict`, { version: "", outcome: "awaiting_evidence", ...(filed.filing ? { rubric: filed.filing } : {}) });
            steps.length = 1;
          } else if (now.status !== "done") {
            // The note keeps the grader's marker that gradeNote puts on every note: evidence collection filters grader comments by
            // it, so an unmarked close would come back as the task's own evidence if the task were reopened and graded again.
            const unreadable = `its deliverable could not be read just now (${s.deliverable?.kind ?? "the deliverable"})`;
            const why = gaveUp ? `${unreadable}: closed ungraded\n\n${graderMarker}` : s.note;
            // The parent's notice was queued with the close's first wording. An unreadable deliverable is not a missing one, so
            // the notice says ungraded too. It is saved before the close: if the PATCH lands and its answer is lost, the next pass
            // sees the task already done and sends this row, which must already carry the ungraded notice rather than the queued
            // "graded against its rubric" one.
            if (gaveUp) {
              for (const x of steps) if (x.do === "tell") x.ungraded = unreadable;
              state.set(`owed:${task}`, JSON.stringify(steps));
            }
            // The checks above take time (evidence, presence, children, cards): an amendment or a re-submission can land
            // between the first look and the close. The filing and the round are read once more, immediately before the close,
            // so the task is not closed on a filing that was replaced, or on a round the row has moved past, while this pass
            // was deciding.
            const still = await stillFiled(task, s.filing, s);
            if (still.verdict === "unknown") return;
            if (still.verdict === "stale") {
              log("a satisfied verdict is stale: the filing was replaced before the close", { issue: task });
              steps.length = 0;
              state.set(`owed:${task}`, "");
              return;
            }
            // That read and the write are still not one step: a re-submission landing after it is caught by the row it leaves
            // `pending` (the next pass grades that submission instead of closing the one before it), and by the task's own
            // status precondition below. The task's status is expected to be the one the verdict was decided on: a cancel or a
            // hand-back that lands between this read and the kernel's write is refused there, not overwritten. The kernel
            // re-reads the status as late as it can, immediately before its own PATCH.
            await pc.setStatus(task, "done", why, { expectStatus: s.status });
            // The kernel's ok resolved this check's hold in the same step, so the close is never replayed: a task another
            // check still holds is waited out by the notice below, which reads the task before it speaks. Asking the kernel to
            // close it again would be refused (this hold is gone) and the step could never land.
            const after = await pc.issue(task).then((i: Json) => i.status, () => "");
            if (after !== "done") {
              // The close is resolved; only the notice is still owed, and it waits for the task to be done.
              steps.shift();
              state.set(`owed:${task}`, steps.length ? JSON.stringify(steps) : "");
              return;
            }
          }
        }
        else if (s.do === "block") await pc.block(task, s.note);
        else if (s.do === "tell") {
          // A notice that waited this long may describe a grade the row no longer holds: an amendment or a re-submission can
          // land between the close and the deferred notice. It names the filing and round it was queued for, and is dropped
          // when the row has moved past them — the pass that grades the new filing queues its own notice. A notice naming
          // neither cannot be verified against anything, so it is not sent: telling a parent "graded against its rubric" on
          // a row that may have been restarted since is worse than the notice being lost (the task is done either way).
          if (!s.filing && typeof s.round !== "number") {
            log("a deferred notice names no filing or round: dropped", { issue: task });
            steps.length = 0;
            state.set(`owed:${task}`, "");
            return;
          }
          const still = await stillFiled(task, s.filing, s);
          if (still.verdict === "unknown") return;
          if (still.verdict === "stale") {
            log("a deferred notice is stale: the filing or round moved on", { issue: task });
            steps.length = 0;
            state.set(`owed:${task}`, "");
            return;
          }
          // The status is read after the round, not before it: the round read is an await of its own, and the owner can cancel
          // or hand the task back in that window. The parent hears "done" only when the task is done now, and a task the owner
          // stopped after the close is resolved is not told as done at all.
          const now = await pc.issue(task).then((i: Json) => i.status, () => "");
          if (now === "cancelled") {
            steps.length = 0;
            state.set(`owed:${task}`, "");
            return;
          }
          if (now !== "done") return;
          if (!(await tellParent(s.issue, s.kind, tellText(s))) && s.fallback) await pc.comment(task, s.fallback);
        }
      } catch (err: Json) {
        const status = Number(err?.status);
        if (!(status >= 400 && status < 500 && status !== 429)) {
          log("a verdict's move failed: retried next pass", { issue: task, step: s.do, err: String(err.message ?? err).slice(0, 300) });
          return;
        }
        log("a verdict's move was refused: dropped", { issue: task, step: s.do, err: String(err.message ?? err).slice(0, 300) });
        const now = s.do === "done" ? await pc.issue(task).then((i: Json) => i.status, () => "") : "";
        // An owner cancelled the task while the close was waiting: it is not owed, and the sweep settles the row. Neither it
        // nor the notice worded for it is sent, so the parent is never told work passed that the owner stopped.
        if (s.do === "done" && now === "cancelled") {
          steps.length = 0;
          state.set(`owed:${task}`, "");
          return;
        }
        // A refused close (the task is already done, or moved on): "is done" is told only when it is done.
        if (s.do === "done" && now !== "done") {
          // A refusal that left the task open (its change request is still open, or the owner handed it back) must be graded
          // again: the row goes back to waiting, or — for a graded close — its own round is requeued, so the next pass picks
          // it up. A refused close that is simply waiting on the gate keeps its queue entry either way.
          if (status === 409) {
            try {
              // The reset names the round this close was decided on: a re-submission that landed since is a different round,
              // and its own `pending` row must stand for its own grading pass rather than be parked as this close's wait.
              // A legacy close names no round and is applied as it was (its filing was verified against this row just now).
              await api.post(`/internal/grades/${encodeURIComponent(task)}/verdict`, { version: "", outcome: "awaiting_evidence", ...(verified ? { rubric: verified } : {}), ...(typeof s.round === "number" ? { round: s.round } : {}) });
            } catch (e: Json) { return log("a refused close's grade reset failed: retried next pass", { issue: task, err: String(e.message ?? e).slice(0, 300) }); }
          }
          steps.length = 1;
        }
      }
      steps.shift();
      state.set(`owed:${task}`, steps.length ? JSON.stringify(steps) : "");
    }
  }

  /** The board's waiting rows: grade each (one at a time per task). */
  async function runGrades() {
    for (const [k, v] of state.list("owed:")) await settle(k.slice("owed:".length), JSON.parse(v));
    const { grades = [] } = await api.get("/internal/grades");
    for (const g of grades) {
      if (grading.has(g.issueId)) continue;
      // A bridge close posts its finishing comment just after the gate: let it land. Waiting evidence: once a minute.
      // A row an amendment or a correction resumed waits it out too: its work was finished just before it was restarted, and
      // that finishing comment is evidence for the new list.
      if ((g.state === "pending" || g.resume) && Date.now() - Date.parse(g.resumedAt ?? g.updatedAt) < 5_000) continue;
      if (g.state === "awaiting_evidence" && Date.now() - (gradeLooked.get(g.issueId) ?? 0) < 60_000) continue;
      grading.add(g.issueId);
      try {
        await gradeOne(g);
      } catch (err: Json) {
        log("grading a task failed", { issue: g.issueId, err: String(err.message ?? err).slice(0, 300) });
      } finally {
        grading.delete(g.issueId);
      }
    }
  }

  /**
   * When a graded task last moved, for a deliverable that doesn't exist yet: its grade row, its last job's end, or a card on it
   * decided or run. An open sub-task (the work handed on) is movement now; a closed one is not (WOR-9756 sat 14 hours on one). A row long held is not stale while the work goes
   * round: a rejection between two jobs, or an Engineer sub-task still building the PR, is not "finished without it".
   */
  async function lastMoved(issue: Json, g: Json) {
    if ((await pc.children(issue.id)).some((c: Json) => !["done", "cancelled"].includes(c.status))) return Date.now();
    const cards = await recordsOn(issue).catch(() => []);
    return Math.max(Date.parse(g.updatedAt) || 0, Date.parse(state.lastJob(issue.id)?.finished_at ?? "") || 0, ...cards.map((a: Json) => Date.parse(a.usedAt ?? a.decidedAt ?? a.createdAt ?? "") || 0));
  }

  /**
   * Whether a waiting grade has stalled: no run on the task, no card open on it, nothing moved for WAKE_GRACE_MS (since its
   * last wake, once woken). "wake" the first time a reason stalls; "give_up" when a reason already woken stalls again, or
   * MAX_WAKES were spent; "" otherwise, and always on a task the breaker stopped (its delegator was told already).
   */
  async function stalled(issue: Json, g: Json, why: unknown) {
    if (issue.status === "in_progress") return "";
    if (Object.values(JSON.parse(state.get(`breaker:${issue.id}`) || "{}")).some((e: Json) => e?.tripped)) return "";
    const cards = await recordsOn(issue).catch(() => []);
    if (cards.some(openCard)) return "";
    const woken = JSON.parse(state.get(`evidence-woken:${issue.id}`) || "null") ?? { codes: [], at: "" };
    if (Date.now() - Math.max(await lastMoved(issue, g), Date.parse(woken.at) || 0) < WAKE_GRACE_MS) return "";
    return woken.codes.includes(reasonCode(why)) || woken.codes.length >= MAX_WAKES ? "give_up" : "wake";
  }

  /** The stalled task woken (once per reason code, at most MAX_WAKES times), the way a rejected version is: reopened with the reason. */
  async function wake(issue: Json, why: unknown) {
    const text = `Grading waits for: ${why}. Do what's missing to finish.`;
    await pc.setStatus(issue.id, "todo", `${text}\n\n<!-- aidenhq:grader -->`);
    const codes = JSON.parse(state.get(`evidence-woken:${issue.id}`) || "null")?.codes ?? [];
    fact("work.waiting", `task:${issue.id}`, `wake:${codes.length + 1}`, issue.id, { reason: "grade_retry" });
    state.set(`evidence-woken:${issue.id}`, JSON.stringify({ codes: [...codes, reasonCode(why)], at: new Date(Date.now()).toISOString() }));
    log("grading waits: task woken", { issue: issue.identifier, why });
  }

  async function gradeOne(g: Json) {
    const issue = await pc.issue(g.issueId);
    // Closed meanwhile (the owner accepted or cancelled it): nothing to grade, and a resumed row is settled so it is not
    // picked up again on every pass (the sweep does the same, but only every five minutes).
    if (["done", "cancelled"].includes(issue.status)) {
      if (g.resume) await api.post(`/board/grades/${encodeURIComponent(g.issueId)}/settle`, { reason: `the task was ${issue.status} before the grader settled it` }).catch(() => {});
      return;
    }
    gradeLooked.set(g.issueId, Date.now());
    const rubric = g.rubric.length ? g.rubric : template(g.deliverable.kind);
    const deps = gradeDeps(issue);
    const verdictPath = `/internal/grades/${encodeURIComponent(g.issueId)}/verdict`;
    // The filing this pass looked at: a wait it reports is bound to it, so a row amended or re-bound mid-pass is left for the
    // next pass instead of being parked awaiting evidence for work that is no longer the one asked for.
    const filing = rubricHash(g.rubric ?? [], g.deliverable, g.revision);
    const attempt = (g.attempts ?? 0) + 1; // the pass this grade is on (a revision is the next attempt)
    // Milliseconds past the day the row may wait (negative: still inside it). Read at the moment it is asked, so a slow pass
    // that crosses the deadline in the same run still counts as past it.
    const overdueBy = () => Date.now() - Date.parse(g.updatedAt) - GRADE_WAIT_MS;
    const overdue = overdueBy() >= 0; // the row was past its day when this pass began
    let agent: Json, ev: Json | undefined, asked = false, v, forced = false;
    try {
      // Past the day the busy signal may no longer stand between the row and its evidence: a job row stuck at "running" makes
      // gather() return before reading anything, and a report that is there would close ungraded for a run that simply died.
      // Read it with busy suppressed for this look only; the signal still governs the short bound and the nudge below.
      // The evidence comes first, too: an assignee lookup that fails must not hide a version the read produced and make
      // settlement see it as newly arrived.
      const busyNow = Boolean((await deps.busy?.()) || "");
      ev = await gather(g.deliverable, overdue ? { ...deps, busy: () => "" } : deps, rubric);
      if (overdue) ev.busy = busyNow || ev.busy; // the log and the close below still say whether it was busy
      agent = issue.assigneeAgentId ? await pc.agent(issue.assigneeAgentId) : undefined;
      if (ev.awaiting) {
        // Evidence that never comes (a PR nobody merges, a deploy that never lands) closes the task done, ungraded, after a day, saying why;
        // a deliverable that doesn't exist at all (finished with no PR, no apply, nothing posted) after MISSING_WAIT_MS, since
        // nothing is coming. A task still moving (a run, its merges, an open card) is never cut short.
        // Every wait ends: a day after the close at most, whatever else it waits on (WOR-5476). The day is measured on the
        // row, never behind `!ev.busy`: a kernel job row stuck at "running" says the agent may still work, not that the task
        // may wait forever. `busy` may hold back only the short, missing-deliverable bound and the nudge below.
        // Read the clock here, not when the pass began: a read that finishes just after the day still ends the wait.
        const deadline = overdueBy() >= 0;
        // The short bound is only asked when the day has not already decided, and never behind busy: its own movement read can
        // fail, and it must not be able to throw the pass out past the close the day already allows.
        const missingOver = !deadline && !ev.busy && Boolean(ev.missing) && Date.now() - (await lastMoved(issue, g)) >= MISSING_WAIT_MS;
        const waitOver = deadline || missingOver;
        // Before that, a stalled wait (the run ended, nothing open on it) wakes the task with the reason, once per reason and at
        // most MAX_WAKES times; a reason already woken, or one past the cap, ends the wait now.
        const nudge = ev.busy || waitOver ? "" : await stalled(issue, g, ev.awaiting);
        if (nudge === "wake") {
          // The wake moves the task back to todo: only for the filing this pass read. A row amended meanwhile is a different
          // filing, and waking its assignee for a reason the amendment may have removed is the same staleness a verdict is.
          const filed = await stillFiled(g.issueId, filing);
          if (filed.verdict !== "ok") return;
          await wake(issue, ev.awaiting);
          if (g.state !== "awaiting_evidence") await api.post(verdictPath, { version: "", outcome: "awaiting_evidence", rubric: filing });
          return;
        }
        if (!waitOver && nudge !== "give_up") {
          if (g.state !== "awaiting_evidence") await api.post(verdictPath, { version: "", outcome: "awaiting_evidence", rubric: filing });
          log("grading waits for evidence", { issue: issue.identifier, why: ev.awaiting });
          return;
        }
        // The day is the fail-open's own bound, so it leaves its own trace: a row nobody looked at and one held past its
        // deadline must not read the same in the log.
        if (deadline) {
          forced = true;
          log("grading deadline passed: closing the task done, ungraded", { issue: issue.identifier, overdue_ms: overdueBy(), busy: Boolean(ev.busy) });
        }
        // The wait is over: the task closes done, ungraded, on today's facts (escalationFor says why; a deliverable that is there
        // after all is named as there). Fail open: nobody is asked to decide.
        const esc = await escalationFor(ev, g.deliverable, deps);
        state.set(`evidence-woken:${issue.id}`, ""); // a later round of work gets its own wake
        // A deliverable that is there keeps its version, so the close isn't read as stale once that version is found again. One
        // that could not be read keeps nothing: nothing was found to vouch for the version. A `busy` pass never read one, and
        // the verdict needs a string either way, so "none" is the empty string, never undefined.
        ev.version = esc.present ? String(ev.version ?? "") : "";
        ev.present = Boolean(esc.present); // the close records that it saw the deliverable, so its replay does not read it as new
        v = { outcome: "error", model: "", criteria: [], reason: esc.present ? `its deliverable is there (${esc.facts.join("; ").slice(0, 200)}) but its evidence never settled` : esc.hold ? `its deliverable could not be read just now (${esc.facts.join("; ").slice(0, 200) || "the lookup did not answer"}), so its close was not checked` : esc.reason };
      } else {
        // The author's model: its last job's engine and the agent's own model (setup's metadata); the grader is never of its family.
        const authorModel = `${state.lastJob(issue.id)?.engine ?? ""} ${agent?.metadata?.model ?? ""}`;
        // Through the model gateway with the runner's grader token (kind grader: billed to the task, never capped). AIDENHQ_GRADER_URL: tests' fake.
        const ask = graderAsk(issue);
        // The grader's pass starts: a task reopened for a revision or a wake resumes here (its retry wait ends).
        const woken = JSON.parse(state.get(`evidence-woken:${issue.id}`) || "null")?.codes?.length ?? 0;
        if (attempt > 1) fact("work.resumed", `task:${issue.id}`, attempt - 1, issue.id, { reason: "grade_retry" });
        else if (woken) fact("work.resumed", `task:${issue.id}`, `wake:${woken}`, issue.id, { reason: "grade_retry" });
        fact("grade.requested", `grade:${issue.id}:${attempt}`, attempt, issue.id);
        asked = true;
        v = await grade({ rubric, deliverable: g.deliverable, facts: ev.facts, data: ev.data, request: `${issue.title}\n\n${stripHidden(issue.description ?? "")}`, images: ev.images, authorModel, ask });
      }
    } catch (err: Json) {
      // A pass that throws is retried on the next one, but not forever: once the row is past its day the task still closes
      // done, ungraded, saying its evidence could not be read. `escalationFor` cannot help here — there is no `ev` to ask
      // about. Inside the day, the throw is the caller's: it logs and retries the row as before.
      if (overdueBy() < 0) throw err;
      const msg = String(err?.message ?? err).slice(0, 300);
      log("grading a task threw past its deadline: closing it done, ungraded", { issue: issue.identifier, overdue_ms: overdueBy(), busy: "unknown", err: msg });
      forced = true;
      // Evidence that was read before the throw stays readable: only a throw before it leaves nothing to vouch for a version.
      // The reason says which failed, so a readable deliverable is never described as unreadable.
      // Whatever failed, the presence check can still say the deliverable is there: record it when no baseline is recorded, so
      // settlement does not take the same existing deploy for one that arrived since.
      const read = Boolean(ev);
      if (!ev) ev = { version: "" };
      if (!ev.present) ev.present = Boolean((await presentNow(g.deliverable, deps).catch(() => undefined))?.present);
      state.set(`evidence-woken:${issue.id}`, "");
      v = { outcome: "error", model: "", criteria: [], reason: read ? `its grading could not be completed (${msg}), so its close was not checked` : `its evidence could not be read (${msg}), so its close was not checked` };
    }
    // A `gather()` that answered `awaiting` carries no version at all, and the verdict (and its log line) need a string.
    ev.version = String(ev.version ?? "");
    // The row's filing this pass graded, by hash: the store drops the verdict if its rubric was amended or its deliverable
    // re-bound while the pass ran. The row's own list (g.rubric) and deliverable, not the template the pass falls back to, are
    // what the store compares against.
    const row = await api.post(verdictPath, { version: ev.version, outcome: v.outcome, model: v.model, criteria: v.criteria, rubric: filing, round: g.round, reason: v.outcome === "grading_failed" ? String(v.reason ?? "") : undefined });
    if (asked) fact("grade.verdict", `grade:${issue.id}:${attempt}`, attempt, issue.id, { pass: v.outcome === "satisfied", attempt, reason_code: String(v.outcome) });
    // A failed pass says why (the grader's call error, or the rule its answer broke): nothing else records it.
    log("graded", { issue: issue.identifier, outcome: v.outcome, state: row.state, attempts: row.attempts, failures: row.failures, model: v.model, version: ev.version.slice(0, 40), ...(v.reason ? { reason: String(v.reason).slice(0, 300) } : {}) });
    // A satisfied row without a satisfied verdict is a close the grader could not check: done, with "ungraded: <reason>".
    const unmet = (v.criteria ?? []).some((c: Json) => c.met === "no");
    const ungraded = row.state === "satisfied" && (v.outcome !== "satisfied" || unmet) ? (unmet ? `criteria were still unmet after ${row.attempts} rejected version${row.attempts === 1 ? "" : "s"}` : v.outcome === "needs_revision" ? "its criteria were not shown by the evidence" : v.outcome === "cannot_judge" ? "the grader couldn't judge it" : String(v.reason || "the grader failed").slice(0, 300)) : "";
    const note = gradeNote(v, rubric, ungraded ? "ungraded" : row.state, { version: ev.version, reason: ungraded || undefined });
    if (row.state === "satisfied") {
      // The row is satisfied now, so the close and the notice are owed steps: retried until they land, even across a restart.
      // The notice keeps its parts, not only the rendered sentence: a later close that changes the reason rewrites the reason and
      // renders the notice again from these, so it never has to guess where the free-text title ends.
      const notice = { who: `${issue.identifier} (${agent?.name ?? "its agent"})`, title: String(issue.title ?? ""), identifier: String(issue.identifier ?? issue.id), ...(ungraded ? { ungraded } : {}) };
      // The notice names the same filing and round as the close it reports: a deferred notice is revalidated against them
      // before it speaks, so a row restarted or amended after the close cannot be described by the grade it replaced.
      // A close past the day names that, and whether it saw the deliverable, so its replay can tell the same one from a new one.
      const past = forced || overdue;
      // `deadlineAt` carries the row's own deadline into the queued close: the row's `updatedAt` may move before the replay.
      const deadlineAt = Date.parse(g.updatedAt) + GRADE_WAIT_MS;
      await owe(issue.id, [{ do: "done", note, ungraded: Boolean(ungraded), version: ev.version, status: issue.status, round: row.round, deliverable: g.deliverable, rubric, filing, ...(past ? { pastDay: true, ...(ev.present ? { present: ev.present } : {}) } : {}), ...(Number.isFinite(deadlineAt) ? { deadlineAt } : {}) }, { do: "tell", issue: { id: issue.id, parentId: issue.parentId }, kind: "done", ...notice, round: row.round, deliverable: g.deliverable, rubric, filing, text: `${notice.who} is done, ${ungraded ? `ungraded: ${ungraded}` : "graded against its rubric"}: ${issue.title}. Its result is on ${issue.identifier}.` }]);
    } else if (row.state === "needs_revision") {
      await owe(issue.id, [{ do: "reopen", note }]);
      fact("work.waiting", `task:${issue.id}`, attempt, issue.id, { reason: "grade_retry" });
      // The reopen wakes the task's agent through the kernel: nothing to dispatch here.
    }
  }

  /** Whether a grade will still speak for this task (notices.ts graderSpeaks): its progress is then not news for its parent. */
  async function graded(issueId: string) {
    return graderSpeaks((await api.get(`/internal/grades/${encodeURIComponent(issueId)}`).catch(() => undefined))?.state);
  }
  return { runGrades, graded };
}
