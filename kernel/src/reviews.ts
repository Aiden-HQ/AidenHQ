// K7, the AI reviewer's slot (reviewer@1, spec §3.3.3; sdk/src/reviewer.ts): a requester's review goes to the bound reviewer
// module with a fresh review token and a reviewer model token, and the module's verdict comes back on POST /v1/reviews/:id
// with that token, which burns on use. Reviews live in memory only: a kernel restart drops them, the requester's call fails,
// and its retry is a new review with a new token, so a token from before the restart opens nothing.
// A record's review is the kernel's (writes.ts review: the runner gathers what the reviewer reads); POST /v1/reviews is the
// runner's check before it files (`aidenhq review`), the same dispatch with nothing recorded.
//
// A review is bounded twice: by `timeoutMs` (the hour its model token lives, so a change read in parts gets its time) and by
// `stallMs`, the window without progress (a keepalive or the verdict) after which it is a failed review. The module's service
// beats every minute while it works (reviewer.ts), so only a review that stopped making progress — a module recreated by an
// apply with its work lost, a call that never returns — reaches the stall window; writes.ts then retries it by REVIEW_TRIES.
// A dispatch's answer names the service instance, and so does its /healthz: the loop asks that each sweep, and a review held by
// an instance other than the one serving now went to a service that restarted, so it is failed at once, never waited out.
import http from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Resolver } from "./net.ts";
import { readHealth } from "./health.ts";

/** The bound reviewer (compile: config/kernel/modules.json `reviewer`). */
export type ReviewerSlot = { module: string; url: string; auth_secret: string };
/** One review waiting: its token's hash, how it ends, when it last showed progress, its hard ceiling and the instance it went to. */
type Pending = { token: Buffer; done: (v: { verdict?: unknown; error?: string }) => void; beat: number; deadline: number; instance?: string; timer?: NodeJS.Timeout };
const fail = (status: number, type: string, message: string) => Object.assign(new Error(message), { status, type });
const hash = (s: string) => createHash("sha256").update(s).digest();
/** What a service may name as its instance (dispatch answer and /healthz alike): anything else is no instance, never a restart. */
const INSTANCE = /^[\w.-]{1,64}$/;
// A review's deadlines are measured on a monotonic clock: a wall-clock step (an NTP correction, a manual change) must neither
// fail a working review early nor hold a lost one past its bound, which is exactly what these windows exist to prevent.
const clock = () => performance.now();
const minutes = (ms: number) => Math.max(1, Math.round(ms / 60_000));

// A large change is read in parts (several calls per vote), so a review gets the hour its model token lives (main.ts) while it
// makes progress, and `stallMs` without any (the issue's window: a lost review is retried well inside the hour).
export function createReviews({ slot, secret, resolver, modelToken, timeoutMs = 60 * 60_000, stallMs = 15 * 60_000, probeMs = 30_000, probeTimeoutMs = 4_000, log = () => {} }: {
  slot: () => ReviewerSlot | undefined; secret: (n: string) => string; resolver: Resolver;
  /** A reviewer-kind gateway token for one review's model calls (the ledger's component names it). */
  modelToken: (component: string) => string;
  timeoutMs?: number;
  /** How long a review may go without a keepalive or a verdict before it is a failed review. */
  stallMs?: number;
  /** How often the bound reviewer's /healthz is asked for its instance (a restart fails what it lost). */
  probeMs?: number;
  /** How long that probe waits for an answer before it is no signal. */
  probeTimeoutMs?: number;
  log?: (msg: string, f?: Record<string, unknown>) => void;
}) {
  const pending = new Map<string, Pending>();
  /** When the bound reviewer's /healthz was last asked. */
  let probed = 0;

  /**
   * What the module's dispatch answer said: accepted, and its service instance when it names one. `accepted: true` is required in
   * reviewer@1, so a 200 that isn't the contract — an empty body, `{"accepted": false}`, a misrouted page — is a failed dispatch,
   * never a review left waiting on a verdict nobody will send. `instance` stays optional: a provider that names none is bounded by
   * the stall window alone.
   *
   * `live.cancelled` is set once the review has ended, and `live.req` is its request: a target that only resolves after that
   * never dispatches (`resolver.resolve` can take seconds), so a reviewer is never started on work whose verdict can't be used.
   */
  async function dispatch(s: ReviewerSlot, body: unknown, live: { req?: http.ClientRequest; cancelled?: boolean } = {}): Promise<{ instance?: string }> {
    const key = secret(s.auth_secret);
    if (!key) throw fail(503, "no_service_key", `${s.module}'s reviewer key is missing`);
    const to = await resolver.resolve(`${s.url.replace(/\/$/, "")}/review`);
    if (live.cancelled) throw fail(502, "review_failed", `${s.module}: the review ended before it was dispatched`);
    const data = Buffer.from(JSON.stringify(body));
    return new Promise<{ instance?: string }>((resolve, reject) => {
      const req = http.request({ host: to.host, port: to.port, path: to.path, method: "POST", timeout: 30_000, headers: { host: new URL(s.url).host, authorization: `Bearer ${key}`, "content-type": "application/json", "content-length": data.length } }, (res) => {
        const chunks: Buffer[] = [];
        let n = 0;
        // Past 4 KB the answer is unusable, not a prefix to parse: a truncated body can still look like `{accepted: true}` and name
        // an instance, so the dispatch fails now and the review is retried instead of being accepted on half an answer.
        res.on("data", (c: Buffer) => {
          n += c.length;
          if (n > 4096) return reject(fail(502, "bad_reviewer", `${s.module} answered more than 4 KB`)), void req.destroy();
          chunks.push(c);
        });
        res.on("end", () => {
          if ((res.statusCode ?? 500) >= 300) return reject(fail(502, "bad_reviewer", `${s.module} answered ${res.statusCode}`));
          let a: { accepted?: unknown; instance?: unknown } | null = null;
          try { a = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { accepted?: unknown; instance?: unknown }; } catch {}
          // Only the contract's own answer accepts the review: a 200 that names no `accepted: true` is a misrouted or broken
          // endpoint, which is a failed dispatch now rather than a review that waits out its window for a verdict never sent.
          if (a?.accepted !== true) return reject(fail(502, "bad_reviewer", `${s.module} didn't accept the review`));
          // The instance is optional (reviewer@1): a service that names none is accepted, and only the stall window bounds its
          // reviews; one that names it is held to the restart check, and a malformed name is no instance at all.
          resolve({ ...(typeof a.instance === "string" && INSTANCE.test(a.instance) ? { instance: a.instance } : {}) });
        });
      });
      live.req = req;
      req.on("timeout", () => req.destroy(fail(504, "timeout", `${s.module} didn't accept the review in 30 s`)));
      req.on("error", (e) => { resolver.forget(s.url); reject((e as { status?: number }).status ? e : fail(502, "bad_reviewer", `${s.module} is unreachable (${e.message})`)); });
      req.end(data);
    });
  }

  /**
   * Ends every review in `covered` that is still held by instance `old` (a service that restarted lost them): the failed-review
   * path. The cutoff is that exact set, not a timestamp: a review acknowledged while the probe was in flight went to a service
   * that is serving now, so an older review's stale instance must not fail it — even when both land in the same clock tick.
   */
  function restarted(module: string, old: string, covered: ReadonlySet<string>) {
    let n = 0;
    for (const [id, p] of pending) {
      if (!covered.has(id) || p.instance !== old) continue;
      log("review lost to a reviewer restart", { module, id, instance: old });
      p.done({ error: `${module} restarted and lost the review` });
      n++;
    }
    return n;
  }

  /** Arms a review's timer for the sooner of its stall window and its ceiling; a beat moves the former. */
  function arm(id: string) {
    const p = pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    const at = Math.min(p.deadline, p.beat + stallMs);
    p.timer = setTimeout(() => {
      const now = clock();
      if (now >= p.beat + stallMs) {
        log("review stalled", { id, ms: now - p.beat });
        p.done({ error: `no progress in ${minutes(stallMs)} min` });
      } else if (now >= p.deadline) {
        p.done({ error: `no verdict in ${minutes(timeoutMs)} min` });
      } else arm(id);
    }, Math.max(0, at - clock()));
    p.timer.unref?.();
  }

  /** What a review's answer means to its requester: its verdict, or the failed-review error (stall, ceiling, restart, its own). */
  function settled(a: { verdict?: unknown; error?: string }): unknown {
    const s = slot();
    if (a.error !== undefined) throw fail(502, "review_failed", `${s?.module ?? "reviewer"}: ${a.error}`);
    const v = a.verdict as { decision?: unknown; reason?: unknown; model?: unknown };
    if (!["approve", "reject", "escalate"].includes(String(v?.decision)) || typeof v.reason !== "string" || typeof v.model !== "string") throw fail(502, "review_failed", `${s?.module ?? "reviewer"}'s verdict is malformed`);
    return a.verdict;
  }

  return {
    /** The reviews still waiting, by the instance that acknowledged them (undefined before its answer): the restart check's set. */
    held: () => [...pending.values()].map((p) => p.instance),
    /** One review, start to verdict: what the module sent, or an error (no reviewer, unreachable, its own failure, stall, timeout). */
    async request(request: Record<string, unknown>): Promise<unknown> {
      const s = slot();
      if (!s) throw fail(503, "no_reviewer", "no reviewer module is installed");
      const id = `r-${randomBytes(8).toString("hex")}`;
      const token = randomBytes(32).toString("base64url");
      const component = typeof request.component === "string" && /^[\w .-]{1,60}$/.test(request.component) ? request.component : "AI reviewer";
      const now = clock();
      const p: Pending = { token: hash(token), done: () => {}, beat: now, deadline: now + timeoutMs };
      const answer = new Promise<{ verdict?: unknown; error?: string }>((done) => (p.done = done));
      pending.set(id, p);
      arm(id);
      try {
        // The stall window bounds the dispatch as well as the work: a service that sends its headers and then stops (recreated
        // mid-answer) ends the review at the stall deadline instead of leaving request() waiting on a dispatch that never ends.
        const live: { req?: http.ClientRequest; cancelled?: boolean } = {};
        const sending = dispatch(s, { id, token, model_token: modelToken(component), request }, live);
        // A dispatch left hanging by an ended review is dropped (its late answer is no one's), never an unhandled rejection.
        sending.catch(() => {});
        const first = await Promise.race([sending.then((ack) => ({ ack })), answer.then((ended) => ({ ended }))]);
        // Ended first: the review is over, so a dispatch still resolving its target is told to stop and a sent one is dropped.
        if ("ended" in first) { live.cancelled = true; live.req?.destroy(); return settled(first.ended); }
        const ack = first.ack;
        // An answer that lands after the review's stall (or ceiling) deadline is too late, as a beat or a verdict is: it must not
        // re-arm a review the kernel has already given up on. The review ends as failed here, so the caller is told instead of
        // waiting on a timer that is already due.
        const now = clock();
        if (pending.has(id) && (now >= p.beat + stallMs || now >= p.deadline)) {
          clearTimeout(p.timer);
          pending.delete(id);
          p.done({ error: now >= p.deadline ? `no verdict in ${minutes(timeoutMs)} min` : `no progress in ${minutes(stallMs)} min` });
        }
        // Which service instance holds this review: check() fails the ones a different instance (a restart) left behind. An answer
        // whose review just ended records nothing: its verdict can no longer decide anything.
        if (pending.has(id)) { if (ack.instance) { p.instance = ack.instance; } p.beat = now; arm(id); }
        const a = await answer;
        return settled(a);
      } finally {
        clearTimeout(pending.get(id)?.timer);
        pending.delete(id);
      }
    },
    /**
     * The bound reviewer's service instance now (its /healthz at the service root) and the reviews failed because it isn't the
     * one they went to: a service recreated by an apply lost them, so they are failed now, never waited out. Asks at most every
     * `probeMs`. Only reviews acknowledged before the probe was sent can be stale: one acknowledged while it was in flight went
     * to a service that is serving now, whatever the older answer says.
     */
    async check(): Promise<number> {
      const s = slot();
      const sent = clock();
      if (!s || sent - probed < probeMs || ![...pending.values()].some((p) => p.instance)) return 0;
      probed = sent;
      // The exact reviews that hold an instance now: one acknowledged while the probe is in flight is not among them.
      const covered = new Set([...pending.entries()].filter(([, p]) => p.instance).map(([id]) => id));
      // The service's own /healthz, read by health.ts's bounded reader (4 s, 8 KB): a hung, flooding or unreachable answer is no
      // signal, never a restart. A body naming no well-formed instance (the null, `ok`, `{"ok":true}` many services send) fails nothing.
      const { status, body } = await readHealth({ resolver, url: s.url, timeoutMs: probeTimeoutMs });
      const instance = status >= 200 && status < 300 && typeof body.instance === "string" && INSTANCE.test(body.instance) ? body.instance : undefined;
      if (!instance) return 0;
      // A review that finished during the probe is no longer pending: it ended on its own, never a restart to report.
      const stale = new Set([...covered].flatMap((id) => { const held = pending.get(id)?.instance; return held && held !== instance ? [held] : []; }));
      let n = 0;
      for (const old of stale) n += restarted(s.module, old, covered);
      return n;
    },
    /**
     * POST /v1/reviews/:id: the module's verdict with that review's token, or its keepalive while it works. False when no review
     * waits for this token.
     */
    verdict(id: string, token: string, body: { error?: unknown; keepalive?: unknown } & Record<string, unknown>): boolean {
      const p = pending.get(id);
      const t = hash(token);
      if (!p || !timingSafeEqual(p.token, t)) return false;
      if (body.keepalive === true) {
        // A beat that arrives after the review's stall (or ceiling) has passed is too late: a delayed event loop can run it
        // before the overdue timer, and a beat must never revive a review the kernel has already given up on.
        const now = clock();
        if (now >= p.beat + stallMs || now >= p.deadline) return false;
        p.beat = now;
        arm(id);
        return true;
      }
      // A verdict that arrives after the review's stall (or ceiling) has passed is too late, as a beat is: a delayed event loop
      // can run it before the overdue timer, and it must not decide a review the kernel has already given up on. The review ends
      // as failed here, so the requester is told rather than left waiting on a timer that no longer fires.
      const now = clock();
      if (now >= p.beat + stallMs || now >= p.deadline) {
        clearTimeout(p.timer);
        pending.delete(id);
        p.done({ error: now >= p.deadline ? `no verdict in ${minutes(timeoutMs)} min` : `no progress in ${minutes(stallMs)} min` });
        return false;
      }
      // The verdict ends the review: its stall timer must never fire after it.
      clearTimeout(p.timer);
      pending.delete(id);
      p.done(body.error !== undefined ? { error: String(body.error).slice(0, 300) } : { verdict: body });
      return true;
    },
  };
}
export type Reviews = ReturnType<typeof createReviews>;
