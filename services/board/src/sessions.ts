// Sessions (docs/superpowers/specs/2026-11-25-sessions-design.md): long-lived harness sessions are ordinary tasks held by the
// `session` agent. The board lists them, opens a session's terminal (ttyd + tmux) through
// the computer launcher, and lets only the task's creator account in.
//   GET  /api/sessions              the session tasks: live state, last activity, creator and spend
//   POST /api/sessions/:task/open   for the creator: short-lived signed a path to the session's terminal
//   ANY  /sessions/:task/<token>/term/*   (and its WebSocket upgrades) the launcher's
//                                   /session/<lease>/…, authorised by that token alone
// Harness content (ttyd's page, whatever a process in the box serves) never runs with the board's origin:
// responses carry `Content-Security-Policy: sandbox …` without allow-same-origin, which gives the page an opaque origin even when
// it is opened on its own, and the board frames it in an iframe with the same sandbox. So it holds no board cookie and can't call
// the board's API; its only authority is the capability in its own URL.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { request as httpRequest } from "node:http";
import { connect, type Socket } from "node:net";
import type { Duplex } from "node:stream";

/** One session as the kernel reads it (GET /v1/work?sessions=1 and ?session=<task>, kernel/src/work.ts; the board's key). */
export interface KernelSession {
  /** The task's id. */
  task: string;
  /**
   * starting: the job is being admitted. running: the harness is mid-turn (tokens flow). waiting: asleep, no tokens. stopped:
   * ended by the owner or finished. error: the job failed or was lost.
   */
  state: "starting" | "running" | "waiting" | "stopped" | "error";
  /** The launcher's lease for the live job; null once it ended. */
  lease: string | null;
  error: string | null;
  started_at: string;
  ended_at: string | null;
  last_activity: { at: string; text: string } | null;
  /** Billed so far, USD (the gateway ledger). */
  cost_usd: number;
}

/** What the page shows of a session. */
export interface SessionRow extends Omit<KernelSession, "lease" | "task"> {
  task: string;
  identifier: string;
  title: string;
  creator: { name: string; kind: "person" | "agent" };
  /** Whether this account may open the terminal and phone UI. */
  mine: boolean;
}

export interface SessionsKernel {
  /** null: the kernel has no session agent (the sessions module isn't installed). */
  list(): Promise<KernelSession[] | null>;
  get(task: string): Promise<KernelSession | null>;
}

/** The kernel's reads, with the board's key. */
export function kernelSessions({ url, token }: { url: string; token: string }): SessionsKernel {
  const read = async (query: string) => {
    const r = await fetch(`${url.replace(/\/+$/, "")}/v1/work?${query}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(`the kernel answered ${r.status} reading sessions`);
    return r.json();
  };
  return {
    list: async () => {
      const j = (await read("sessions=1")) as { enabled: boolean; sessions: KernelSession[] };
      return j.enabled ? j.sessions : null;
    },
    get: async (task) => ((await read(`session=${encodeURIComponent(task)}`)) as { session: KernelSession | null }).session,
  };
}

/** The Paperclip id of the Session agent: the grants table's agent with profile `session` (setup writes it; agents can't edit it). */
export function sessionAgent(grants: () => { agents?: Record<string, { profile?: unknown; roles?: unknown }> }): string | null {
  try {
    return Object.entries(grants().agents ?? {}).find(([, g]) => g.profile === "session" && Array.isArray(g.roles) && g.roles.includes("session"))?.[0] ?? null;
  } catch {
    return null;
  }
}

/** How far up a handed-out task's chain the creator is looked for. */
const DEPTH = 8;

/**
 * Whether `account` may open the session on `task`: its creator account does. For a task an agent created, the creator of its
 * nearest ancestor a person created counts (`authoredBy` is the board's record of who wrote a task; `parentOf` its parent).
 */
export async function mayOpen(account: string, task: string, deps: { authoredBy: (task: string) => string | undefined; parentOf: (task: string) => Promise<string | null> }): Promise<boolean> {
  return (await creatorOf(task, deps)) === account;
}

async function creatorOf(task: string, deps: { authoredBy: (task: string) => string | undefined; parentOf: (task: string) => Promise<string | null> }): Promise<string | undefined> {
  let at: string | null = task;
  for (let i = 0; i < DEPTH && at; i++) {
    const by = deps.authoredBy(at);
    if (by) return by;
    at = await deps.parentOf(at);
  }
  return undefined;
}

export interface Terminals {
  /** The launcher base URL and the board's session key (computer_session_key). */
  launcher?: { url: string; key: string };
  kernel: SessionsKernel;
  authoredBy: (task: string) => string | undefined;
  /** A task's parent; null when it has none or doesn't exist. A read that fails throws (the caller answers 502). */
  parentOf: (task: string) => Promise<string | null>;
  /** A task's identifier, title and the agent that filed it, when one did (Paperclip, cached); null for a task Paperclip no longer has. */
  issue: (task: string) => Promise<{ identifier: string; title: string; agent: string | null } | null>;
  /** Display name of an account (the owner included). */
  nameOf: (account: string) => Promise<string | undefined>;
  /** The board's own Hosts. */
  hosts: string[];
  /** Token lifetime, ms (tests). */
  ttl?: number;
}

const PATH = /^\/sessions\/([\w-]{1,64})\/([A-Za-z0-9_-]{20,400}\.[A-Za-z0-9_-]{43})\/(term)(\/.*)?$/;
export const isSessionPath = (pathname: string) => PATH.test(pathname);
/** A path for the logs: a session path's token is a credential, so it never reaches one. */
export const loggedPath = (pathname: string) => pathname.replace(/^(\/sessions\/[\w-]{1,64}\/)[^/]+(\/)/, "$1[token]$2");

export class SessionError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** The page runs sandboxed (an opaque origin, scripts and forms only); only the board may frame it. */
const SANDBOX = "sandbox allow-scripts allow-forms allow-popups allow-downloads";
/** The headers every proxied answer gets. `*` for CORS: a sandboxed page's requests carry Origin: null, and the URL's token is the only credential. */
const FRAMED = { "x-frame-options": "SAMEORIGIN", "content-security-policy": `${SANDBOX}; frame-ancestors 'self'`, "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "cache-control": "private, no-store", "access-control-allow-origin": "*" };
/** The only upstream headers a proxied answer keeps: nothing from the box sets a cookie, clears site data or widens the page's rights. */
const KEEP = new Set(["content-type", "content-length", "content-encoding", "content-range", "accept-ranges", "etag", "last-modified"]);
/** A WebSocket's 101 answer keeps only the handshake. */
const KEEP_UPGRADE = new Set(["upgrade", "connection", "sec-websocket-accept", "sec-websocket-protocol", "sec-websocket-extensions"]);
/** The request headers that stay the browser's (the rest of the hop-by-hop and credential ones are dropped). */
const DROP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-authenticate", "proxy-authorization", "te", "trailer", "authorization"]);

export function createTerminals(t: Terminals) {
  const secret = randomBytes(32);
  const ttl = t.ttl ?? 10 * 60_000;
  const sign = (payload: string) => createHmac("sha256", secret).update(payload).digest("base64url");
  /** A token for `task`: only the board can make one, it names the task and ends after `ttl`. */
  const mint = (task: string) => {
    const payload = Buffer.from(JSON.stringify({ t: task, e: Date.now() + ttl })).toString("base64url");
    return `${payload}.${sign(payload)}`;
  };
  const valid = (token: string, task: string) => {
    const [payload = "", sig = ""] = token.split(".");
    const want = Buffer.from(sign(payload)), got = Buffer.from(sig);
    if (want.length !== got.length || !timingSafeEqual(want, got)) return false;
    try {
      const j = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { t?: unknown; e?: unknown };
      return j.t === task && typeof j.e === "number" && j.e > Date.now();
    } catch {
      return false;
    }
  };
  const mayOpenTask = (account: string, task: string) => mayOpen(account, task, { authoredBy: t.authoredBy, parentOf: t.parentOf });
  /** The live lease behind a session. */
  async function lease(task: string): Promise<string> {
    const s = await t.kernel.get(task);
    if (!s) throw new SessionError(404, "no such session");
    if (!s.lease) throw new SessionError(404, "this session has ended");
    if (!/^l-[0-9a-f]{8}$/.test(s.lease)) throw new SessionError(502, "the kernel named a bad lease");
    return s.lease;
  }
  const need = () => t.launcher ?? (() => { throw new SessionError(503, "the session terminal is off: the board has no launcher key"); })();
  const target = (id: string, m: RegExpExecArray, search: string) => `/session/${id}/${m[3]}${m[4] ?? "/"}${search}`;
  const hostOk = (req: IncomingMessage) => t.hosts.includes(String(req.headers.host ?? "").toLowerCase());

  return {
    async rows(account: string): Promise<SessionRow[] | null> {
      const rows = await t.kernel.list();
      if (!rows) return null;
      const names = new Map<string, string>();
      const person = async (id: string) => names.get(id) ?? names.set(id, (await t.nameOf(id)) ?? "Someone").get(id)!;
      const listed = await Promise.all(rows.map(async ({ lease: _lease, ...s }) => {
        const [issue, by] = await Promise.all([t.issue(s.task), creatorOf(s.task, { authoredBy: t.authoredBy, parentOf: t.parentOf })]);
        // A deleted task's old job stays in the kernel: it has no row here.
        if (!issue) return null;
        return { ...s, identifier: issue.identifier, title: issue.title, creator: by ? { name: await person(by), kind: "person" as const } : { name: issue.agent ?? "Aiden", kind: "agent" as const }, mine: by === account };
      }));
      return listed.filter((r) => r !== null);
    },

    /** Signed paths to a session's terminal and web view, for the account that may open it. */
    async open(account: string, task: string): Promise<{ term: string }> {
      need();
      if (!(await mayOpenTask(account, task))) throw new SessionError(403, "this session belongs to someone else");
      await lease(task);
      const token = mint(task);
      return { term: `/sessions/${task}/${token}/term/` };
    },

    /** An HTTP request for a session path: the token in it is the credential (the board's cookie is never read). */
    async http(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
      const m = PATH.exec(url.pathname)!;
      if (!hostOk(req)) throw new SessionError(403, "unknown host");
      // A sandboxed page's cross-origin requests ask first.
      if (req.method === "OPTIONS") return void res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE", "access-control-allow-headers": String(req.headers["access-control-request-headers"] ?? "*"), "access-control-max-age": "600" }).end();
      if (!valid(m[2]!, m[1]!)) throw new SessionError(401, "this link has expired: open the session again");
      const l = need(), launcher = new URL(l.url);
      const id = await lease(m[1]!);
      const up = httpRequest({ host: launcher.hostname, port: launcher.port, method: req.method, path: target(id, m, url.search), headers: forward(req, l.key, launcher.host) }, (r) => {
        const headers: Record<string, string | string[]> = { ...FRAMED };
        for (const [k, v] of Object.entries(r.headers)) if (v !== undefined && KEEP.has(k)) headers[k] = v;
        // A redirect stays under the proxy's own path; one to another host is dropped.
        const to = r.headers.location;
        if (to?.startsWith("/") && !to.startsWith("//")) headers.location = `/sessions/${m[1]}/${m[2]}/${m[3]}${to}`;
        res.writeHead(r.statusCode ?? 502, headers);
        r.pipe(res);
        // The stream ends, or breaks, on either side: the other side goes too.
        r.on("aborted", () => res.destroy());
        r.on("error", () => res.destroy());
      });
      up.on("error", () => { if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" }).end(JSON.stringify({ error: "the session's computer did not answer" })); else res.destroy(); });
      res.on("close", () => up.destroy());
      req.pipe(up);
    },

    /** A WebSocket upgrade for a session path (Origin is "null" from a sandboxed page: the token is what counts). */
    async upgrade(req: IncomingMessage, socket: Duplex, head: Buffer, url: URL): Promise<void> {
      const m = PATH.exec(url.pathname)!;
      if (!hostOk(req)) throw new SessionError(403, "unknown host");
      if (!valid(m[2]!, m[1]!)) throw new SessionError(401, "this link has expired: open the session again");
      const l = need(), launcher = new URL(l.url);
      const id = await lease(m[1]!);
      const up: Socket = connect(Number(launcher.port || 80), launcher.hostname);
      const fail = () => { socket.destroy(); up.destroy(); };
      up.on("error", fail);
      socket.on("error", fail);
      // Either side going away takes the other with it, also while the handshake is pending; a handshake that never answers ends.
      up.on("close", () => socket.destroy());
      socket.on("close", () => up.destroy());
      const shake = setTimeout(fail, 15_000);
      up.on("close", () => clearTimeout(shake));
      up.on("connect", () => {
        const headers = forward(req, l.key, launcher.host, true);
        up.write([`${req.method} ${target(id, m, url.search)} HTTP/1.1`, ...Object.entries(headers).map(([k, v]) => `${k}: ${[v].flat().join(", ")}`), "", ""].join("\r\n"));
        if (head.length) up.write(head);
        // The 101 answer is read to its end and cut down to the handshake before it reaches the browser.
        let head101 = Buffer.alloc(0);
        const onData = (chunk: Buffer) => {
          head101 = Buffer.concat([head101, chunk]);
          const end = head101.indexOf("\r\n\r\n");
          if (end < 0) return head101.length > 16_384 ? fail() : undefined;
          up.off("data", onData);
          clearTimeout(shake);
          const [status, ...lines] = head101.subarray(0, end).toString("latin1").split("\r\n");
          socket.write([status, ...lines.filter((l) => KEEP_UPGRADE.has(l.slice(0, l.indexOf(":")).toLowerCase())), "", ""].join("\r\n"));
          const rest = head101.subarray(end + 4);
          if (rest.length) socket.write(rest);
          up.pipe(socket);
          socket.pipe(up);
        };
        up.on("data", onData);
      });
    },
  };
}

/** The browser's request for the launcher: its own cookies and authorization stay here, the board's session key goes on. */
function forward(req: IncomingMessage, key: string, host: string, upgrade = false): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined || k === "cookie" || k === "authorization" || k === "host" || k === "origin" || k === "referer" || k.startsWith("x-forwarded-")) continue;
    if (!upgrade && DROP.has(k)) continue;
    out[k] = v;
  }
  return { ...out, host, authorization: `Bearer ${key}`, ...(upgrade ? { connection: "Upgrade", upgrade: "websocket" } : {}) };
}
