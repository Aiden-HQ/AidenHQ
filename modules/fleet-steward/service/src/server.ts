// The service's HTTP surface. /mcp takes the connection's service key and checks the kernel's caller assertion per call. /alerts
// (Alertmanager's webhook) and /metrics (Prometheus's scrape) take the monitoring module's own token, which the kernel vouches
// for (GET /v1/whoami says module `monitoring`): a forged post files nothing and tells nobody.
import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Caller } from "./aidenhq-sdk/caller.ts";

export interface Deps {
  serviceKey: string;
  /** Whether the bearer is the monitoring module's own token. */
  isMonitoring: (authorization: string) => Promise<boolean>;
  receiveAlerts: (body: unknown) => Promise<unknown>;
  metrics: () => string;
  mcp: (msg: any, caller: () => Promise<Caller>) => Promise<object | undefined>;
  caller: (req: IncomingMessage) => Promise<Caller>;
}

const same = (a: string, b: string) => Boolean(a && b) && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const read = async (req: IncomingMessage, max = 2_000_000) => {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) { n += (c as Buffer).length; if (n > max) throw Object.assign(new Error("too large"), { status: 413 }); chunks.push(c as Buffer); }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
};
const send = (res: ServerResponse, status: number, v: unknown, type = "application/json") => res.writeHead(status, { "content-type": type }).end(typeof v === "string" ? v : JSON.stringify(v));

export function createStewardServer(d: Deps) {
  return createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    const auth = String(req.headers.authorization ?? "");
    try {
      if (path === "/healthz") return send(res, 200, { ok: true });
      if ((path === "/alerts" && req.method === "POST") || (path === "/metrics" && req.method === "GET")) {
        if (!(await d.isMonitoring(auth))) return void res.writeHead(401).end();
        if (path === "/metrics") return send(res, 200, d.metrics(), "text/plain; version=0.0.4; charset=utf-8");
        return send(res, 200, await d.receiveAlerts(await read(req)));
      }
      if (path === "/mcp" && req.method === "POST") {
        if (!same(auth.replace(/^Bearer\s+/i, ""), d.serviceKey)) return void res.writeHead(401).end();
        const msg = await read(req);
        const caller = () => d.caller(req);
        const out = Array.isArray(msg) ? (await Promise.all(msg.map((m) => d.mcp(m, caller)))).filter(Boolean) : await d.mcp(msg, caller);
        return out === undefined ? void res.writeHead(202).end() : send(res, 200, out);
      }
      return void res.writeHead(404).end();
    } catch (e) {
      return send(res, (e as { status?: number }).status ?? 400, { error: String((e as Error).message ?? e).slice(0, 300) });
    }
  });
}
