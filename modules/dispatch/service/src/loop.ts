// Wakes into jobs: each tick follows the module's jobs to their end (posting each outcome once) and claims new inbox rows.
// A claimed comment on a task with a live job goes into that job; any other row starts the task's next job with a prompt
// built from the task and its conversation. What a row may start follows the asker rules (thread.ts). The kernel owns
// admission, limits, identity and the job's lifecycle: a busy kernel (429), or input a run didn't take, leaves the row
// claimed, and its lease brings it back.
import type { DatabaseSync } from "node:sqlite";
import { KernelError, type Kernel, type Wake } from "./kernel.ts";
import { buildPrompt, outcome, type Words } from "./prompt.ts";
import { createAsker } from "./asker.ts";
import { dataBlock as fence } from "./aidenhq-sdk/fence.ts";
import { progressTracker } from "./progress.ts";
import { agentMade, freshWords, moduleMade, ownRequest, redirectNote, speaker, spoke, stripHidden, threadEntries, threadSection, type Agent, type Directory, type Issue } from "./thread.ts";

// The jobs this module started, until their outcome is posted; a start asked for whose answer isn't recorded yet (`starting`:
// a crash or a lost answer leaves it, and the next tick asks the kernel for the wake's job); per task, the newest comment its last job saw; comments a run took as live input; tasks greeted.
const DDL = `CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, task TEXT NOT NULL, agent TEXT NOT NULL, wake TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS starting (wake TEXT PRIMARY KEY, task TEXT NOT NULL, agent TEXT NOT NULL, seen TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS seen (task TEXT PRIMARY KEY, comment TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS delivered (comment TEXT PRIMARY KEY, task TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS greeted (task TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS ended (job TEXT PRIMARY KEY, task TEXT NOT NULL, state TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS summarized (parent TEXT PRIMARY KEY, batch INTEGER NOT NULL);
DROP TABLE IF EXISTS sessions;`;
// A job's end states (kernel jobs.ts); any other state is still live.
const ENDED = new Set(["done", "failed", "cancelled", "timeout", "lost"]);
// A comment on a finished or blocked task would reopen it: those get no note.
const QUIET = new Set(["done", "cancelled", "blocked"]);
const CLOSED = new Set(["done", "cancelled"]);

type Log = (msg: string, f?: Record<string, unknown>) => void;

export function createDispatch({ kernel, db, owner, log = () => {} }: { kernel: Kernel; db: DatabaseSync; owner: string; log?: Log }) {
  db.exec(DDL);
  const q = (sql: string) => db.prepare(sql);
  const asker = createAsker(kernel);
  // Each running job's progress judge, and why this module stopped a job (until its outcome is posted; a restart starts both fresh).
  const judges = new Map<string, ReturnType<typeof progressTracker>>();
  const stoppedFor = new Map<string, string>();

  /** A started job is recorded with the newest comment it saw; its wake's `starting` row goes. */
  const started = (job: string, w: { wake: string; task: string; agent: string; seen: string }) => {
    q("INSERT OR IGNORE INTO jobs (id, task, agent, wake) VALUES (?, ?, ?, ?)").run(job, w.task, w.agent, w.wake);
    q("INSERT INTO seen (task, comment) VALUES (?, ?) ON CONFLICT DO UPDATE SET comment = excluded.comment").run(w.task, w.seen);
    q("DELETE FROM starting WHERE wake = ?").run(w.wake);
  };

  /** Starts whose answer was lost: the kernel's job on the wake is followed; with none, the wake comes back to be claimed. */
  async function recover() {
    for (const r of q("SELECT wake, task, agent, seen FROM starting").all() as { wake: string; task: string; agent: string; seen: string }[]) {
      try {
        const [job] = await kernel.jobsOn(r.wake);
        if (job) { started(job.id, r); log("job recovered", { job: job.id, wake: r.wake }); }
        else q("DELETE FROM starting WHERE wake = ?").run(r.wake);
      } catch (e) {
        log("job recovery failed", { wake: r.wake, err: (e as Error).message });
      }
    }
  }

  /**
   * After a run of an agent's task ends, whoever asked hears what it needs: with a parent, one summary once its last sibling
   * ends; with none, a run that stopped. Once per batch (`summarized`) or per run (the asker's dedupe).
   */
  async function report(task: Issue, job: string, stopped: string | undefined) {
    if (!agentMade(task)) return;
    if (!task.parentId) {
      if (stopped) await asker.tell(task, `**${task.identifier} stopped:** ${stopped}`, "was stopped");
      return;
    }
    // A run's place in the order runs ended here (rowid): a batch is the newest of its siblings' last runs.
    const ended = (t: string) => q("SELECT rowid AS seq, state FROM ended WHERE task = ? ORDER BY rowid DESC LIMIT 1").get(t) as { seq: number; state: string } | undefined;
    const live = (t: string) => Boolean(q("SELECT 1 FROM jobs WHERE task = ? AND done = 0 AND id != ?").get(t, job));
    const last = (q("SELECT batch FROM summarized WHERE parent = ?").get(task.parentId) as { batch: number } | undefined)?.batch ?? 0;
    if (last >= (ended(task.id)?.seq ?? 0)) return;
    const batch = await asker.summarize(task, { ended, live, dir: await kernel.directory() });
    if (batch) q("INSERT INTO summarized (parent, batch) VALUES (?, ?) ON CONFLICT DO UPDATE SET batch = excluded.batch").run(task.parentId, batch);
  }

  /** Each ended job's outcome, once: its reply (none for NO_REPLY), or how it stopped; a run whose task was closed is stopped. */
  async function follow() {
    for (const r of q("SELECT id, task, agent FROM jobs WHERE done = 0").all() as { id: string; task: string; agent: string }[]) {
      try {
        const v = await kernel.job(r.id);
        if (!ENDED.has(v.state)) {
          // A task closed while its run goes on (the owner cancelled it): nothing else would end the run or free its computer.
          if (CLOSED.has(String((await kernel.task(r.task)).status))) { await kernel.stop(r.id); log("task closed while running: run stopped", { job: r.id, task: r.task }); continue; }
          // A run that stops making progress is stopped here (progress.ts); the kernel keeps only the hard deadline.
          const judge = judges.get(r.id) ?? judges.set(r.id, progressTracker()).get(r.id)!;
          judge.add(v.progress?.steps);
          const why = judge.check();
          if (why) { stoppedFor.set(r.id, why); await kernel.stop(r.id); log("run stopped for lack of progress", { job: r.id, task: r.task, why }); }
          continue;
        }
        judges.delete(r.id);
        const o = outcome({ ...v, stopped: stoppedFor.get(r.id) });
        stoppedFor.delete(r.id);
        if (o) await kernel.post(r.id, o);
        q("INSERT OR IGNORE INTO ended (job, task, state) VALUES (?, ?, ?)").run(r.id, r.task, v.state);
        const task = await kernel.task(r.task);
        if (!CLOSED.has(String(task.status))) await report(task, r.id, o?.kind === "notice" ? o.body : undefined);
        q("UPDATE jobs SET done = 1 WHERE id = ?").run(r.id);
        log("job ended", { job: r.id, task: r.task, state: v.state, posted: o?.kind ?? null });
      } catch (e) {
        log("job follow failed", { job: r.id, err: (e as Error).message });
      }
    }
  }

  async function handle(w: Wake, tick: { dir?: Directory; agents: Map<string, Agent>; redirected: Set<string> }) {
    const [task, comments] = await Promise.all([kernel.task(w.task), kernel.comments(w.task)]);
    const dir = (tick.dir ??= await kernel.directory());
    const agents = tick.agents;
    for (const id of new Set([task.assigneeAgentId, task.createdByAgentId, ...comments.map((c) => c.authorAgentId)])) if (id && !agents.has(id)) { const a = await kernel.agent(id); if (a) agents.set(id, a); }

    if (w.cause === "comment") {
      const c = comments.find((x) => `comment:${x.id}` === w.key);
      const who = c ? speaker(c, task, dir) : "ours";
      if (who === "ours") return kernel.drop(w.key, c ? "our own words" : "the comment is gone");
      if (who === "other") {
        if (!QUIET.has(String(task.status)) && !tick.redirected.has(task.id)) await kernel.note(w.key, redirectNote(task, owner, agents));
        tick.redirected.add(task.id);
        return kernel.drop(w.key, "another agent's comment: only the asker, the owner or the chief of staff start work");
      }
      if (w.live_job) {
        const from = who === "owner" ? "owner" : who === "notice" ? "wake notice" : agents.get(c!.authorAgentId!)?.name ?? "agent";
        const r = await kernel.input(w.live_job, { text: stripHidden(c!.body).trim(), from, wake: w.key });
        if (r.sent) q("INSERT OR IGNORE INTO delivered (comment, task) VALUES (?, ?)").run(c!.id, task.id);
        log(r.sent ? "comment passed to the run" : "the run took no input: the comment waits for the next job", { task: task.identifier, job: w.live_job });
        return;
      }
    }

    // The kernel resumes the engine's session on this task (reset and a changed engine start fresh): a task this module ran to
    // the end is sent in its resumed form, with the full form beside it for the kernel to use when it finds no session.
    const ran = Boolean(q("SELECT 1 FROM ended WHERE task = ? AND state = 'done'").get(task.id));
    const first = !ran && !spoke(comments, task);
    const seen = (q("SELECT comment FROM seen WHERE task = ?").get(task.id) as { comment: string } | undefined)?.comment;
    const delivered = new Set((q("SELECT comment FROM delivered WHERE task = ?").all(task.id) as { comment: string }[]).map((r) => r.comment));
    const fresh = freshWords(comments, task, dir, { seen, delivered });
    // A routine run's wake (routine, or routine:<key> naming the routine) or a module's scheduled wake.
    const scheduled = /^(routine|scheduled)(:|$)/.test(w.cause);
    const said = (who: string) => fresh.filter((f) => f.who === who).map((f) => (f.chief ? `${agents.get(f.by!)?.name ?? "The chief of staff"} (the chief of staff, not ${owner}) wrote:\n${fence("CHIEF_OF_STAFF", f.text)}` : f.text));
    const words: Words = { owner: said("owner"), agent: said("agent"), notice: said("notice") };
    if (first && ownRequest(task)) words.task = "owner";
    else if (first && agentMade(task) && stripHidden(task.description).trim()) words.task = "agent";
    else if (first && moduleMade(task)) words.task = "module";
    else if (scheduled && !fresh.length) words.task = "scheduled";

    if (!words.task && !fresh.length) {
      if (!first) return kernel.drop(w.key, "nothing new to act on");
      // A task with no request: its asker (an agent) is told, a person writing the task is asked, once.
      if (!q("SELECT 1 FROM greeted WHERE task = ?").get(task.id) && !QUIET.has(String(task.status))) {
        const ask = `**${task.identifier} has no request:** "${task.title}" reached its agent with an empty description, so nothing has started. Write what to do as a comment on ${task.identifier}, or cancel it.`;
        const told = agentMade(task) ? await asker.tell(task, ask, "needs a decision") : false;
        // The note stays on the task where its asker didn't get it as a task of its own (the owner reads it there).
        if (told !== "parent" && told !== "asker") await kernel.note(w.key, agentMade(task) ? ask : "Ready. What would you like me to do? (Or write it in the task description.)");
        q("INSERT OR IGNORE INTO greeted (task) VALUES (?)").run(task.id);
      }
      return kernel.drop(w.key, "the task has no request");
    }

    const parent = task.parentId ? await kernel.task(task.parentId).catch(() => undefined) : undefined;
    const assignee = agents.get(w.agent);
    const entries = threadEntries(comments, task, { owner, agents, skip: new Set(fresh.map((f) => f.id)) });
    const build = (resumed: boolean) => buildPrompt({ user: owner, task, parent, profile: dir[w.agent]?.profile ?? "crew", persona: assignee?.metadata?.persona, thread: threadSection(owner, entries, { resumed }), words, resumed });
    const start = { wake: w.key, task: w.task, agent: w.agent, seen: comments.at(-1)?.id ?? "" };
    q("INSERT INTO starting (wake, task, agent, seen) VALUES (?, ?, ?, ?) ON CONFLICT DO UPDATE SET seen = excluded.seen").run(start.wake, start.task, start.agent, start.seen);
    try {
      const r = await kernel.start({ wake: w.key, prompt: build(ran), ...(ran ? { full_prompt: build(false) } : {}) });
      if ("busy" in r) {
        q("DELETE FROM starting WHERE wake = ?").run(w.key);
        return log("busy: the wake comes back", { task: task.identifier, wake: w.key });
      }
      started(r.job.id, start);
      log("job started", { job: r.job.id, task: task.identifier, wake: w.key, cause: w.cause });
    } catch (e) {
      // The kernel refused this wake for good (not its agent, task closed or reassigned); anything else (a lost answer
      // included) stays `starting`, and the next tick asks the kernel whether a job came of it.
      if (e instanceof KernelError && e.status >= 400 && e.status < 500) {
        q("DELETE FROM starting WHERE wake = ?").run(w.key);
        return kernel.drop(w.key, e.message);
      }
      throw e;
    }
  }

  return {
    async tick() {
      await recover();
      await follow();
      const tick = { agents: new Map<string, Agent>(), redirected: new Set<string>() };
      for (const w of await kernel.claim(20)) await handle(w, tick).catch((e: Error) => log("wake failed", { wake: w.key, err: e.message }));
    },
  };
}
