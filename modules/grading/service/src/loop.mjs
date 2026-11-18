// The grade loop in the grading module (phase 2 W7): the runner's loop (src/loop.mjs) with its executor dependencies swapped for the
// kernel's. A reopened task wakes its agent through the kernel (a reopen wake), so the loop no longer dispatches an Engineer itself;
// a verdict's task move (done, todo + note) is the finish check's own resolve (POST /v1/checks/:task). Its per-task memory
// (evidence-woken, escalation-told) is rows in the grades database (kernel-loop.ts). Unstarted until the switch.
export function createGradeLoop({ api, pc, log, state, gather, grade, escalationFor, gradeNote, template, gradeDeps, tellParent, recordsOn, graderAsk, stripHidden, graderSpeaks, isUserInstruction }) {
  const grading = new Set();
  const GRADE_WAIT_MS = 24 * 60 * 60_000; // evidence still missing a day after the close: it escalates to the delegator
  const MISSING_WAIT_MS = 10 * 60_000; // finished with no deliverable at all and nothing moving: the delegator decides now
  const WAKE_GRACE_MS = 2 * 60_000; // a run's own follow-through (an auto-deploy, a merge) lands before its task is woken
  const MAX_WAKES = 2; // evidence wakes per task, whatever their reasons: the next stall escalates
  // A wait reason's stable code: its words without the numbers and hashes that change between looks.
  const reasonCode = (why) => String(why).toLowerCase().replace(/\b[0-9a-f]{7,40}\b|\d+/g, "#").replace(/\s+/g, " ").trim().slice(0, 200);
  const gradeLooked = new Map(); // issueId → when its evidence was last looked at while waiting
  /** The board's waiting rows: grade each (one at a time per task), and check escalated tasks finished again for a new version. */
  async function runGrades() {
    const { grades = [], resubmitted = [] } = await api.get("/internal/grades");
    for (const g of resubmitted) {
      // The mark stays until a version is found: look again once a minute.
      if (Date.now() - (gradeLooked.get(g.issueId) ?? 0) < 60_000) continue;
      gradeLooked.set(g.issueId, Date.now());
      try {
        const issue = await pc.issue(g.issueId);
        let version = "";
        if (["file", "report"].includes(g.deliverable.kind)) {
          // Any comment is a new version of these: only the owner's or the delegator's word since the escalation sends it back
          // to the grader.
          version = (await pc.comments(issue.id)).filter((c) => (isUserInstruction(c) || (issue.createdByAgentId && c.authorAgentId === issue.createdByAgentId)) && c.createdAt > g.updatedAt).at(-1)?.id ?? "";
        } else {
          const ev = await gather(g.deliverable, gradeDeps(issue));
          if (ev.awaiting) continue; // still moving (checks, merges, a card): the mark stays, the next look decides
          version = ev.version ?? "";
        }
        await api.post(`/internal/grades/${encodeURIComponent(g.issueId)}/resubmit`, { version });
      } catch (err) {
        log("resubmitted grade check failed", { issue: g.issueId, err: String(err.message ?? err).slice(0, 300) });
      }
    }
    for (const g of grades) {
      if (grading.has(g.issueId)) continue;
      // A bridge close posts its finishing comment just after the gate: let it land. Waiting evidence: once a minute.
      if (g.state === "pending" && Date.now() - Date.parse(g.updatedAt) < 5_000) continue;
      if (g.state === "awaiting_evidence" && Date.now() - (gradeLooked.get(g.issueId) ?? 0) < 60_000) continue;
      grading.add(g.issueId);
      try {
        await gradeOne(g);
      } catch (err) {
        log("grading a task failed", { issue: g.issueId, err: String(err.message ?? err).slice(0, 300) });
      } finally {
        grading.delete(g.issueId);
      }
    }
  }

  /**
   * When a graded task last moved, for a deliverable that doesn't exist yet: its grade row, its last job's end, or a card on it
   * decided or run. An open sub-task (the work handed on) is movement now. A row long held is not stale while the work goes
   * round: a rejection between two jobs, or an Engineer sub-task still building the PR, is not "finished without it".
   */
  async function lastMoved(issue, g) {
    if ((await pc.children(issue.id)).length) return Date.now();
    const cards = await recordsOn(issue).catch(() => []);
    return Math.max(Date.parse(g.updatedAt) || 0, Date.parse(state.lastJob(issue.id)?.finished_at ?? "") || 0, ...cards.map((a) => Date.parse(a.usedAt ?? a.decidedAt ?? a.createdAt ?? "") || 0));
  }

  /**
   * Whether a waiting grade has stalled: no run on the task, no card open on it, nothing moved for WAKE_GRACE_MS (since its
   * last wake, once woken). "wake" the first time a reason stalls; "escalate" when a reason already woken stalls again, or
   * MAX_WAKES were spent; "" otherwise, and always on a task the breaker stopped (its delegator was told already).
   */
  async function stalled(issue, g, why) {
    if (issue.status === "in_progress") return "";
    if (Object.values(JSON.parse(state.get(`breaker:${issue.id}`) || "{}")).some((e) => e?.tripped)) return "";
    const cards = await recordsOn(issue).catch(() => []);
    if (cards.some((a) => ["pending", "approved"].includes(a.state) || (a.state === "used" && !a.outcome))) return "";
    const woken = JSON.parse(state.get(`evidence-woken:${issue.id}`) || "null") ?? { codes: [], at: "" };
    if (Date.now() - Math.max(await lastMoved(issue, g), Date.parse(woken.at) || 0) < WAKE_GRACE_MS) return "";
    return woken.codes.includes(reasonCode(why)) || woken.codes.length >= MAX_WAKES ? "escalate" : "wake";
  }

  /** The stalled task woken (once per reason code, at most MAX_WAKES times), the way a rejected version is: reopened with the reason. */
  async function wake(issue, why) {
    const text = `Grading waits for: ${why}. Do what's missing to finish.`;
    await pc.setStatus(issue.id, "todo", `${text}\n\n<!-- aidenhq:grader -->`);
    const codes = JSON.parse(state.get(`evidence-woken:${issue.id}`) || "null")?.codes ?? [];
    state.set(`evidence-woken:${issue.id}`, JSON.stringify({ codes: [...codes, reasonCode(why)], at: new Date(Date.now()).toISOString() }));
    log("grading waits: task woken", { issue: issue.identifier, why });
  }

  async function gradeOne(g) {
    const issue = await pc.issue(g.issueId);
    // Closed meanwhile (the owner accepted or cancelled it): nothing to grade.
    if (["done", "cancelled"].includes(issue.status)) return;
    gradeLooked.set(g.issueId, Date.now());
    const rubric = g.rubric.length ? g.rubric : template(g.deliverable.kind);
    const deps = gradeDeps(issue);
    const ev = await gather(g.deliverable, deps, rubric);
    const verdictPath = `/internal/grades/${encodeURIComponent(g.issueId)}/verdict`;
    const agent = (await pc.agents()).find((a) => a.id === issue.assigneeAgentId);
    const last = g.verdicts?.at(-1);
    let v;
    if (ev.awaiting) {
      // Evidence that never comes (a PR nobody merges, a deploy that never lands) escalates to the delegator after a day, saying why;
      // a deliverable that doesn't exist at all (finished with no PR, no apply, nothing posted) after MISSING_WAIT_MS, since
      // nothing is coming. A task still moving (a run, its merges, an open card) is never cut short.
      const waitOver = !ev.busy && (ev.missing ? Date.now() - (await lastMoved(issue, g)) >= MISSING_WAIT_MS : Date.now() - Date.parse(g.updatedAt) >= GRADE_WAIT_MS);
      // Before that, a stalled wait (the run ended, nothing open on it) wakes the task with the reason, once per reason and at
      // most MAX_WAKES times; a reason already woken, or one past the cap, escalates to its delegator now.
      const nudge = ev.busy || waitOver ? "" : await stalled(issue, g, ev.awaiting);
      if (nudge === "wake") {
        await wake(issue, ev.awaiting);
        if (g.state !== "awaiting_evidence") await api.post(verdictPath, { version: "", outcome: "awaiting_evidence" });
        return;
      }
      if (!waitOver && nudge !== "escalate") {
        if (g.state !== "awaiting_evidence") await api.post(verdictPath, { version: "", outcome: "awaiting_evidence" });
        log("grading waits for evidence", { issue: issue.identifier, why: ev.awaiting });
        return;
      }
      // The wait is over: hold the row if the deliverable turns out to be there after all, else escalate on today's facts
      // (escalationFor says which, and why). Both places the owner hears of a held grade — the note below and the board's
      // owner-channel line, which carries the escalated row — go through here; the other escalations (rejected versions,
      // cannot_judge, 5 failed grader passes) do not.
      const esc = await escalationFor(ev, g.deliverable, deps);
      if (!esc.hold) state.set(`evidence-woken:${issue.id}`, ""); // a later round of work gets its own wake
      if (esc.hold) {
        log("grading waits: the deliverable is present", { issue: issue.identifier, why: ev.awaiting, facts: esc.facts.join("; ").slice(0, 400) });
        if (g.state !== "awaiting_evidence") await api.post(verdictPath, { version: "", outcome: "awaiting_evidence" });
        return;
      }
      ev.version = "";
      v = { outcome: "error", model: "", criteria: [], reason: esc.reason };
    } else if (g.state === "awaiting_evidence" && last?.verdict === "satisfied" && last.version === ev.version) {
      // Graded satisfied before, but closing the task failed: the same version keeps its verdict, no second grader call.
      v = { outcome: "satisfied", model: last.model, criteria: last.criteria };
    } else {
      // The author's model: the job's engine for a runner Engineer, else the agent's own; the grader is never of its family.
      const authorModel = `${state.lastJob(issue.id)?.engine ?? ""} ${agent?.adapterConfig?.model ?? ""}`;
      // Through the model gateway with the runner's grader token (kind grader: billed to the task, never capped). AIDENHQ_GRADER_URL: tests' fake.
      const ask = graderAsk(issue);
      v = await grade({ rubric, deliverable: g.deliverable, facts: ev.facts, data: ev.data, request: `${issue.title}\n\n${stripHidden(issue.description ?? "")}`, images: ev.images, authorModel, ask });
    }
    const row = await api.post(verdictPath, { version: ev.version, outcome: v.outcome, model: v.model, criteria: v.criteria });
    // A failed pass says why (the grader's call error, or the rule its answer broke): nothing else records it.
    log("graded", { issue: issue.identifier, outcome: v.outcome, state: row.state, attempts: row.attempts, failures: row.failures, model: v.model, version: ev.version.slice(0, 40), ...(v.reason ? { reason: String(v.reason).slice(0, 300) } : {}) });
    const note = gradeNote(v, rubric, row.state, { version: ev.version, reason: row.state === "escalated" && v.outcome === "error" ? v.reason : undefined });
    if (row.state === "satisfied") {
      try {
        await pc.setStatus(issue.id, "done", note);
      } catch (err) {
        // Back to waiting, so the next poll closes it (the verdict above is reused, not asked again).
        await api.post(verdictPath, { version: "", outcome: "awaiting_evidence" }).catch(() => {});
        throw err;
      }
      await tellParent(issue, "done", `${issue.identifier} (${agent?.metadata?.persona?.name ?? agent?.name ?? "its agent"}) is done, graded against its rubric: ${issue.title}. Its result is on ${issue.identifier}.`);
    } else if (row.state === "needs_revision") {
      await pc.setStatus(issue.id, "todo", note);
      // The reopen wakes the task's agent through the kernel: nothing to dispatch here.
    } else if (row.state === "escalated") {
      // One question to the delegator, with the grader's note in it; on the task itself only when no open parent hears it (a
      // note there would wake its assignee, who has nothing left to do).
      const ask = `**${issue.identifier} needs your decision** (its grade escalated to you): ${issue.title}. Close it if you're satisfied (that accepts the work), or reopen it with what to change.`;
      // The same escalation again in the same hour (same version, outcome and criteria verdicts) is no news: told once (marked
      // only once posted). A new version or verdict, or the same one in a later hour, is told.
      const said = JSON.stringify([ev.version, v.outcome, (v.criteria ?? []).map((c) => [c.id, c.met]), Math.floor(Date.now() / 3_600_000)]), told = state.get(`escalation-told:${issue.id}`) === said;
      if (!told && (await tellParent(issue, "escalated", `${ask}\n\n${note}`).catch(() => false))) state.set(`escalation-told:${issue.id}`, said);
      else if (!told) await pc.comment(issue.id, note);
    }
  }

  /** Whether a grade will still speak for this task (notices.ts graderSpeaks): its progress is then not news for its parent. */
  async function graded(issueId) {
    return graderSpeaks((await api.get(`/internal/grades/${encodeURIComponent(issueId)}`).catch(() => undefined))?.state);
  }
  return { runGrades, graded };
}
