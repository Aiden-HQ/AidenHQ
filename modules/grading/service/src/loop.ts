// The grade loop in the grading module (phase 2 W7): the runner's loop (src/loop.ts) with its executor dependencies swapped for the
// kernel's. A reopened task wakes its agent through the kernel (a reopen wake), so the loop no longer dispatches an Engineer itself;
// a verdict's task move (done, todo + note) is the finish check's own resolve (POST /v1/checks/:task). Its per-task memory
// (evidence-woken, escalation-told) is rows in the grades database (kernel-loop.ts). Unstarted until the switch.
// The injected collaborators (the kernel's api client, Paperclip's client, the grade store) and the rows they return are loosely typed.
type Json = any;
export function createGradeLoop({ api, pc, log, state, gather, grade, escalationFor, gradeNote, template, gradeDeps, tellParent, recordsOn, graderAsk, stripHidden, graderSpeaks, isUserInstruction, emit = () => {} }: {
  api: Json;
  pc: Json;
  log: (...a: unknown[]) => void;
  state: Json;
  gather: Json;
  grade: Json;
  escalationFor: Json;
  gradeNote: Json;
  template: Json;
  gradeDeps: Json;
  tellParent: Json;
  recordsOn: Json;
  graderAsk: Json;
  stripHidden: Json;
  graderSpeaks: Json;
  isUserInstruction: Json;
  emit?: (e: Json) => void;
}) {
  const grading = new Set<string>();
  const GRADE_WAIT_MS = 24 * 60 * 60_000; // evidence still missing a day after the close: it closes done, ungraded
  const RESUBMIT_WAIT_MS = 24 * 60 * 60_000; // an escalated task finished again, its evidence still moving a day later: no new version
  const MISSING_WAIT_MS = 10 * 60_000; // finished with no deliverable at all and nothing moving: the delegator decides now
  const WAKE_GRACE_MS = 2 * 60_000; // a run's own follow-through (an auto-deploy, a merge) lands before its task is woken
  const MAX_WAKES = 2; // evidence wakes per task, whatever their reasons: the next stall escalates
  // A wait reason's stable code: its words without the numbers and hashes that change between looks.
  const reasonCode = (why: unknown) => String(why).toLowerCase().replace(/\b[0-9a-f]{7,40}\b|\d+/g, "#").replace(/\s+/g, " ").trim().slice(0, 200);
  // Flow facts (docs/design/flow.md): a grade attempt is one subject, its retry wait is on the task.
  const fact = (type: string, subject: string, version: unknown, task: string, data: Json = {}) => emit({ type, subject, version: String(version), at: new Date().toISOString(), task, data });
  const gradeLooked = new Map(); // issueId → when its evidence was last looked at while waiting
  /**
   * What a verdict still owes once its row is written: the task's move (done, reopen with the note, block) and its parent's notice. Each
   * is a row (`owed:<task>`) until it lands, retried at the top of every pass: the row's state alone never brings the task back
   * (due() skips needs_revision and escalated rows), so a kernel 5xx would leave the task held in review, or its parent unaware.
   * A refusal (4xx: the task closed or moved on) drops that step.
   */
  async function owe(task: string, steps: Json[]) {
    state.set(`owed:${task}`, JSON.stringify(steps));
    await settle(task, steps);
  }
  async function settle(task: string, steps: Json[]) {
    while (steps.length) {
      const s = steps[0]!;
      try {
        if (s.do === "reopen") await pc.setStatus(task, "todo", s.note);
        else if (s.do === "done") {
          // Replayed later: still the task and evidence the grader saw? Else the verdict is stale: drop the close and the notice,
          // and send the row back to waiting so the next pass grades what is there now.
          const now = await pc.issue(task);
          // An empty recorded version (no deliverable then) is stale once one appears.
          const found = now.status === "done" || now.status !== s.status ? "" : (await gather(s.deliverable, gradeDeps(now), s.rubric)).version ?? "";
          // A versionless close also waits out work that has started since: an open sub-task or a card on the task.
          const active = !s.version && now.status !== "done" && ((await pc.children(now.id)).length > 0 || (await recordsOn(now).catch(() => [])).some((a: Json) => ["pending", "approved"].includes(a.state) || (a.state === "used" && !a.outcome)));
          if (now.status !== "done" && (now.status !== s.status || active || (s.version ? found !== s.version : Boolean(found)))) {
            log("a satisfied verdict is stale: not closed", { issue: task });
            await api.post(`/internal/grades/${encodeURIComponent(task)}/verdict`, { version: "", outcome: "awaiting_evidence" });
            steps.length = 1;
          } else if (now.status !== "done") await pc.setStatus(task, "done", s.note);
        }
        else if (s.do === "block") await pc.block(task, s.note);
        else if (!(await tellParent(s.issue, s.kind, s.text)) && s.fallback) await pc.comment(task, s.fallback);
      } catch (err: Json) {
        const status = Number(err?.status);
        if (!(status >= 400 && status < 500 && status !== 429)) {
          log("a verdict's move failed: retried next pass", { issue: task, step: s.do, err: String(err.message ?? err).slice(0, 300) });
          return;
        }
        log("a verdict's move was refused: dropped", { issue: task, step: s.do, err: String(err.message ?? err).slice(0, 300) });
        // A refused close (the task is already done, or moved on): "is done" is told only when it is done.
        if (s.do === "done" && (await pc.issue(task).then((i: Json) => i.status, () => "")) !== "done") {
          // An ungraded close the kernel refuses (its change request is still open): the row goes back to waiting, so the next pass tries again.
          if (s.ungraded && status === 409) await api.post(`/internal/grades/${encodeURIComponent(task)}/verdict`, { version: "", outcome: "awaiting_evidence" }).catch(() => {});
          steps.length = 1;
        }
      }
      steps.shift();
      state.set(`owed:${task}`, steps.length ? JSON.stringify(steps) : "");
    }
  }

  /** The board's waiting rows: grade each (one at a time per task), and check escalated tasks finished again for a new version. */
  async function runGrades() {
    for (const [k, v] of state.list("owed:")) await settle(k.slice("owed:".length), JSON.parse(v));
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
          version = (await pc.comments(issue.id)).filter((c: Json) => (isUserInstruction(c) || (issue.createdByAgentId && c.authorAgentId === issue.createdByAgentId)) && c.createdAt > g.updatedAt).at(-1)?.id ?? "";
        } else {
          const ev = await gather(g.deliverable, gradeDeps(issue));
          // Still moving (checks, merges, a card): the mark stays and the next look decides, for a day. Then it is no new version:
          // the row stays escalated and its hold goes back to the delegator (server.ts tick).
          if (ev.awaiting && Date.now() - Date.parse(g.resubmittedAt) < RESUBMIT_WAIT_MS) continue;
          version = ev.awaiting ? "" : ev.version ?? "";
        }
        await api.post(`/internal/grades/${encodeURIComponent(g.issueId)}/resubmit`, { version });
      } catch (err: Json) {
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
      } catch (err: Json) {
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
  async function lastMoved(issue: Json, g: Json) {
    if ((await pc.children(issue.id)).length) return Date.now();
    const cards = await recordsOn(issue).catch(() => []);
    return Math.max(Date.parse(g.updatedAt) || 0, Date.parse(state.lastJob(issue.id)?.finished_at ?? "") || 0, ...cards.map((a: Json) => Date.parse(a.usedAt ?? a.decidedAt ?? a.createdAt ?? "") || 0));
  }

  /**
   * Whether a waiting grade has stalled: no run on the task, no card open on it, nothing moved for WAKE_GRACE_MS (since its
   * last wake, once woken). "wake" the first time a reason stalls; "escalate" when a reason already woken stalls again, or
   * MAX_WAKES were spent; "" otherwise, and always on a task the breaker stopped (its delegator was told already).
   */
  async function stalled(issue: Json, g: Json, why: unknown) {
    if (issue.status === "in_progress") return "";
    if (Object.values(JSON.parse(state.get(`breaker:${issue.id}`) || "{}")).some((e: Json) => e?.tripped)) return "";
    const cards = await recordsOn(issue).catch(() => []);
    if (cards.some((a: Json) => ["pending", "approved"].includes(a.state) || (a.state === "used" && !a.outcome))) return "";
    const woken = JSON.parse(state.get(`evidence-woken:${issue.id}`) || "null") ?? { codes: [], at: "" };
    if (Date.now() - Math.max(await lastMoved(issue, g), Date.parse(woken.at) || 0) < WAKE_GRACE_MS) return "";
    return woken.codes.includes(reasonCode(why)) || woken.codes.length >= MAX_WAKES ? "escalate" : "wake";
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
    // Closed meanwhile (the owner accepted or cancelled it): nothing to grade.
    if (["done", "cancelled"].includes(issue.status)) return;
    gradeLooked.set(g.issueId, Date.now());
    const rubric = g.rubric.length ? g.rubric : template(g.deliverable.kind);
    const deps = gradeDeps(issue);
    const ev = await gather(g.deliverable, deps, rubric);
    const verdictPath = `/internal/grades/${encodeURIComponent(g.issueId)}/verdict`;
    const agent = issue.assigneeAgentId ? await pc.agent(issue.assigneeAgentId) : undefined;
    const attempt = (g.attempts ?? 0) + 1; // the pass this grade is on (a revision is the next attempt)
    let asked = false, v;
    if (ev.awaiting) {
      // Evidence that never comes (a PR nobody merges, a deploy that never lands) closes the task done, ungraded, after a day, saying why;
      // a deliverable that doesn't exist at all (finished with no PR, no apply, nothing posted) after MISSING_WAIT_MS, since
      // nothing is coming. A task still moving (a run, its merges, an open card) is never cut short.
      const waitOver = !ev.busy && (ev.missing ? Date.now() - (await lastMoved(issue, g)) >= MISSING_WAIT_MS : Date.now() - Date.parse(g.updatedAt) >= GRADE_WAIT_MS);
      // Before that, a stalled wait (the run ended, nothing open on it) wakes the task with the reason, once per reason and at
      // most MAX_WAKES times; a reason already woken, or one past the cap, ends the wait now.
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
      // The wait is over: hold the row if the deliverable turns out to be there after all, else close ungraded on today's facts
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
    const row = await api.post(verdictPath, { version: ev.version, outcome: v.outcome, model: v.model, criteria: v.criteria, reason: v.outcome === "grading_failed" ? String(v.reason ?? "") : undefined });
    if (asked) fact("grade.verdict", `grade:${issue.id}:${attempt}`, attempt, issue.id, { pass: v.outcome === "satisfied", attempt, reason_code: String(v.outcome) });
    // A failed pass says why (the grader's call error, or the rule its answer broke): nothing else records it.
    log("graded", { issue: issue.identifier, outcome: v.outcome, state: row.state, attempts: row.attempts, failures: row.failures, model: v.model, version: ev.version.slice(0, 40), ...(v.reason ? { reason: String(v.reason).slice(0, 300) } : {}) });
    // A satisfied row without a satisfied verdict is a close the grader could not check: done, with "ungraded: <reason>".
    const ungraded = row.state === "satisfied" && v.outcome !== "satisfied" ? (v.outcome === "needs_revision" ? "its criteria were not shown by the evidence" : v.outcome === "cannot_judge" ? "the grader couldn't judge it" : String(v.reason || "the grader failed").slice(0, 300)) : "";
    const note = gradeNote(v, rubric, ungraded ? "ungraded" : row.state, { version: ev.version, reason: ungraded || undefined });
    if (row.state === "satisfied") {
      // The row is satisfied now, so the close and the notice are owed steps: retried until they land, even across a restart.
      await owe(issue.id, [{ do: "done", note, ungraded: Boolean(ungraded), version: ev.version, status: issue.status, deliverable: g.deliverable, rubric }, { do: "tell", issue: { id: issue.id, parentId: issue.parentId }, kind: "done", text: `${issue.identifier} (${agent?.name ?? "its agent"}) is done, ${ungraded ? `ungraded: ${ungraded}` : "graded against its rubric"}: ${issue.title}. Its result is on ${issue.identifier}.` }]);
    } else if (row.state === "needs_revision") {
      await owe(issue.id, [{ do: "reopen", note }]);
      fact("work.waiting", `task:${issue.id}`, attempt, issue.id, { reason: "grade_retry" });
      // The reopen wakes the task's agent through the kernel: nothing to dispatch here.
    } else if (row.state === "escalated") {
      // One question to the delegator, with the grader's note in it; on the task itself only when no open parent hears it (a
      // note there would wake its assignee, who has nothing left to do).
      const ask = `**${issue.identifier} needs your decision** (its grade escalated to you): ${issue.title}. Close it if you're satisfied (that accepts the work), or reopen it with what to change.`;
      // The same escalation again in the same hour (same version, outcome and criteria verdicts) is no news: told once. A new
      // version or verdict, or the same one in a later hour, is told. The notice is an owed step, so a kernel blip retries it.
      const said = JSON.stringify([ev.version, v.outcome, (v.criteria ?? []).map((c: Json) => [c.id, c.met]), Math.floor(Date.now() / 3_600_000)]);
      if (state.get(`escalation-told:${issue.id}`) !== said) {
        state.set(`escalation-told:${issue.id}`, said);
        await owe(issue.id, [{ do: "tell", issue: { id: issue.id, parentId: issue.parentId }, kind: "escalated", text: `${ask}\n\n${note}`, fallback: note }]);
      }
    }
  }

  /** Whether a grade will still speak for this task (notices.ts graderSpeaks): its progress is then not news for its parent. */
  async function graded(issueId: string) {
    return graderSpeaks((await api.get(`/internal/grades/${encodeURIComponent(issueId)}`).catch(() => undefined))?.state);
  }
  return { runGrades, graded };
}
