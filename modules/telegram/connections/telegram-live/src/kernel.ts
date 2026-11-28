// The kernel, as telegram-live calls it with the module's own token (telegram_token): routines' events (role kernel.events),
// owner notices and connection needs (role kernel.owner-notice).
import type { Logger } from "pino";

/** A routine's event (kernel/src/events.ts SourceEvent), as telegram-live sends it. */
export type SourceEvent = {
  connection: "telegram_account";
  resource: string;
  id: string;
  kind: "message";
  author?: string;
  text?: string;
  truncated?: boolean;
  bot?: boolean;
  /** The message is the owner's own (TDLib's outgoing flag, never its text). The kernel honours it only from a connector with role kernel.attest-owner. */
  from_owner?: boolean;
  labels?: string[];
  /** No `thread`: a Telegram chat is one conversation for summons. A reply chain's root or forum topic is data.thread. */
  data?: Record<string, string | number | boolean | null>;
};

export interface Kernel {
  /** Throws on a 429 or 5xx (the drain retries); any other refusal is logged and dropped. */
  event(e: SourceEvent): Promise<void>;
  /** notify and need throw when the kernel can't be reached or answers 429 or 5xx (the caller retries); any other refusal is logged and dropped. */
  notify(text: string, dedupeKey: string): Promise<void>;
  need(cause: "expired" | "not_connected", detail: string): Promise<void>;
}

export function createKernel(o: { url: string; token: string; log: Pick<Logger, "warn"> }): Kernel {
  const base = o.url.replace(/\/$/, "");
  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, { method: "POST", headers: { authorization: `Bearer ${o.token}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  const report = async (res: Response, what: string) => {
    if (res.status === 429 || res.status >= 500) throw new Error(`${what}: ${res.status}`);
    if (!res.ok) o.log.warn({ status: res.status }, what);
  };
  return {
    async event(e) {
      const res = await post("/v1/events", e);
      if (res.status === 429 || res.status >= 500) throw new Error(`POST /v1/events -> ${res.status}`);
      if (!res.ok) o.log.warn({ status: res.status, id: e.id }, "the kernel refused an event; dropped");
    },
    async notify(text, dedupeKey) {
      await report(await post("/v1/notify", { kind: "alert", text, dedupe_key: dedupeKey }), "owner notice not taken");
    },
    async need(cause, detail) {
      await report(await post("/v1/connections/need", { connection: "telegram_account", need: { cause, detail } }), "connection need not taken");
    },
  };
}
