// A session's terminal (ttyd) behind the launcher's control listener, for the board:
//   ANY /session/<lease>/term/*  (and its WebSocket upgrade) -> http://<box>:<term port>/*   with ttyd's basic credential
// The bearer is `computer_session_key`, read only by the board; it opens nothing else, and the box-side credentials are added
// here and never reach the board. An unknown or released lease is a 404.
import type { IncomingMessage, ServerResponse } from "node:http";
import { request } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { connect } from "node:net";
import type { Duplex } from "node:stream";

/** Where a live lease listens (the standing box's address, the lease's two ports and its two secrets). */
export interface LeaseTarget { host: string; ports: { serve: number; term: number }; secrets: { serve: string; term: string } }

const ROUTE = /^\/session\/(l-[0-9a-f]{8})\/(term)(\/[^?]*)?(\?.*)?$/;
export const isSessionRoute = (url: string | undefined) => ROUTE.test(url ?? "");

/** ttyd's `--credential` (the box's AIDENHQ_TERM_CREDENTIAL, services/computer/lib.ts jobEnvFile) is `aidenhq:<secret>`. (The web view needs a per-session origin: #1769.) */
export const termCredential = (secret: string) => `aidenhq:${secret}`;
const b64 = (v: string) => Buffer.from(v).toString("base64");
const basic = (secrets: LeaseTarget["secrets"]) => `Basic ${b64(termCredential(secrets.term))}`;

/**
 * ttyd hands its page a `token` (the base64 credential) and wants it back in the first WebSocket frame. The browser never
 * holds it: `/term/token` answers an empty one here, and the browser's first frame (masked, JSON with `AuthToken`) is
 * rewritten to the real one on its way to ttyd. Returns the frame with the real token, and the bytes after it.
 */
export function withAuthToken(buf: Buffer, token: string): { frame: Buffer; rest: Buffer } | undefined {
  if (buf.length < 2) return undefined;
  let len = buf[1]! & 0x7f, at = 2;
  if (len === 126) {
    if (buf.length < 4) return undefined;
    (len = buf.readUInt16BE(2)), (at = 4);
  }
  if (len === 127 || !(buf[1]! & 0x80)) return { frame: buf, rest: Buffer.alloc(0) };
  if (buf.length < at + 4 + len) return undefined;
  const mask = buf.subarray(at, at + 4), data = Buffer.from(buf.subarray(at + 4, at + 4 + len)).map((b, i) => b ^ mask[i % 4]!);
  const rest = buf.subarray(at + 4 + len);
  let json: Record<string, unknown>;
  try { json = JSON.parse(Buffer.from(data).toString("utf8")); } catch { return { frame: buf.subarray(0, at + 4 + len), rest }; }
  const body = Buffer.from(JSON.stringify({ ...json, AuthToken: b64(token) }));
  const key = randomBytes(4), head = body.length < 126 ? Buffer.from([0x80 | (buf[0]! & 0x0f), 0x80 | body.length]) : Buffer.from([0x80 | (buf[0]! & 0x0f), 0x80 | 126, body.length >> 8, body.length & 0xff]);
  return { frame: Buffer.concat([head, key, body.map((b, i) => b ^ key[i % 4]!)]), rest };
}

export function createSessionProxy({ key, lease }: { key: string; lease: (id: string) => Promise<LeaseTarget | undefined> }) {
  // Compared as equal-length digests, in constant time.
  const digest = (v: string) => createHash("sha256").update(v).digest();
  const keyed = (req: IncomingMessage) => Boolean(key) && timingSafeEqual(digest(String(req.headers.authorization ?? "")), digest(`Bearer ${key}`));
  const aim = async (req: IncomingMessage) => {
    const m = ROUTE.exec(req.url ?? "");
    const t = m && (await lease(m[1]!));
    if (!m || !t) return undefined;
    const port = t.ports.term;
    const headers = { ...req.headers, host: `${t.host}:${port}`, authorization: basic(t.secrets) };
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
      // ttyd's token is its credential: the page gets an empty one (see withAuthToken).
      if (to.path.split("?")[0] === "/token") return res.writeHead(200, { "content-type": "application/json" }).end('{"token":""}'), true;
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
      // Either side going away takes the other with it, also before the first frame.
      up.on("close", () => socket.destroy());
      socket.on("close", () => up.destroy());
      up.on("connect", () => {
        up.write([`${req.method} ${to.path} HTTP/1.1`, ...Object.entries(to.headers).map(([k, v]) => `${k}: ${[v].flat().join(", ")}`), "", ""].join("\r\n"));
        if (head.length) up.write(head);
        up.pipe(socket);
        // The terminal's first frame carries the (empty) token: swap in ttyd's. The rest goes through untouched.
        let first = Buffer.alloc(0);
        const onFirst = (chunk: Buffer) => {
          first = Buffer.concat([first, chunk]);
          const done = withAuthToken(first, termCredential(to.t.secrets.term));
          if (!done) return first.length > 16_384 ? fail() : undefined;
          socket.off("data", onFirst);
          up.write(Buffer.concat([done.frame, done.rest]));
          socket.pipe(up);
        };
        socket.on("data", onFirst);
      });
      return true;
    },
  };
}
