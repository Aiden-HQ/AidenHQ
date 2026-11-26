// The one way a message reaches the owner (the owner-channel module's `notify`). The kernel only carries: it queues the
// owner messages of the kernel, the board and the runner (POST /v1/notify, or queue() in process) for the module with role
// kernel.notify, which takes them (GET /v1/notify/take) and routes them like an agent's notify call, then acknowledges each
// (POST /v1/notify/ack): a taken message not acknowledged within TAKE_LEASE_MS (the router crashed, its answer was lost) is
// taken again, and only an acknowledged one goes; and it hands that
// module's sends to a channel's transport (POST /v1/notify/send → the channel's `providers.channel.transport`, with the
// channel's own token). Routing, mutes, caps, dedupe and digests are the module's, never the kernel's.
// A transport is a compose service, never a loopback or IP address: it gets a channel's token.
import http from "node:http";
import type { DatabaseSync } from "node:sqlite";
import type { ModulesFile } from "./channels.ts";
import type { Target } from "./net.ts";
import { fail } from "./proxy.ts";

export const KINDS = ["decision", "done", "fyi", "alert", "digest"] as const;
/**
 * `reply`: a job's reply relayed to the channel the owner wrote from (relay.ts), headed by its agent and task. `head`: the
 * kernel's question for the owner from an agent waiting on `task` (escalate.ts), headed by that agent so their reply lands there.
 */
export type Notice = { kind: (typeof KINDS)[number]; text: string; task?: string; dedupe_key?: string; reply?: { via: "telegram" | "slack"; agent: string; issue: string }; head?: { agent: string; issue: string };
  /** The agent whose question `head` carries: the owner channel applies its mutes and the task's loop brake. */
  asker?: { id: string; key: string; roles: string[] } };
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

const TAKE_LEASE_MS = 2 * 60_000;
/** The push test (onboarding's "Send a test"): one fixed decision card whose buttons do nothing (`inert`). */
export const TEST_MESSAGE = { kind: "decision", text: "Test from AidenHQ: this is how a decision reaches you. The buttons do nothing.", inert: ["Looks good", "Not now"] } as const;
/** An owner message nobody acknowledged in a week (no router installed): dropped, and logged. */
const KEEP_MS = 7 * 86_400_000;

export function createNotify({ db, modules, secret, resolver, extra = () => [], log = () => {}, testHosts = false, now = Date.now }: {
  db: DatabaseSync; modules: () => ModulesFile; secret: (name: string) => string; resolver: Resolver;
  /** What the kernel has for the owner at take time (the approvals digest): queued then, so it is leased and acknowledged like any other. */
  extra?: () => Notice[];
  log?: (msg: string, f?: Record<string, unknown>) => void;
  /** Tests only: transports on 127.0.0.1. */
  testHosts?: boolean;
  now?: () => number;
}) {
  db.exec(`CREATE TABLE IF NOT EXISTS owner_notify (id INTEGER PRIMARY KEY, msg TEXT NOT NULL);`);
  const cols = new Set((db.prepare("PRAGMA table_info(owner_notify)").all() as { name: string }[]).map((c) => c.name));
  for (const c of ["at", "taken"]) if (!cols.has(c)) db.exec(`ALTER TABLE owner_notify ADD COLUMN ${c} INTEGER`);
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
  const queue = (n: Notice) => {
    db.prepare("INSERT INTO owner_notify (msg, at) VALUES (?, ?)").run(JSON.stringify(n), now());
    const old = db.prepare("DELETE FROM owner_notify WHERE at < ?").run(now() - KEEP_MS).changes;
    if (old) log("owner messages nobody took in a week dropped", { n: old });
  };
  return {
    queue,
    /** Up to 50 messages, oldest first, each with its `id` to acknowledge; a taken one comes back after TAKE_LEASE_MS unacknowledged. */
    take(roles: string[]): { messages: (Notice & { id: number })[] } {
      router(roles);
      for (const n of extra()) queue(n);
      const rows = db.prepare("UPDATE owner_notify SET taken = ? WHERE id IN (SELECT id FROM owner_notify WHERE taken IS NULL OR taken < ? ORDER BY id LIMIT 50) RETURNING id, msg").all(now(), now() - TAKE_LEASE_MS) as { id: number; msg: string }[];
      return { messages: rows.sort((x, y) => x.id - y.id).map((r) => ({ ...(JSON.parse(r.msg) as Notice), id: r.id })) };
    },
    /** The router has the messages it took (routed, or kept by it for its own retry): they go. */
    ack(roles: string[], b: { ids?: unknown }) {
      router(roles);
      const ids = Array.isArray(b?.ids) ? b.ids.filter((x): x is number => Number.isInteger(x)) : [];
      if (!ids.length) throw fail(400, "bad_request", "send {ids: [the taken messages' ids]}");
      for (const id of ids) db.prepare("DELETE FROM owner_notify WHERE id = ?").run(id);
      return { acked: ids.length };
    },
    /** One message to one channel's transport; `sent` is the transport's answer (false when it is down; `off` when not set up). */
    async send(roles: string[], b: { to?: unknown; message?: unknown }): Promise<{ sent: boolean; off?: true; reason?: string }> {
      router(roles);
      if (!b.message || typeof b.message !== "object") throw fail(400, "bad_request", "send {to, message}");
      return post(String(b.to), b.message);
    },
    /**
     * The push test (the board's key): the fixed test card to exactly `to`'s transport, its own answer back. Never queued for
     * the router (no owner_notify row), never retried, never routed elsewhere.
     */
    test(b: { to?: unknown }): Promise<{ sent: boolean; off?: true; reason?: string }> {
      if (typeof b?.to !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(b.to)) throw fail(400, "bad_request", "send {to: a channel module}");
      return post(b.to, TEST_MESSAGE);
    },
  };
}
export type Notify = ReturnType<typeof createNotify>;
