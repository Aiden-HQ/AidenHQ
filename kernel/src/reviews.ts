// K7, the AI reviewer's slot (reviewer@1, spec §3.3.3; sdk/src/reviewer.ts): a requester's review goes to the bound reviewer
// module with a fresh review token and a reviewer model token, and the module's verdict comes back on POST /v1/reviews/:id
// with that token, which burns on use. Reviews live in memory only: a kernel restart drops them, the requester's call fails,
// and its retry is a new review with a new token, so a token from before the restart opens nothing.
// A record's review is the kernel's (writes.ts review: the runner gathers what the reviewer reads); POST /v1/reviews is the
// runner's check before it files (`aidenhq review`), the same dispatch with nothing recorded.
import http from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Resolver } from "./net.ts";

/** The bound reviewer (compile: config/kernel/modules.json `reviewer`). */
export type ReviewerSlot = { module: string; url: string; auth_secret: string };
type Pending = { token: Buffer; done: (v: { verdict?: unknown; error?: string }) => void };
const fail = (status: number, type: string, message: string) => Object.assign(new Error(message), { status, type });
const hash = (s: string) => createHash("sha256").update(s).digest();

export function createReviews({ slot, secret, resolver, modelToken, timeoutMs = 15 * 60_000, log = () => {} }: {
  slot: () => ReviewerSlot | undefined; secret: (n: string) => string; resolver: Resolver;
  /** A reviewer-kind gateway token for one review's model calls (the ledger's component names it). */
  modelToken: (component: string) => string;
  timeoutMs?: number; log?: (msg: string, f?: Record<string, unknown>) => void;
}) {
  const pending = new Map<string, Pending>();

  async function dispatch(s: ReviewerSlot, body: unknown): Promise<void> {
    const key = secret(s.auth_secret);
    if (!key) throw fail(503, "no_service_key", `${s.module}'s reviewer key is missing`);
    const to = await resolver.resolve(`${s.url.replace(/\/$/, "")}/review`);
    const data = Buffer.from(JSON.stringify(body));
    await new Promise<void>((resolve, reject) => {
      const req = http.request({ host: to.host, port: to.port, path: to.path, method: "POST", timeout: 30_000, headers: { host: new URL(s.url).host, authorization: `Bearer ${key}`, "content-type": "application/json", "content-length": data.length } }, (res) => {
        res.resume().on("end", () => ((res.statusCode ?? 500) < 300 ? resolve() : reject(fail(502, "bad_reviewer", `${s.module} answered ${res.statusCode}`))));
      });
      req.on("timeout", () => req.destroy(fail(504, "timeout", `${s.module} didn't accept the review in 30 s`)));
      req.on("error", (e) => { resolver.forget(s.url); reject((e as { status?: number }).status ? e : fail(502, "bad_reviewer", `${s.module} is unreachable (${e.message})`)); });
      req.end(data);
    });
  }

  return {
    /** One review, start to verdict: what the module sent, or an error (no reviewer, unreachable, its own failure, timeout). */
    async request(request: Record<string, unknown>): Promise<unknown> {
      const s = slot();
      if (!s) throw fail(503, "no_reviewer", "no reviewer module is installed");
      const id = `r-${randomBytes(8).toString("hex")}`;
      const token = randomBytes(32).toString("base64url");
      const component = typeof request.component === "string" && /^[\w .-]{1,60}$/.test(request.component) ? request.component : "AI reviewer";
      const answer = new Promise<{ verdict?: unknown; error?: string }>((done) => pending.set(id, { token: hash(token), done }));
      const timer = setTimeout(() => pending.get(id)?.done({ error: `no verdict in ${Math.round(timeoutMs / 60_000)} min` }), timeoutMs);
      try {
        await dispatch(s, { id, token, model_token: modelToken(component), request });
        const a = await answer;
        if (a.error !== undefined) throw fail(502, "review_failed", `${s.module}: ${a.error}`);
        const v = a.verdict as { decision?: unknown; reason?: unknown; model?: unknown };
        if (!["approve", "reject", "escalate"].includes(String(v?.decision)) || typeof v.reason !== "string" || typeof v.model !== "string") throw fail(502, "review_failed", `${s.module}'s verdict is malformed`);
        log("review", { id, module: s.module });
        return a.verdict;
      } finally {
        clearTimeout(timer);
        pending.delete(id);
      }
    },
    /** POST /v1/reviews/:id: the module's verdict with that review's token. False when no review waits for this token. */
    verdict(id: string, token: string, body: { error?: unknown } & Record<string, unknown>): boolean {
      const p = pending.get(id);
      const t = hash(token);
      if (!p || !timingSafeEqual(p.token, t)) return false;
      pending.delete(id);
      p.done(body.error !== undefined ? { error: String(body.error).slice(0, 300) } : { verdict: body });
      return true;
    },
  };
}
export type Reviews = ReturnType<typeof createReviews>;
