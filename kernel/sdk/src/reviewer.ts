// reviewer@1 (spec §3.3.3): the AI reviewer is a module the kernel calls; a requester never runs it in its own process.
//   requester → kernel  POST /v1/reviews { request } (the runner's reviewer key) → the verdict, once the module sends it
//   kernel → module     POST <url>/review { id, token, model_token, request } (the module's service key) → { accepted: true }
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
import { timingSafeEqual } from "node:crypto";
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

/** The module's reviewer: one request in, one verdict out. */
export type Review = (req: ReviewRequest, ctx: { modelToken: string }) => Promise<Verdict>;

/**
 * A handler for POST `<path>/review`: answers and returns true, or returns false for any other path. It accepts at once and
 * sends the verdict to the kernel with the review's token (retried; a verdict the kernel no longer waits for is dropped).
 * A reviewer that throws sends `{ error }`: the requester counts it as a failed review (reviewer_failed) and tries again later.
 */
export function serveReviewer(review: Review, { key, kernelUrl = process.env.AIDENHQ_KERNEL_URL ?? "http://10.231.0.1:3130", path = "/aidenhq/v1/reviewer", log = () => {} }: {
  key: string; kernelUrl?: string; path?: string; log?: (msg: string, f?: Record<string, unknown>) => void;
}) {
  const send = (res: ServerResponse, status: number, body: unknown) => void res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  const keyed = (req: IncomingMessage) => {
    const a = Buffer.from(String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "")), b = Buffer.from(key);
    return b.length > 0 && a.length === b.length && timingSafeEqual(a, b);
  };
  async function deliver(id: string, token: string, v: Verdict | { error: string }) {
    for (let i = 0; i < 5; i++) {
      const r = await fetch(`${kernelUrl}/v1/reviews/${id}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(v), signal: AbortSignal.timeout(15_000) }).catch(() => undefined);
      if (r && (r.ok || r.status === 404 || r.status === 401)) return;
      await new Promise((ok) => setTimeout(ok, 1000 * 2 ** i));
    }
    log("verdict not delivered", { id });
  }
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
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
    send(res, 202, { accepted: true });
    const v = await review(request, { modelToken }).catch((e: Error) => ({ error: String(e.message ?? e).slice(0, 300) }));
    await deliver(id, token, v);
    return true;
  };
}
