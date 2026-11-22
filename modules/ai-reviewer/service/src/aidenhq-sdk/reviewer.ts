// reviewer@1 (spec §3.3.3): the AI reviewer is a module the kernel calls; a requester never runs it in its own process.
//   requester → kernel  POST /v1/reviews { request } (the runner's reviewer key) → the verdict, once the module sends it
//   kernel → module     POST <url>/review { id, token, model_token, request } (the module's service key) → { accepted: true }
//                       (and, when it names one, `instance`: this service's id; the kernel fails the reviews a service that
//                       restarted left behind. Optional in reviewer@1: an answer of `{ accepted: true }` alone is still accepted)
//   module → kernel     POST /v1/reviews/:id <verdict> | { error } (Bearer: that review's token, once: it burns on use)
// The module calls models through the gateway with `model_token` (a reviewer token the kernel minted for this review), never a
// vendor key. It can't change a tier: the verdict is the requester's input, and the records bind it to their digest.
//
// The verdict is approve or reject (malice only), or escalate with code reviewer_failed for a review that couldn't finish:
// the kernel tries once more, then approves (fail open; owner, 2026-11-22).
//
// The requester reads the changed files with `fileContext` (services/shared/review-files.ts) and sends each whole, whatever
// its size: the reviewer shows what fits inline and reads the rest with read-only tools over the request.
//
// Canonical copy: kernel/sdk/src/reviewer.ts. The reviewer module holds a byte-identical copy at src/aidenhq-sdk/reviewer.ts:
// edit this one, then run `node scripts/sync-shared.ts`.
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export interface ReviewCard { action: string; rule?: string; target?: string; sentence?: string; reason?: string }
/**
 * `list`: each changed file at the reviewed head, plain text whole or code's note (media, binary); `leftOut`: the files it
 * can't read (binary); `changed`: the code host's own numstat of the change, read at filing: the reviewer checks the diff against it.
 */
export interface Files { list: { name: string; text?: string; note?: string }[]; leftOut: string[]; changed?: { path: string; add?: number; del?: number }[] }
/** One request as the reviewer reads it. Everything but `card.action` is data an agent or a stranger wrote. */
export interface ReviewRequest {
  card: ReviewCard; diff: string; files?: Files; chain?: string; requesterModel?: string;
  /**
   * The task's comments as they stand, oldest first, rendered by the kernel: each under a label line code wrote (the owner's
   * own typed words, or an agent by its place in the request: the delegating agent, the chief of staff, the requesting agent,
   * another agent) with its text quoted line by line. The text is its author's; only the labels are code's.
   */
  comments?: string;
  /** The ledger's name for the model calls (the card's review, or an agent's check before filing). */
  component?: string;
}
export interface Verdict { decision: "approve" | "reject" | "escalate"; code?: string; reason: string; model: string }
/**
 * Instance details in a GitHub write (a conn.tool card on the github connection: a comment, an issue, a review): a tailnet
 * host (*.ts.net), a home-directory path, or an IPv4 address other than loopback. A GitHub thread is outside the instance and
 * often public, and no issue or review needs these, so code refuses it itself: a model once approved a triage comment that
 * pasted the host, its address and a runner log path as "in scope". (github-mcp's scrub redacts owner data from the
 * comments when they are sent; this is the refusal before that, for every GitHub write.) The kernel runs it before it asks the
 * reviewer (review-loop.ts), so it never fails open; the reviewer runs it too (review.ts).
 */
export function instanceDetails(card: ReviewCard | undefined, diff: string | undefined) {
  const text = String(diff ?? "");
  if (card?.action !== "conn.tool" || !/^tool: github\./.test(text)) return [];
  const found = [
    ...text.matchAll(/\b[\w-]+(?:\.[\w-]+)*\.ts\.net\b/gi),
    ...text.matchAll(/(?<![\w.~])\/(?:home|Users)\/[\w.-]+\/\S*/g),
    ...[...text.matchAll(/(?<![\w.])\d{1,3}(?:\.\d{1,3}){3}(?!\w|\.\d)/g)].filter((m) => !/^(127\.|0\.0\.0\.0$)/.test(m[0])),
  ].map((m) => m[0].replace(/[`'"),.\\]+$/, ""));
  return [...new Set(found)];
}

/** The request fields a reviewer reads; anything else in a request (a policy, a model) is dropped. */
export const REQUEST_FIELDS = ["card", "diff", "files", "chain", "requesterModel", "comments"] as const;

/**
 * The handler POST `<path>/review`, and the `/healthz` beside it: it answers with the service instance that serves now, so the
 * kernel's review loop can fail the reviews a recreated service (an apply) lost instead of waiting out any window.
 */
export type ReviewerHandler = ((req: IncomingMessage, res: ServerResponse) => Promise<boolean>) & { instance: string };
/**
 * The module's reviewer: one request in, one verdict out. `progress` is called as the review's work advances (each model-call
 * attempt and each answer), so a review that hangs reports none and the kernel's stall window runs out on it.
 */
export type Review = (req: ReviewRequest, ctx: { modelToken: string; progress: () => void }) => Promise<Verdict>;

/** The longest a working review waits between keepalives to the kernel. */
const BEAT_MS = 60_000;
/** A beat the kernel never got is sent again at most this many times, with backoff (1 s, 2 s, 4 s), unless the review is over. */
const KEEPALIVE_TRIES = 3;

/**
 * A handler for POST `<path>/review`: answers and returns true, or returns false for any other path. It accepts at once, naming
 * the service instance that took the review (a fresh one each start, so the kernel fails what a recreated service lost; an answer
 * without one is still accepted), and sends the verdict to the kernel with the review's token (retried; a verdict the kernel no
 * longer waits for is dropped). While the review's work advances it keeps the review alive (at most once per BEAT_MS): the kernel
 * bounds a review by progress, not only by its hour, so a call that hangs — and reports nothing — still stalls. GET `<path>/healthz`
 * answers `{ ok: true, instance }`. A reviewer that throws sends `{ error }`: the requester counts it as a failed review
 * (reviewer_failed) and tries again later.
 */
export function serveReviewer(review: Review, { key, kernelUrl = process.env.AIDENHQ_KERNEL_URL ?? "http://10.231.0.1:3130", path = "/aidenhq/v1/reviewer", instance = randomUUID(), beatMs = BEAT_MS, log = () => {} }: {
  key: string; kernelUrl?: string; path?: string;
  /** This service process's id: a review it took is failed at once when another instance answers /healthz. */
  instance?: string; beatMs?: number;
  log?: (msg: string, f?: Record<string, unknown>) => void;
}) {
  const send = (res: ServerResponse, status: number, body: unknown) => void res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  const keyed = (req: IncomingMessage) => {
    const a = Buffer.from(String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "")), b = Buffer.from(key);
    return b.length > 0 && a.length === b.length && timingSafeEqual(a, b);
  };
  /** A reviewer's failure as the error answer: `null`, `undefined` or a bare string is a failure too, and never a crash. */
  const failed = (e: unknown): { error: string } => {
    // An Error's message, or a rejection that is itself text; anything else (`null`, `undefined`, a bare object) is a failure
    // with nothing to say, and answers the generic reason rather than "[object Object]".
    const m = (e as { message?: unknown } | null | undefined)?.message;
    const said = typeof m === "string" && m.trim() ? m : typeof e === "string" && e.trim() ? e : "the reviewer failed";
    return { error: said.slice(0, 300) };
  };
  async function deliver(id: string, token: string, v: Verdict | { error: string }) {
    for (let i = 0; i < 5; i++) {
      const r = await fetch(`${kernelUrl}/v1/reviews/${id}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(v), signal: AbortSignal.timeout(15_000) }).catch(() => undefined);
      if (r && (r.ok || r.status === 404 || r.status === 401)) return;
      await new Promise((ok) => setTimeout(ok, 1000 * 2 ** i));
    }
    log("verdict not delivered", { id });
  }
  /**
   * A review's progress: its work moving (in-process, free) and a keepalive to the kernel at most every BEAT_MS. Progress inside
   * the throttle is not dropped: it schedules one trailing keepalive for when the throttle ends, so the kernel's window counts from
   * the last step that actually happened. A call that hangs reports nothing — it only ever gets that one trailing beat, not a clock.
   */
  const progressOf = (id: string, token: string) => {
    // A monotonic clock, like the kernel's own windows: a wall-clock step must not delay or hurry a keepalive.
    const clock = () => performance.now();
    let until = clock();
    let trailing: NodeJS.Timeout | undefined;
    // `stop` runs when the work is over: a beat queued or retried from before must not outlive the review.
    let stopped = false;
    // One more try at this same beat, if the review is still running and the tries are not spent: backoff 1 s, then 2 s, then 4 s.
    const again = (attempt: number) => {
      if (!stopped && attempt < KEEPALIVE_TRIES) setTimeout(() => keepalive(attempt + 1), 1_000 * 2 ** attempt).unref?.();
    };
    const keepalive = (attempt = 0) => {
      if (stopped) return;
      fetch(`${kernelUrl}/v1/reviews/${id}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: '{"keepalive":true}', signal: AbortSignal.timeout(10_000) })
        .then((r) => {
          // The kernel no longer waits for this review (it stalled, hit its hour, or was failed by a restart): its token is
          // closed, so there is nothing left to keep alive. 404 is that answer; any other status reached the kernel.
          if (r.status === 404) return void (stopped = true);
          // A beat the kernel answered with a transient failure (a gateway in front of it: 502, 503, 504, or a throttle) never
          // registered, and `fetch` resolves on it. Retried like a lost one: two long model rounds apart by a 503 must not fail a
          // review that is working. Any other answer did reach the kernel and counted.
          if (r.status === 429 || r.status >= 500) again(attempt);
        })
        // A beat lost to a reset or a timeout is retried the same way: a window with no beat at all would fail a review whose work
        // is fine. Stops when the review is over.
        .catch(() => again(attempt));
    };
    const beat = () => {
      clearTimeout(trailing);
      trailing = undefined;
      until = clock() + beatMs;
      keepalive();
    };
    const progress = () => {
      const now = clock();
      if (now >= until) return beat();
      // Suppressed progress: one trailing beat at the end of the throttle, however many steps arrive in it.
      if (!trailing) trailing = setTimeout(beat, until - now);
      trailing.unref?.();
    };
    // The work is over (its verdict is on its way): a beat queued for the end of the throttle, or a retry of a lost one, must
    // not outlive it.
    const stop = () => { stopped = true; clearTimeout(trailing); trailing = undefined; };
    return Object.assign(progress, { stop });
  };
  const handle: ReviewerHandler = Object.assign(async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    if (req.url === `${path}/healthz`) return send(res, 200, { ok: true, instance }), true;
    if (String(req.url ?? "") !== `${path}/review`) return false;
    if (req.method !== "POST") return send(res, 405, { error: "POST only" }), true;
    if (!keyed(req)) return send(res, 401, { error: "unauthorized" }), true;
    let body: { id?: unknown; token?: unknown; model_token?: unknown; request?: Record<string, unknown> };
    try {
      const chunks: Buffer[] = [];
      let n = 0;
      for await (const c of req) { n += c.length; if (n > 64_000_000) throw new Error("too large"); chunks.push(c); }
      body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      if (!body || typeof body !== "object") throw new Error("send {id, token, model_token, request}");
    } catch (e) { return send(res, 400, { error: (e as Error).message }), true; }
    const id = String(body.id ?? ""), token = String(body.token ?? ""), modelToken = String(body.model_token ?? "");
    if (!/^r-[0-9a-f]{16}$/.test(id) || !token || !modelToken || !body.request || typeof body.request !== "object") return send(res, 400, { error: "send {id, token, model_token, request}" }), true;
    // Only the fields a reviewer reads, each only when the requester sent it: an absent field keeps the reviewer's default.
    const request = Object.fromEntries(REQUEST_FIELDS.filter((k) => body.request![k] !== undefined).map((k) => [k, body.request![k]])) as unknown as ReviewRequest;
    send(res, 202, { accepted: true, instance });
    // A throw from the reviewer — or a promise rejecting with nothing at all — still sends its error back (a failed review),
    // never a review left waiting on a verdict, and never a rejection of this handler that nobody reads.
    const progress = progressOf(id, token);
    // The error answer is built before `finally` clears the progress, and a failing error handler still leaves it an answer.
    const v = await (async () => review(request, { modelToken, progress }))()
      .catch(failed)
      .then((r) => (r && typeof r === "object" ? r : failed(r)))
      .catch(() => failed("the reviewer failed"))
      .finally(() => progress.stop());
    await deliver(id, token, v);
    return true;
  }, { instance });
  return handle;
}
