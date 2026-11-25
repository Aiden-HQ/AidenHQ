// The event log's reader (the first one in production, kernel/src/events.ts): pages of the log after a committed cursor. Each
// event that matches an armed watch fires it, and the cursor is committed once a page was handled, so a crash resends notices
// the kernel dedupes (one id per watch). A gap (rows pruned past the cursor) or a repo's resync marks the armed watches for a
// live check; a check that can't be read is retried on later passes and never holds the cursor. A task that has ended has its
// watches cancelled each pass.
import { KernelError } from "./aidenhq-sdk/kernel-client.ts";
import { closes, fire, noticeText, reconcile, send, type Kernel } from "./reconcile.ts";
import type { Watch, Watches } from "./watches.ts";

/** A logged event as the kernel serves it (kernel/src/events.ts LoggedEvent): the fields a watch reads. */
type Logged = { id: string; kind: string; resource: string; url?: string; data?: Record<string, unknown> };
type Page = { events: Logged[]; next: number; gap: boolean };
const PAGE = 200, CLOCK_SLACK_MS = 30_000;
type Log = (msg: string, f?: Record<string, unknown>) => void;

/** Whether a logged event is the one the watch waits for: its kind, repo (lower case) and PR number, and merged when asked. */
export function matches(w: Watch, e: { kind: string; resource: string; data?: Record<string, unknown> }): boolean {
  // A close from before the watch was armed belongs to an earlier life of the PR (closed, then reopened): the live check at arm decided.
  // GitHub's own closing time is compared, not when the log took the event; a little slack covers the clocks' difference.
  return Date.parse(String(e.data?.closed_at)) >= w.at - CLOCK_SLACK_MS && e.kind === w.kind && e.resource.toLowerCase() === w.resource && Number(e.data?.number) === w.match.number && closes(w, e.data?.merged === true);
}

export function createReader({ kernel, watches, log }: { kernel: Kernel; watches: Watches; log: Log }) {
  const settled = (s: string | undefined) => s === "done" || s === "cancelled" || s === "gone";

  /**
   * The watches marked for a live check (service start, a gap, a repo's resync) against the live state. One that can't be read now
   * stays marked and is tried again on the next pass: it never holds the log's cursor or another watch back.
   */
  async function checkPending() {
    for (const w of watches.toCheck()) {
      await reconcile(kernel, watches, w).then(() => watches.checked(w.id), (e) => log("watch not checked live yet", { watch: w.id, err: String(e.message).slice(0, 200) }));
    }
  }

  /** Marks every armed watch for a live check, and checks them: the service has just started. */
  async function reconcileAll() { watches.markCheck(); await checkPending(); }

  /** The watches of tasks that have ended are cancelled: the session is finished. */
  async function sweep() {
    for (const task of new Set(watches.armed().map((w) => w.task))) {
      // A task that is done, cancelled or gone has no session to wake; any other failed read says nothing and is tried again.
      const status = await kernel.read(`/api/issues/${encodeURIComponent(task)}`).then((i) => i?.status, (e) => (e instanceof KernelError && e.status === 404 ? "gone" : undefined));
      if (settled(status)) { watches.cancelTask(task); log("watches cancelled: the task ended", { task }); }
    }
  }

  async function tick() {
    await sweep();
    // One notice that can't be filed (its task's thread unreadable) stays pending and never holds the others back.
    for (const w of watches.unsent()) await send(kernel, watches, w).catch((e) => log("wake notice not filed yet", { watch: w.id, err: String(e.message).slice(0, 200) }));
    const after = watches.cursor();
    // A first read has no cursor: the log answers its end, where this reader starts (a watch armed before it was reconciled on arm).
    // Events that came before the cursor existed are lost, so every armed watch is checked live.
    if (after === undefined) { watches.setCursor((await kernel.call("GET", "/v1/events/log?connection=github")).next); watches.markCheck(); }
    for (;;) {
      const page = (await kernel.call("GET", `/v1/events/log?connection=github&after=${watches.cursor()}`)) as Page;
      // Events that may have been missed (rows pruned past the cursor): every armed watch is checked live.
      if (page.gap) watches.markCheck();
      for (const e of page.events) {
        // A repo's first feed pass (or a rebuilt feed state) emits a resync, not the closures before it: its watches are checked live.
        if (e.kind === "github.resync") { watches.markCheck(e.resource.toLowerCase()); continue; }
        for (const w of watches.armed()) {
          if (!matches(w, e)) continue;
          await fire(kernel, watches, w, e.id, noticeText(w, { url: e.url, merged: e.data?.merged === true, sha: typeof e.data?.merge_sha === "string" ? e.data.merge_sha : null }))
            .catch((e2) => log("wake notice not filed yet", { watch: w.id, err: String(e2.message).slice(0, 200) }));
        }
      }
      watches.setCursor(page.next);
      if (page.events.length < PAGE) break;
    }
    // Once a pass, after the events: the marks this pass made, and the checks that couldn't be read before.
    await checkPending();
  }
  return { tick, reconcileAll, sweep };
}
