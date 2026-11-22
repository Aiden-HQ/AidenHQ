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
/**
 * A connection tool call as the reviewer reads it: the connection, the tool, and the call's own argument object, every key as
 * the tool takes it. Sent by the kernel in place of a diff for a `conn.tool` record; the reviewer renders it as TOOL_CALL.
 */
export interface ToolCall { connection: string; tool: string; arguments: Record<string, unknown>; unreadable?: string[] }
/** One request as the reviewer reads it. Everything but `card.action` is data an agent or a stranger wrote. */
export interface ReviewRequest {
  card: ReviewCard; diff: string; files?: Files; chain?: string; requesterModel?: string;
  /**
   * A connection tool call's arguments, structured, as the reviewer reads them instead of a diff: code read them from the
   * record (`args.connection`, `args.tool`, `args.arguments`), never parsed out of the card's prose. `arguments` is the call's
   * own argument object, key for key as the tool takes them. `unreadable` names each argument code could not read (a value
   * that isn't there), so the reviewer is told which field is missing rather than that the whole call is body-only.
   */
  tool_call?: ToolCall;
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
 * Whether a dotted quad is a version number rather than an address: `v1.2.3.4` after a `v`, or under a label that names one
 * on the same line (`Affected versions: 1.2.3.4`) or on the line just above (`Affected versions:` then `1.2.3.4`). A bug
 * report's version is not instance data, and the decoded scan below now sees a newline the JSON-escaped text used to hide, so
 * the label is what tells the two apart. An address under a host or settings line is unaffected and still refused.
 */
function versionNumber(text: string, at: number): boolean {
  if (/[vV]$/.test(text.slice(Math.max(0, at - 1), at))) return true;
  const before = text.slice(0, at);
  const lineStart = before.lastIndexOf("\n") + 1;
  const label = /(?:^|[\s>*_-])[^:\n]{0,40}?\b(?:versions?|release|build|tag)\b[^:\n]{0,20}:\s*$/i;
  if (label.test(before.slice(lineStart))) return true;
  const above = lineStart > 0 ? before.slice(0, lineStart - 1).split("\n").pop() ?? "" : "";
  // A label alone on the line above (`Affected versions`, or an argument's own key `version`, which the scan pushes as its own
  // line before its value) names the number under it too.
  return label.test(above) || /^\s*[*_>\s-]*(?:versions?|release|build|tag)\s*[*_]*\s*:?\s*$/i.test(above);
}

/**
 * Instance details in a GitHub write (a conn.tool card on the github connection: a comment, an issue, a review): a tailnet
 * host (*.ts.net), a home-directory path, or an IPv4 address other than loopback. A GitHub thread is outside the instance and
 * often public, and no issue or review needs these, so code refuses it itself: a model once approved a triage comment that
 * pasted the host, its address and a runner log path as "in scope". (github-mcp's scrub redacts owner data from the
 * comments when they are sent; this is the refusal before that, for every GitHub write.) The kernel runs it before it asks the
 * reviewer (review-loop.ts), so it never fails open; the reviewer runs it too (review.ts).
 */
export function instanceDetails(card: ReviewCard | undefined, diff: string | undefined, toolCall?: ToolCall) {
  if (card?.action !== "conn.tool") return [];
  // A tool call's arguments arrive structured (`tool_call`): check the arguments' own strings and keys, decoded, never their
  // JSON encoding (a "\n" escape would hide a line start from the lookbehinds below). The card's details text still rides in
  // `diff` for a reviewer provider that doesn't read `tool_call` yet, so it is scanned too, never trusted to agree with the
  // arguments. A caller without a tool_call (an eval case, an older kernel) passes only the details text.
  const parts: string[] = [];
  if (toolCall) {
    if (toolCall.connection !== "github") return [];
    // Walked with an explicit stack, not recursion: this runs in the kernel before the reviewer's own depth check, and an
    // argument object is the requester's to shape, so a deep one must not overflow the stack it is scanned on. A value seen
    // twice (a shared reference, or a cycle only a direct caller could build) is read once.
    const seen = new Set<unknown>();
    const stack: unknown[] = [];
    // Each string is pushed right after its own key, so a value and the label it sits under stay on adjacent lines; a nested
    // object's entries are queued on the same stack rather than recursed into.
    const open = (v: unknown) => {
      if (!v || typeof v !== "object" || seen.has(v)) return;
      seen.add(v);
      for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
        parts.push(k);
        if (typeof child === "string") parts.push(child);
        else stack.push(child);
      }
    };
    open(toolCall.arguments);
    while (stack.length) {
      const v = stack.pop();
      if (typeof v === "string") parts.push(v);
      else open(v);
    }
  } else if (!/^tool: github\./.test(String(diff ?? ""))) return [];
  parts.push(String(diff ?? ""));
  const text = parts.join("\n");
  const found = [
    ...text.matchAll(/\b[\w-]+(?:\.[\w-]+)*\.ts\.net\b/gi),
    ...text.matchAll(/(?<![\w.~])\/(?:home|Users)\/[\w.-]+\/\S*/g),
    ...[...text.matchAll(/(?<![\w.])\d{1,3}(?:\.\d{1,3}){3}(?!\w|\.\d)/g)]
      .filter((m) => !/^(127\.|0\.0\.0\.0$)/.test(m[0]) && !versionNumber(text, m.index ?? 0)),
  ].map((m) => m[0].replace(/[`'"),.\\]+$/, ""));
  return [...new Set(found)];
}

/** The request fields a reviewer reads; anything else in a request (a policy, a model) is dropped. */
export const REQUEST_FIELDS = ["card", "diff", "tool_call", "files", "chain", "requesterModel", "comments"] as const;

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
