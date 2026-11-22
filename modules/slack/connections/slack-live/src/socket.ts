// @slack/socket-mode is CommonJS: default import, then destructure.
import socketMode from "@slack/socket-mode";
import type { Logger } from "pino";
import { makeDedupe, toEvent, toSourceEvent, type SourceEvent } from "./map.js";
import type { Store } from "./store.js";

const { SocketModeClient } = socketMode;

interface Deps {
  appToken: string;
  store: Store;
  onKept: () => void;
  /** The owner's own messages in their command channel (the paired DM): chat with Aiden, posted as the owner by the kernel. */
  chat?: { owner: () => { user: string; channel: string } | undefined; deliver: (text: string) => Promise<void> };
  /** A pairing DM (pair.ts): true when it was one, and then it goes no further. */
  pair?: (body: unknown) => Promise<boolean>;
  /** Channel binding (bind.ts): `/aiden …` answered to the person who typed it, and @mentions in bound channels. */
  bind?: { command: (body: any) => Promise<string>; mention: (ev: any) => Promise<boolean> };
  tee?: (body: unknown) => void; // src_slack (sources.ts): every event that is not a pairing DM; never throws or blocks
  /** The kernel's event router (POST /v1/events): throws only when the kernel didn't take it (transport, 429, 5xx). */
  forward?: (e: SourceEvent) => Promise<void>;
  log: Logger;
}

// Persist BEFORE ack: if the insert throws we do not ack, so Slack redelivers; a duplicate
// event_id is a no-op. Events during a disconnect are lost (accepted; the scout scan covers it).
export async function startSocket({ appToken, store, onKept, chat, pair, bind, tee, forward, log }: Deps): Promise<void> {
  const client = new SocketModeClient({ appToken });
  const dedupe = makeDedupe();
  client.on("slack_event", async (msg: { type: string; body: unknown; ack: () => Promise<void> }) => {
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
      const source = msg.type === "events_api" ? toSourceEvent(msg.body) : null;
      if (source && forward) await forward(source);
      const e = msg.type === "events_api" ? toEvent(msg.body) : null;
      if (e) dedupe(e, () => { store.insertEvent(e); onKept(); }); // the wake-up follows the insert, so a redelivery after a failed one wakes (a spare poke is harmless)
    } catch (err) {
      log.error({ err: String(err) }, "event insert or forward failed; not acking so Slack redelivers");
      return;
    }
    await msg.ack().catch((err: unknown) => log.warn({ err: String(err) }, "socket ack failed"));
  });
  client.on("connected", () => log.info("socket mode connected"));
  client.on("disconnected", () => log.warn("socket mode disconnected"));
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
