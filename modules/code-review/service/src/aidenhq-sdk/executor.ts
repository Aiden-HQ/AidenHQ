// executor@1, the module side (spec §3.3.2): the kernel calls a module's write kinds here, with the module's own service key.
//   POST <path>/plan     { kind, args, requester, task, evidence?, revalidate? } → { args, targets?, facts?, raise?, card?, satisfied? }
//   POST <path>/execute  { id, kind, args, digest, idempotency_key }  → { accepted: true } at once; the outcome follows to the
//                        kernel's POST /v1/writes/:id/outcome. Once per id: a repeat is accepted and runs nothing.
//   POST <path>/status   { id, idempotency_key } → { state: running | done | failed | unknown, text? }
// The kernel calls execute only for an approved, claimed and revalidated record; plan never changes anything.
//
// First-party modules hold byte-identical copies (scripts/sync-shared.mjs: edit this one and run it); third-party modules import
// @aidenhq/sdk/executor.
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export interface Requester { agent: string; key: string; name: string; roles: string[]; kind: string; task?: string; run?: string; module?: string }
export interface PlanRequest { kind: string; args: any; requester: Requester; task: string; evidence?: unknown; revalidate?: boolean }
export interface PlanResult {
  args: unknown; targets?: Record<string, unknown>; facts?: Record<string, unknown>;
  raise?: { tier: 1 | 2; panel?: boolean; reason: string; rule: string }; card?: Record<string, string>; satisfied?: { evidence: string };
}
export interface ExecuteRequest { id: string; kind: string; args: any; digest: string; idempotency_key: string }
export interface Executor {
  plan(req: PlanRequest): Promise<PlanResult>;
  /** Runs the write; its result is the outcome the kernel records and tells the task. Throwing is a failed outcome. */
  execute(rec: ExecuteRequest): Promise<{ ok: boolean; text: string }>;
}

/** A handler for `<path>/*`: answers and returns true, or returns false for any other path. */
export function serveExecutor(ex: Executor, { key, kernelUrl = process.env.AIDENHQ_KERNEL_URL ?? "http://10.231.0.1:3130", path = "/aidenhq/v1/executor", log = () => {} }: {
  key: string; kernelUrl?: string; path?: string; log?: (msg: string, f?: Record<string, unknown>) => void;
}) {
  const runs = new Map<string, { state: "running" | "done" | "failed"; text?: string }>();
  const send = (res: ServerResponse, status: number, body: unknown) => void res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  const keyed = (req: IncomingMessage) => {
    const a = Buffer.from(String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "")), b = Buffer.from(key);
    return b.length > 0 && a.length === b.length && timingSafeEqual(a, b);
  };
  async function report(id: string, ok: boolean, text: string) {
    for (let i = 0; i < 5; i++) {
      const r = await fetch(`${kernelUrl}/v1/writes/${id}/outcome`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ ok, text }), signal: AbortSignal.timeout(15_000) }).catch(() => undefined);
      if (r && (r.ok || r.status === 409)) return;
      await new Promise((ok) => setTimeout(ok, 2000 * 2 ** i));
    }
    log("executor outcome not delivered", { id });
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
        void ex.execute(body).catch((e: Error) => ({ ok: false, text: e.message })).then(async (o) => {
          runs.set(id, { state: o.ok ? "done" : "failed", text: o.text });
          await report(id, o.ok, o.text);
        });
      }
      return send(res, 200, { accepted: true }), true;
    } catch (e) {
      return send(res, 422, { error: String((e as Error).message ?? e).slice(0, 1000) }), true;
    }
  };
}
