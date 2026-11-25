// The release train's loop (W3; the runner's runReleases, moved): once a minute, over cached inputs (no GitHub read on the
// timer: instance.yaml read at start and on each push to the instance repo, `refresh`; the product tip and whether it is green
// from the change feed's snapshot of that head, `github.tip`), the instance target's bump decided by
// release.ts trainStep, written by code and filed as a kernel.apply through the kernel's /v1/writes with this module's own
// token (role kernel.apply). The kernel plans it (kernel/src/apply-tier.ts) and tiers it like any apply, with no branch for who
// filed it. Its task is one the kernel
// files for the agent holding the platform-engineer role (POST /v1/tasks, role kernel.tasks), once per tip.
//
// No apply runs twice: the bump's commit is deterministic for the same instance main and pins, the bump being filed is
// written down before it is filed (a restart files the same commit again, which the kernel answers with the same open
// record), and a filed bump is followed by its record until it ends; the executor launches each record once. A bump whose
// written-down state is lost is recovered through the kernel's idempotent task filing (release:instance:<sha>) and the card
// on that task, so a replaced process still settles the task it opened: a failed or unknown card closes it "Not landed".
// A bump filed by a process that is gone (the runner's own ms stamp, or a train that restarted onto a newer tip) is settled by
// a sweep on every poll: it lists the open tasks of the train's source family and acts on each one's newest card, with no
// memory of it at all. The family is the only one it can list or close this way (kernel/src/modtasks.ts).
//
// Only the instance's product pin: the official modules are the product's modules/ (owner, 2026-11-18). The task is filed
// when the bump files (no description updates as merges land), filed quiet so its assignment wakes nobody: the card carries
// the work and the train follows it.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pinOwner } from "./aidenhq-sdk/pin-owner.ts";
import { bumpInstance, trainDescription, trainStep } from "./release.ts";

export type Commit = { repo: string; sha: string; subject: string };
export type TrainOptions = {
  dir: string; productRepo: string; instanceRepo: string; windowMinutes: number;
  /** The kernel with this module's token: POST /v1/tasks, /v1/tasks/:id/close, /v1/writes; GET /v1/work?task=, /v1/tasks?source=. */
  kernel(method: "GET" | "POST", path: string, body?: unknown): Promise<any>;
  github: {
    /** A repo's default branch head and whether every check on it passed; undefined while not known yet. */
    tip(repo: string): Promise<{ tip?: string; green: boolean } | undefined>;
    /** A file at the default branch's head, undefined when it isn't there. */
    text(repo: string, path: string, at?: string): Promise<string | undefined>;
    commits(repo: string, from: string, to: string): Promise<Commit[]>;
  };
  /**
   * The bump's commit on the instance's main, in this service's cache: `edit` reads the file at the head it builds on. With
   * `base`, the commit is refused unless that head is exactly the revision the compile preflight passed, so the bump can never
   * be built on settings the check never saw.
   */
  commit(repo: string, path: string, edit: (text: string) => string, message: string, base?: string): Promise<string>;
  /**
   * Compiles the instance as it stands on its main against product commit `to`, the way the apply stages it (the kernel's
   * /v1/compile/check): `{ok: true, base}`, or the compiler's first message when the target would refuse it. `base` is the
   * instance commit that was compiled, and the bump is committed on it or not at all. Throws when the check itself couldn't run
   * (a transient read), which is retried on the next poll, never read as a refusal.
   */
  compile(to: string): Promise<{ ok: true; base: string } | { ok: false; error: string; base: string }>;
  now?: () => Date; log?: (msg: string, f?: Record<string, unknown>) => void;
};
type State = {
  open?: { since: string };
  /** The bump's task, filed; `sha` once its commit is made, `base` the instance revision the preflight passed. */
  filing?: { to: string; sha?: string; base?: string; task: string; identifier: string };
  flight?: { to: string; record: string; task: string; identifier: string };
  lastTried?: string;
  /**
   * A target the preflight refused, with the instance text it refused: the refusal is a fact about that instance, so the same tip
   * is checked again once the instance's own text changes (the owner fixes the setting), not only on a newer product merge.
   */
  refused?: { to: string; text: string; base?: string; instance?: string; at?: string };
  /** A task filed for a bump that ended before its card: closed with the reason, retried next poll if the close was refused. */
  orphan?: { to: string; task: string; error: string };
};
const MOVING = ["review", "owner", "approved", "claimed"];
/** A land refused because main moved on, or the eval still running: that bump is over, and its commits are filed again. */
const REFILE = /moved on since this commit's base|not landed: .*(eval|isn't at)/;

export function createReleaseTrain(o: TrainOptions) {
  const log = o.log ?? (() => {});
  /** instance.yaml as last read (refresh): at start, then on each push to the instance repo. */
  let instanceText: Promise<string | undefined> | undefined;
  const refresh = (at?: string) => { const p = o.github.text(o.instanceRepo, "instance.yaml", at); instanceText = p; p.catch(() => { if (instanceText === p) instanceText = undefined; }); return p; };
  const now = o.now ?? (() => new Date());
  mkdirSync(o.dir, { recursive: true });
  const file = join(o.dir, "release-instance.json");
  const load = (): State => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {});
  const save = (s: State) => { writeFileSync(`${file}.tmp`, JSON.stringify(s)); renameSync(`${file}.tmp`, file); };
  /** A close the kernel refuses answers false, never throws: the bump stays on record and the next poll retries it. */
  const close = async (task: string, status: "done" | "cancelled", body: string) => {
    try { await o.kernel("POST", `/v1/tasks/${task}/close`, { status, body }); return true; }
    catch (e) { log("release task not closed", { task, err: (e as Error).message }); return false; }
  };

  /**
   * The kernel.apply filed on this bump's task: the newest, or the one `id` names. Read from the kernel's work log by task, never
   * from this process's memory, so a card another process filed is followed too. A task holds one source (one bump), so its
   * kernel.apply is that bump's card. A failed read throws; so does a named card the log doesn't have (never silently stranded).
   */
  async function cardOn(task: string, id?: string): Promise<{ id: string; state: string; text: string } | undefined> {
    const work = await o.kernel("GET", `/v1/work?task=${encodeURIComponent(task)}`);
    const r = ((work?.records ?? []) as { id: string; kind: string; state: string; outcome_text?: string | null }[]).find((x) => x.kind === "kernel.apply" && (!id || x.id === id));
    if (!r && id) throw new Error(`no kernel.apply ${id} on ${task}`);
    return r && { id: r.id, state: r.state, text: String(r.outcome_text ?? "").split("\n")[0]!.slice(0, 300) };
  }

  /** A filed bump: over once its card is. A land refused because main moved on, or the eval still running, is filed again. */
  async function follow(s: State) {
    const f = s.flight!;
    const r = await cardOn(f.task, f.record);
    if (!r || MOVING.includes(r.state)) return;
    const retry = r.state === "failed" && REFILE.test(r.text);
    const body = settleBody(r.state, r.text, retry);
    // Only an install closes the task done: every other settled ending leaves the bump not landed, so the task is cancelled.
    // A close the kernel refused leaves the flight entry where it is, so the next poll settles the task rather than abandoning it.
    if (!(await close(f.task, r.state === "done" ? "done" : "cancelled", body))) return;
    log("release bump over", { task: f.identifier, state: r.state, retry });
    if (!retry) s.lastTried = f.to;
    delete s.flight;
  }

  /**
   * A settled bump's note: `retry` (a land refused on a moved base or a running eval) says the same commits are filed again.
   */
  function settleBody(state: string, text: string, retry = false) {
    if (state === "done") return "Applied: this instance runs the bump.";
    const why = state === "rejected" ? "the card was rejected" : state === "failed" || state === "unknown" ? `it was approved but failed: ${text}` : `the card was ${state}`;
    return `**Not landed:** ${why}. ${retry ? "The same commits are filed again as the next bump." : "The next merge to the product files the next bump."}`;
  }

  /**
   * Every poll, whether or not this process has a bump in flight: the open tasks stamped `release:instance:` by any process (this
   * train's 40-hex sha or the runner's old ms stamp), settled by the newest kernel.apply on each. A card still moving is left
   * alone; a task filed by a process that is gone is closed with the note follow() writes, so it never strands. The task in
   * flight is skipped: follow() owns it, and the two must not race to close it.
   */
  async function sweep(skip?: string) {
    const open = await o.kernel("GET", "/v1/tasks?source=release:instance:");
    for (const task of ((open?.tasks ?? []) as { id: string; identifier?: string; status?: string }[])) {
      if (!task.id || task.id === skip) continue;
      // One task's refused read is logged and retried next poll; it never stops the train's own follow and filing.
      try {
        // No card at all: a task filed before its card (the gap between filing the task and filing the apply) or one whose
        // process died in it. Nothing is known about its bump, so it is left open rather than closed as never carded.
        // Any card that has ended settles its task: done, failed, unknown, rejected, and also cancelled (expired, replaced) or stale.
        const r = await cardOn(task.id);
        if (!r || MOVING.includes(r.state)) continue;
        const body = settleBody(r.state, r.text);
        // A close the kernel refuses is logged by close() and retried on the next poll: it never throws the sweep.
        if (await close(task.id, r.state === "done" ? "done" : "cancelled", body)) log("release bump swept", { task: task.identifier ?? task.id, state: r.state });
      } catch (e) {
        log("release bump sweep read failed", { task: task.identifier ?? task.id, err: (e as Error).message.slice(0, 300) });
      }
    }
  }

  /**
   * The bump's task, its commit and its kernel.apply, each written down as soon as it exists: a restart files the same one, and
   * a lasting refusal after the task is filed closes that task (step), never strands it.
   */
  async function fileBump(s: State, to: string, pinned: string, text: string) {
    // The edit is made on instance.yaml as it is at the head the commit builds on, never on the text read in step.
    const edit = (t: string) => {
      try {
        return bumpInstance(t, { product: to });
      } catch (e) {
        throw Object.assign(new Error(`instance.yaml can't be bumped in place: ${(e as Error).message}`), { lasting: true });
      }
    };
    // `adopt`: the bump's task was filed before, by this process (its own file) or one this process replaced (the kernel's
    // idempotent re-file answers `deduplicated`). Either way its card, if any, is on that task.
    let adopt = Boolean(s.filing?.to === to);
    // A filing with no `base` was written before the preflight existed (a bump held by a process running the previous code), or its
    // base was dropped because main moved. It is checked now, never filed on a verdict it never had — including one that already
    // carries a saved `sha`: that commit is only this service's train ref (`refs/train/<sha>`), never pushed, so the bump is still
    // uncommitted on the instance, and filing its card would be exactly the #1730 break. A filing that has a base passed the check;
    // it is committed and filed as before.
    if (!s.filing || s.filing.to !== to || !s.filing.base) {
      if (!s.filing || s.filing.to !== to) edit(text); // refused before a task is filed for it
      // A restored filing may already have its card: the previous process filed the apply and stopped before saving `s.flight`.
      // Its card can still land the bump, so it is adopted (followed) instead of the task being closed "Not filed" under a card
      // that applies anyway. A card this target never got is not one to adopt: it is only a card on this filing's own task.
      if (s.filing && s.filing.to === to) {
        const had = await cardOn(s.filing.task);
        // Exactly the rule the ordinary adopt path uses: a card whose end said the same commits are filed again is this bump's
        // end, not one to adopt; anything else (moving, or settled done/rejected/failed) is followed, which settles the task.
        if (had && !(had.state === "failed" && REFILE.test(had.text))) {
          s.flight = { to, record: had.id, task: s.filing.task, identifier: s.filing.identifier };
          delete s.filing;
          delete s.open;
          log("release bump adopted before its preflight", { task: s.flight.identifier, to, record: had.id, state: had.state });
          save(s);
          await follow(s);
          return;
        }
      }
      // The target must compile the instance it would pin, before anything is committed or filed: the apply's own staged
      // compile against the target product (#1730). A target that doesn't is never tried again (the next merge files the next
      // attempt, at a target that may compile); a check that couldn't run throws and is retried on the next poll with no state
      // touched, so nothing is closed for a transient failure.
      const compiled = await o.compile(to);
      if (!compiled.ok) {
        log(`release bump not filed: the target product ${to.slice(0, 12)} doesn't compile the instance`, { to, err: compiled.error });
        s.lastTried = to;
        s.refused = { to, text, base: compiled.base, instance: (await o.github.tip(o.instanceRepo))?.tip, at: now().toISOString() };
        delete s.open;
        // The task filed for this bump (an earlier process's, or one this process restored) is settled here, with or without a saved
        // commit: it has no card and never gets one (the target is refused), so leaving it open would strand it. Not lasting-refused
        // through step(): that path assumes the task came from this attempt's own filing write.
        const filed = s.filing && s.filing.to === to ? s.filing.task : undefined;
        delete s.filing;
        if (filed) s.orphan = { to, task: filed, error: compiled.error };
        save(s);
        if (s.orphan) await settleOrphan(s);
        return;
      }
      delete s.refused;
      if (!s.filing || s.filing.to !== to) {
        const carries = await o.github.commits(o.productRepo, pinned, to);
        const source = `release:instance:${to}`;
        // Idempotent per source: a restart adopts the task an earlier process filed for this commit instead of opening a second.
        const task = await o.kernel("POST", "/v1/tasks", {
          title: "Pin bump: this instance's product", role: "platform-engineer", source, quiet: true,
          description: trainDescription({ what: `Moves this instance's product pin (\`product:\` in ${o.instanceRepo}'s instance.yaml) to the newest green commit of ${o.productRepo}'s main, as one apply.`, carries, windowMinutes: o.windowMinutes, marker: source }),
        });
        s.filing = { to, base: compiled.base, task: task.id, identifier: task.identifier };
        adopt ||= Boolean(task.deduplicated);
      } else {
        // The task was filed before (or a 409 dropped its base): this is the same bump, now checked on the current main. A commit
        // saved before any check existed is rebuilt on the revision that just passed — it is a train ref, never pushed — so no
        // card is ever filed at a commit built on a main the check never compiled.
        if (!s.filing.base) delete s.filing.sha;
        s.filing = { ...s.filing, base: compiled.base };
      }
      save(s);
    }
    const f = s.filing;
    if (!f.sha) {
      try {
        f.sha = await o.commit(o.instanceRepo, "instance.yaml", edit, `chore: product ${to.slice(0, 8)} (${f.identifier})\n\nWritten by the code host's release train; no agent wrote it.`, f.base);
      } catch (e) {
        // The instance moved since the preflight compiled it: that verdict is for another revision. Its base is dropped (never the
        // filing), so the next poll checks the new main and commits on it — and the task already filed for this target is reused,
        // not left open with no card.
        if ((e as { status?: number }).status !== 409) throw e;
        log("release bump held: the instance moved since the compile check", { to, base: f.base });
        delete f.base;
        save(s);
        return;
      }
      save(s);
    }
    // A bump whose task already existed may already have its card: it is followed, never filed a second time. Moving, it is left
    // alone; settled, it settles the task. A card that ended where the same commits are filed again is that bump's end, not one
    // to adopt. A read that fails throws: the next poll retries with the same task, never a second card.
    if (adopt) {
      const had = await cardOn(f.task);
      if (had && !(had.state === "failed" && REFILE.test(had.text))) {
        s.flight = { to, record: had.id, task: f.task, identifier: f.identifier };
        delete s.filing;
        delete s.open;
        log("release bump adopted", { task: f.identifier, to, record: had.id });
        await follow(s);
        return;
      }
    }
    // The kernel's refusal (its rules, the grant) is lasting; anything else is tried again next poll with the same commit.
    const r = await o.kernel("POST", "/v1/writes", { kind: "kernel.apply", args: { repo: o.instanceRepo, branch: `fleet/release-${f.identifier.toLowerCase()}`, sha: f.sha }, task: f.task })
      .catch((e: Error) => { throw Object.assign(e, { lasting: /answered (403|422)\b/.test(e.message) }); });
    s.flight = { to, record: r.id, task: f.task, identifier: f.identifier };
    delete s.filing;
    delete s.open;
    log("release bump filed", { task: f.identifier, to, record: r.id, tier: r.tier });
  }

  /**
   * A task filed for a bump that ended before it had a card: closed "Not filed" with the reason. The kernel's refusal to close
   * leaves it on record, so the next poll says it again rather than stranding it; the sweep leaves cardless tasks alone on purpose.
   */
  async function settleOrphan(s: State) {
    const o = s.orphan;
    if (!o) return;
    if (await close(o.task, "cancelled", `**Not filed:** the target product ${o.to.slice(0, 12)} doesn't compile the instance: ${o.error}`.slice(0, 1000))) {
      log("release bump task settled", { to: o.to });
      delete s.orphan;
      save(s);
    }
  }

  async function step() {
    const s = load();
    try {
      // The task follow() is about to settle is skipped by the sweep below, even once follow() has cleared the flight.
      const flown = s.flight?.task;
      if (s.flight) await follow(s);
      // A bump whose task this process never had in hand is still settled: before the train decides whether it has work at all.
      await sweep(flown);
      await settleOrphan(s);
      const instance = await (instanceText ?? refresh());
      // An instance that installs releases (a `release:` key) is the kernel's updater's: the train stays idle.
      if (pinOwner(instance ?? "") !== "train") return;
      const pinned = /^product:[ \t]*["']?([0-9a-f]{40})["']?[ \t]*(?:#.*)?$/m.exec(instance ?? "")?.[1];
      const head = await o.github.tip(o.productRepo);
      if (!head) return;
      const { tip, green } = head;
      // A refusal is about the instance revision that was compiled, so it is rechecked when that revision is no longer main: any
      // change to instance.yaml, apps.yaml, a local module or an agent's files moves the commit. instance.yaml's own text catches a
      // settings fix even before the push is seen; a tip refused for longer is checked again every half hour as a backstop.
      const movedInstance = s.refused?.instance ? (await o.github.tip(o.instanceRepo))?.tip : undefined;
      if (s.refused && s.refused.to === tip && (s.refused.text !== (instance ?? "") || (movedInstance !== undefined && movedInstance !== s.refused.instance) || Date.parse(now().toISOString()) - Date.parse(s.refused.at ?? "") >= 30 * 60_000)) {
        log("release bump rechecked: the instance changed since the target refused it", { to: tip, was: s.refused.instance, now: movedInstance });
        delete s.lastTried;
        delete s.refused;
      }
      const d = trainStep({ tip, green, pinned, lastTried: s.lastTried, open: s.open, flight: s.flight, now: now().toISOString(), windowMinutes: o.windowMinutes });
      if (d.do === "open") s.open = { since: now().toISOString() };
      else if (d.do === "close") delete s.open;
      else if (d.do === "file" || s.filing) {
        try {
          await fileBump(s, s.filing?.to ?? tip!, pinned!, instance!);
        } catch (e) {
          if (!(e as { lasting?: boolean }).lasting) throw e;
          // Refused for good (the rules, the eval, the edit): said on the bump's task if it has one; the next merge files the next.
          // A close that doesn't land keeps the filing, so the next poll says it again instead of leaving the task open.
          if (s.filing && !(await close(s.filing.task, "cancelled", `**Not filed:** ${(e as Error).message.slice(0, 1000)}`))) return;
          log("release bump refused", { to: tip, err: (e as Error).message.slice(0, 300) });
          s.lastTried = s.filing?.to ?? tip;
          delete s.filing;
          delete s.open;
        }
      }
    } finally {
      save(s);
    }
  }
  return {
    step,
    /** Reads instance.yaml again at the commit a push to the instance repo moved its default branch to. */
    refresh: (at?: string) => refresh(at).then(() => undefined),
    start(everyMs = 60_000) {
      let busy = false;
      const tick = () => { if (busy) return; busy = true; step().catch((e: Error) => log("release train step failed", { err: e.message.slice(0, 300) })).finally(() => { busy = false; }); };
      setInterval(tick, everyMs).unref();
      tick();
    },
  };
}
