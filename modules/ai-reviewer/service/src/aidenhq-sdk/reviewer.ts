// reviewer@1 (spec §3.3.3): the AI reviewer is a module the kernel calls; a requester never runs it in its own process.
//   requester → kernel  POST /v1/reviews { request } (the runner's reviewer key) → the verdict, once the module sends it
//   kernel → module     POST <url>/review { id, token, model_token, request } (the module's service key) → { accepted: true }
//   module → kernel     POST /v1/reviews/:id <verdict> | { error } (Bearer: that review's token, once: it burns on use)
// The module calls models through the gateway with `model_token` (a reviewer token the kernel minted for this review), never a
// vendor key. It can't change a tier: the verdict is the requester's input, and the records bind it to their digest.
//
// Deviations from the spec's sketch, kept until 3b moves review orchestration into the kernel: one dispatch carries the panel
// (`request.panel`) and the module runs it itself, so the second reviewer is asked only after a first approve, and an unsure
// first hands its note to the second (both as before); the two votes decide (the module's review()); the verdict is today's shape (decision, code, reason, model, second,
// flag), and `panel_marked` says the first reviewer called the change authority-expanding, so the requester records that on
// its card before acting on the verdict.
//
// The requester reads the changed files with `fileContext` (services/shared/review-files.ts) and sends each whole, whatever
// its size: the reviewer shows what fits inline and reads the rest with read-only tools over the request.
//
// Canonical copy: kernel/sdk/src/reviewer.ts. The reviewer module holds a byte-identical copy at src/aidenhq-sdk/reviewer.ts:
// edit this one, then run `node scripts/sync-shared.ts`.
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export interface ReviewCard { action: string; rule: string; target?: string; sentence?: string; reason?: string;
  /** The repositories that are one product for scope (the product repo and the official modules repo): code's own. */
  product?: string[] }
/**
 * `list`: each changed file at the reviewed head, plain text whole or code's note (media, binary); `leftOut`: the files it
 * can't read (binary); `changed`: the code host's own numstat of the change, read at filing: the reviewer checks the diff against it.
 */
export interface Files { list: { name: string; text?: string; note?: string }[]; leftOut: string[]; changed?: { path: string; add?: number; del?: number }[] }
export interface SourceRecords { where: string; records: Record<string, unknown>[] }
/** One Tier 1 request as the reviewer reads it. Everything but `card.action`, `card.rule` and `panel` is data an agent or a stranger wrote. */
export interface ReviewRequest {
  card: ReviewCard; diff: string; files?: Files; chain?: string; siblings?: string; sources?: SourceRecords;
  requesterModel?: string; panel?: boolean; previous?: string[];
  /**
   * The task grader's latest verdict that sent the work back, rendered by the kernel from the grading store: each rubric
   * criterion's number and met, and the rubric's own text for an unmet one. Absent: no such verdict or no grading module.
   */
  grader_note?: string;
  /**
   * The task's comments as they stand, oldest first, rendered by the kernel: each under a label line code wrote (the owner's
   * own typed words, or an agent by its place in the request: the delegating agent, the chief of staff, the requesting agent,
   * another agent) with its text quoted line by line. The text is its author's; only the labels are code's.
   */
  comments?: string;
    /** `decisions`: the instance's decisions.md, read by the requester from the instance repo's default branch. */
  decisions?: { where: string; text: string };
  /** The fleet's current model and engine choices, rendered by the kernel from the compiled grants table (code's, never prose). */
  settings?: string;
  /** A model whose rejection this review follows (a fresh review of the same content, a parked target's panel): its family is asked last. */
  avoid?: string;
  /** The ledger's name for the model calls (the card's review, or an agent's check before filing). */
  component?: string;
}
/**
 * `second`: the panel's second approval; `second_unsure`: an approval whose other reviewer was unsure (owner, 2026-11-20), never
 * in `second`, given only with `whole`: code verified the input whole (the diff matched the code host's count, every changed
 * file and the whole diff reachable by the reviewer, a request chain).
 */
export interface Verdict { decision: "approve" | "reject" | "escalate"; code?: string; reason: string; model: string; second?: string; second_unsure?: string; whole?: boolean; flag?: boolean; panel_marked?: boolean }
/** The model's "I can't tell" (a second reviewer is asked; both unsure, or unsure over missing input, the request goes back to the agent). */
export const UNSURE = "reviewer_unsure";
/** The request fields a reviewer reads; anything else in a request (a policy, a model) is dropped. */
export const REQUEST_FIELDS = ["card", "diff", "files", "chain", "siblings", "sources", "decisions", "settings", "requesterModel", "avoid", "panel", "previous", "grader_note", "comments"] as const;

/** The module's reviewer: one request in, one verdict out. `onPanel` records that the change needs a second reviewer. */
export type Review = (req: ReviewRequest, ctx: { modelToken: string; onPanel: () => Promise<void> }) => Promise<Verdict>;

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
    let marked = false;
    const v = await review(request, { modelToken, onPanel: async () => { marked = true; } }).catch((e: Error) => ({ error: String(e.message ?? e).slice(0, 300) }));
    await deliver(id, token, "error" in v ? v : { ...v, ...(marked ? { panel_marked: true } : {}) });
    return true;
  };
}
