// A session's terminal (ttyd) and phone UI (opencode serve) behind the launcher's control listener, for the board:
//   ANY /session/<lease>/term/*  (and its WebSocket upgrade) -> http://<box>:<term port>/*   with ttyd's basic credential
//   ANY /session/<lease>/web/*   (and its upgrade)           -> http://<box>:<serve port>/*  with opencode's basic auth
// The bearer is `computer_session_key`, read only by the board; it opens nothing else, and the box-side credentials are added
// here and never reach the board. An unknown or released lease is a 404.
import type { IncomingMessage, ServerResponse } from "node:http";
import { request } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { connect } from "node:net";
import type { Duplex } from "node:stream";

/** Where a live lease listens (the standing box's address, the lease's two ports and its two secrets). */
export interface LeaseTarget { host: string; ports: { serve: number; term: number }; secrets: { serve: string; term: string } }

const ROUTE = /^\/session\/(l-[0-9a-f]{8})\/(term|web)(\/[^?]*)?(\?.*)?$/;
export const isSessionRoute = (url: string | undefined) => ROUTE.test(url ?? "");

/** ttyd's `--credential` is `aidenhq:<secret>`; opencode's server basic auth is `opencode:<OPENCODE_SERVER_PASSWORD>`. */
const basic = (which: "term" | "web", secrets: LeaseTarget["secrets"]) => `Basic ${Buffer.from(which === "term" ? `aidenhq:${secrets.term}` : `opencode:${secrets.serve}`).toString("base64")}`;

export function createSessionProxy({ key, lease }: { key: string; lease: (id: string) => Promise<LeaseTarget | undefined> }) {
  // Compared as equal-length digests, in constant time.
  const digest = (v: string) => createHash("sha256").update(v).digest();
  const keyed = (req: IncomingMessage) => Boolean(key) && timingSafeEqual(digest(String(req.headers.authorization ?? "")), digest(`Bearer ${key}`));
  const aim = async (req: IncomingMessage) => {
    const m = ROUTE.exec(req.url ?? "");
    const t = m && (await lease(m[1]!));
    if (!m || !t) return undefined;
    const port = m[2] === "term" ? t.ports.term : t.ports.serve;
    const headers = { ...req.headers, host: `${t.host}:${port}`, authorization: basic(m[2] as "term" | "web", t.secrets) };
    return { t, port, path: `${m[3] ?? "/"}${m[4] ?? ""}`, headers };
  };
  const refuse = (res: ServerResponse, status: number, error: string) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ error }));
  return {
    /** Answers a session route and returns true; false: not a session route (the caller answers it). */
    async http(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
      if (!isSessionRoute(req.url)) return false;
      if (!keyed(req)) return refuse(res, 401, "unauthorized"), true;
      const to = await aim(req);
      if (!to) return refuse(res, 404, "no such session"), true;
      const up = request({ host: to.t.host, port: to.port, method: req.method, path: to.path, headers: to.headers }, (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
        // The stream breaks on either side: the other side goes too.
        r.on("aborted", () => res.destroy());
        r.on("error", () => res.destroy());
      });
      res.on("close", () => up.destroy());
      up.on("error", () => (res.headersSent ? res.destroy() : refuse(res, 502, "the session did not answer")));
      req.pipe(up);
      return true;
    },
    /** Takes a session route's WebSocket upgrade; false: not one. */
    async upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<boolean> {
      if (!isSessionRoute(req.url)) return false;
      const end = (status: number, why: string) => void socket.end(`HTTP/1.1 ${status} ${why}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`);
      if (!keyed(req)) return end(401, "Unauthorized"), true;
      const to = await aim(req);
      if (!to) return end(404, "Not Found"), true;
      const up = connect(to.port, to.t.host);
      const fail = () => (socket.destroy(), up.destroy());
      up.on("error", fail);
      socket.on("error", fail);
      up.on("connect", () => {
        up.write([`${req.method} ${to.path} HTTP/1.1`, ...Object.entries(to.headers).map(([k, v]) => `${k}: ${[v].flat().join(", ")}`), "", ""].join("\r\n"));
        if (head.length) up.write(head);
        up.pipe(socket);
        socket.pipe(up);
      });
      return true;
    },
  };
}
