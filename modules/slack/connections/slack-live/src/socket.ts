// @slack/socket-mode is CommonJS: default import, then destructure.
import socketMode from "@slack/socket-mode";
import type { Logger } from "pino";
import { toSourceEvent, type SourceEvent } from "./map.js";
import type { Store } from "./store.js";

const { SocketModeClient } = socketMode;

interface Deps {
  appToken: string;
  store: Store;
  /** The owner's own messages in their command channel (the paired DM): chat with Aiden, posted as the owner by the kernel. */
  chat?: { owner: () => { user: string; channel: string } | undefined; deliver: (text: string) => Promise<void> };
  /** A pairing DM (pair.ts): true when it was one, and then it goes no further. */
  pair?: (body: unknown) => Promise<boolean>;
  /** Channel binding (bind.ts): `/aiden …` answered to the person who typed it, and @mentions in bound channels. */
  bind?: { command: (body: any) => Promise<string>; mention: (ev: any) => Promise<boolean> };
  tee?: (body: unknown) => void; // src_slack (sources.ts): every event that is not a pairing DM; never throws or blocks
  /** The kernel's event router (POST /v1/events): throws only when the kernel didn't take it (transport, 429, 5xx). */
  forward?: (e: SourceEvent) => Promise<void>;
  /** The socket's real connection state, for /healthz: connected, or disconnected (and not yet reconnected). */
  onState?: (s: "connected" | "disconnected") => void;
  log: Logger;
}

/** What an inbound event is, for the ingress line: its shape only, never the text, the users, a code or a token. */
export function ingressLine(msgType: string, body: unknown): Record<string, string> | undefined {
  if (msgType !== "events_api") return undefined;
  const b = body as { event?: Record<string, string>; event_id?: string } | null;
  const ev = b?.event;
  if (!ev) return undefined;
  const line: Record<string, string> = {};
  if (ev.type) line.type = ev.type;
  if (ev.channel_type) line.channel_type = ev.channel_type;
  if (ev.subtype) line.subtype = ev.subtype;
  if (b?.event_id) line.event_id = b.event_id;
  return line;
}

// Persist BEFORE ack: if the insert throws we do not ack, so Slack redelivers; a duplicate
// event_id is a no-op. Events during a disconnect are lost (accepted; the scout scan covers it).
export async function startSocket({ appToken, store, chat, pair, bind, tee, forward, onState, log }: Deps): Promise<void> {
  const client = new SocketModeClient({ appToken });
  client.on("slack_event", async (msg: { type: string; body: unknown; ack: () => Promise<void> }) => {
    // Before any filter: "a DM arrived" is observable, whatever the pairing, chat and routing rules then do with it.
    const ingress = ingressLine(msg.type, msg.body);
    if (ingress) log.info(ingress, "slack event in");
    if (msg.type === "slash_commands" && bind) {
      // Acked at once (Slack allows 3 s); the answer is private to the sender, through the command's response_url.
      await msg.ack().catch(() => undefined);
      const b = msg.body as { command?: string; response_url?: string };
      if (b.command !== "/aiden" || !b.response_url) return;
      const text = await bind.command(b).catch((err: unknown) => `Not done: ${String(err)}`);
      await fetch(b.response_url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ response_type: "ephemeral", text }) }).catch((err: unknown) => log.warn({ err: String(err) }, "slash response failed"));
      return;
    }
    try {
      if (msg.type === "events_api" && pair && (await pair(msg.body))) {
        await msg.ack().catch(() => undefined);
        return;
      }
      if (msg.type === "events_api") tee?.(msg.body);
      // Owner's messages in the command channel are chat with the CoS, not triage events.
      const ev = (msg.body as { event?: Record<string, string> } | null)?.event;
      const owner = chat?.owner();
      if (chat && owner?.channel && msg.type === "events_api" && ev?.type === "message" && !ev.subtype && !ev.bot_id && ev.user === owner.user && ev.channel === owner.channel && ev.text?.trim()) {
        if (!store.getKv(`slack_chat:${ev.ts}`)) {
          await chat.deliver(ev.text.trim());
          store.setKv(`slack_chat:${ev.ts}`, "1");
        }
        await msg.ack().catch(() => undefined);
        return;
      }
      // An @mention in a channel bound to an agent is that agent's task, not triage's; a failure leaves it unacked so Slack redelivers.
      if (bind && msg.type === "events_api" && (await bind.mention(ev))) {
        await msg.ack().catch(() => undefined);
        return;
      }
      // Routines' events (bot posts too, flagged): a kernel that didn't take it leaves the envelope unacked, so Slack redelivers.
      const source = msg.type === "events_api" ? toSourceEvent(msg.body, owner?.user) : null;
      if (source && forward) await forward(source);
    } catch (err) {
      log.error({ err: String(err) }, "event forward failed; not acking so Slack redelivers");
      return;
    }
    await msg.ack().catch((err: unknown) => log.warn({ err: String(err) }, "socket ack failed"));
  });
  client.on("connected", () => { onState?.("connected"); log.info("socket mode connected"); });
  // A routine refresh closes the socket and reconnects without ever emitting "disconnected": the state must drop on "close"
  // too, or /healthz would report a live listener that is not listening.
  const down = (why: string) => { onState?.("disconnected"); log.warn(why); };
  client.on("disconnected", () => down("socket mode disconnected"));
  client.on("close", () => down("socket mode closed; reconnecting"));
  // Initial start only: 30 s doubling to 5 min. After that the client reconnects itself.
  for (let backoff = 30_000; ; backoff = Math.min(backoff * 2, 300_000)) {
    try {
      await client.start();
      return;
    } catch (err) {
      log.error({ err: String(err), retryMs: backoff }, "socket mode start failed");
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
}
