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
// A dispatch's answer names the service instance: a different one than the module's last is a restart, and the reviews it was
// holding are failed at once, never waited out.
import http from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Resolver } from "./net.ts";

/** The bound reviewer (compile: config/kernel/modules.json `reviewer`). */
export type ReviewerSlot = { module: string; url: string; auth_secret: string };
/** One review waiting: its token's hash, how it ends, when it last showed progress, its hard ceiling and the instance it went to. */
type Pending = { token: Buffer; done: (v: { verdict?: unknown; error?: string }) => void; beat: number; deadline: number; instance?: string; timer?: NodeJS.Timeout };
const fail = (status: number, type: string, message: string) => Object.assign(new Error(message), { status, type });
const hash = (s: string) => createHash("sha256").update(s).digest();
const minutes = (ms: number) => Math.max(1, Math.round(ms / 60_000));

// A large change is read in parts (several calls per vote), so a review gets the hour its model token lives (main.ts) while it
// makes progress, and `stallMs` without any (the issue's window: a lost review is retried well inside the hour).
export function createReviews({ slot, secret, resolver, modelToken, timeoutMs = 60 * 60_000, stallMs = 15 * 60_000, probeMs = 30_000, log = () => {} }: {
  slot: () => ReviewerSlot | undefined; secret: (n: string) => string; resolver: Resolver;
  /** A reviewer-kind gateway token for one review's model calls (the ledger's component names it). */
  modelToken: (component: string) => string;
  timeoutMs?: number;
  /** How long a review may go without a keepalive or a verdict before it is a failed review. */
  stallMs?: number;
  /** How often the bound reviewer's /healthz is asked for its instance (a restart fails what it lost). */
  probeMs?: number;
  log?: (msg: string, f?: Record<string, unknown>) => void;
}) {
  const pending = new Map<string, Pending>();
  /** The service instance each reviewer module last accepted a review as (absent: it names none). */
  const instances = new Map<string, string>();
  /** When the bound reviewer's /healthz was last asked. */
  let probed = 0;

  /** What the module's dispatch answer said: accepted, and its service instance when it names one. */
  async function dispatch(s: ReviewerSlot, body: unknown): Promise<{ instance?: string }> {
    const key = secret(s.auth_secret);
    if (!key) throw fail(503, "no_service_key", `${s.module}'s reviewer key is missing`);
    const to = await resolver.resolve(`${s.url.replace(/\/$/, "")}/review`);
    const data = Buffer.from(JSON.stringify(body));
    return new Promise<{ instance?: string }>((resolve, reject) => {
      const req = http.request({ host: to.host, port: to.port, path: to.path, method: "POST", timeout: 30_000, headers: { host: new URL(s.url).host, authorization: `Bearer ${key}`, "content-type": "application/json", "content-length": data.length } }, (res) => {
        const chunks: Buffer[] = [];
        let n = 0;
        res.on("data", (c: Buffer) => { n += c.length; if (n <= 4096) chunks.push(c); });
        res.on("end", () => {
          if ((res.statusCode ?? 500) >= 300) return reject(fail(502, "bad_reviewer", `${s.module} answered ${res.statusCode}`));
          let a: { instance?: unknown } = {};
          try { a = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { instance?: unknown }; } catch {}
          resolve({ instance: typeof a?.instance === "string" && /^[\w.-]{1,64}$/.test(a.instance) ? a.instance : undefined });
        });
      });
      req.on("timeout", () => req.destroy(fail(504, "timeout", `${s.module} didn't accept the review in 30 s`)));
      req.on("error", (e) => { resolver.forget(s.url); reject((e as { status?: number }).status ? e : fail(502, "bad_reviewer", `${s.module} is unreachable (${e.message})`)); });
      req.end(data);
    });
  }

  /** Ends every review dispatched to `module`'s instance `old` (a service that restarted lost them): the failed-review path. */
  function restarted(module: string, old: string) {
    let n = 0;
    for (const [id, p] of pending) {
      if (p.instance !== old) continue;
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
      const now = Date.now();
      if (now >= p.beat + stallMs) {
        log("review stalled", { id, ms: now - p.beat });
        p.done({ error: `no progress in ${minutes(stallMs)} min` });
      } else if (now >= p.deadline) {
        p.done({ error: `no verdict in ${minutes(timeoutMs)} min` });
      } else arm(id);
    }, Math.max(0, at - Date.now()));
    p.timer.unref?.();
  }

  return {
    /** One review, start to verdict: what the module sent, or an error (no reviewer, unreachable, its own failure, stall, timeout). */
    async request(request: Record<string, unknown>): Promise<unknown> {
      const s = slot();
      if (!s) throw fail(503, "no_reviewer", "no reviewer module is installed");
      const id = `r-${randomBytes(8).toString("hex")}`;
      const token = randomBytes(32).toString("base64url");
      const component = typeof request.component === "string" && /^[\w .-]{1,60}$/.test(request.component) ? request.component : "AI reviewer";
      const now = Date.now();
      const p: Pending = { token: hash(token), done: () => {}, beat: now, deadline: now + timeoutMs };
      const answer = new Promise<{ verdict?: unknown; error?: string }>((done) => (p.done = done));
      pending.set(id, p);
      arm(id);
      try {
        const ack = await dispatch(s, { id, token, model_token: modelToken(component), request });
        // A service answering as an instance other than the module's last was recreated: the reviews it held are gone, so
        // they are failed now, not after the stall window.
        const last = instances.get(s.module);
        if (ack.instance) instances.set(s.module, ack.instance);
        if (ack.instance && last && ack.instance !== last) restarted(s.module, last);
        if (pending.has(id)) { p.instance = ack.instance; p.beat = Date.now(); arm(id); }
        const a = await answer;
        if (a.error !== undefined) throw fail(502, "review_failed", `${s.module}: ${a.error}`);
        const v = a.verdict as { decision?: unknown; reason?: unknown; model?: unknown };
        if (!["approve", "reject", "escalate"].includes(String(v?.decision)) || typeof v.reason !== "string" || typeof v.model !== "string") throw fail(502, "review_failed", `${s.module}'s verdict is malformed`);
        log("review", { id, module: s.module });
        return a.verdict;
      } finally {
        clearTimeout(pending.get(id)?.timer);
        pending.delete(id);
      }
    },
    /**
     * The bound reviewer's service instance now (its /healthz), and the reviews failed because it isn't the one they went to: a
     * service recreated by an apply lost them, so they are failed now, never waited out. Asks at most every `probeMs`.
     */
    async check(): Promise<number> {
      const s = slot();
      const now = Date.now();
      if (!s || now - probed < probeMs || ![...pending.values()].some((p) => p.instance)) return 0;
      probed = now;
      let instance: string | undefined;
      try {
        const to = await resolver.resolve(`${s.url.replace(/\/$/, "")}/healthz`);
        const r = await fetch(`http://${to.host}:${to.port}${to.path}`, { signal: AbortSignal.timeout(4_000) });
        const j = (await r.json().catch(() => ({}))) as { instance?: unknown };
        if (r.ok && typeof j.instance === "string") instance = j.instance;
      } catch {
        resolver.forget(s.url);
        return 0;
      }
      if (!instance) return 0;
      instances.set(s.module, instance);
      const stale = new Set([...pending.values()].map((p) => p.instance).filter((i): i is string => Boolean(i) && i !== instance));
      let n = 0;
      for (const old of stale) n += restarted(s.module, old);
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
        p.beat = Date.now();
        arm(id);
        return true;
      }
      pending.delete(id);
      p.done(body.error !== undefined ? { error: String(body.error).slice(0, 300) } : { verdict: body });
      return true;
    },
  };
}
export type Reviews = ReturnType<typeof createReviews>;
