// executor@1, the module side (spec §3.3.2): the kernel calls a module's write kinds here, with the module's own service key.
//   POST <path>/plan     { kind, args, requester, task, evidence?, revalidate? } → { args, targets?, facts?, raise?, card?, satisfied? }
//   POST <path>/execute  { id, kind, args, digest, idempotency_key, task }  → { accepted: true } at once; the outcome follows to the
//                        kernel's POST /v1/writes/:id/outcome. Once per id: a repeat is accepted and runs nothing.
//   POST <path>/status   { id, idempotency_key } → { state: running | done | failed | unknown, text?, objects? }
// The kernel calls execute only for an approved, claimed and revalidated record; plan never changes anything.
//
// First-party modules hold byte-identical copies (scripts/sync-shared.ts: edit this one and run it); third-party modules import
// @aidenhq/sdk/executor.
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export interface Requester { agent: string; key: string; name: string; roles: string[]; kind: string; task?: string; run?: string; module?: string }
export interface PlanRequest { kind: string; args: any; requester: Requester; task: string; evidence?: unknown; revalidate?: boolean }
export interface PlanResult {
  args: unknown; targets?: Record<string, unknown>; facts?: Record<string, unknown>;
  raise?: { tier: 1 | 2; reason: string; rule: string }; card?: Record<string, string>; satisfied?: { evidence: string };
  /** What the AI reviewer reads beside the card (reviewer@1): the changed files at the reviewed head (review-files.ts fileContext), the owner's source exceptions, the task's merged sibling PRs. */
  review?: ReviewContext;
}
export type ReviewContext = {
  /** The card's details whole: the kernel sets it at filing, over anything a plan sends. */
  diff?: string; files?: { list: { name: string; text?: string; note?: string }[]; leftOut: string[]; changed?: { path: string; add?: number; del?: number }[] }; sources?: { where: string; records: Record<string, unknown>[] };
  /** The task's other PRs merged into the change's base: `files` its own, `changed` those the base changed again since (undefined: not read). */
  siblings?: { repo: string; number: number; base: string; mergeCommit: string; files?: string[]; changed?: string[] }[] };
export interface ExecuteRequest {
  id: string; kind: string; args: any; digest: string; idempotency_key: string;
  /** The record's task (the kernel's own row, never a cache keyed by kind and args): what the write is for. */
  task?: string;
  /** The task's identifier as people read it (ACME-12), when the record kept one: what the code host's own PR rows are keyed by. */
  identifier?: string;
  /** The record's tier as the kernel set it (0 ran unreviewed): an executor rechecks what a Tier 0 rested on. */
  tier?: 0 | 1 | 2;
}
export interface Executor {
  plan(req: PlanRequest): Promise<PlanResult>;
  /** Runs the write; its result is the outcome the kernel records and tells the task. Throwing is a failed outcome. `objects`: the GitHub object refs it made (`github:o/r#12`, `github:o/r@<sha40>`, `…#12/comment/<id>`), which the kernel keeps. */
  execute(rec: ExecuteRequest): Promise<{ ok: boolean; text: string; objects?: string[] }>;
}

/** A handler for `<path>/*`: answers and returns true, or returns false for any other path. */
export function serveExecutor(ex: Executor, { key, kernelUrl = process.env.AIDENHQ_KERNEL_URL ?? "http://10.231.0.1:3130", path = "/aidenhq/v1/executor", log = () => {}, retryMs = 2000 }: {
  key: string; kernelUrl?: string; path?: string; log?: (msg: string, f?: Record<string, unknown>) => void;
  /** The first wait before an undelivered outcome is posted again; it doubles, to a minute at most. */
  retryMs?: number;
}) {
  const runs = new Map<string, { state: "running" | "done" | "failed"; text?: string; objects?: string[] }>();
  const send = (res: ServerResponse, status: number, body: unknown) => void res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  const keyed = (req: IncomingMessage) => {
    const a = Buffer.from(String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "")), b = Buffer.from(key);
    return b.length > 0 && a.length === b.length && timingSafeEqual(a, b);
  };
  /**
   * The outcome, until the kernel takes it (409: it has one already). A kernel restart or an unreachable kernel is waited out,
   * backing off to once a minute, never given up on; only a 4xx the kernel means for good (bad request, no such record) ends it.
   */
  async function report(id: string, ok: boolean, text: string, objects?: string[]) {
    for (let i = 0; ; i++) {
      const r = await fetch(`${kernelUrl}/v1/writes/${id}/outcome`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ ok, text, ...(objects?.length ? { objects } : {}) }), signal: AbortSignal.timeout(15_000) }).catch(() => undefined);
      if (r && (r.ok || r.status === 409)) return;
      if (r && r.status >= 400 && r.status < 500 && ![401, 408, 429].includes(r.status)) return log("executor outcome refused", { id, status: r.status });
      if (i === 4) log("executor outcome not delivered yet: still trying", { id, status: r?.status });
      await new Promise((ok) => setTimeout(ok, Math.min(retryMs * 2 ** i, 60_000)));
    }
  }
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = String(req.url ?? "");
    if (!url.startsWith(`${path}/`)) return false;
    if (req.method !== "POST") return send(res, 405, { error: "POST only" }), true;
    if (!keyed(req)) return send(res, 401, { error: "unauthorized" }), true;
    let body: any;
    try {
      const chunks: Buffer[] = [];
      let n = 0;
      for await (const c of req) { n += c.length; if (n > 1_000_000) throw new Error("too large"); chunks.push(c); }
      body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    } catch (e) { return send(res, 400, { error: (e as Error).message }), true; }
    const op = url.slice(path.length + 1);
    const id = String(body?.id ?? "");
    try {
      if (op === "plan") return send(res, 200, await ex.plan(body)), true;
      if (op === "status") return send(res, 200, runs.get(id) ?? { state: "unknown" }), true;
      if (op !== "execute") return send(res, 404, { error: "no such operation" }), true;
      if (!/^k-[0-9a-f]{16}$/.test(id)) return send(res, 400, { error: "bad id" }), true;
      if (!runs.has(id)) {
        if (runs.size >= 1000) runs.delete(runs.keys().next().value!);
        runs.set(id, { state: "running" });
        void Promise.resolve().then(() => ex.execute(body)).catch((e: unknown) => ({ ok: false, text: String((e as Error)?.message ?? e), objects: undefined as string[] | undefined })).then(async (o) => {
          runs.set(id, { state: o.ok ? "done" : "failed", text: o.text, ...(o.objects?.length ? { objects: o.objects } : {}) });
          await report(id, o.ok, o.text, o.objects);
        });
      }
      return send(res, 200, { accepted: true }), true;
    } catch (e) {
      // A plan-time refusal carries its rule's stable code beside its words (kernel/src/writes.ts records both on the job).
      const code = (e as { code?: unknown }).code;
      return send(res, 422, { error: String((e as Error).message ?? e).slice(0, 1000), ...(typeof code === "string" && code ? { code: code.slice(0, 80) } : {}) }), true;
    }
  };
}
