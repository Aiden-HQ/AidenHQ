// The one way a message reaches the owner (the owner-channel module's `notify`). The kernel only carries: it queues the
// owner messages of the kernel, the board and the runner (POST /v1/notify, or queue() in process) for the module with role
// kernel.notify, which takes them (GET /v1/notify/take) and routes them like an agent's notify call; and it hands that
// module's sends to a channel's transport (POST /v1/notify/send → the channel's `providers.channel.transport`, with the
// channel's own token). Routing, mutes, caps, dedupe and digests are the module's, never the kernel's.
// A credential for the owner (an account reset link) never reaches the router: the kernel keeps it (owner_secrets) and sends
// it itself, only to a channel that declares a private owner chat (providers.channel.credentials: the paired Telegram chat),
// until one takes it. A transport is a compose service, never a loopback or IP address: it gets a channel's token.
import http from "node:http";
import type { DatabaseSync } from "node:sqlite";
import type { ModulesFile } from "./channels.ts";
import type { Target } from "./net.ts";
import { fail } from "./proxy.ts";

export const KINDS = ["decision", "done", "fyi", "alert", "digest"] as const;
/** `reply`: a job's reply relayed to the channel the owner wrote from (relay.ts), headed by its agent and task. */
export type Notice = { kind: (typeof KINDS)[number]; text: string; task?: string; dedupe_key?: string; reply?: { via: "telegram" | "slack"; agent: string; issue: string } };
type Resolver = { resolve: (url: string) => Promise<Target>; forget: (url: string) => void };

/** A notice from a producer's body: kind, text, and optionally the task it is about and its dedupe key. */
export function notice(b: { kind?: unknown; text?: unknown; task?: unknown; dedupe_key?: unknown }): Notice {
  const text = typeof b.text === "string" ? b.text.trim().slice(0, 3000) : "";
  if (!KINDS.includes(b.kind as Notice["kind"]) || !text) throw fail(400, "bad_request", `send {kind: ${KINDS.join("|")}, text, task?, dedupe_key?}`);
  if (b.task != null && (typeof b.task !== "string" || !/^[A-Z][A-Z0-9]*-\d+$/.test(b.task))) throw fail(400, "bad_request", "task is a task identifier (WOR-123)");
  if (b.dedupe_key != null && (typeof b.dedupe_key !== "string" || !b.dedupe_key || b.dedupe_key.length > 200)) throw fail(400, "bad_request", "dedupe_key is a short string");
  return { kind: b.kind as Notice["kind"], text, ...(b.task ? { task: b.task as string } : {}), ...(b.dedupe_key ? { dedupe_key: b.dedupe_key as string } : {}) };
}

/** A transport's host: a compose service name (compile checks the same), never an address or localhost. */
export const SERVICE_HOST = /^[a-z][a-z0-9-]*$/;
const loopback = (ip: string) => /^127\./.test(ip) || ip === "::1" || ip === "0.0.0.0" || ip === "localhost";

export function createNotify({ db, modules, secret, resolver, extra = () => [], log = () => {}, testHosts = false }: {
  db: DatabaseSync; modules: () => ModulesFile; secret: (name: string) => string; resolver: Resolver;
  /** What the kernel has for the owner at take time (the approvals digest), each handed over once. */
  extra?: () => Notice[];
  log?: (msg: string, f?: Record<string, unknown>) => void;
  /** Tests only: transports on 127.0.0.1. */
  testHosts?: boolean;
}) {
  db.exec(`CREATE TABLE IF NOT EXISTS owner_notify (id INTEGER PRIMARY KEY, msg TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS owner_secrets (id INTEGER PRIMARY KEY, text TEXT NOT NULL, at TEXT NOT NULL);`);
  async function post(to: string, message: unknown): Promise<{ sent: boolean; off?: true; reason?: string }> {
    const m = modules().modules?.[to];
    const url = m?.channel?.transport;
    if (!url || !m?.token) throw fail(404, "not_found", `${to} isn't an installed channel with a transport`);
    const host = new URL(url).hostname;
    if (!testHosts && (!SERVICE_HOST.test(host) || host === "localhost")) throw fail(403, "forbidden", `${to}'s transport isn't a compose service`);
    const key = secret(m.token);
    const data = Buffer.from(JSON.stringify(message));
    try {
      const target = await resolver.resolve(url);
      if (!testHosts && loopback(target.host)) throw new Error("it resolves to loopback");
      return await new Promise((resolve) => {
        const req = http.request({ host: target.host, port: target.port, path: target.path, method: "POST", timeout: 30_000, headers: { host: new URL(url).host, authorization: `Bearer ${key}`, "content-type": "application/json", "content-length": data.length } }, (res) => {
          let text = "";
          res.setEncoding("utf8").on("data", (c) => { if (text.length < 100_000) text += c; }).on("end", () => {
            let j: { sent?: unknown; off?: unknown } = {};
            try { j = JSON.parse(text); } catch { /* not sent */ }
            // off: the channel isn't set up (no bot, nobody paired), so there is nothing to retry there.
            resolve(res.statusCode === 200 && j.sent === true ? { sent: true } : { sent: false, ...(j.off === true ? { off: true as const } : {}), reason: `the transport answered ${res.statusCode}` });
          });
        });
        req.on("timeout", () => req.destroy(new Error("timeout")));
        req.on("error", (e) => { resolver.forget(url); resolve({ sent: false, reason: `unreachable (${e.message})` }); });
        req.end(data);
      });
    } catch (e) {
      return { sent: false, reason: `unreachable (${(e as Error).message})` };
    }
  }
  const router = (roles: string[]) => { if (!roles.includes("kernel.notify")) throw fail(403, "forbidden", "only the owner's router (role kernel.notify) takes and sends owner messages"); };
  return {
    queue(n: Notice) {
      db.prepare("INSERT INTO owner_notify (msg) VALUES (?)").run(JSON.stringify(n));
      db.prepare("DELETE FROM owner_notify WHERE id NOT IN (SELECT id FROM owner_notify ORDER BY id DESC LIMIT 200)").run();
    },
    take(roles: string[]): { messages: Notice[] } {
      router(roles);
      const rows = db.prepare("DELETE FROM owner_notify WHERE id IN (SELECT id FROM owner_notify ORDER BY id LIMIT 50) RETURNING id, msg").all() as { id: number; msg: string }[];
      return { messages: [...extra(), ...rows.sort((x, y) => x.id - y.id).map((r) => JSON.parse(r.msg) as Notice)] };
    },
    /** One message to one channel's transport; `sent` is the transport's answer (false when it is down; `off` when not set up). */
    async send(roles: string[], b: { to?: unknown; message?: unknown }): Promise<{ sent: boolean; off?: true; reason?: string }> {
      router(roles);
      if (!b.message || typeof b.message !== "object") throw fail(400, "bad_request", "send {to, message}");
      return post(String(b.to), b.message);
    },
    /** A credential for the owner (an account reset link): kept here and sent only to a credentials channel (deliverSecrets). */
    secret(text: string) {
      db.prepare("INSERT INTO owner_secrets (text, at) VALUES (?, ?)").run(text.slice(0, 3000), new Date().toISOString());
    },
    /** Sends each kept credential to the first credentials channel that takes it; one none takes stays, and is logged. */
    async deliverSecrets(): Promise<number> {
      const to = Object.entries(modules().modules ?? {}).filter(([, m]) => m.channel?.credentials === true && m.channel.transport).map(([n]) => n);
      let n = 0;
      for (const r of db.prepare("SELECT id, text FROM owner_secrets ORDER BY id").all() as { id: number; text: string }[]) {
        let sent = false;
        for (const t of to) if (!sent) sent = (await post(t, { kind: "done", text: r.text }).catch(() => ({ sent: false }))).sent;
        if (sent) { db.prepare("DELETE FROM owner_secrets WHERE id = ?").run(r.id); n++; }
        else log("a credential for the owner is waiting: no private owner chat took it", { channels: to });
      }
      return n;
    },
  };
}
export type Notify = ReturnType<typeof createNotify>;
