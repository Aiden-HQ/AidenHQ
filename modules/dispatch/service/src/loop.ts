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
import { createRoutines } from "./routines.ts";
import { progressTracker } from "./progress.ts";
import { agentMade, freshWords, moduleMade, ownRequest, redirectNote, speaker, spoke, stripHidden, threadEntries, threadSection, type Agent, type Directory, type Issue } from "./thread.ts";

// What this module keeps is conversation state: per task, the newest comment its last job saw; comments a run took as live input;
// tasks greeted; per parent, the batch of sub-task runs already summarized. The jobs themselves, their ends and their
// acknowledgements are the kernel's ledger (jobs?open=1, jobs?task=, ack).
const DDL = `CREATE TABLE IF NOT EXISTS seen (task TEXT PRIMARY KEY, comment TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS delivered (comment TEXT PRIMARY KEY, task TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS greeted (task TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS summarized (parent TEXT PRIMARY KEY, batch INTEGER NOT NULL);
DROP TABLE IF EXISTS jobs; DROP TABLE IF EXISTS starting; DROP TABLE IF EXISTS ended; DROP TABLE IF EXISTS sessions;`;
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
  const routines = createRoutines(kernel, log);
  // Each running job's progress judge, and why this module stopped a job (until its outcome is posted; a restart starts both fresh).
  const judges = new Map<string, ReturnType<typeof progressTracker>>();
  const stoppedFor = new Map<string, string>();

  /**
   * After a run of an agent's task ends, whoever asked hears what it needs: a task left blocked, with the run's reply as the reason;
   * with a parent, one summary once its last sibling ends; with none, a run that stopped. Once per batch (`summarized`) or per run (the asker's dedupe). A run's place in the order is when the kernel saw it end.
   */
  async function report(task: Issue, job: string, stopped: string | undefined, said: string | undefined) {
    if (!agentMade(task)) return;
    if (task.status === "blocked") { await asker.tell(task, `**${task.identifier} is blocked:** ${said?.slice(0, 600) || stopped || "its run ended without saying why."}\n\nUnblock it, re-route it, or tell the owner what is needed.`, "is blocked"); return; }
    if (!task.parentId) {
      if (stopped) await asker.tell(task, `**${task.identifier} stopped:** ${stopped}`, "was stopped");
      return;
    }
    // The kernel's ledger: a task's runs that are done with (acknowledged, or this one) are its ended runs; any other is still busy.
    const ended = async (t: string) => {
      const j = (await kernel.jobsOf(t)).find((x) => ENDED.has(x.state) && (x.acked || x.id === job));
      return j && { seq: j.ended ?? j.at, state: j.state };
    };
    const live = async (t: string) => (await kernel.jobsOf(t)).some((j) => !j.acked && j.id !== job);
    const last = (q("SELECT batch FROM summarized WHERE parent = ?").get(task.parentId) as { batch: number } | undefined)?.batch ?? 0;
    if (last >= ((await ended(task.id))?.seq ?? 0)) return;
    const batch = await asker.summarize(task, { ended, live, dir: await kernel.directory() });
    if (batch) q("INSERT INTO summarized (parent, batch) VALUES (?, ?) ON CONFLICT DO UPDATE SET batch = excluded.batch").run(task.parentId, batch);
  }

  /** Each ended job's outcome, once: its reply (none for NO_REPLY), or how it stopped; a run whose task was closed is stopped. */
  async function follow() {
    for (const v of await kernel.open()) {
      try {
        if (!ENDED.has(v.state)) {
          // A task closed while its run goes on (the owner cancelled it): nothing else would end the run or free its computer.
          if (CLOSED.has(String((await kernel.task(v.task)).status))) { await kernel.stop(v.id); log("task closed while running: run stopped", { job: v.id, task: v.task }); continue; }
          // A run that stops making progress is stopped here (progress.ts); the kernel keeps only the hard deadline.
          const judge = judges.get(v.id) ?? judges.set(v.id, progressTracker()).get(v.id)!;
          judge.add(v.progress?.steps);
          const why = judge.check();
          if (why) { stoppedFor.set(v.id, why); await kernel.stop(v.id); log("run stopped for lack of progress", { job: v.id, task: v.task, why }); }
          continue;
        }
        judges.delete(v.id);
        const o = outcome({ ...v, stopped: stoppedFor.get(v.id) });
        stoppedFor.delete(v.id);
        if (o) await kernel.post(v.id, o);
        const task = await kernel.task(v.task);
        if (!CLOSED.has(String(task.status))) await report(task, v.id, o?.kind === "notice" ? o.body : undefined, o?.body);
        await kernel.ack(v.id);
        log("job ended", { job: v.id, task: v.task, state: v.state, posted: o?.kind ?? null });
      } catch (e) {
        log("job follow failed", { job: v.id, err: (e as Error).message });
      }
    }
  }

  async function handle(w: Wake, tick: { dir?: Directory; agents: Map<string, Agent>; redirected: Set<string> }) {
    const [task, comments] = await Promise.all([kernel.task(w.task), kernel.comments(w.task)]);
    const dir = (tick.dir ??= await kernel.directory());
    const agents = tick.agents;
    for (const id of new Set([task.assigneeAgentId, task.createdByAgentId, ...comments.map((c) => c.authorAgentId)])) if (id && !agents.has(id)) { const a = await kernel.agent(id); if (a) agents.set(id, a); }

    if (/^routine(:|$)/.test(w.cause) && (await routines.coalesce(task))) return kernel.drop(w.key, "folded into an earlier run of its routine");
    if (w.cause === "comment") {
      const c = comments.find((x) => `comment:${x.id}` === w.key);
      const who = c ? speaker(c, task, dir) : "ours";
      if (who === "ours") return kernel.drop(w.key, c ? "our own words" : "the comment is gone");
      if (who === "other") {
        if (!QUIET.has(String(task.status)) && !tick.redirected.has(task.id)) await kernel.note(w.key, redirectNote(task, owner, agents));
        tick.redirected.add(task.id);
        return kernel.drop(w.key, "another agent's comment: only the asker, the owner or a fleet overseer start work");
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
    const ran = (await kernel.jobsOf(task.id)).some((j) => j.state === "done");
    const first = !ran && !spoke(comments, task);
    const seen = (q("SELECT comment FROM seen WHERE task = ?").get(task.id) as { comment: string } | undefined)?.comment;
    const delivered = new Set((q("SELECT comment FROM delivered WHERE task = ?").all(task.id) as { comment: string }[]).map((r) => r.comment));
    // A task the agent spoke on before this module ran it (no `seen` yet): what came before this comment's wake is history, never new words.
    const start = seen === undefined && !first && w.cause === "comment" ? w.key.replace(/^comment:/, "") : undefined;
    const fresh = freshWords(comments, task, dir, { seen, delivered, start });
    // A routine run's wake (routine, or routine:<key> naming the routine) or a module's scheduled wake.
    const scheduled = /^(routine|scheduled)(:|$)/.test(w.cause);
    const said = (who: string) => fresh.filter((f) => f.who === who).map((f) => (who === "agent" ? `${agents.get(f.by!)?.name ?? "An agent"} (an agent, not ${owner}) wrote:\n${fence("AGENT", f.text)}` : f.text));
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
    try {
      const r = await kernel.start({ wake: w.key, prompt: build(ran), ...(ran ? { full_prompt: build(false) } : {}) });
      if ("busy" in r) return log("busy: the wake comes back", { task: task.identifier, wake: w.key });
      q("INSERT INTO seen (task, comment) VALUES (?, ?) ON CONFLICT DO UPDATE SET comment = excluded.comment").run(w.task, comments.at(-1)?.id ?? "");
      log("job started", { job: r.job.id, task: task.identifier, wake: w.key, cause: w.cause });
    } catch (e) {
      // The kernel refused this wake for good (not its agent, task closed or reassigned). Anything else (a lost answer
      // included) leaves the wake claimed: its lease brings it back if no job came of it, and a job that did is in the open list.
      if (e instanceof KernelError && e.status >= 400 && e.status < 500) return kernel.drop(w.key, e.message);
      throw e;
    }
  }

  return {
    async tick() {
      await follow();
      await routines.sweep(async () => Object.keys(await kernel.directory()));
      const tick = { agents: new Map<string, Agent>(), redirected: new Set<string>() };
      for (const w of await kernel.claim(20)) await handle(w, tick).catch((e: Error) => log("wake failed", { wake: w.key, err: e.message }));
    },
  };
}
